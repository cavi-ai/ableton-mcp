import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class ParameterAutomationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.params = self.song.tracks[0].devices[0].parameters
        self.target = {"trackId": "track-0", "deviceId": "track-0:device-0"}

    def call(self, method, extra=None):
        return dispatch_request(self.song, {"method": method, "params": {**self.target, **(extra or {})}}, 4)

    def test_reports_automation_ownership_without_changing_controls(self):
        for state, name in [(0, "none"), (1, "playing"), (2, "overridden"), (9, "unknown")]:
            self.params[0].automation_state = state
            row = self.call("list_device_parameters")["parameters"][0]
            self.assertEqual(row["automationState"], {"value": state, "name": name})
            self.assertEqual(self.params[0].value, 0.4)
        del self.params[0].automation_state
        self.assertIsNone(self.call("list_device_parameters")["parameters"][0]["automationState"])

    def test_changed_automation_refuses_whole_batch_even_when_values_and_version_match(self):
        for parameter in self.params:
            parameter.automation_state = 0
        changes = [{"id": "parameter-0", "value": 0.6, "previousAutomationState": {"value": 0, "name": "none"}},
                   {"id": "parameter-1", "value": 2, "previousAutomationState": {"value": 0, "name": "none"}}]
        self.params[1].automation_state = 1
        with self.assertRaisesRegex(ValueError, "automation state changed"):
            self.call("set_device_parameters", {"expectedStateVersion": 4, "changes": changes})
        self.assertEqual(self.params[0].value, 0.4)
        self.assertEqual(self.params[1].value, 1)

    def test_guarded_write_can_report_an_intentionally_overridden_parameter(self):
        self.params[0].automation_state = 2
        result = self.call("set_device_parameters", {"expectedStateVersion": 4, "changes": [{
            "id": "parameter-0", "value": 0.6, "previousAutomationState": {"value": 2, "name": "overridden"}}]})
        self.assertEqual(result["observedChanges"][0]["automationState"]["value"], 2)

    def test_replaced_device_with_identical_parameters_invalidates_edit_identity(self):
        before = self.call("get_device_parameter_edit_context")
        self.song.tracks[0].devices[0] = copy.deepcopy(self.song.tracks[0].devices[0])
        with self.assertRaisesRegex(ValueError, "device edit context changed"):
            self.call("set_device_parameters", {"expectedStateVersion": 4, "beforeEditContext": before.get("editContext"),
                "changes": [{"id": "parameter-0", "value": 0.6}]})
        self.assertEqual(self.song.tracks[0].devices[0].parameters[0].value, 0.4)
        before = self.call("get_device_parameter_edit_context")
        self.song = copy.deepcopy(self.song)
        with self.assertRaisesRegex(ValueError, "device edit context changed"):
            self.call("set_device_parameters", {"beforeEditContext": before["editContext"],
                "changes": [{"id": "parameter-0", "value": 0.6}]})


if __name__ == "__main__":
    unittest.main()
