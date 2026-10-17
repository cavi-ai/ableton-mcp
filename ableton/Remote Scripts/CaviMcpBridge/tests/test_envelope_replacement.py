import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AutomationEnvelope
from test_parameter_display import Frequency


class EnvelopeReplacementTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.parameter = Frequency()
        self.song.tracks[0].devices[0].parameters = [self.parameter, Frequency()]
        self.old = self.clip.create_automation_envelope(self.parameter)
        self.old.insert_step(0, 2, .2)
        self.old.insert_step(2, 2, .8)
        self.args = {"trackId": "track-0", "clipId": "track-0:clip-0", "deviceId": "track-0:device-0",
                     "parameterId": "parameter-0", "replaceExisting": True,
                     "points": [{"time": 0, "duration": 2, "value": .3}, {"time": 2, "duration": 2, "value": .6}]}

    def source(self):
        return dispatch_request(self.song, {"method": "get_clip_envelope_replacement_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "set_clip_parameter_envelope", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def test_existing_curve_requires_explicit_whole_lane_replacement_authority(self):
        for flag in (None, False, "true"):
            self.args["replaceExisting"] = flag
            with self.assertRaisesRegex(ValueError, "replaceExisting"):
                self.source()
            self.assertIs(self.clip.automation_envelope(self.parameter), self.old)
            self.assertEqual(self.old.value_at_time(3), .8)

    def test_replacement_is_inert_until_confirmed_and_keeps_raw_clamping_explicit(self):
        self.args["points"] = [{"time": 0, "duration": 2, "value": -1}, {"time": 2, "duration": 2, "value": 2}]
        before = self.source()
        self.assertIs(self.clip.automation_envelope(self.parameter), self.old)
        self.assertEqual([p["value"] for p in before["points"]], [0, 1])
        self.assertEqual([p["requestedValue"] for p in before["points"]], [-1, 2])
        self.assertFalse(before["fullCurveCaptured"])
        result = self.apply(before)
        self.assertTrue(result["replaced"])
        self.assertTrue(result["verified"])
        self.assertEqual(result["verificationScope"], "sampled_steps")
        self.assertEqual(self.clip.automation_envelope(self.parameter).value_at_time(3), 1)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_sampled_edits_or_replaced_native_objects_invalidate_same_version_plans(self):
        changes = [lambda: self.old.insert_step(.5, 1, .9),
                   lambda: self.clip.envelopes.__setitem__(id(self.parameter), copy.deepcopy(self.old)),
                   lambda: setattr(self.clip, "loop_end", 3),
                   lambda: setattr(self.song.tracks[0].devices[0].parameters[1], "value", .7),
                   lambda: self.song.tracks[0].devices[0].parameters.__setitem__(0, Frequency())]
        for change in changes:
            self.setUp()
            before = self.source()
            change()
            current = dict(self.clip.envelopes)
            with self.assertRaises(ValueError):
                self.apply(before)
            self.assertEqual(self.clip.envelopes, current)

    def test_preflight_errors_do_not_clear_the_current_lane(self):
        for points in [[], [{"time": -1, "duration": 1, "value": .3}], [{"time": 0, "duration": 0, "value": .3}],
                       [{"time": 0, "duration": 5, "value": .3}], [{"time": 0, "duration": 4, "value": float("nan")}],
                       [{"time": 0, "duration": 3, "value": .2}, {"time": 2, "duration": 2, "value": .6}]]:
            self.args["points"] = points
            with self.assertRaises(ValueError):
                self.source()
            self.assertIs(self.clip.automation_envelope(self.parameter), self.old)
        self.setUp()
        self.song.is_playing = True
        with self.assertRaises(ValueError):
            self.source()
        self.assertIs(self.clip.automation_envelope(self.parameter), self.old)

    def test_failure_after_clear_keeps_partial_state_and_does_not_claim_curve_restoration(self):
        class WrongEnvelope(AutomationEnvelope):
            def value_at_time(self, time):
                return .9

        def create(parameter):
            envelope = WrongEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "previous curve.*not backed up"):
            self.apply()
        current = self.clip.automation_envelope(self.parameter)
        self.assertIsNot(current, self.old)
        self.assertGreater(len(current.steps), 0)

    def test_parameter_replaced_during_creation_leaves_an_explicit_partial_failure(self):
        device = self.song.tracks[0].devices[0]

        def create(parameter):
            envelope = AutomationEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            device.parameters[0] = Frequency()
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "ownership is unconfirmed.*previous curve was not backed up"):
            self.apply()
        self.assertIsNone(self.clip.automation_envelope(device.parameters[0]))
        self.assertEqual(self.clip.automation_envelope(self.parameter).steps, [])

    def test_absent_lane_uses_guarded_creation_and_later_creation_invalidates_its_plan(self):
        self.clip.clear_envelope(self.parameter)
        self.args.pop("replaceExisting")
        before = self.source()
        self.assertFalse(before["envelopeExists"])
        self.assertTrue(self.apply(before)["verified"])
        with self.assertRaisesRegex(ValueError, "replaceExisting"):
            self.apply(before)

    def test_existing_triplet_pattern_capacity_is_preserved_for_absent_and_existing_lanes(self):
        for exists in (False, True):
            self.setUp()
            self.clip.length = self.clip.loop_end = 64
            if not exists:
                self.clip.clear_envelope(self.parameter)
            self.args["points"] = [{"time": index / 6, "duration": 1 / 6, "value": .3 if index % 2 else .6}
                                   for index in range(384)]
            result = self.apply()
            self.assertTrue(result["verified"])
            self.assertEqual(len(result["samples"]), 1152)
