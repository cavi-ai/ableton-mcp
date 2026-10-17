import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class ReturnRoutingReadTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.bus = self.song.return_tracks[0]
        route = lambda key, name: type("Route", (), {"identifier": key, "display_name": name})()
        self.bus.available_output_routing_types = [route("main", "Main"), route("external", "Ext. Out")]
        self.bus.available_output_routing_channels = [route("stereo", "1/2")]
        self.bus.current_output_routing = self.bus.available_output_routing_types[0]
        self.bus.current_output_sub_routing = self.bus.available_output_routing_channels[0]

    def read(self, target="return-0"):
        return dispatch_request(self.song, {"method": "get_return_routing", "params": {"returnTrackId": target}}, 8)

    def test_exact_return_output_choices_are_read_without_input_or_monitoring_assumptions(self):
        result = self.read()
        self.assertEqual(result["stateVersion"], 8)
        self.assertEqual(result["returnTrackId"], "return-0")
        self.assertEqual(result["name"], self.bus.name)
        self.assertEqual(result["output"]["type"], {"id": "main", "name": "Main"})
        self.assertEqual(result["output"]["channel"], {"id": "stereo", "name": "1/2"})
        self.assertEqual(len(result["output"]["availableTypes"]), 2)
        self.assertNotIn("input", result)
        self.assertNotIn("monitoring", result)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_external_destination_is_observed_without_redirecting_it(self):
        self.bus.current_output_routing = self.bus.available_output_routing_types[1]
        self.assertEqual(self.read()["output"]["type"]["id"], "external")
        self.assertIs(self.bus.current_output_routing, self.bus.available_output_routing_types[1])

    def test_invalid_unavailable_and_non_return_owners_are_refused(self):
        for target in ("track-0", "master", "return-00", "return-99", "return--1"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                self.read(target)


if __name__ == "__main__":
    unittest.main()
