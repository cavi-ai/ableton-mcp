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
        self.mute = False
        self.solo = False
        self.arm = False
        self.mixer_device = type("Mixer", (), {
            "volume": type("Value", (), {"value": 0.75, "min": 0.0, "max": 1.0})(),
            "panning": type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})()
        })()


class Clip:
    def __init__(self):
        self.name = "Loop"
        self.is_playing = False

    def fire(self):
        self.is_playing = True

    def stop(self):
        self.is_playing = False


class ClipSlot:
    def __init__(self):
        self.has_clip = True
        self.clip = Clip()

    def fire(self):
        self.clip.fire()

    def stop(self):
        self.clip.stop()


class Scene:
    def __init__(self):
        self.name = "Verse"
        self.is_triggered = False

    def fire(self):
        self.is_triggered = True


class Song:
    def __init__(self):
        self.tracks = [Track()]
        self.scenes = [Scene()]
        self.tracks[0].clip_slots = [ClipSlot()]
        self.tempo = 120.0
        self.is_playing = False

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False


class DispatchTest(unittest.TestCase):
    def test_status_and_parameter_write_return_observed_state(self):
        song = Song()
        status = dispatch_request(song, {"method": "get_live_state", "params": {}}, 4)
        self.assertEqual(status["stateVersion"], 4)
        self.assertEqual(status["bridgeVersion"], "0.1.0")
        self.assertIn("list_scenes", status["capabilities"])
        result = dispatch_request(song, {
            "method": "set_device_parameters",
            "params": {"trackId": "track-0", "deviceId": "track-0:device-0", "changes": [{"id": "parameter-0", "value": 0.8}]}
        }, 4)
        self.assertEqual(result["observedChanges"][0]["value"], 0.8)
        self.assertEqual(song.tracks[0].devices[0].parameters[0].value, 0.8)

    def test_core_production_controls_return_observed_state(self):
        song = Song()
        self.assertEqual(dispatch_request(song, {"method": "list_scenes"}, 1)["scenes"][0]["name"], "Verse")
        self.assertEqual(dispatch_request(song, {"method": "list_clips", "params": {"trackId": "track-0"}}, 1)["clips"][0]["name"], "Loop")
        dispatch_request(song, {"method": "transport_play"}, 1)
        self.assertTrue(song.is_playing)
        dispatch_request(song, {"method": "set_tempo", "params": {"tempo": 128}}, 2)
        self.assertEqual(song.tempo, 128)
        dispatch_request(song, {"method": "set_track_mixer", "params": {"trackId": "track-0", "volume": 0.5, "pan": -0.25, "mute": True}}, 3)
        self.assertEqual(song.tracks[0].mixer_device.volume.value, 0.5)
        self.assertTrue(song.tracks[0].mute)
        dispatch_request(song, {"method": "launch_scene", "params": {"sceneId": "scene-0"}}, 4)
        self.assertTrue(song.scenes[0].is_triggered)
        dispatch_request(song, {"method": "launch_clip", "params": {"trackId": "track-0", "clipId": "track-0:clip-0"}}, 5)
        self.assertTrue(song.tracks[0].clip_slots[0].clip.is_playing)
        dispatch_request(song, {"method": "arm_track", "params": {"trackId": "track-0", "armed": True}}, 6)
        self.assertTrue(song.tracks[0].arm)


if __name__ == "__main__":
    unittest.main()
