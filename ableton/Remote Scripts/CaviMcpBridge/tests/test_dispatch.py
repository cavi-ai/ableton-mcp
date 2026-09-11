import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request


class Parameter:
    def __init__(self):
        self.name = "Cutoff"
        self.original_name = "Filter Freq"
        self.min = 0.0
        self.max = 1.0
        self.value = 0.4
        self.is_enabled = True
        self.is_quantized = False
        self.value_items = ()

    def str_for_value(self, value):
        return f"{value * 1000:.0f} Hz"


class QuantizedParameter:
    def __init__(self):
        self.name = "Filter Type"
        self.original_name = "Filter Type"
        self.min = 0.0
        self.max = 2.0
        self.value = 1.0
        self.is_enabled = True
        self.is_quantized = True
        self.value_items = ("Low-pass", "Band-pass", "High-pass")

    def str_for_value(self, value):
        return self.value_items[int(value)]


class Device:
    def __init__(self):
        self.name = "Serum 2"
        self.parameters = [Parameter(), QuantizedParameter()]


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
        self.length = 4.0
        self.envelopes = {}

    def fire(self):
        self.is_playing = True

    def stop(self):
        self.is_playing = False

    def set_notes(self, notes):
        self.notes = notes

    def get_notes(self, start, pitch, duration, pitch_span):
        return getattr(self, "notes", ())

    def automation_envelope(self, parameter):
        return self.envelopes.get(id(parameter))

    def create_automation_envelope(self, parameter):
        envelope = AutomationEnvelope()
        self.envelopes[id(parameter)] = envelope
        return envelope

    def clear_envelope(self, parameter):
        self.envelopes.pop(id(parameter), None)


class AutomationEnvelope:
    def __init__(self):
        self.steps = []

    def insert_step(self, time, duration, value):
        self.steps.append((time, duration, value))

    def value_at_time(self, time):
        value = 0.0
        for step_time, _, step_value in self.steps:
            if step_time <= time:
                value = step_value
        return value


class ClipSlot:
    def __init__(self, has_clip=True):
        self.has_clip = has_clip
        self.clip = Clip() if has_clip else None

    def create_clip(self, length):
        if self.has_clip:
            raise RuntimeError("occupied")
        self.has_clip = True
        self.clip = Clip()
        self.clip.length = length

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
        self.tracks[0].clip_slots = [ClipSlot(), ClipSlot(False)]
        self.tempo = 120.0
        self.is_playing = False

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False


class DispatchTest(unittest.TestCase):
    def test_parameter_listing_exposes_agent_usable_plugin_metadata(self):
        result = dispatch_request(Song(), {
            "method": "list_device_parameters",
            "params": {"trackId": "track-0", "deviceId": "track-0:device-0"}
        }, 3)

        self.assertEqual(result["parameters"], [
            {
                "id": "parameter-0", "name": "Cutoff", "originalName": "Filter Freq",
                "min": 0.0, "max": 1.0, "value": 0.4, "displayValue": "400 Hz",
                "enabled": True, "quantized": False, "valueItems": []
            },
            {
                "id": "parameter-1", "name": "Filter Type", "originalName": "Filter Type",
                "min": 0.0, "max": 2.0, "value": 1.0, "displayValue": "Band-pass",
                "enabled": True, "quantized": True,
                "valueItems": ["Low-pass", "Band-pass", "High-pass"]
            }
        ])

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
        self.assertEqual(result["observedChanges"], [{
            "id": "parameter-0", "name": "Cutoff", "originalName": "Filter Freq",
            "min": 0.0, "max": 1.0, "value": 0.8, "displayValue": "800 Hz",
            "enabled": True, "quantized": False, "valueItems": []
        }])
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

    def test_create_midi_clip_writes_notes_and_returns_observed_clip(self):
        song = Song()
        result = dispatch_request(song, {
            "method": "create_midi_clip",
            "params": {
                "trackId": "track-0", "clipId": "track-0:clip-1",
                "lengthBeats": 4, "name": "Agent Pattern",
                "notes": [{"pitch": 60, "start": 0, "duration": 1, "velocity": 100, "mute": False}]
            }
        }, 3)
        clip = song.tracks[0].clip_slots[1].clip
        self.assertEqual(clip.notes, ((60, 0.0, 1.0, 100, False),))
        self.assertEqual(result["clip"]["name"], "Agent Pattern")
        self.assertEqual(result["clip"]["noteCount"], 1)

    def test_create_midi_clip_refuses_to_overwrite(self):
        with self.assertRaisesRegex(ValueError, "already contains"):
            dispatch_request(Song(), {
                "method": "create_midi_clip",
                "params": {"trackId": "track-0", "clipId": "track-0:clip-0", "lengthBeats": 4, "notes": []}
            }, 3)

    def test_get_midi_clip_notes_returns_normalized_notes(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.length = 4.0
        clip.notes = ((60, 0.0, 1.0, 100, False), (64, 1.0, 0.5, 90, True))
        result = dispatch_request(song, {
            "method": "get_midi_clip_notes",
            "params": {"trackId": "track-0", "clipId": "track-0:clip-0"}
        }, 3)
        self.assertEqual(result["lengthBeats"], 4.0)
        self.assertEqual(result["notes"], [
            {"pitch": 60, "start": 0.0, "duration": 1.0, "velocity": 100, "mute": False},
            {"pitch": 64, "start": 1.0, "duration": 0.5, "velocity": 90, "mute": True},
        ])

    def test_clip_parameter_envelope_can_be_sampled_and_replaced(self):
        song = Song()
        params = {
            "trackId": "track-0", "clipId": "track-0:clip-0",
            "deviceId": "track-0:device-0", "parameterId": "parameter-0"
        }
        missing = dispatch_request(song, {
            "method": "get_clip_parameter_envelope",
            "params": {**params, "sampleTimes": [0.0, 2.0]}
        }, 3)
        self.assertFalse(missing["exists"])

        written = dispatch_request(song, {
            "method": "set_clip_parameter_envelope",
            "params": {**params, "points": [
                {"time": 0.0, "duration": 1.0, "value": 0.2},
                {"time": 2.0, "duration": 0.5, "value": 0.8},
            ]}
        }, 3)
        self.assertTrue(written["replaced"])
        self.assertEqual(written["samples"], [
            {"time": 0.0, "value": 0.2},
            {"time": 2.0, "value": 0.8},
        ])


if __name__ == "__main__":
    unittest.main()
