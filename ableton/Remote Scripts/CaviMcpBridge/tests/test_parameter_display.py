import copy
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Parameter


class Frequency(Parameter):
    automation_state = 0

    def str_for_value(self, value):
        hz = 20 * 1000 ** value
        return f"{hz / 1000:.2f} kHz" if hz >= 1000 else f"{hz:.1f} Hz"


class ParameterDisplayTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.parameter = Frequency()
        self.song.tracks[0].devices[0].parameters = [self.parameter, Frequency()]
        self.args = {"trackId": "track-0", "deviceId": "track-0:device-0",
                     "parameterId": "parameter-0", "targetDisplay": "2 kHz"}

    def source(self):
        return dispatch_request(self.song, {"method": "get_device_parameter_display_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "set_device_parameter_display", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def test_nonlinear_frequency_resolution_is_inert_and_changes_only_one_control(self):
        before = self.source()
        self.assertEqual(self.parameter.value, .4)
        self.assertEqual(before["target"]["quantity"], {"value": 2000, "unit": "Hz"})
        self.assertAlmostEqual(before["target"]["value"], 2 / 3, delta=.001)
        result = self.apply(before)
        self.assertTrue(result["verified"])
        self.assertEqual(result["parameter"]["displayValue"], "2.00 kHz")
        self.assertEqual(self.song.tracks[0].devices[0].parameters[1].value, .4)
        self.assertEqual(result["dependentChanges"], [])
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_time_db_percent_and_decreasing_native_displays_use_observed_units(self):
        cases = [(lambda v: f"{.1 + v * 9.9:.2f} s", "2000 ms", "2.00 s"),
                 (lambda v: "-inf dB" if v == 0 else f"{-60 + 60 * math.sqrt(v):.1f} dB", "-12 dB", "-12.0 dB"),
                 (lambda v: f"{100 - v * 100:.1f} %", "25 %", "25.0 %")]
        for formatter, target, observed in cases:
            self.setUp()
            self.parameter.str_for_value = formatter
            self.args["targetDisplay"] = target
            self.assertEqual(self.apply()["parameter"]["displayValue"], observed)

    def test_unrepresentable_incompatible_or_ambiguous_scales_never_move_the_parameter(self):
        for target in ["2000 ms", "20001 Hz", "2", "NaN Hz", "-inf dB", "2 MHz", "1,000 Hz", "100.05 Hz"]:
            self.setUp()
            self.args["targetDisplay"] = target
            with self.assertRaises(ValueError):
                self.source()
            self.assertEqual(self.parameter.value, .4)
        for formatter in [lambda v: "Sync", lambda v: f"{math.sin(v * math.pi) * 1000:.0f} Hz",
                          lambda v: "100 ms" if v < .5 else "200 Hz"]:
            self.setUp()
            self.parameter.str_for_value = formatter
            with self.assertRaises(ValueError):
                self.source()

    def test_same_version_target_replacement_mode_changes_and_recording_invalidate_plans(self):
        changes = [lambda s: setattr(self.parameter, "value", .5),
                   lambda s: setattr(s.tracks[0].devices[0].parameters[1], "value", .6),
                   lambda s: s.tracks[0].devices[0].parameters.__setitem__(0, Frequency()),
                   lambda s: s.tracks[0].devices.__setitem__(0, copy.deepcopy(s.tracks[0].devices[0])),
                   lambda s: s.tracks.__setitem__(0, copy.deepcopy(s.tracks[0])),
                   lambda s: setattr(self.parameter, "automation_state", 1),
                   lambda s: setattr(s, "session_record", True)]
        for change in changes:
            self.setUp()
            before = self.source()
            change(self.song)
            with self.assertRaises(ValueError):
                self.apply(before)

    def test_unsupported_ownership_and_identifiers_are_refused(self):
        for key, value in [("is_enabled", False), ("is_quantized", True), ("automation_state", None),
                           ("automation_state", 1), ("automation_state", 2), ("automation_state", 9)]:
            self.setUp()
            setattr(self.parameter, key, value)
            with self.assertRaises(ValueError):
                self.source()
        for key, value in [("parameterId", "parameter-00"), ("parameterId", "parameter-2"),
                           ("deviceId", "track-0:device-00"), ("trackId", "track-00")]:
            self.setUp()
            self.args[key] = value
            with self.assertRaises(ValueError):
                self.source()
        self.setUp()
        self.song.tracks[0].is_frozen = True
        with self.assertRaises(ValueError):
            self.source()
        self.setUp()
        self.song.record_mode = True
        with self.assertRaises(ValueError):
            self.source()

    def test_failed_readback_restores_only_the_target(self):
        class Rejecting(Frequency):
            _value = .4

            @property
            def value(self):
                return self._value

            @value.setter
            def value(self, value):
                self._value = value if value == .4 else .9

        self.parameter = Rejecting()
        self.song.tracks[0].devices[0].parameters[0] = self.parameter
        with self.assertRaisesRegex(RuntimeError, "readback"):
            self.apply()
        self.assertEqual(self.parameter.value, .4)
        self.assertEqual(self.song.tracks[0].devices[0].parameters[1].value, .4)

    def test_native_dependent_control_changes_are_reported(self):
        sibling = self.song.tracks[0].devices[0].parameters[1]

        class Coupled(Frequency):
            _value = .4

            @property
            def value(self):
                return self._value

            @value.setter
            def value(self, value):
                self._value = value
                sibling.value = .6

        self.parameter = Coupled()
        self.song.tracks[0].devices[0].parameters[0] = self.parameter
        sibling.value = .4
        result = self.apply()
        self.assertEqual(len(result["dependentChanges"]), 1)
        change = result["dependentChanges"][0]
        self.assertEqual(change["before"]["id"], "parameter-1")
        self.assertEqual(change["before"]["value"], .4)
        self.assertEqual(change["after"]["value"], .6)

    def test_return_and_main_owners_resolve_the_same_native_parameter(self):
        for owner, track in [("return-0", self.song.return_tracks[0]), ("master", self.song.master_track)]:
            track.devices = [copy.deepcopy(self.song.tracks[0].devices[0])]
            track.name = owner
            track.devices[0].parameters = [Frequency()]
            self.args.update(trackId=owner, deviceId=f"{owner}:device-0")
            self.assertTrue(self.apply()["verified"])

    def test_native_replacement_or_removed_controls_cannot_produce_verified_receipts(self):
        for replace in (True, False):
            self.setUp()
            device = self.song.tracks[0].devices[0]

            class ChangingTopology(Frequency):
                _value = .4

                @property
                def value(self):
                    return self._value

                @value.setter
                def value(self, value):
                    self._value = value
                    if value != .4:
                        if replace:
                            device.parameters[0] = Frequency()
                        else:
                            device.parameters.pop()

            self.parameter = ChangingTopology()
            device.parameters[0] = self.parameter
            with self.assertRaisesRegex(RuntimeError, "topology changed.*inspect"):
                self.apply()
            if replace:
                self.assertEqual(device.parameters[0].value, .4)
            else:
                self.assertEqual(len(device.parameters), 1)
