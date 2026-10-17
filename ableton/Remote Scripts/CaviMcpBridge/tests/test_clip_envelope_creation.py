import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AutomationEnvelope, QuantizedParameter
from test_parameter_display import Frequency


class ClipEnvelopeCreationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.parameter = Frequency()
        self.song.tracks[0].devices[0].parameters = [self.parameter, Frequency()]
        self.args = {"trackId": "track-0", "clipId": "track-0:clip-0", "deviceId": "track-0:device-0",
                     "parameterId": "parameter-0", "points": [
                         {"time": 0, "duration": 2, "targetDisplay": "200 Hz"},
                         {"time": 2, "duration": 2, "targetDisplay": "2 kHz"}]}

    def source(self):
        return dispatch_request(self.song, {"method": "get_clip_envelope_creation_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "create_clip_parameter_envelope", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def test_unit_steps_are_planned_without_writes_and_verified_at_multiple_native_positions(self):
        before = self.source()
        self.assertIsNone(self.clip.automation_envelope(self.parameter))
        self.assertEqual(self.parameter.value, .4)
        self.assertAlmostEqual(before["points"][0]["value"], 1 / 3, delta=.001)
        result = self.apply(before)
        self.assertTrue(result["verified"])
        self.assertEqual(result["verificationScope"], "sampled_steps")
        self.assertEqual(len(result["samples"]), 6)
        self.assertEqual([x["displayValue"] for x in result["samples"][:3]], ["200.0 Hz"] * 3)
        self.assertEqual([x["displayValue"] for x in result["samples"][3:]], ["2.00 kHz"] * 3)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_left_continuous_native_boundaries_are_reported_separately_from_step_interiors(self):
        original = self.parameter.value

        class NativeBoundaryEnvelope(AutomationEnvelope):
            def value_at_time(self, time):
                value = original
                for start, _, step_value in self.steps:
                    if start < time:
                        value = step_value
                return value

        def create(parameter):
            envelope = NativeBoundaryEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            return envelope

        self.clip.create_automation_envelope = create
        result = self.apply()
        self.assertTrue(result["verified"])
        self.assertEqual(result["boundarySamples"][0]["value"], .4)
        self.assertEqual(result["samples"][0]["displayValue"], "200.0 Hz")

    def test_an_existing_or_newly_inserted_envelope_is_never_cleared(self):
        before = self.source()
        envelope = self.clip.create_automation_envelope(self.parameter)
        envelope.insert_step(0, 4, .9)
        with self.assertRaisesRegex(ValueError, "existing envelope"):
            self.apply(before)
        self.assertIs(self.clip.automation_envelope(self.parameter), envelope)
        self.assertEqual(envelope.value_at_time(0), .9)

    def test_clip_edits_mode_changes_and_native_replacements_invalidate_the_plan(self):
        changes = [lambda: setattr(self.clip, "loop_end", 3),
                   lambda: setattr(self.song.tracks[0].devices[0].parameters[1], "value", .6),
                   lambda: self.song.tracks[0].clip_slots[0].__setattr__("clip", copy.deepcopy(self.clip)),
                   lambda: self.song.tracks[0].devices[0].parameters.__setitem__(0, Frequency())]
        for change in changes:
            self.setUp()
            before = self.source()
            change()
            with self.assertRaises(ValueError):
                self.apply(before)
            self.assertIsNone(self.clip.automation_envelope(self.parameter))

    def test_invalid_steps_and_unsupported_readiness_are_refused_without_creating_a_lane(self):
        for points in [[], [{"time": 0, "duration": 0, "value": .5}], [{"time": 3, "duration": 2, "value": .5}],
                       [{"time": 0, "duration": 3, "value": .2}, {"time": 2, "duration": 2, "value": .8}],
                       [{"time": 0, "duration": 4, "value": 2}], [{"time": 0, "duration": 4, "value": .2, "targetDisplay": "2 kHz"}]]:
            self.setUp()
            self.args["points"] = points
            with self.assertRaises(ValueError):
                self.source()
        for obj, field, value in [("song", "is_playing", True), ("song", "record_mode", True),
                                   ("song", "session_record", True), ("clip", "is_recording", True),
                                   ("clip", "is_triggered", True), ("parameter", "automation_state", 1),
                                   ("parameter", "automation_state", None), ("parameter", "is_enabled", False)]:
            self.setUp()
            setattr(getattr(self, obj), field, value)
            with self.assertRaises(ValueError):
                self.source()
        self.setUp()
        self.song.tracks[0].is_frozen = True
        with self.assertRaises(ValueError):
            self.source()

    def test_raw_quantized_steps_require_exact_choices_without_clamping(self):
        parameter = QuantizedParameter()
        parameter.automation_state = 0
        self.song.tracks[0].devices[0].parameters[0] = parameter
        self.args["points"] = [{"time": 0, "duration": 2, "value": 0}, {"time": 2, "duration": 2, "value": 2}]
        self.assertTrue(self.apply()["verified"])
        self.setUp()
        self.song.tracks[0].devices[0].parameters[0] = parameter
        self.args["points"] = [{"time": 0, "duration": 4, "value": .5}]
        with self.assertRaises(ValueError):
            self.source()

    def test_failed_step_readback_removes_only_the_new_owned_envelope(self):
        unrelated = self.clip.create_automation_envelope(self.song.tracks[0].devices[0].parameters[1])
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
        self.assertIsNone(self.clip.automation_envelope(self.parameter))
        self.assertIs(self.clip.automation_envelope(self.song.tracks[0].devices[0].parameters[1]), unrelated)
        self.assertEqual(unrelated.value_at_time(0), .7)

    def test_parameter_replaced_during_creation_is_not_verified_or_written(self):
        device = self.song.tracks[0].devices[0]

        def create(parameter):
            envelope = AutomationEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            device.parameters[0] = Frequency()
            return envelope

        self.clip.create_automation_envelope = create
        with self.assertRaisesRegex(RuntimeError, "ownership is unconfirmed"):
            self.apply()
        self.assertIsNone(self.clip.automation_envelope(device.parameters[0]))
        self.assertEqual(self.clip.automation_envelope(self.parameter).steps, [])

    def test_cleanup_does_not_restore_a_replaced_native_parameter(self):
        device = self.song.tracks[0].devices[0]

        class WrongEnvelope(AutomationEnvelope):
            def value_at_time(self, time):
                return .9

        def create(parameter):
            envelope = WrongEnvelope()
            self.clip.envelopes[id(parameter)] = envelope
            parameter.value = .7
            return envelope

        def clear(parameter):
            self.clip.envelopes.pop(id(parameter))
            device.parameters[0] = Frequency()

        self.clip.create_automation_envelope, self.clip.clear_envelope = create, clear
        with self.assertRaisesRegex(RuntimeError, "cleanup failed.*topology"):
            self.apply()
        self.assertEqual(self.parameter.value, .7)
        self.assertEqual(device.parameters[0].value, .4)
