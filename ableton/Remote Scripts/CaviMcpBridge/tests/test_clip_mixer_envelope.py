import copy
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Parameter, AutomationEnvelope


class Gain(Parameter):
    def __init__(self):
        super().__init__()
        self.name = self.original_name = "Gain"
        self.automation_state = 0

    def str_for_value(self, value):
        return "-inf dB" if value == 0 else f"{-60 + 60 * math.sqrt(value):.1f} dB"


class ClipMixerEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.mixer = self.song.tracks[0].mixer_device
        self.mixer.volume, self.mixer.sends = Gain(), [Gain()]
        self.mixer.panning = Parameter()
        self.args = {"trackId": "track-0", "clipId": "track-0:clip-0", "mixerControl": "volume",
                     "points": [{"time": 0, "duration": 2, "targetDisplay": "-24 dB"},
                                {"time": 2, "duration": 2, "targetDisplay": "-12 dB"}]}

    def source(self):
        return dispatch_request(self.song, {"method": "get_clip_mixer_envelope_creation_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "create_clip_mixer_envelope", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def send(self):
        self.args.update(mixerControl="send", sendId="send-0", returnTrackId="return-0")

    def pan(self):
        self.mixer.panning_mode = 0
        self.mixer.panning.min, self.mixer.panning.max = -1, 1
        self.mixer.panning.automation_state = 0
        self.args.update(mixerControl="pan", points=[
            {"time": 0, "duration": 1, "value": -1},
            {"time": 1, "duration": 1, "value": 0},
            {"time": 2, "duration": 2, "value": 1}])

    def test_pan_steps_target_only_the_stereo_pan_lane_and_read_back_during_playback(self):
        self.pan()
        unrelated = self.clip.create_automation_envelope(self.mixer.volume)
        unrelated.insert_step(0, 4, .8)
        before = self.source()
        self.assertEqual(before["panningMode"], 0)
        result = self.apply(before)
        self.assertTrue(result["verified"])
        self.assertEqual(result["mixerControl"], "pan")
        self.assertEqual([x["value"] for x in result["samples"]], [-1] * 3 + [0] * 3 + [1] * 3)
        self.assertIs(self.clip.automation_envelope(self.mixer.volume), unrelated)
        self.assertEqual(unrelated.value_at_time(3), .8)
        self.song.is_playing = True
        read = dispatch_request(self.song, {"method": "get_clip_mixer_envelope", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0", "mixerControl": "pan", "sampleTimes": [.5, 1.5, 3]}}, 4)
        self.assertEqual(read["panningMode"], 0)
        self.assertEqual([x["value"] for x in read["samples"]], [-1, 0, 1])
        self.assertTrue(self.song.is_playing)

    def test_pan_refuses_split_or_unknown_modes_and_display_targets(self):
        for mode in [1, None, 2]:
            self.setUp()
            self.pan()
            self.mixer.panning_mode = mode
            with self.assertRaisesRegex(ValueError, "pan|stereo"):
                self.source()
            self.assertEqual(self.clip.envelopes, {})
        self.setUp()
        self.pan()
        self.args["points"] = [{"time": 0, "duration": 4, "targetDisplay": "50 %"}]
        with self.assertRaisesRegex(ValueError, "pan|native"):
            self.source()

    def test_pan_plan_preserves_intervening_edits_and_refuses_mode_changes_during_creation(self):
        self.pan()
        before = self.source()
        self.mixer.panning.value = .7
        with self.assertRaisesRegex(ValueError, "changed"):
            self.apply(before)
        self.assertEqual(self.clip.envelopes, {})
        before = self.source()
        self.mixer.panning_mode = 1
        with self.assertRaisesRegex(ValueError, "pan|stereo"):
            self.apply(before)
        self.assertEqual(self.clip.envelopes, {})
        self.mixer.panning_mode = 0

        def create(parameter):
            envelope = AutomationEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            self.mixer.panning_mode = 1
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "ownership is unconfirmed"):
            self.apply()
        self.assertEqual(self.clip.automation_envelope(self.mixer.panning).steps, [])

    def test_volume_targets_resolve_without_writes_and_create_verified_native_steps(self):
        before = self.source()
        self.assertIsNone(self.clip.automation_envelope(self.mixer.volume))
        self.assertAlmostEqual(before["points"][0]["value"], .36, delta=.002)
        result = self.apply(before)
        self.assertTrue(result["created"])
        self.assertTrue(result["verified"])
        self.assertEqual(result["mixerControl"], "volume")
        self.assertEqual([x["displayValue"] for x in result["samples"]], ["-24.0 dB"] * 3 + ["-12.0 dB"] * 3)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])
        self.assertIsNone(self.clip.automation_envelope(self.mixer.sends[0]))

    def test_send_lane_binds_the_exact_return_and_preserves_the_volume_lane(self):
        volume = self.clip.create_automation_envelope(self.mixer.volume)
        volume.insert_step(0, 4, .8)
        self.send()
        before = self.source()
        self.assertEqual(before["returnName"], "Reverb")
        result = self.apply(before)
        self.assertEqual(result["sendId"], "send-0")
        self.assertEqual(result["returnTrackId"], "return-0")
        self.assertIs(self.clip.automation_envelope(self.mixer.volume), volume)
        self.assertEqual(volume.value_at_time(3), .8)
        self.assertTrue(result["verified"])

    def test_existing_lane_and_intervening_mixer_return_or_clip_edits_are_preserved(self):
        changes = [lambda: setattr(self.mixer.sends[0], "value", .6),
                   lambda: setattr(self.clip, "loop_end", 3),
                   lambda: setattr(self.mixer, "volume", Gain()),
                   lambda: self.song.return_tracks.__setitem__(0, copy.deepcopy(self.song.return_tracks[0])),
                   lambda: self.clip.create_automation_envelope(self.mixer.volume)]
        for change in changes:
            self.setUp()
            before = self.source()
            change()
            envelopes = dict(self.clip.envelopes)
            with self.assertRaises(ValueError):
                self.apply(before)
            self.assertEqual(self.clip.envelopes, envelopes)

    def test_invalid_mixer_targets_and_gain_steps_fail_before_creation(self):
        for change in [{"mixerControl": "pan"}, {"mixerControl": "volume", "sendId": "send-0"},
                       {"mixerControl": "send"}, {"mixerControl": "send", "sendId": "send-0", "returnTrackId": "return-1"},
                       {"points": [{"time": 0, "duration": 4, "targetDisplay": "200 Hz"}]},
                       {"points": [{"time": 0, "duration": 4, "value": 2}]},
                       {"points": [{"time": 0, "duration": 4, "targetDisplay": "-inf dB"}]}]:
            self.setUp()
            self.args.update(change)
            with self.assertRaises(ValueError):
                self.source()
            self.assertEqual(self.clip.envelopes, {})
        for obj, field, value in [("song", "is_playing", True), ("song", "session_record", True),
                                   ("volume", "automation_state", None), ("volume", "automation_state", 2),
                                   ("volume", "is_enabled", False)]:
            self.setUp()
            setattr(self.song if obj == "song" else self.mixer.volume, field, value)
            with self.assertRaises(ValueError):
                self.source()

    def test_reading_existing_lane_is_focus_preserving_and_available_during_playback(self):
        self.apply()
        self.song.is_playing = True
        args = {k: v for k, v in self.args.items() if k != "points"}
        result = dispatch_request(self.song, {"method": "get_clip_mixer_envelope", "params": {
            **args, "sampleTimes": [.5, 2.5]}}, 3)
        self.assertTrue(result["exists"])
        self.assertEqual([x["displayValue"] for x in result["samples"]], ["-24.0 dB", "-12.0 dB"])
        self.assertTrue(self.song.is_playing)
        for times in [[-1], [float("nan")], list(range(513))]:
            with self.assertRaises(ValueError):
                dispatch_request(self.song, {"method": "get_clip_mixer_envelope", "params": {**args, "sampleTimes": times}}, 3)

    def test_failed_readback_removes_only_the_new_owned_mixer_lane(self):
        unrelated = self.clip.create_automation_envelope(self.mixer.sends[0])
        unrelated.insert_step(0, 4, .7)

        class WrongEnvelope(AutomationEnvelope):
            def value_at_time(self, time):
                return .9

        def create(parameter):
            envelope = WrongEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "readback"):
            self.apply()
        self.assertIsNone(self.clip.automation_envelope(self.mixer.volume))
        self.assertIs(self.clip.automation_envelope(self.mixer.sends[0]), unrelated)
        self.assertEqual(unrelated.value_at_time(3), .7)

    def test_return_replaced_during_creation_is_refused_before_steps_and_cleanup(self):
        self.send()

        def create(parameter):
            envelope = AutomationEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "ownership is unconfirmed"):
            self.apply()
        self.assertEqual(self.clip.automation_envelope(self.mixer.sends[0]).steps, [])
