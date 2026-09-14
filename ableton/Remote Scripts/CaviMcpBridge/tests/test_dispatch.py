import copy
import json
import copy
import os
import sys
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import SocketBridge, dispatch_request, _device_type


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
        self.is_active = True
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

    def insert_chain(self, index):
        self.chains.insert(index, Chain("Chain", []))


class Track:
    def __init__(self):
        self.name = "Synth"
        self.devices = [Device()]
        self.mute = False
        self.solo = False
        self.arm = False
        route = lambda identifier, name: type("Route", (), {"identifier": identifier, "display_name": name})()
        self.available_input_routing_types = [route("all-ins", "All Ins"), route("no-input", "No Input")]
        self.available_input_routing_channels = [route("all-channels", "All Channels"), route("channel-1", "Ch. 1")]
        self.available_output_routing_types = [route("main", "Main"), route("no-output", "No Output")]
        self.available_output_routing_channels = [route("post-mixer", "Post Mixer")]
        self.current_input_routing = "All Ins"
        self.current_input_sub_routing = self.available_input_routing_channels[0]
        self.current_output_routing = self.available_output_routing_types[0]
        self.current_output_sub_routing = self.available_output_routing_channels[0]
        self.current_monitoring_state = 1
        self.mixer_device = type("Mixer", (), {
            "volume": type("Value", (), {"value": 0.75, "min": 0.0, "max": 1.0})(),
            "panning": type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})(),
            "sends": [type("Value", (), {"value": 0.2, "min": 0.0, "max": 1.0})()]
        })()

    def duplicate_clip_slot(self, index):
        source = self.clip_slots[index]
        destination = self.clip_slots[index + 1]
        if not source.has_clip or destination.has_clip:
            raise RuntimeError("invalid duplicate")
        destination.has_clip = True
        destination.clip = Clip()
        destination.clip.name = source.clip.name

    def delete_device(self, index):
        self.devices.pop(index)


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

    def duplicate_loop(self):
        self.loop_end += self.loop_end - self.loop_start
        self.length = max(self.length, self.loop_end)


class AudioClip(Clip):
    def __init__(self):
        super().__init__()
        self.name = "Vocal"
        self.is_audio_clip = True
        self.gain = 0.5
        self.gain_display_string = "0.00 dB"
        self.pitch_coarse = 0
        self.pitch_fine = 0
        self.warping = True
        self.warp_mode = 0
        self.start_marker = 0.0
        self.end_marker = 8.0


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

    def duplicate_clip_to(self, target):
        if target.has_clip:
            raise RuntimeError("occupied")
        target.has_clip = True
        target.clip = copy.deepcopy(self.clip)

    def delete_clip(self):
        self.has_clip = False
        self.clip = None


class Scene:
    def __init__(self):
        self.name = "Verse"
        self.is_triggered = False

    def fire(self):
        self.is_triggered = True


class CuePoint:
    def __init__(self, name="Verse", time=16.0):
        self.name = name
        self.time = time
        self.jumped = False

    def jump(self):
        self.jumped = True


class Song:
    def __init__(self):
        self.tracks = [Track(), Track()]
        self.view = type("View", (), {"selected_track": self.tracks[0]})()
        mixer = lambda volume=0.6: type("Mixer", (), {
            "volume": type("Value", (), {"value": volume, "min": 0.0, "max": 1.0})(),
            "panning": type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})(),
        })()
        self.return_tracks = [type("ReturnTrack", (), {"name": "Reverb", "mixer_device": mixer(), "mute": False, "solo": False})()]
        master_mixer = mixer(0.8)
        master_mixer.cue_volume = type("Value", (), {"value": 0.7, "min": 0.0, "max": 1.0})()
        master_mixer.crossfader = type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})()
        self.master_track = type("MasterTrack", (), {"mixer_device": master_mixer})()
        self.master_track.current_output_sub_routing = "1/2"
        self.master_track.available_output_routing_channels = ("1/2", "3/4")
        self.scenes = [Scene(), Scene()]
        self.can_undo = True
        self.can_redo = False
        self.tracks[0].clip_slots = [ClipSlot(), ClipSlot(False)]
        self.tracks[1].clip_slots = [ClipSlot(False), ClipSlot(False)]
        audio_slot = ClipSlot()
        audio_slot.clip = AudioClip()
        self.tracks[0].clip_slots.append(audio_slot)
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
        self.current_song_time = 16.5
        self.metronome = True
        self.record_mode = False
        self.arrangement_overdub = False
        self.punch_in = True
        self.punch_out = False
        self.back_to_arranger = False
        self.session_record = False
        self.overdub = True
        self.session_automation_record = False
        self.groove_pool = type("GroovePool", (), {"grooves": [type("Groove", (), {
            "name": "Swing 16-65", "base": 3, "timing_amount": 1.0,
            "quantization_amount": 1.0, "random_amount": 0.0,
        })()]})()
        self.current_song_time = 4.0
        self.cue_points = [CuePoint()]
        self.metronome = False
        self.count_in_duration = 1

    def set_or_delete_cue(self):
        existing = next((cue for cue in self.cue_points if cue.time == self.current_song_time), None)
        if existing:
            self.cue_points.remove(existing)
        else:
            self.cue_points.append(CuePoint("", self.current_song_time))

    def create_midi_track(self, index):
        self.tracks.insert(index, Track())

    def create_audio_track(self, index):
        track = Track()
        track.name = "Audio"
        self.tracks.insert(index, track)

    def create_scene(self, index):
        self.scenes.insert(index, Scene())

    def duplicate_scene(self, index):
        scene = Scene()
        scene.name = self.scenes[index].name
        self.scenes.insert(index + 1, scene)
        for track in self.tracks:
            source = track.clip_slots[index]
            duplicate = ClipSlot(False)
            if source.has_clip:
                duplicate.has_clip = True
                duplicate.clip = Clip()
                duplicate.clip.name = source.clip.name
            track.clip_slots.insert(index + 1, duplicate)

    def duplicate_track(self, index):
        track = copy.deepcopy(self.tracks[index])
        self.tracks.insert(index + 1, track)

    def delete_track(self, index):
        self.tracks.pop(index)

    def delete_scene(self, index):
        self.scenes.pop(index)
        for track in self.tracks:
            track.clip_slots.pop(index)

    def start_playing(self):
        self.is_playing = True

    def stop_playing(self):
        self.is_playing = False

    def undo(self):
        self.can_undo = False
        self.can_redo = True

    def redo(self):
        self.can_undo = True
        self.can_redo = False


