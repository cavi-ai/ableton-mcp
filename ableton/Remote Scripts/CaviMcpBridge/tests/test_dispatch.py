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
        self.class_name = "PluginDevice"
        self.class_display_name = "Plug-in"
        self.type = 1
        self.can_have_chains = False
        self.can_have_drum_pads = False
        self.parameters = [Parameter(), QuantizedParameter()]


class NestedDevice(Device):
    def __init__(self, name, class_name, device_type=1):
        super().__init__()
        self.name = name
        self.class_name = class_name
        self.class_display_name = name
        self.type = device_type


class Chain:
    def __init__(self, name, devices):
        self.name = name
        self.devices = devices


class DrumPad:
    def __init__(self, note, name, chains):
        self.note = note
        self.name = name
        self.mute = False
        self.solo = False
        self.chains = chains


class DrumRack(NestedDevice):
    def __init__(self):
        super().__init__("Drum Rack", "InstrumentGroupDevice")
        self.can_have_chains = True
        self.can_have_drum_pads = True
        kick = Chain("Kick", [NestedDevice("Kick", "OriginalSimpler")])
        self.chains = [kick]
        self.drum_pads = [DrumPad(36, "Kick", [kick]), DrumPad(37, "Empty", [])]


class Track:
    def __init__(self):
        self.name = "Synth"
        self.devices = [Device()]
        self.mute = False
        self.solo = False
        self.arm = False
        self.mixer_device = type("Mixer", (), {
            "volume": type("Value", (), {"value": 0.75, "min": 0.0, "max": 1.0})(),
            "panning": type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})(),
            "sends": [type("Value", (), {"value": 0.2, "min": 0.0, "max": 1.0})()]
        })()


class Clip:
    def __init__(self):
        self.name = "Loop"
        self.is_playing = False
        self.length = 4.0
        self.looping = True
        self.loop_start = 0.0
        self.loop_end = 4.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.launch_quantization = 0
        self.groove = None
        self.envelopes = {}

    def fire(self):
        self.is_playing = True

    def stop(self):
        self.is_playing = False

    def set_notes(self, notes):
        self.notes = notes

    def get_notes(self, start, pitch, duration, pitch_span):
        return getattr(self, "notes", ())

    def get_all_notes_extended(self):
        return getattr(self, "extended_notes", [])

    def get_notes_by_id(self, note_ids):
        return [note for note in self.extended_notes if note.note_id in note_ids]

    def apply_note_modifications(self, notes):
        if not notes:
            raise AssertionError("Live rejects an empty apply_note_modifications call")
        self.extended_notes = list(notes)

    def add_new_notes(self, notes):
        self.added_notes = list(notes)
        first_id = 100 + sum(note.note_id >= 100 for note in self.extended_notes)
        added_ids = tuple(range(first_id, first_id + len(notes)))
        for note_id, spec in zip(added_ids, notes):
            note = MidiNote(note_id)
            note.pitch = spec["pitch"]
            note.start_time = spec["start"]
            note.duration = spec["duration"]
            self.extended_notes.append(note)
        return added_ids

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


class MidiNote:
    def __init__(self, note_id=7):
        self.note_id = note_id
        self.pitch = 60
        self.start_time = 0.0
        self.duration = 1.0
        self.velocity = 100
        self.velocity_deviation = 0
        self.release_velocity = 64
        self.probability = 1.0
        self.mute = False


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
        self.return_tracks = [type("ReturnTrack", (), {"name": "Reverb"})()]
        self.scenes = [Scene()]
        self.tracks[0].clip_slots = [ClipSlot(), ClipSlot(False)]
        self.tempo = 120.0
        self.is_playing = False
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.root_note = 0
        self.scale_name = "Major"
        self.scale_mode = True
        self.scale_intervals = (0, 2, 4, 5, 7, 9, 11)
        self.clip_trigger_quantization = 4
        self.midi_recording_quantization = 5
        self.groove_amount = 1.0
        self.swing_amount = 0.0
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 8.0
        self.groove_pool = type("GroovePool", (), {"grooves": [type("Groove", (), {
            "name": "Swing 16-65", "base": 3, "timing_amount": 1.0,
            "quantization_amount": 1.0, "random_amount": 0.0,
        })()]})()

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False


