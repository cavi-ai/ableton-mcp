import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request


class Parameter:
    def __init__(self):
        self.name = "Cutoff"
        self.min = 0.0
        self.max = 1.0
        self.value = 0.4
        self.is_enabled = True


class Device:
    def __init__(self):
        self.name = "Serum 2"
        self.parameters = [Parameter()]


class Track:
    def __init__(self):
        self.name = "Synth"
        self.devices = [Device()]


class Song:
    def __init__(self):
        self.tracks = [Track()]
        self.tempo = 120.0
        self.is_playing = False

    def stop_playing(self):
        self.is_playing = False


class DispatchTest(unittest.TestCase):
    def test_status_and_parameter_write_return_observed_state(self):
        song = Song()
        status = dispatch_request(song, {"method": "get_live_state", "params": {}}, 4)
        self.assertEqual(status["stateVersion"], 4)
        result = dispatch_request(song, {
            "method": "set_device_parameters",
            "params": {"trackId": "track-0", "deviceId": "track-0:device-0", "changes": [{"id": "parameter-0", "value": 0.8}]}
        }, 4)
        self.assertEqual(result["observedChanges"][0]["value"], 0.8)
        self.assertEqual(song.tracks[0].devices[0].parameters[0].value, 0.8)


if __name__ == "__main__":
    unittest.main()