class BrowserItem:
    def __init__(self, name, uri, loadable=False, children=()):
        self.name = name
        self.uri = uri
        self.is_loadable = loadable
        self.is_folder = bool(children)
        self.children = tuple(children)


class Application:
    def __init__(self):
        self.loaded = []
        drift = BrowserItem("Drift", "query:Drift", True)
        snare = BrowserItem("Snare.wav", "query:snare", True)
        drums = BrowserItem("Drums", "query:drums", children=(snare,))
        splice = BrowserItem("Splice", "query:splice", children=(drums,))
        self.browser = type("Browser", (), {
            "instruments": BrowserItem("Instruments", "query:instruments", children=(drift,)),
            "plugins": BrowserItem("Plug-ins", "query:plugins", children=(drift,)),
            "user_library": BrowserItem("User Library", "query:user-library", children=(drift,)),
            "user_folders": BrowserItem("User Folders", "query:user-folders", children=(splice,)),
            "load_item": self.loaded.append,
        })()


class DispatchTest(unittest.TestCase):
    def test_audio_inspection_exposes_loaded_source_for_analysis(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.file_path = "/samples/vocal.wav"
        clip.sample_length = 96000
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-2"
        }}, 3)
        self.assertEqual(result["source"], {"path": "/samples/vocal.wav", "lengthSamples": 96000})

    def test_unwarped_session_duration_is_seconds_not_beats(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warping = False
        clip.looping = False
        clip.start_marker = 0.25
        clip.loop_start = 0.25
        clip.loop_end = 2.0
        clip.end_marker = 4.0
        observed = dispatch_request(song, {"method": "list_clips", "params": {"trackId": "track-0"}}, 3)
        record = observed["clips"][2]
        self.assertIsNone(record["lengthBeats"])
        self.assertEqual(record["lengthSeconds"], 1.75)
        self.assertEqual(record["durationUnit"], "seconds")
        clip.looping = True
        clip.loop_start = 0.5
        clip.loop_end = 1.25
        loop_record = dispatch_request(song, {"method": "list_clips", "params": {"trackId": "track-0"}}, 3)["clips"][2]
        self.assertEqual(loop_record["lengthSeconds"], 0.75)
        self.assertIsNone(loop_record["lengthBeats"])
        with self.assertRaisesRegex(ValueError, "tempo-map"):
            dispatch_request(song, {"method": "place_session_clip_in_arrangement", "params": {
                "trackId": "track-0", "clipId": "track-0:clip-2", "startBeats": 8
            }}, 3)

    def test_track_hierarchy_reports_group_membership_and_fold_state(self):
        song = Song()
        group, child = song.tracks
        group.name = "Bass Bus"
        group.is_foldable = True
        group.is_grouped = False
        group.group_track = None
        group.fold_state = 1
        child.name = "Sub Bass"
        child.is_foldable = False
        child.is_grouped = True
        child.group_track = group
        child.fold_state = 0

        observed = dispatch_request(song, {"method": "list_tracks"}, 3)

        self.assertEqual(observed["tracks"], [
            {"id": "track-0", "name": "Bass Bus", "mute": False, "solo": False, "armed": False,
             "volume": 0.75, "pan": 0.0, "isGroup": True, "isGrouped": False,
             "groupTrackId": None, "foldState": 1},
            {"id": "track-1", "name": "Sub Bass", "mute": False, "solo": False, "armed": False,
             "volume": 0.75, "pan": 0.0, "isGroup": False, "isGrouped": True,
             "groupTrackId": "track-0", "foldState": None},
        ])

    def test_group_fold_and_batch_bus_routing_apply_exact_existing_targets(self):
        song = Song()
        source, group = song.tracks
        group.name = "Bass Bus"
        group.is_foldable = True
        group.is_grouped = False
        group.fold_state = 0
        source.is_foldable = False
        source.is_grouped = False
        source.available_output_routing_types.append(
            type("Route", (), {"identifier": "track-1", "display_name": "Bass Bus"})()
        )

        folded = dispatch_request(song, {"method": "set_group_fold_state", "params": {"trackId": "track-1", "folded": True}}, 3)
        self.assertEqual(folded["track"]["foldState"], 1)
        routed = dispatch_request(song, {"method": "route_tracks_to_bus", "params": {
            "busTrackId": "track-1", "routes": [{"trackId": "track-0", "outputTypeId": "track-1"}]
        }}, 4)
        self.assertEqual(routed["routes"][0]["output"]["type"]["id"], "track-1")

    def test_transport_recording_context_reads_and_writes_exact_modes(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_transport_recording_context"}, 3)
        self.assertEqual(observed["currentSongTime"], 4.0)
        self.assertTrue(observed["arrangement"]["punchIn"])
        self.assertTrue(observed["session"]["overdub"])
        changed = dispatch_request(song, {"method": "set_transport_recording_context", "params": {"changes": {
            "currentSongTime": 32.0, "metronome": False,
            "arrangement": {"record": True, "overdub": True, "punchIn": False, "punchOut": True, "backToArranger": True},
            "session": {"record": True, "overdub": False}, "automationArm": True,
        }}}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(song.current_song_time, 32.0)
        self.assertTrue(song.record_mode)
        self.assertTrue(song.back_to_arranger)
        self.assertFalse(song.overdub)
        self.assertTrue(song.session_automation_record)

    def test_socket_bridge_defers_cue_mutations_until_live_applies_the_playhead(self):
        song = Song()

        class Surface:
            def song(self):
                return song

            def schedule_message(self, _, callback):
                self.callback = callback

        class Client:
            def __init__(self):
                self.messages = []

            def sendall(self, payload):
                self.messages.append(json.loads(payload))

        surface = Surface()
        client = Client()
        bridge = SocketBridge(surface, "/unused")
        bridge.requests.put((client, {"id": 1, "method": "create_arrangement_cue_point", "params": {"timeBeats": 32, "name": "Chorus"}}))
        bridge.drain()
        self.assertEqual(client.messages, [])
        self.assertEqual(song.current_song_time, 32)
        surface.callback()
        self.assertEqual(client.messages[0]["result"]["cuePoint"]["name"], "Chorus")
        self.assertEqual(song.current_song_time, 4.0)

    def test_arrangement_cue_point_lifecycle_and_jump(self):
        song = Song()
        observed = dispatch_request(song, {"method": "list_arrangement_cue_points"}, 3)
        self.assertEqual(observed["cuePoints"][0], {"id": "cue-0", "name": "Verse", "timeBeats": 16.0})
        created = dispatch_request(song, {"method": "create_arrangement_cue_point", "params": {"timeBeats": 32, "name": "Chorus"}}, 3)
        self.assertEqual(created["cuePoint"]["name"], "Chorus")
        self.assertEqual(song.current_song_time, 4.0)
        dispatch_request(song, {"method": "rename_arrangement_cue_point", "params": {"cuePointId": "cue-0", "name": "Intro"}}, 4)
        self.assertEqual(song.cue_points[0].name, "Intro")
        dispatch_request(song, {"method": "jump_to_arrangement_cue_point", "params": {"cuePointId": "cue-0"}}, 5)
        self.assertTrue(song.cue_points[0].jumped)
        dispatch_request(song, {"method": "delete_arrangement_cue_point", "params": {"cuePointId": "cue-1"}}, 6)
        self.assertEqual(len(song.cue_points), 1)
        self.assertEqual(song.current_song_time, 4.0)

    def test_track_routing_reads_choices_and_applies_exact_identifiers(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_track_routing", "params": {"trackId": "track-0"}}, 3)
        self.assertEqual(observed["input"]["type"], {"id": "All Ins", "name": "All Ins"})
        self.assertEqual(observed["monitoring"]["name"], "auto")
        changed = dispatch_request(song, {"method": "set_track_routing", "params": {
            "trackId": "track-0", "changes": {
                "inputChannelId": {"value": {"id": "channel-1"}},
                "outputTypeId": {"value": {"id": "no-output"}},
                "monitoring": {"value": {"value": 2}},
            }
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(changed["input"]["channel"]["id"], "Ch. 1")
        self.assertEqual(changed["output"]["type"]["id"], "No Output")
        self.assertEqual(changed["monitoring"]["name"], "off")

    def test_factory_browser_lists_one_level_and_loads_an_exact_item(self):
        song = Song()
        application = Application()
        listing = dispatch_request(song, {
            "method": "get_factory_browser_items", "params": {"root": "instruments", "path": []}
        }, 3, application)
        self.assertEqual(listing["children"][0], {
            "name": "Drift", "uri": "query:Drift", "loadable": True, "folder": False,
        })
        loaded = dispatch_request(song, {"method": "load_factory_browser_item", "params": {
            "root": "instruments", "path": ["Drift"], "trackId": "track-0",
            "before": dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3),
        }}, 3, application)
        self.assertEqual(application.loaded[0].name, "Drift")
        self.assertEqual(loaded["stateVersion"], 4)

    def test_live_browser_lists_plugins_and_loads_user_library_items(self):
        song = Song()
        application = Application()
        listing = dispatch_request(song, {
            "method": "get_browser_items", "params": {"root": "plugins", "path": []}
        }, 3, application)
        self.assertEqual(listing["root"], "plugins")
        loaded = dispatch_request(song, {"method": "load_browser_item", "params": {
            "root": "user_library", "path": ["Drift"], "trackId": "track-0",
            "before": dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3),
        }}, 3, application)
        self.assertEqual(application.loaded[0].name, "Drift")
        self.assertEqual(loaded["stateVersion"], 4)

    def test_browser_load_rejects_changed_target_devices_before_loading(self):
        song, application = Song(), Application()
        before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        song.tracks[0].devices[0].name = "Changed instrument"
        with self.assertRaisesRegex(ValueError, "target device chain changed"):
            dispatch_request(song, {"method": "load_factory_browser_item", "params": {
                "root": "instruments", "path": ["Drift"], "trackId": "track-0", "before": before
            }}, 3, application)
        self.assertEqual(application.loaded, [])

    def test_browser_load_rejects_nested_rack_changes_before_loading(self):
        song, application = Song(), Application()
        rack = DrumRack()
        song.tracks[0].devices = [rack]
        before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        rack.chains[0].devices[0].name = "Changed nested sound"
        with self.assertRaisesRegex(ValueError, "target device chain changed"):
            dispatch_request(song, {"method": "load_factory_browser_item", "params": {
                "root": "instruments", "path": ["Drift"], "trackId": "track-0", "before": before
            }}, 3, application)
        self.assertEqual(application.loaded, [])

    def test_live_browser_search_returns_exact_nested_splice_paths(self):
        result = dispatch_request(Song(), {"method": "search_browser_items", "params": {
            "root": "user_folders", "path": [], "query": "snare", "maxDepth": 3, "limit": 10,
        }}, 3, Application())
        self.assertEqual(result["results"], [{
            "name": "Snare.wav", "uri": "query:snare", "loadable": True, "folder": False,
            "path": ["Splice", "Drums", "Snare.wav"],
        }])

    def test_live_browser_search_honors_depth_and_result_limits(self):
        shallow = dispatch_request(Song(), {"method": "search_browser_items", "params": {
            "root": "user_folders", "path": [], "query": "snare", "maxDepth": 2, "limit": 10,
        }}, 3, Application())
        self.assertEqual(shallow["results"], [])
        limited = dispatch_request(Song(), {"method": "search_browser_items", "params": {
            "root": "user_folders", "path": [], "query": "r", "maxDepth": 3, "limit": 1,
        }}, 3, Application())
        self.assertEqual(len(limited["results"]), 1)

    def test_device_lifecycle_reports_active_state_and_checks_exact_identity(self):
        song = Song()
        class LiveDevice(Device):
            @property
            def is_active(self):
                return self.parameters[0].value > 0

            @is_active.setter
            def is_active(self, value):
                raise AttributeError("property has no setter")

            def __init__(self):
                self.name = "Serum 2"
                self.class_name = "PluginDevice"
                self.class_display_name = "Plug-in"
                self.type = 1
                self.can_have_chains = False
                self.can_have_drum_pads = False
                on = QuantizedParameter()
                on.name = on.original_name = "Device On"
                on.max = 1.0
                on.value_items = ("Off", "On")
                self.parameters = [on]
        song.tracks[0].devices = [LiveDevice()]
        listed = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        device = listed["devices"][0]
        self.assertTrue(device["active"])
        changed = dispatch_request(song, {"method": "set_device_active", "params": {
            "trackId": "track-0", "deviceId": device["id"], "beforeDevice": device, "active": False,
        }}, 3)
        self.assertFalse(changed["device"]["active"])
        deleted = dispatch_request(song, {"method": "delete_device", "params": {
            "trackId": "track-0", "deviceId": device["id"], "beforeDevice": {**device, "active": False},
        }}, 4)
        self.assertEqual(deleted["devices"], [])

    def test_nested_device_deletion_preserves_owner_path(self):
        song = Song()
        rack = DrumRack()
        song.tracks[0].devices = [rack]
        chain = rack.chains[0]
        second = NestedDevice("EQ Eight", "Eq8", 0)
        chain.devices.append(second)
        chain.delete_device = lambda index: chain.devices.pop(index)
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0/chain-0/device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        result = dispatch_request(song, {"method": "delete_device", "params": {**ids, "beforeDevice": before}}, 3)
        self.assertEqual(result["deletedDevice"]["id"], ids["deviceId"])
        self.assertEqual(result["devices"][0]["id"], "track-0:device-0/chain-0/device-0")
        self.assertEqual(result["devices"][0]["className"], "Eq8")
        self.assertEqual(song.tracks[0].devices, [rack])

    def test_device_reorder_returns_actual_position_and_new_id(self):
        song = Song()
        first = Device()
        second = NestedDevice("EQ Eight", "Eq8", 0)
        song.tracks[0].devices = [first, second]
        def move_device(device, target, target_position):
            target.devices.remove(device)
            position = min(target_position, len(target.devices))
            target.devices.insert(position, device)
            return position
        song.move_device = move_device
        result = dispatch_request(song, {"method": "move_device", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-1", "targetPosition": 0,
            "beforeDevice": {"name": "EQ Eight", "className": "Eq8"},
        }}, 3)
        self.assertEqual(result["actualPosition"], 0)
        self.assertEqual(result["device"]["id"], "track-0:device-0")
        self.assertIs(song.tracks[0].devices[0], second)

    def test_device_types_use_live_enum_constants_not_assumed_ordinals(self):
        enum = SimpleNamespace(instrument=11, audio_effect=22, midi_effect=44)
        live = SimpleNamespace(Device=SimpleNamespace(DeviceType=enum))
        with patch("bridge.Live", live):
            for value, name in ((11, "instrument"), (22, "audio_effect"), (44, "midi_effect"), (99, "unknown")):
                self.assertEqual(_device_type(SimpleNamespace(type=value)), name)

    def test_session_clip_placement_lists_timeline_and_rejects_overlap(self):
        song = Song()
        track = song.tracks[0]
        track.arrangement_clips = []
        def duplicate(clip, time):
            result = copy.deepcopy(clip)
            result.start_time = time
            result.end_time = time + clip.length
            result.is_audio_clip = False
            track.arrangement_clips.append(result)
            return result
        track.duplicate_clip_to_arrangement = duplicate
        params = {"trackId": "track-0", "clipId": "track-0:clip-0", "startBeats": 8.0}
        result = dispatch_request(song, {"method": "place_session_clip_in_arrangement", "params": params}, 3)
        self.assertEqual(result["placedClip"]["startBeats"], 8.0)
        self.assertEqual(result["placedClip"]["endBeats"], 12.0)
        with self.assertRaisesRegex(ValueError, "overlap"):
            dispatch_request(song, {"method": "place_session_clip_in_arrangement", "params": {**params, "startBeats": 10.0}}, 4)
        self.assertEqual(len(track.arrangement_clips), 1)

    def test_arrangement_deletion_checks_identity_and_preserves_other_clips(self):
        song = Song()
        track = song.tracks[0]
        track.arrangement_clips = [SimpleNamespace(name="A", start_time=0, end_time=4, is_audio_clip=False),
                                   SimpleNamespace(name="B", start_time=8, end_time=12, is_audio_clip=False)]
        track.delete_clip = lambda clip: track.arrangement_clips.remove(clip)
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        before = {"id": "track-0:arrangement-clip-0", "name": "A", "startBeats": 0.0,
                  "endBeats": 4.0, "lengthBeats": 4.0, "type": "midi"}
        params = {"trackId": "track-0", "clipId": before["id"], "before": before}
        with self.assertRaisesRegex(ValueError, "identity changed"):
            dispatch_request(song, {"method": "delete_arrangement_clip", "params": {**params, "before": {**before, "name": "Wrong"}}}, 3)
        result = dispatch_request(song, {"method": "delete_arrangement_clip", "params": params}, 3)
        self.assertEqual(result["deletedClip"], before)
        self.assertEqual([clip["name"] for clip in result["clips"]], ["B"])
        self.assertEqual(boundaries, ["begin", "end"])

    def test_arrangement_move_rolls_back_failed_destination_copy(self):
        song = Song()
        track = song.tracks[0]
        track.arrangement_clips = [SimpleNamespace(name="A", start_time=8.0, end_time=12.0, is_audio_clip=False, notes=[60])]
        track.delete_clip = lambda clip: track.arrangement_clips.remove(clip)
        copies = []
        def duplicate(clip, time):
            copies.append(time)
            if len(copies) == 2:
                raise RuntimeError("destination copy failed")
            result = copy.deepcopy(clip)
            result.start_time = time
            result.end_time = time + clip.end_time - clip.start_time
            track.arrangement_clips.append(result)
            return result
        track.duplicate_clip_to_arrangement = duplicate
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        before = {"id": "track-0:arrangement-clip-0", "name": "A", "startBeats": 8.0, "endBeats": 12.0, "lengthBeats": 4.0, "type": "midi"}
        with self.assertRaisesRegex(RuntimeError, "destination copy failed"):
            dispatch_request(song, {"method": "move_arrangement_clip", "params": {
                "trackId": "track-0", "clipId": before["id"], "before": before, "startBeats": 10.0,
            }}, 3)
        self.assertEqual(len(track.arrangement_clips), 1)
        self.assertEqual(track.arrangement_clips[0].start_time, 8.0)
        self.assertEqual(track.arrangement_clips[0].notes, [60])

    def test_audio_import_checks_file_identity_and_empty_audio_slot(self):
        song = Song()
        track = song.tracks[1]
        track.has_audio_input = True
        track.is_frozen = False
        slot = track.clip_slots[0]
        imported = []
        def create_audio(path):
            imported.append(path)
            slot.has_clip = True
            slot.clip = AudioClip()
        slot.create_audio_clip = create_audio
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        with tempfile.NamedTemporaryFile(suffix=".wav") as source:
            stat = os.stat(source.name)
            descriptor = {"size": str(stat.st_size), "mtimeNs": str(stat.st_mtime_ns), "device": str(stat.st_dev), "inode": str(stat.st_ino)}
            params = {"trackId": "track-1", "clipId": "track-1:clip-0", "sourcePath": source.name, "sourceFile": descriptor}
            with self.assertRaisesRegex(ValueError, "source file changed"):
                dispatch_request(song, {"method": "create_audio_clip", "params": {**params, "sourceFile": {**descriptor, "size": "99"}}}, 3)
            result = dispatch_request(song, {"method": "create_audio_clip", "params": params}, 3)
            self.assertEqual(imported, [source.name])
            self.assertTrue(result["clips"][0]["hasClip"])
            with self.assertRaisesRegex(ValueError, "already contains"):
                dispatch_request(song, {"method": "create_audio_clip", "params": params}, 4)

    def test_arrangement_audio_state_targets_only_the_exact_timeline_clip(self):
        song = Song()
        audio = AudioClip()
        audio.start_time = 8.0
        audio.end_time = 12.0
        song.tracks[0].arrangement_clips = [audio]
        params = {"trackId": "track-0", "clipId": "track-0:arrangement-clip-0"}
        observed = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        self.assertEqual(observed["location"], "arrangement")
        self.assertEqual(observed["timeline"]["startBeats"], 8.0)
        result = dispatch_request(song, {"method": "set_audio_clip_state", "params": {
            **params, "before": observed, "changes": {"pitchCoarse": {"value": -7}},
        }}, 3)
        self.assertEqual(result["pitch"]["coarse"], -7)
        self.assertEqual(result["timeline"]["startBeats"], 8.0)
        for invalid in ("track-0:arrangement-clip--1", "track-1:arrangement-clip-0", "track-0:arrangement-clip-99"):
            with self.assertRaises(ValueError):
                dispatch_request(song, {"method": "get_audio_clip_state", "params": {**params, "clipId": invalid}}, 3)

    def test_arrangement_move_supports_self_overlap_and_preserves_contents(self):
        song = Song()
        track = song.tracks[0]
        original = SimpleNamespace(name="A", start_time=8.0, end_time=12.0, is_audio_clip=False, notes=[60, 64])
        track.arrangement_clips = [original]
        track.delete_clip = lambda clip: track.arrangement_clips.remove(clip)
        def duplicate(clip, time):
            result = copy.deepcopy(clip)
            result.start_time = time
            result.end_time = time + clip.end_time - clip.start_time
            track.arrangement_clips.append(result)
            return result
        track.duplicate_clip_to_arrangement = duplicate
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        before = {"id": "track-0:arrangement-clip-0", "name": "A", "startBeats": 8.0, "endBeats": 12.0, "lengthBeats": 4.0, "type": "midi"}
        result = dispatch_request(song, {"method": "move_arrangement_clip", "params": {
            "trackId": "track-0", "clipId": before["id"], "before": before, "startBeats": 10.0,
        }}, 3)
        self.assertEqual(result["movedClip"]["startBeats"], 10.0)
        self.assertEqual(result["movedClip"]["endBeats"], 14.0)
        self.assertEqual(len(track.arrangement_clips), 1)
        self.assertEqual(track.arrangement_clips[0].notes, [60, 64])
        self.assertEqual(boundaries, ["begin", "end"])

    def test_master_and_return_mixer_lifecycle(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_set_mixer"}, 3)
        self.assertEqual(observed["master"]["cueVolume"]["value"], 0.7)
        self.assertEqual(observed["master"]["outputRouting"]["channel"]["id"], "1/2")
        routed = dispatch_request(song, {"method": "set_master_mixer", "params": {"changes": {
            "outputChannelId": {"value": {"id": "3/4", "name": "3/4"}},
        }}}, 3)
        self.assertEqual(routed["master"]["outputRouting"]["channel"]["id"], "3/4")
        self.assertEqual(observed["returns"][0]["name"], "Reverb")
        master = dispatch_request(song, {"method": "set_master_mixer", "params": {"changes": {
            "volume": {"value": 0.5}, "crossfader": {"value": -0.25},
        }}}, 3)
        self.assertEqual(master["master"]["volume"]["value"], 0.5)
        returned = dispatch_request(song, {"method": "set_return_mixer", "params": {
            "returnTrackId": "return-0", "beforeReturn": observed["returns"][0],
            "changes": {"pan": {"value": 0.5}, "mute": {"value": True}},
        }}, 4)
        self.assertTrue(returned["return"]["mute"])
        self.assertEqual(returned["return"]["pan"]["value"], 0.5)

    def test_audio_clip_state_reads_and_writes_warp_pitch_gain_and_markers(self):
        song = Song()
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        observed = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        self.assertEqual(observed["warpMode"]["name"], "beats")
        changed = dispatch_request(song, {"method": "set_audio_clip_state", "params": {**params, "before": observed, "changes": {
            "gain": {"value": 0.75}, "pitchCoarse": {"value": -12}, "pitchFine": {"value": 17},
            "warpMode": {"value": 6},
            "startMarkerBeats": {"value": 1}, "endMarkerBeats": {"value": 7},
        }}}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(changed["pitch"], {"coarse": -12, "fine": 17})
        self.assertEqual(changed["markers"], {"unit": "beats", "startBeats": 1.0, "endBeats": 7.0})

    def test_unwarped_audio_markers_use_seconds_and_reject_beats_before_mutation(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warping = False
        clip.looping = False
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        observed = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        self.assertEqual(observed["markers"]["unit"], "seconds")
        self.assertNotIn("startBeats", observed["markers"])
        with self.assertRaisesRegex(ValueError, "marker units"):
            dispatch_request(song, {"method": "set_audio_clip_state", "params": {**params, "before": observed, "changes": {
                "gain": {"value": 0.9}, "startMarkerBeats": {"value": 1}
            }}}, 3)
        self.assertEqual(clip.gain, observed["gain"]["value"])
        changed = dispatch_request(song, {"method": "set_audio_clip_state", "params": {**params, "before": observed, "changes": {
            "startMarkerSeconds": {"value": 1}, "endMarkerSeconds": {"value": 7}
        }}}, 3)
        self.assertEqual(changed["markers"], {"unit": "seconds", "startSeconds": 1.0, "endSeconds": 7.0})
        self.assertEqual((clip.loop_start, clip.loop_end), (1.0, 7.0))

    def test_transport_context_reads_and_writes_metronome_and_count_in(self):
        song = Song()
        observed = dispatch_request(song, {"method": "get_transport_context"}, 3)
        self.assertFalse(observed["metronome"])
        self.assertEqual(observed["countInDuration"]["name"], "one_bar")
        changed = dispatch_request(song, {"method": "set_transport_context", "params": {"changes": {
            "metronome": {"value": True}, "countInDuration": {"value": 2}
        }}}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertTrue(song.metronome)
        self.assertEqual(changed["countInDuration"]["name"], "two_bars")

    def test_clip_duplication_and_deletion_return_observed_slots(self):
        song = Song()
        duplicated = dispatch_request(song, {"method": "duplicate_clip", "params": {
            "trackId": "track-0", "sourceClipId": "track-0:clip-0", "targetClipId": "track-0:clip-1"
        }}, 3)
        self.assertEqual(duplicated["stateVersion"], 4)
        self.assertEqual(duplicated["clips"][1]["name"], "Loop")
        deleted = dispatch_request(song, {"method": "delete_clip", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-1"
        }}, 4)
        self.assertFalse(deleted["clips"][1]["hasClip"])

    def test_duplicate_clip_loop_doubles_loop_region_and_returns_timing(self):
        song = Song()
        result = dispatch_request(song, {"method": "duplicate_clip_loop", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["loop"], {"enabled": True, "startBeats": 0.0, "endBeats": 8.0})

    def test_history_state_and_undo_redo_return_observed_availability(self):
        song = Song()
        history = dispatch_request(song, {"method": "get_history_state"}, 3)
        self.assertEqual(history, {"stateVersion": 3, "canUndo": True, "canRedo": False})
        undone = dispatch_request(song, {"method": "undo"}, 3)
        self.assertEqual(undone, {"stateVersion": 4, "canUndo": False, "canRedo": True})
        redone = dispatch_request(song, {"method": "redo"}, 4)
        self.assertEqual(redone, {"stateVersion": 5, "canUndo": True, "canRedo": False})

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

    def test_unwarped_audio_clip_timing_reports_seconds_not_beats(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.is_audio_clip = True
        clip.warping = False
        clip.loop_start = 0.25
        clip.loop_end = 1.75
        observed = dispatch_request(song, {"method": "get_clip_timing", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        self.assertEqual(observed["loop"], {
            "enabled": True, "unit": "seconds", "startSeconds": 0.25, "endSeconds": 1.75
        })
        with self.assertRaisesRegex(ValueError, "unwarped audio"):
            dispatch_request(song, {"method": "set_clip_timing", "params": {
                "trackId": "track-0", "clipId": "track-0:clip-0",
                "changes": {"loop": {"enabled": False, "startBeats": 1.0}}
            }}, 3)
        self.assertTrue(clip.looping)
        self.assertEqual(clip.loop_start, 0.25)
        changed = dispatch_request(song, {"method": "set_clip_timing", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0",
            "changes": {"loop": {"startSeconds": 0.5, "endSeconds": 2.0}}
        }}, 3)
        self.assertEqual(changed["loop"]["startSeconds"], 0.5)
        self.assertEqual(changed["loop"]["endSeconds"], 2.0)

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

    def test_clip_timing_rejects_changed_observation_before_mutation(self):
        song = Song()
        params = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_clip_timing", "params": params}, 3)
        clip = song.tracks[0].clip_slots[0].clip
        clip.loop_end = 8.0
        with self.assertRaisesRegex(ValueError, "timing changed"):
            dispatch_request(song, {"method": "set_clip_timing", "params": {
                **params, "before": before, "changes": {"loop": {"enabled": False}}
            }}, 3)
        self.assertTrue(clip.looping)
        self.assertEqual(clip.loop_end, 8.0)

    def test_rack_chain_hierarchy_reports_native_mixer_ranges(self):
        song = Song()
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        rack = DrumRack()
        chain = rack.chains[0]
        volume, pan = Parameter(), Parameter()
        volume.value = 0.75
        pan.min, pan.max, pan.value = -1.0, 1.0, -0.25
        chain.mixer_device = SimpleNamespace(volume=volume, panning=pan)
        chain.mute, chain.solo = True, False
        song.tracks[0].devices = [rack]
        result = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        mixer = result["device"]["chains"][0]["mixer"]
        self.assertEqual(mixer["volume"], {"value": 0.75, "min": 0.0, "max": 1.0, "enabled": True})
        self.assertEqual(mixer["pan"], {"value": -0.25, "min": -1.0, "max": 1.0, "enabled": True})
        self.assertTrue(mixer["mute"])
        self.assertFalse(mixer["solo"])
        base = {"trackId": "track-0", "deviceId": "track-0:device-0",
                "chainId": "track-0:device-0/chain-0", "beforeDevice": result["device"]}
        for changes in ({"volume": 0.5, "pan": 2.0}, {"volume": float("nan")},
                        {"mute": 1}, {}, {"unknown": True}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
                        **base, "changes": changes}}, 3)
                self.assertEqual(volume.value, 0.75)
                self.assertEqual(pan.value, -0.25)
                self.assertTrue(chain.mute)
                self.assertFalse(chain.solo)
        with self.assertRaisesRegex(ValueError, "unknown rack chain"):
            dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
                **base, "chainId": "track-0:device-0/chain-99", "changes": {"volume": 0.5}}}, 3)
        chain.name = "Changed layer"
        with self.assertRaisesRegex(ValueError, "rack state changed"):
            dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
                **base, "changes": {"volume": 0.5}}}, 3)
        self.assertEqual(volume.value, 0.75)
        chain.name = result["device"]["chains"][0]["name"]
        written = dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0", "chainId": "track-0:device-0/chain-0",
            "beforeDevice": result["device"], "changes": {"volume": 0.5, "pan": 0.25, "mute": False, "solo": True}}}, 3)
        self.assertEqual(volume.value, 0.5)
        self.assertEqual(pan.value, 0.25)
        self.assertFalse(chain.mute)
        self.assertTrue(chain.solo)
        self.assertEqual(written["mixer"]["volume"]["value"], 0.5)
        renamed = dispatch_request(song, {"method": "rename_rack_chain", "params": {
            **base, "beforeDevice": written["device"], "name": "Sub bass"}}, 4)
        self.assertEqual(chain.name, "Sub bass")
        self.assertEqual(renamed["name"], "Sub bass")

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
        self.assertFalse(rack["chains"][0]["apiSupport"]["deleteDevice"])
        song.tracks[0].devices[0].chains[0].delete_device = lambda index: None
        supported = dispatch_request(song, {
            "method": "get_device_hierarchy",
            "params": {"trackId": "track-0", "deviceId": "track-0:device-0"}
        }, 3)
        self.assertTrue(supported["device"]["chains"][0]["apiSupport"]["deleteDevice"])
        self.assertEqual(rack["drumPads"], [{
            "note": 36, "name": "Kick", "mute": False, "solo": False,
            "chainIds": ["track-0:device-0/chain-0"]
        }])

    def test_device_hierarchy_includes_rack_return_chain_devices(self):
        song = Song()
        rack = DrumRack()
        rack.return_chains = [Chain("Mix Bus", [NestedDevice("EQ", "Eq8", 2)])]
        song.tracks[0].devices = [rack]
        result = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)["device"]
        returns = result.get("returnChains", [])
        self.assertEqual(len(returns), 1)
        self.assertEqual(returns[0]["id"], "track-0:device-0/return-chain-0")
        self.assertEqual(returns[0]["name"], "Mix Bus")
        self.assertIn("mixer", returns[0])
        self.assertEqual(returns[0]["devices"][0]["id"], "track-0:device-0/return-chain-0/device-0")
        self.assertEqual(returns[0]["devices"][0]["className"], "Eq8")
        self.assertEqual(returns[0]["devices"][0].get("returnChains"), [])

    def test_device_hierarchy_reads_native_sample_source(self):
        song = Song()
        simpler = NestedDevice("Kick", "OriginalSimpler")
        simpler.sample = type("Sample", (), {"file_path": "/library/kick.wav"})()
        song.tracks[0].devices = [simpler]
        request = {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}
        self.assertEqual(dispatch_request(song, request, 3)["device"]["sampleSource"],
                         {"path": "/library/kick.wav"})
        simpler.sample = None
        self.assertIsNone(dispatch_request(song, request, 3)["device"]["sampleSource"])
        song.tracks[0].devices = [Device()]
        self.assertIsNone(dispatch_request(song, request, 3)["device"]["sampleSource"])

    def test_device_hierarchy_distinguishes_native_multisample_mode(self):
        song = Song()
        device = song.tracks[0].devices[0]
        request = {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}
        self.assertIsNone(dispatch_request(song, request, 3)["device"].get("multiSampleMode"))
        for value in (True, False):
            device.multi_sample_mode = value
            self.assertIs(dispatch_request(song, request, 3)["device"].get("multiSampleMode"), value)

    def test_drum_pad_state_changes_exact_note(self):
        song = Song()
        rack = DrumRack()
        song.tracks[0].devices = [rack]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        result = dispatch_request(song, {"method": "set_drum_pad_state", "params": {
            **ids, "beforeDevice": before, "note": 36, "changes": {"mute": True}}}, 3)
        self.assertTrue(result["pad"]["mute"])
        self.assertFalse(result["pad"]["solo"])
        with self.assertRaisesRegex(ValueError, "muted and soloed"):
            dispatch_request(song, {"method": "set_drum_pad_state", "params": {
                **ids, "beforeDevice": result["device"], "note": 36,
                "changes": {"mute": True, "solo": True}}}, 4)
        with self.assertRaisesRegex(ValueError, "rack state changed"):
            dispatch_request(song, {"method": "set_drum_pad_state", "params": {
                **ids, "beforeDevice": before, "note": 36, "changes": {"mute": False}}}, 4)

    def test_drum_chain_note_routing_validates_before_mutating(self):
        song = Song()
        rack = DrumRack()
        chain = rack.chains[0]
        chain.in_note, chain.out_note = 36, 60
        song.tracks[0].devices = [rack]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        args = {**ids, "chainId": "track-0:device-0/chain-0", "beforeDevice": before}
        with self.assertRaises(ValueError):
            dispatch_request(song, {"method": "set_rack_chain_note_routing", "params": {
                **args, "changes": {"inputNote": 40, "outputNote": 128}}}, 3)
        self.assertEqual(chain.in_note, 36)
        routed = dispatch_request(song, {"method": "set_rack_chain_note_routing", "params": {
            **args, "changes": {"inputNote": 40}}}, 3)
        self.assertEqual(chain.in_note, 40)
        self.assertEqual(chain.out_note, 60)
        self.assertEqual(routed["noteRouting"], {"inputNote": 40, "outputNote": 60})

    def test_pad_restoration_applies_mute_after_solo_side_effects(self):
        song = Song()
        rack = DrumRack()
        class SoloSideEffectPad:
            note, name = 36, "Kick"
            def __init__(self):
                self.chains = rack.chains
                self.mute = True
                self._solo = True
            @property
            def solo(self):
                return self._solo
            @solo.setter
            def solo(self, value):
                self._solo = value
                if not value:
                    self.mute = True
        rack.drum_pads = [SoloSideEffectPad()]
        song.tracks[0].devices = [rack]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        result = dispatch_request(song, {"method": "set_drum_pad_state", "params": {
            **ids, "beforeDevice": before, "note": 36, "changes": {"mute": False, "solo": False}}}, 3)
        self.assertFalse(result["pad"]["mute"])
        self.assertFalse(result["pad"]["solo"])

    def test_pad_chain_references_use_native_equality_not_wrapper_identity(self):
        song = Song()
        rack = DrumRack()
        chain = rack.chains[0]
        class ChainReference:
            def __eq__(self, other):
                return other is chain
        rack.drum_pads[0].chains = [ChainReference()]
        song.tracks[0].devices = [rack]
        result = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        self.assertEqual(result["device"]["drumPads"][0]["chainIds"], ["track-0:device-0/chain-0"])
        self.assertEqual(result["device"]["chains"][0]["noteRouting"], {"inputNote": None, "outputNote": None})
        chain.in_note, chain.out_note = 36, 60
        routed = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        self.assertEqual(routed["device"]["chains"][0]["noteRouting"], {"inputNote": 36, "outputNote": 60})

    def test_create_rack_chain_inserts_named_empty_chain_and_rejects_stale_rack(self):
        song = Song()
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        song.tracks[0].devices = [DrumRack()]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        params = {**ids, "beforeDevice": before, "index": 1, "name": "Bass layer"}
        result = dispatch_request(song, {"method": "create_rack_chain", "params": params}, 3)
        self.assertEqual(result["device"]["chains"][1]["name"], "Bass layer")
        self.assertEqual(result["device"]["chains"][1]["devices"], [])
        with self.assertRaisesRegex(ValueError, "rack state changed"):
            dispatch_request(song, {"method": "create_rack_chain", "params": params}, 4)

    def test_move_device_into_rack_chain_preserves_object_and_returns_nested_id(self):
        song = Song()
        source = Device()
        rack = DrumRack()
        song.tracks[0].devices = [rack, source]
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        def move(device, target, position):
            song.tracks[0].devices.remove(device)
            target.devices.insert(position, device)
            return position
        song.move_device = move
        ids = {"trackId": "track-0", "deviceId": "track-0:device-1"}
        destination = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"
        }}, 3)["device"]
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        result = dispatch_request(song, {"method": "move_device_to_chain", "params": {
            **ids, "targetTrackId": "track-0", "targetChainId": "track-0:device-0/chain-0",
            "targetPosition": 1, "beforeDevice": before, "beforeTargetRack": destination
        }}, 3)
        self.assertIs(rack.chains[0].devices[1], source)
        self.assertEqual(result["device"]["id"], "track-0:device-0/chain-0/device-1")

    def test_nested_device_parameter_paths_resolve_exact_rack_children(self):
        song = Song()
        outer = DrumRack()
        inner = DrumRack()
        outer.chains[0].devices = [inner]
        song.tracks[0].devices = [outer]
        path = "track-0:device-0/chain-0/device-0/chain-0/device-0"
        result = dispatch_request(song, {"method": "list_device_parameters",
            "params": {"trackId": "track-0", "deviceId": path}}, 3)
        self.assertEqual(result["deviceId"], path)
        dispatch_request(song, {"method": "set_device_parameters", "params": {
            "trackId": "track-0", "deviceId": path,
            "changes": [{"id": "parameter-0", "value": 0.7}]}}, 3)
        self.assertEqual(inner.chains[0].devices[0].parameters[0].value, 0.7)
        self.assertEqual(outer.parameters[0].value, 0.4)
        for invalid in [path + "/junk", "track-0:device--1", "track-0:device-0/chain-5/device-0"]:
            with self.assertRaises(ValueError):
                dispatch_request(song, {"method": "list_device_parameters",
                    "params": {"trackId": "track-0", "deviceId": invalid}}, 3)

    def test_device_listing_exposes_stable_identity_and_structure(self):
        enum = SimpleNamespace(instrument=1, audio_effect=2, midi_effect=4)
        with patch("bridge.Live", SimpleNamespace(Device=SimpleNamespace(DeviceType=enum))):
            result = dispatch_request(Song(), {
                "method": "list_devices", "params": {"trackId": "track-0"}
            }, 3)

        self.assertEqual(result["devices"][0], {
            "id": "track-0:device-0", "name": "Serum 2", "className": "PluginDevice",
            "classDisplayName": "Plug-in", "type": "instrument", "active": True,
            "canHaveChains": False, "canHaveDrumPads": False,
            "sampleSource": None,
            "multiSampleMode": None,
            "chains": [], "drumPads": [],
            "returnChains": [],
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

    def test_continuous_parameters_do_not_read_quantized_value_items(self):
        class ContinuousParameter(Parameter):
            @property
            def value_items(self):
                raise RuntimeError("Only quantized parameters have value items")
            @value_items.setter
            def value_items(self, value):
                pass
        song = Song()
        song.tracks[0].devices[0].parameters = [ContinuousParameter()]
        result = dispatch_request(song, {"method": "list_device_parameters", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        self.assertEqual(result["parameters"][0]["valueItems"], [])
        self.assertEqual(result["parameters"][0]["value"], 0.4)

    def test_status_and_parameter_write_return_observed_state(self):
        song = Song()
        status = dispatch_request(song, {"method": "get_live_state", "params": {}}, 4)
        self.assertEqual(status["stateVersion"], 4)
        self.assertEqual(status["bridgeVersion"], "0.1.0")
        self.assertIn("list_scenes", status["capabilities"])
        self.assertIn("create_rack_chain", status["capabilities"])
        self.assertIn("move_device_to_chain", status["capabilities"])
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

    def test_session_structure_creation_and_exact_rename(self):
        song = Song()
        created_track = dispatch_request(song, {"method": "create_track", "params": {
            "type": "midi", "index": 1, "name": "Bass"
        }}, 3)
        self.assertEqual(created_track["track"], {"id": "track-1", "name": "Bass", "type": "midi"})
        created_scene = dispatch_request(song, {"method": "create_scene", "params": {
            "index": 0, "name": "Intro"
        }}, 4)
        self.assertEqual(created_scene["scene"], {"id": "scene-0", "name": "Intro"})
        renamed = dispatch_request(song, {"method": "rename_session_object", "params": {
            "target": {"targetType": "clip", "trackId": "track-0", "targetId": "track-0:clip-0",
                       "previousName": "Loop", "name": "Hook"}
        }}, 5)
        self.assertEqual(renamed["target"]["name"], "Hook")
        self.assertEqual(song.tracks[0].clip_slots[0].clip.name, "Hook")

    def test_session_duplicate_and_delete_return_exact_observed_state(self):
        song = Song()
        duplicated_track = dispatch_request(song, {"method": "duplicate_session_object", "params": {
            "target": {"targetType": "track", "targetId": "track-0", "destinationId": "track-1",
                       "sourceName": "Synth", "name": "Synth Layer"}
        }}, 2)
        self.assertEqual(duplicated_track["target"]["destinationId"], "track-1")
        self.assertEqual(song.tracks[1].name, "Synth Layer")
        duplicated = dispatch_request(song, {"method": "duplicate_session_object", "params": {
            "target": {"targetType": "clip", "trackId": "track-0", "targetId": "track-0:clip-0",
                       "destinationId": "track-0:clip-1", "name": "Loop"}
        }}, 3)
        self.assertEqual(duplicated["target"]["destinationId"], "track-0:clip-1")
        self.assertTrue(song.tracks[0].clip_slots[1].has_clip)
        deleted_clip = dispatch_request(song, {"method": "delete_session_object", "params": {
            "target": {"targetType": "clip", "trackId": "track-0", "targetId": "track-0:clip-1", "name": "Loop"}
        }}, 4)
        self.assertFalse(song.tracks[0].clip_slots[1].has_clip)
        self.assertEqual(deleted_clip["deleted"]["targetId"], "track-0:clip-1")
        dispatch_request(song, {"method": "duplicate_session_object", "params": {
            "target": {"targetType": "scene", "targetId": "scene-0", "destinationId": "scene-1", "name": "Verse"}
        }}, 5)
        self.assertEqual(len(song.scenes), 3)
        dispatch_request(song, {"method": "delete_session_object", "params": {
            "target": {"targetType": "scene", "targetId": "scene-1", "name": "Verse", "occupiedClips": []}
        }}, 6)
        self.assertEqual(len(song.scenes), 2)
        dispatch_request(song, {"method": "delete_session_object", "params": {
            "target": {"targetType": "track", "targetId": "track-1", "name": "Synth", "clipCount": 0, "deviceCount": 0}
        }}, 7)
        self.assertEqual(len(song.tracks), 2)

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
