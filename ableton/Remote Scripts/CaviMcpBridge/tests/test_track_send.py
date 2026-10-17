import copy
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class Send:
    min, max, value = 0.0, 1.0, 0.36
    is_enabled, is_quantized, automation_state = True, False, 0

    def str_for_value(self, value):
        return "-inf dB" if value == 0 else f"{-60 + 60 * math.sqrt(value):.1f} dB"


class TrackSendTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        other_return = copy.deepcopy(self.song.return_tracks[0])
        other_return.name = "Delay"
        self.song.return_tracks.append(other_return)
        self.song.tracks[0].mixer_device.sends = [Send(), Send()]
        self.args = {"trackId": "track-0", "sendId": "send-0", "returnTrackId": "return-0", "sendDb": -12}

    def source(self):
        return dispatch_request(self.song, {"method": "get_track_send_edit_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "set_track_send_db", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def test_native_send_display_drives_inert_plan_and_only_the_selected_send_changes(self):
        mixer = dispatch_request(self.song, {"method": "get_track_mixer", "params": {"trackId": "track-0"}}, 3)
        self.assertEqual(mixer["sends"][0]["decibels"], -24)
        before = self.source()
        self.assertEqual(before["send"]["decibels"], -24)
        self.assertEqual(before["returnName"], "Reverb")
        self.assertEqual(before["target"]["decibels"], -12)
        self.assertAlmostEqual(before["target"]["value"], .64, delta=.002)
        self.assertEqual(self.song.tracks[0].mixer_device.sends[0].value, .36)
        result = self.apply(before)
        self.assertTrue(result["verified"])
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["send"]["decibels"], -12)
        self.assertEqual(self.song.tracks[0].mixer_device.sends[1].value, .36)
        self.assertEqual(self.song.tracks[0].mixer_device.volume.value, .75)
        self.assertEqual(self.song.tracks[0].mixer_device.panning.value, 0)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_manual_edits_and_native_target_replacements_invalidate_the_plan(self):
        changes = [lambda s: setattr(s.tracks[0].mixer_device.sends[0], "value", .5),
                   lambda s: s.tracks[0].mixer_device.sends.__setitem__(0, Send()),
                   lambda s: s.return_tracks.__setitem__(0, copy.deepcopy(s.return_tracks[0])),
                   lambda s: s.tracks.__setitem__(0, copy.deepcopy(s.tracks[0]))]
        for change in changes:
            self.setUp()
            before = self.source()
            change(self.song)
            with self.assertRaisesRegex(ValueError, "changed"):
                self.apply(before)

    def test_refuses_recording_automation_disabled_frozen_and_invalid_targets(self):
        for key, value in [("automation_state", 1), ("automation_state", 2), ("automation_state", None),
                           ("is_enabled", False), ("is_quantized", True)]:
            self.setUp()
            setattr(self.song.tracks[0].mixer_device.sends[0], key, value)
            with self.assertRaises(ValueError):
                self.source()
            self.assertEqual(self.song.tracks[0].mixer_device.sends[0].value, .36)
        for flag in ["record_mode", "session_record"]:
            self.setUp()
            setattr(self.song, flag, True)
            with self.assertRaisesRegex(ValueError, "recording"):
                self.source()
        self.setUp()
        self.song.tracks[0].is_frozen = True
        with self.assertRaisesRegex(ValueError, "frozen"):
            self.source()
        for key, value in [("sendDb", 1), ("sendDb", -90), ("sendDb", True), ("sendDb", float("nan")),
                           ("sendId", "send-00"), ("sendId", "send-2"), ("returnTrackId", "return-1"),
                           ("trackId", "track-00")]:
            self.setUp()
            self.args[key] = value
            with self.assertRaises(ValueError):
                self.source()

    def test_automation_changed_after_plan_is_refused_at_native_write(self):
        before = self.source()
        self.song.tracks[0].mixer_device.sends[0].automation_state = 1
        with self.assertRaisesRegex(ValueError, "automation"):
            self.apply(before)
        self.assertEqual(self.song.tracks[0].mixer_device.sends[0].value, .36)

    def test_a_silent_baseline_can_be_restored_through_the_same_native_guard(self):
        parameter = self.song.tracks[0].mixer_device.sends[0]
        parameter.value = 0
        self.assertTrue(self.source()["send"]["silent"])
        self.assertTrue(self.apply()["verified"])
        self.args["sendDb"] = "-inf"
        before = self.source()
        self.assertTrue(before["target"]["silent"])
        self.assertEqual(before["target"]["value"], 0)
        result = self.apply(before)
        self.assertTrue(result["verified"])
        self.assertTrue(result["send"]["silent"])
        self.assertIsNone(result["send"]["decibels"])
        self.assertEqual(parameter.value, 0)

    def test_unknown_send_display_is_read_as_unavailable_and_refused_for_write(self):
        self.song.tracks[0].mixer_device.sends[0].str_for_value = lambda value: "unknown"
        mixer = dispatch_request(self.song, {"method": "get_track_mixer", "params": {"trackId": "track-0"}}, 3)
        self.assertIsNone(mixer["sends"][0]["decibels"])
        with self.assertRaisesRegex(ValueError, "dB display"):
            self.source()

    def test_failed_readback_restores_only_the_selected_send(self):
        class RejectingSend(Send):
            _value = .36

            @property
            def value(self):
                return self._value

            @value.setter
            def value(self, value):
                self._value = value if value == .36 else .9

        self.song.tracks[0].mixer_device.sends[0] = RejectingSend()
        with self.assertRaisesRegex(RuntimeError, "readback"):
            self.apply()
        self.assertEqual(self.song.tracks[0].mixer_device.sends[0].value, .36)
        self.assertEqual(self.song.tracks[0].mixer_device.sends[1].value, .36)