class DispatchTest(unittest.TestCase):
    def test_song_musical_context_reads_and_writes_timing_key_groove_and_loop(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_song_musical_context"}, 3)
        self.assertEqual(observed["timeSignature"], {"numerator": 4, "denominator": 4})
        self.assertEqual(observed["key"], {
            "rootNote": 0, "rootName": "C", "scaleName": "Major", "scaleMode": True,
            "scaleIntervals": [0, 2, 4, 5, 7, 9, 11],
        })
        self.assertEqual(observed["quantization"]["clipTrigger"]["value"], 4)
        self.assertEqual(observed["quantization"]["clipTrigger"]["name"], "1_bar")
        self.assertIn({"value": 7, "name": "1_4"}, observed["quantization"]["clipTrigger"]["choices"])
        self.assertEqual(observed["quantization"]["midiRecording"]["value"], 5)
        self.assertEqual(observed["quantization"]["midiRecording"]["name"], "1_16")
        self.assertEqual(observed["groove"]["pool"][0]["id"], "groove-0")
        self.assertEqual(observed["loop"], {"enabled": False, "startBeats": 0.0, "lengthBeats": 8.0})

        changed = dispatch_request(song, {"method": "set_song_musical_context", "params": {"changes": {
            "timeSignature": {"numerator": 7, "denominator": 8},
            "key": {"rootNote": 2, "scaleName": "Dorian", "scaleMode": True},
            "quantization": {"clipTrigger": 7, "midiRecording": 2},
            "groove": {"amount": 0.75, "swingAmount": 0.2},
            "loop": {"enabled": True, "startBeats": 4.0, "lengthBeats": 12.0},
        }}}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(song.signature_numerator, 7)
        self.assertEqual(song.root_note, 2)
        self.assertEqual(song.clip_trigger_quantization, 7)
        self.assertEqual(song.groove_amount, 0.75)
        self.assertTrue(song.loop)
        self.assertEqual(song.loop_length, 12.0)

    def test_clip_timing_reads_and_writes_loop_signature_quantization_and_groove(self):
        song = Song()
        params = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        observed = dispatch_request(song, {"method": "get_clip_timing", "params": params}, 3)
        self.assertEqual(observed["loop"], {"enabled": True, "startBeats": 0.0, "endBeats": 4.0})
        self.assertEqual(observed["timeSignature"], {"numerator": 4, "denominator": 4})
        self.assertEqual(observed["launchQuantization"]["value"], 0)
        self.assertEqual(observed["launchQuantization"]["name"], "global")
        self.assertIn({"value": 12, "name": "1_16"}, observed["launchQuantization"]["choices"])
        self.assertIsNone(observed["grooveId"])

        changed = dispatch_request(song, {"method": "set_clip_timing", "params": {**params, "changes": {
            "loop": {"enabled": True, "startBeats": 1.0, "endBeats": 5.0},
            "timeSignature": {"numerator": 3, "denominator": 4},
            "launchQuantization": 12, "grooveId": "groove-0",
        }}}, 3)
        clip = song.tracks[0].clip_slots[0].clip
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual((clip.loop_start, clip.loop_end), (1.0, 5.0))
        self.assertEqual(clip.signature_numerator, 3)
        self.assertIs(clip.groove, song.groove_pool.grooves[0])

    def test_device_hierarchy_exposes_nested_chain_devices_and_loaded_drum_pads(self):
        song = Song()
        song.tracks[0].devices = [DrumRack()]
        result = dispatch_request(song, {
            "method": "get_device_hierarchy",
            "params": {"trackId": "track-0", "deviceId": "track-0:device-0"}
        }, 3)

        rack = result["device"]
        self.assertEqual(rack["className"], "InstrumentGroupDevice")
        self.assertEqual(rack["chains"][0]["id"], "track-0:device-0/chain-0")
        self.assertEqual(rack["chains"][0]["devices"][0]["id"], "track-0:device-0/chain-0/device-0")
        self.assertEqual(rack["chains"][0]["devices"][0]["className"], "OriginalSimpler")
        self.assertEqual(rack["drumPads"], [{
            "note": 36, "name": "Kick", "mute": False, "solo": False,
            "chainIds": ["track-0:device-0/chain-0"]
        }])

    def test_device_listing_exposes_stable_identity_and_structure(self):
        result = dispatch_request(Song(), {
            "method": "list_devices", "params": {"trackId": "track-0"}
        }, 3)

        self.assertEqual(result["devices"][0], {
            "id": "track-0:device-0", "name": "Serum 2", "className": "PluginDevice",
            "classDisplayName": "Plug-in", "type": "instrument",
            "canHaveChains": False, "canHaveDrumPads": False,
        })

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

    def test_track_mixer_read_and_write_include_named_return_sends(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_track_mixer", "params": {"trackId": "track-0"}}, 3)
        self.assertEqual(observed["sends"][0], {
            "id": "send-0", "returnTrackId": "return-0", "name": "Reverb",
            "value": 0.2, "min": 0.0, "max": 1.0,
        })
        changed = dispatch_request(song, {"method": "set_track_mixer", "params": {
            "trackId": "track-0", "changes": {
                "volume": {"value": 0.5}, "mute": {"value": True},
                "sends": [{"id": "send-0", "value": 0.8}],
            }
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(changed["volume"], 0.5)
        self.assertEqual(changed["sends"][0]["value"], 0.8)

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

    def test_extended_notes_can_be_read_and_modified_by_stable_id(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote()]
        params = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        observed = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": params}, 3)
        self.assertEqual(observed["notes"][0]["noteId"], 7)
        self.assertEqual(observed["notes"][0]["releaseVelocity"], 64)
        changed = dispatch_request(song, {"method": "set_midi_note_properties", "params": {
            **params, "changes": [{"noteId": 7, "probability": 0.25, "releaseVelocity": 92,
                                    "velocityDeviation": -12}]
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(clip.extended_notes[0].probability, 0.25)
        self.assertEqual(changed["notes"][0]["velocityDeviation"], -12)

    def test_transform_midi_notes_updates_existing_notes_and_adds_duplicates(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote()]
        params = {"trackId": "track-0", "clipId": "track-0:clip-0"}

        changed = dispatch_request(song, {"method": "transform_midi_notes", "params": {
            **params,
            "changes": [{"noteId": 7, "start": 0.25, "duration": 0.75}],
            "newNotes": [{"sourceNoteId": 7, "pitch": 60, "start": 2.0, "duration": 0.75,
                          "velocity": 100, "velocityDeviation": 0, "releaseVelocity": 64,
                          "probability": 1.0, "mute": False}]
        }}, 3)

        self.assertEqual(clip.extended_notes[0].start_time, 0.25)
        self.assertEqual(clip.extended_notes[0].duration, 0.75)
        self.assertEqual(changed["addedNoteIds"], [100])
        self.assertEqual(changed["stateVersion"], 4)

        duplicate_only = dispatch_request(song, {"method": "transform_midi_notes", "params": {
            **params, "changes": [],
            "newNotes": [{"sourceNoteId": 7, "pitch": 60, "start": 3.0, "duration": 0.5,
                          "velocity": 100, "velocityDeviation": 0, "releaseVelocity": 64,
                          "probability": 1.0, "mute": False}]
        }}, 4)
        self.assertEqual(duplicate_only["addedNoteIds"], [101])
        self.assertEqual([note["noteId"] for note in duplicate_only["notes"]], [7, 100, 101])

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
