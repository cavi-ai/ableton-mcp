import copy
import json
import os
import sys
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import SocketBridge, dispatch_request, _device_type, _new_midi_note, _persisted_device_chain, _set_fingerprint, _track_topology_signature


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
        self.has_midi_input = True
        self.has_audio_input = False
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

    def remove_notes_by_id(self, note_ids):
        removed = set(note_ids)
        self.extended_notes = [note for note in self.extended_notes if note.note_id not in removed]

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
        self.undo_boundaries = []
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
            "quantization_amount": 1.0, "random_amount": 0.0, "velocity_amount": -25.0,
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

    def begin_undo_step(self):
        self.undo_boundaries.append("begin")

    def end_undo_step(self):
        self.undo_boundaries.append("end")

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


class BrowserItemVector(tuple):
    """Live's user_folders root is a collection, not a BrowserItem."""


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

    def test_track_listing_does_not_read_arm_on_non_armable_tracks(self):
        class NonArmableTrack(Track):
            can_be_armed = False
            @property
            def arm(self):
                raise RuntimeError("Main and Return Tracks have no Arm state")
            @arm.setter
            def arm(self, value):
                pass
        song = Song()
        song.tracks[0] = NonArmableTrack()
        observed = dispatch_request(song, {"method": "list_tracks"}, 3)
        self.assertFalse(observed["tracks"][0]["armed"])

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
        self.assertEqual(source.current_output_routing, "Bass Bus")
        self.assertEqual(routed["routes"][0]["output"]["type"]["name"], "Bass Bus")

    def test_batch_bus_routing_validates_all_destinations_before_mutation(self):
        song = Song()
        source, group = song.tracks
        song.tracks = [source, Track(), group]
        group.is_foldable = True
        source.available_output_routing_types.append(
            SimpleNamespace(identifier="bus", display_name="Bus"))
        original = source.current_output_routing
        with self.assertRaises(ValueError):
            dispatch_request(song, {"method": "route_tracks_to_bus", "params": {
                "busTrackId": "track-2", "routes": [
                    {"trackId": "track-0", "outputTypeId": "bus"},
                    {"trackId": "track-1", "outputTypeId": "missing"}]}}, 3)
        self.assertIs(source.current_output_routing, original)

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

    def test_socket_bridge_advances_state_version_after_external_group_topology_change(self):
        song = Song()

        class Surface:
            def song(self):
                return song

            def application(self):
                return None

        class Client:
            def __init__(self):
                self.messages = []

            def sendall(self, payload):
                self.messages.append(json.loads(payload))

        client = Client()
        bridge = SocketBridge(Surface(), "/unused")
        bridge.requests.put((client, {"id": 1, "method": "list_tracks"}))
        bridge.drain()
        first_version = client.messages[-1]["result"]["stateVersion"]
        group, child = song.tracks
        group.is_foldable = True
        group.is_grouped = False
        group.fold_state = 0
        child.is_grouped = True
        child.group_track = group
        bridge.requests.put((client, {"id": 2, "method": "list_tracks"}))
        bridge.drain()
        self.assertNotIn("error", client.messages[-1], client.messages[-1])
        self.assertEqual(client.messages[-1]["result"]["stateVersion"], first_version + 1)
        self.assertEqual(client.messages[-1]["result"]["tracks"][1]["groupTrackId"], "track-0")

    def test_socket_bridge_survives_a_client_disconnect_before_response(self):
        song = Song()

        class Surface:
            def song(self):
                return song

            def application(self):
                return None

        class DisconnectedClient:
            def sendall(self, _payload):
                raise OSError(9, "Bad file descriptor")

        class Client:
            def __init__(self):
                self.messages = []

            def sendall(self, payload):
                self.messages.append(json.loads(payload))

        bridge = SocketBridge(Surface(), "/unused")
        client = Client()
        bridge.requests.put((DisconnectedClient(), {"id": 1, "method": "get_live_state"}))
        bridge.requests.put((client, {"id": 2, "method": "get_live_state"}))
        bridge.drain()
        self.assertTrue(bridge.requests.empty())
        self.assertEqual(client.messages[0]["id"], 2)

    def test_socket_bridge_advances_state_version_after_external_scene_change(self):
        song = Song()

        class Surface:
            def song(self):
                return song

            def application(self):
                return None

        class Client:
            def __init__(self):
                self.messages = []

            def sendall(self, payload):
                self.messages.append(json.loads(payload))

        client = Client()
        bridge = SocketBridge(Surface(), "/unused")
        bridge.requests.put((client, {"id": 1, "method": "list_scenes"}))
        bridge.drain()
        first_version = client.messages[-1]["result"]["stateVersion"]
        song.create_scene(0)
        bridge.requests.put((client, {"id": 2, "method": "list_scenes"}))
        bridge.drain()
        self.assertEqual(client.messages[-1]["result"]["stateVersion"], first_version + 1)

    def test_topology_signature_ignores_fresh_live_object_wrappers(self):
        class TrackProxy:
            def __init__(self, token, parent=None):
                self.token = token
                self.parent = parent
                self.is_grouped = parent is not None
                self.is_foldable = token == "bus"

            @property
            def group_track(self):
                return TrackProxy(self.parent) if self.parent else None

            def __eq__(self, other):
                return isinstance(other, TrackProxy) and self.token == other.token

        class ProxiedSong:
            parent = "bus"
            scenes = ()

            @property
            def tracks(self):
                return (TrackProxy("bus"), TrackProxy("child", self.parent))

        song = ProxiedSong()
        before = _track_topology_signature(song)
        self.assertEqual(_track_topology_signature(song), before)
        song.parent = None
        self.assertNotEqual(_track_topology_signature(song), before)

    def test_set_fingerprint_ignores_fresh_song_wrappers(self):
        base = Song()

        class SongProxy:
            def __getattr__(self, name):
                return getattr(base, name)

        self.assertEqual(_set_fingerprint(SongProxy()), _set_fingerprint(SongProxy()))

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
        self.assertEqual(observed["input"]["type"], {"id": "all-ins", "name": "All Ins"})
        self.assertEqual(observed["monitoring"]["name"], "auto")
        changed = dispatch_request(song, {"method": "set_track_routing", "params": {
            "trackId": "track-0", "changes": {
                "inputChannelId": {"value": {"id": "channel-1"}},
                "outputTypeId": {"value": {"id": "no-output"}},
                "monitoring": {"value": {"value": 2}},
            }
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(changed["input"]["channel"]["id"], "channel-1")
        self.assertEqual(changed["output"]["type"]["id"], "no-output")
        self.assertEqual(changed["monitoring"]["name"], "off")

    def test_track_routing_rejects_ambiguous_label_only_current_choice(self):
        song = Song()
        route = lambda identifier: type("Route", (), {"identifier": identifier, "display_name": "Bass"})()
        song.tracks[0].available_output_routing_types = [route("bass-a"), route("bass-b")]
        song.tracks[0].current_output_routing = "Bass"
        with self.assertRaisesRegex(ValueError, "ambiguous current routing label"):
            dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 3)

    def test_track_routing_normalizes_live_current_route_aliases_to_available_choices(self):
        song = Song()
        track = song.tracks[0]
        route = lambda identifier, label: type("Route", (), {"identifier": identifier, "display_name": label})()
        track.available_input_routing_types = [route("all-ins", "All Ins")]
        track.available_input_routing_channels = [route("all-channels", "All Channels")]
        track.available_output_routing_types = [route("main", "Main")]
        track.available_output_routing_channels = [route("", "")]
        track.current_input_routing = "Ext: All Ins"
        track.current_input_sub_routing = ""
        track.current_output_routing = "Master"
        track.current_output_sub_routing = ""

        observed = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 3)

        self.assertEqual(observed["routing"]["input"]["type"], {"id": "all-ins", "name": "All Ins"})
        self.assertEqual(observed["routing"]["input"]["channel"], {"id": "all-channels", "name": "All Channels"})
        self.assertEqual(observed["routing"]["output"]["type"], {"id": "main", "name": "Main"})

    def test_track_state_recall_rejects_ambiguous_native_setter_label(self):
        song = Song()
        route = lambda identifier: type("Route", (), {"identifier": identifier, "display_name": "Bass"})()
        song.tracks[0].available_output_routing_types = [route("bass-a"), route("bass-b")]
        song.tracks[0].current_output_routing = song.tracks[0].available_output_routing_types[0]
        before = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        target = {"format": "cavi-track-state-v1",
                  "track": {"name": "Synth", "type": "midi", "isGroup": False},
                  "mixer": {"volume": 0.75, "pan": 0.0, "mute": False, "solo": False,
                            "sends": [{"id": "send-0", "name": "Reverb", "value": 0.2}]},
                  "routing": {"inputTypeId": "all-ins", "inputChannelId": "all-channels",
                              "outputTypeId": "bass-b", "outputChannelId": "post-mixer", "monitoring": 1},
                  "devices": [{"name": "Serum 2", "className": "PluginDevice", "type": "unknown",
                               "parameters": [{"originalName": "Filter Freq", "min": 0.0, "max": 1.0,
                                               "quantized": False, "valueItems": [], "value": 0.4},
                                              {"originalName": "Filter Type", "min": 0.0, "max": 2.0,
                                               "quantized": True, "valueItems": ["Low-pass", "Band-pass", "High-pass"], "value": 1.0}]}]}
        with self.assertRaisesRegex(ValueError, "ambiguous routing label"):
            dispatch_request(song, {"method": "set_track_state_snapshot", "params": {
                "trackId": "track-0", "before": before, "target": target}}, 6)

    def test_track_state_recall_refreshes_channels_after_changing_routing_type(self):
        class DynamicTrack(Track):
            @property
            def current_output_routing(self):
                return self._current_output_routing
            @current_output_routing.setter
            def current_output_routing(self, value):
                self._current_output_routing = value
                name = str(getattr(value, "display_name", value))
                route = lambda identifier, label: type("Route", (), {"identifier": identifier, "display_name": label})()
                self.available_output_routing_channels = [route("external-3-4", "3/4")] if name == "External Out" else [route("post-mixer", "Post Mixer")]
            @property
            def current_output_sub_routing(self):
                return self._current_output_sub_routing
            @current_output_sub_routing.setter
            def current_output_sub_routing(self, value):
                name = str(getattr(value, "display_name", value))
                if hasattr(self, "available_output_routing_channels") and not any(
                        str(getattr(choice, "display_name", choice)) == name for choice in self.available_output_routing_channels):
                    raise RuntimeError("channel unavailable for current type")
                self._current_output_sub_routing = value
        song = Song()
        song.tracks[0] = DynamicTrack()
        song.tracks[0].clip_slots = [ClipSlot(), ClipSlot(False)]
        route = lambda identifier, label: type("Route", (), {"identifier": identifier, "display_name": label})()
        song.tracks[0].available_output_routing_types = [route("main", "Main"), route("external", "External Out")]
        song.tracks[0].current_output_routing = song.tracks[0].available_output_routing_types[0]
        before = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        target = {"format": "cavi-track-state-v1", "track": {"name": "Synth", "type": "midi", "isGroup": False},
                  "mixer": {"volume": 0.75, "pan": 0.0, "mute": False, "solo": False,
                            "sends": [{"id": "send-0", "name": "Reverb", "value": 0.2}]},
                  "routing": {"inputTypeId": "all-ins", "inputChannelId": "all-channels",
                              "outputTypeId": "external", "outputChannelId": "external-3-4", "monitoring": 1},
                  "devices": [{"name": "Serum 2", "className": "PluginDevice", "type": "unknown",
                               "parameters": [{"originalName": "Filter Freq", "min": 0.0, "max": 1.0,
                                               "quantized": False, "valueItems": [], "value": 0.4},
                                              {"originalName": "Filter Type", "min": 0.0, "max": 2.0,
                                               "quantized": True, "valueItems": ["Low-pass", "Band-pass", "High-pass"], "value": 1.0}]}]}
        result = dispatch_request(song, {"method": "set_track_state_snapshot", "params": {
            "trackId": "track-0", "before": before, "target": target}}, 6)
        self.assertEqual(result["routing"]["output"]["type"]["id"], "external")
        self.assertEqual(result["routing"]["output"]["channel"]["id"], "external-3-4")
        parameter = song.tracks[0].devices[0].parameters[0]
        class FailingParameter(type(parameter)):
            @property
            def value(self):
                return self._value
            @value.setter
            def value(self, value):
                if value == 0.9:
                    raise RuntimeError("parameter write failed")
                self._value = value
        failing = FailingParameter()
        failing._value = parameter.value
        song.tracks[0].devices[0].parameters[0] = failing
        before_failure = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 7)
        rollback_target = copy.deepcopy(target)
        rollback_target["routing"].update({"outputTypeId": "main", "outputChannelId": "post-mixer"})
        rollback_target["devices"][0]["parameters"][0]["value"] = 0.9
        with self.assertRaisesRegex(RuntimeError, "parameter write failed"):
            dispatch_request(song, {"method": "set_track_state_snapshot", "params": {
                "trackId": "track-0", "before": before_failure, "target": rollback_target}}, 7)
        after_failure = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 7)
        self.assertEqual(after_failure, before_failure)

    def test_group_routing_does_not_access_unsupported_monitoring(self):
        song = Song()
        group = song.tracks[0]
        group.is_foldable = True
        del group.current_monitoring_state
        observed = dispatch_request(song, {"method": "get_track_routing", "params": {"trackId": "track-0"}}, 3)
        self.assertIsNone(observed["monitoring"])
        previous = group.current_output_routing
        with self.assertRaisesRegex(ValueError, "monitoring is not supported"):
            dispatch_request(song, {"method": "set_track_routing", "params": {"trackId": "track-0", "changes": {
                "outputTypeId": {"value": {"id": "no-output"}}, "monitoring": {"value": {"value": 0}}
            }}}, 3)
        self.assertEqual(group.current_output_routing, previous)

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

    def test_factory_load_reports_actual_inserted_device_and_shifted_order(self):
        song, application = Song(), Application()
        owner = song.tracks[0]
        before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        application.browser.load_item = lambda item: owner.devices.insert(0, NestedDevice("EQ Eight", "Eq8", 2))
        loaded = dispatch_request(song, {"method": "load_factory_browser_item", "params": {
            "root": "instruments", "path": ["Drift"], "trackId": "track-0", "before": before,
        }}, 3, application)
        self.assertIn("deviceChainEffect", loaded)
        self.assertEqual(loaded["deviceChainEffect"], {
            "kind": "inserted", "insertedIndex": 0, "deviceId": "track-0:device-0",
            "removedIndices": [], "oldOrderPreserved": True,
        })
        self.assertEqual([device["name"] for device in loaded["deviceChain"]["devices"]], ["EQ Eight", "Serum 2"])

    def test_factory_load_reports_replacement_without_claiming_an_append(self):
        song, application = Song(), Application()
        owner = song.tracks[0]
        before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        application.browser.load_item = lambda item: owner.devices.__setitem__(0, NestedDevice("Drift", "Drift", 1))
        loaded = dispatch_request(song, {"method": "load_factory_browser_item", "params": {
            "root": "instruments", "path": ["Drift"], "trackId": "track-0", "before": before,
        }}, 3, application)
        self.assertIn("deviceChainEffect", loaded)
        self.assertEqual(loaded["deviceChainEffect"]["kind"], "replaced")
        self.assertEqual(loaded["deviceChainEffect"]["insertedIndex"], 0)
        self.assertEqual(loaded["deviceChainEffect"]["removedIndices"], [0])

    def test_factory_load_matches_recreated_wrappers_for_the_same_native_device(self):
        song, application = Song(), Application()
        owner = song.tracks[0]

        class ProxyDevice(NestedDevice):
            def __init__(self, key, name):
                super().__init__(name, "Eq8", 2)
                self.key = key

            def __eq__(self, other):
                return isinstance(other, ProxyDevice) and self.key == other.key

        owner.devices = [ProxyDevice("existing-eq", "EQ Eight")]
        before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 3)
        application.browser.load_item = lambda item: setattr(owner, "devices", [
            ProxyDevice("existing-eq", "EQ Eight"), ProxyDevice("new-utility", "Utility")])
        loaded = dispatch_request(song, {"method": "load_factory_browser_item", "params": {
            "root": "instruments", "path": ["Drift"], "trackId": "track-0", "before": before,
        }}, 3, application)
        self.assertEqual(loaded["deviceChainEffect"]["kind"], "inserted")
        self.assertEqual(loaded["deviceChainEffect"]["insertedIndex"], 1)
        self.assertEqual(loaded["deviceChainEffect"]["removedIndices"], [])

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

    def test_browser_load_targets_return_and_master_device_owners(self):
        song = Song()
        application = Application()
        song.return_tracks[0].devices = []
        song.master_track.devices = []
        original_selection = song.view.selected_track
        for owner_id, owner in [("return-0", song.return_tracks[0]), ("master", song.master_track)]:
            before = dispatch_request(song, {"method": "list_devices", "params": {"trackId": owner_id}}, 3)
            loaded = dispatch_request(song, {"method": "load_browser_item", "params": {
                "root": "user_library", "path": ["Drift"], "trackId": owner_id, "before": before,
            }}, 3, application)
            self.assertEqual(loaded["trackId"], owner_id)
            self.assertIs(song.view.selected_track, original_selection)
            self.assertIsNot(owner, original_selection)

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

    def test_live_browser_user_folders_vector_supports_listing_and_search(self):
        application = Application()
        application.browser.user_folders = BrowserItemVector(
            application.browser.user_folders.children
        )
        listing = dispatch_request(Song(), {"method": "get_browser_items", "params": {
            "root": "user_folders", "path": [],
        }}, 3, application)
        self.assertEqual([item["name"] for item in listing["children"]], ["Splice"])
        result = dispatch_request(Song(), {"method": "search_browser_items", "params": {
            "root": "user_folders", "path": [], "query": "snare", "maxDepth": 3, "limit": 10,
        }}, 3, application)
        self.assertEqual(result["results"][0]["path"], ["Splice", "Drums", "Snare.wav"])

    def test_browser_listing_pages_large_roots_without_serializing_all_children(self):
        application = Application()
        items = tuple(BrowserItem(f"Sound-{index}", f"query:sound-{index}", True) for index in range(250))
        application.browser.samples = BrowserItem("Samples", "query:samples", children=items)
        page = dispatch_request(Song(), {"method": "get_browser_items", "params": {
            "root": "samples", "path": [], "offset": 100, "limit": 25,
        }}, 3, application)
        self.assertEqual(len(page["children"]), 25)
        self.assertEqual(page["children"][0]["name"], "Sound-100")
        self.assertEqual(page["children"][-1]["name"], "Sound-124")
        self.assertEqual(page["totalChildren"], 250)
        self.assertEqual(page["nextOffset"], 125)

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
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
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

    def test_arrangement_duplication_checks_identity_collision_and_preserves_source(self):
        song = Song()
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        track = song.tracks[0]
        source = SimpleNamespace(name="Verse", start_time=0, end_time=4, length=4, is_audio_clip=False)
        track.arrangement_clips = [source]
        def duplicate(clip, start):
            result = copy.deepcopy(clip)
            result.start_time, result.end_time = start, start + 4
            track.arrangement_clips.append(result)
            return result
        track.duplicate_clip_to_arrangement = duplicate
        before = {"id": "track-0:arrangement-clip-0", "name": "Verse", "startBeats": 0.0,
                  "endBeats": 4.0, "lengthBeats": 4.0, "type": "midi"}
        params = {"trackId": "track-0", "clipId": before["id"], "before": before, "startBeats": 4.0}
        result = dispatch_request(song, {"method": "duplicate_arrangement_clip", "params": params}, 3)
        self.assertEqual(result["duplicatedClip"]["startBeats"], 4.0)
        self.assertIs(track.arrangement_clips[0], source)
        self.assertEqual(boundaries, ["begin", "end"])
        with self.assertRaisesRegex(ValueError, "identity changed"):
            dispatch_request(song, {"method": "duplicate_arrangement_clip", "params": {**params, "before": {**before, "name": "Wrong"}}}, 4)
        with self.assertRaisesRegex(ValueError, "overlap"):
            dispatch_request(song, {"method": "duplicate_arrangement_clip", "params": {**params, "startBeats": 2.0}}, 4)

    def test_arrangement_duplication_rejects_shifted_native_copy_and_reports_failed_cleanup(self):
        for cleanup_fails in (False, True):
            song = Song()
            track = song.tracks[0]
            source = SimpleNamespace(name="Verse", start_time=0, end_time=4, length=4, is_audio_clip=False)
            track.arrangement_clips = [source]
            def duplicate(clip, start):
                result = copy.deepcopy(clip)
                result.start_time, result.end_time = start + 1, start + 5
                track.arrangement_clips.append(result)
                return result
            track.duplicate_clip_to_arrangement = duplicate
            def delete(clip):
                if cleanup_fails:
                    raise RuntimeError("cleanup exploded")
                track.arrangement_clips.remove(clip)
            track.delete_clip = delete
            before = {"id": "track-0:arrangement-clip-0", "name": "Verse", "startBeats": 0.0,
                      "endBeats": 4.0, "lengthBeats": 4.0, "type": "midi"}
            message = "rollback failed.*cleanup exploded" if cleanup_fails else "changed the duplicated clip interval"
            with self.assertRaisesRegex((RuntimeError if cleanup_fails else ValueError), message):
                dispatch_request(song, {"method": "duplicate_arrangement_clip", "params": {
                    "trackId": "track-0", "clipId": before["id"], "before": before, "startBeats": 8.0}}, 3)
            self.assertEqual(len(track.arrangement_clips), 2 if cleanup_fails else 1)
            self.assertEqual(song.undo_boundaries, ["begin", "end"])

    def test_arrangement_duplication_rejects_large_position_relative_drift(self):
        song = Song()
        track = song.tracks[0]
        source = SimpleNamespace(name="Verse", start_time=0, end_time=4, length=4, is_audio_clip=False)
        track.arrangement_clips = [source]
        def duplicate(clip, start):
            result = copy.deepcopy(clip)
            result.start_time, result.end_time = start + 1_000_000, start + 1_000_004
            track.arrangement_clips.append(result)
            return result
        track.duplicate_clip_to_arrangement = duplicate
        track.delete_clip = lambda clip: track.arrangement_clips.remove(clip)
        before = {"id": "track-0:arrangement-clip-0", "name": "Verse", "startBeats": 0.0,
                  "endBeats": 4.0, "lengthBeats": 4.0, "type": "midi"}
        with self.assertRaisesRegex(ValueError, "changed the duplicated clip interval"):
            dispatch_request(song, {"method": "duplicate_arrangement_clip", "params": {
                "trackId": "track-0", "clipId": before["id"], "before": before,
                "startBeats": 9_000_000_000_000_000.0}}, 3)
        self.assertEqual(track.arrangement_clips, [source])

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

    def test_create_return_track_appends_named_bus_and_rejects_stale_bus_list(self):
        song = Song()
        song.begin_undo_step = lambda: song.undo_boundaries.append("begin")
        song.end_undo_step = lambda: song.undo_boundaries.append("end")
        def create_return_track():
            mixer = lambda: type("Mixer", (), {
                "volume": type("Value", (), {"value": 0.6, "min": 0.0, "max": 1.0})(),
                "panning": type("Value", (), {"value": 0.0, "min": -1.0, "max": 1.0})(),
            })()
            song.return_tracks.append(type("ReturnTrack", (), {
                "name": "Audio", "mixer_device": mixer(), "mute": False, "solo": False,
            })())
        song.create_return_track = create_return_track
        before = dispatch_request(song, {"method": "get_set_mixer"}, 3)["returns"]
        params = {"beforeReturns": before, "name": "Parallel Crush"}
        result = dispatch_request(song, {"method": "create_return_track", "params": params}, 3)
        self.assertEqual(result["return"], {"id": "return-1", "name": "Parallel Crush"})
        self.assertEqual(song.undo_boundaries, ["begin", "end"])
        with self.assertRaisesRegex(ValueError, "return tracks changed"):
            dispatch_request(song, {"method": "create_return_track", "params": params}, 4)

    def test_rename_return_track_requires_exact_current_identity(self):
        song = Song()
        target = {"targetType": "return", "targetId": "return-0",
                  "previousName": "Reverb", "name": "Short Verb"}
        result = dispatch_request(song, {"method": "rename_session_object", "params": {"target": target}}, 3)
        self.assertEqual(result["target"]["name"], "Short Verb")
        self.assertEqual(song.return_tracks[0].name, "Short Verb")
        with self.assertRaisesRegex(ValueError, "return track identity changed"):
            dispatch_request(song, {"method": "rename_session_object", "params": {"target": target}}, 4)

    def test_delete_return_track_requires_exact_snapshot_and_uses_native_undo(self):
        song = Song()
        song.return_tracks[0].devices = [Device()]
        song.return_tracks[0].mixer_device.sends = []
        song.begin_undo_step = lambda: song.undo_boundaries.append("begin")
        song.end_undo_step = lambda: song.undo_boundaries.append("end")
        song.delete_return_track = lambda index: song.return_tracks.pop(index)
        before = dispatch_request(song, {"method": "get_set_mixer"}, 3)["returns"][0]
        target = {"targetType": "return", "targetId": "return-0", **before,
                  "affectedTrackSends": []}
        result = dispatch_request(song, {"method": "delete_session_object", "params": {"target": target}}, 3)
        self.assertEqual(result["deleted"]["targetId"], "return-0")
        self.assertEqual(song.undo_boundaries, ["begin", "end"])
        self.assertEqual(len(song.return_tracks), 0)

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

    def test_device_sidechain_routing_reads_native_ids_and_unsupported_devices(self):
        song = Song()
        params = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        unsupported = dispatch_request(song, {"method": "get_device_sidechain_routing", "params": params}, 3)
        self.assertEqual(unsupported["sidechain"], {"supported": False, "type": None, "channel": None,
            "availableTypes": [], "availableChannels": []})
        device = song.tracks[0].devices[0]
        source = SimpleNamespace(identifier=42, display_name="Bass Bus")
        channel = SimpleNamespace(identifier="post-fx", display_name="Post FX")
        device.available_input_routing_types = (source,)
        device.available_input_routing_channels = (channel,)
        device.input_routing_type, device.input_routing_channel = source, channel
        result = dispatch_request(song, {"method": "get_device_sidechain_routing", "params": params}, 3)
        self.assertEqual(result["sidechain"], {"supported": True, "type": {"id": "42", "name": "Bass Bus"},
            "channel": {"id": "post-fx", "name": "Post FX"}, "availableTypes": [{"id": "42", "name": "Bass Bus"}],
            "availableChannels": [{"id": "post-fx", "name": "Post FX"}]})
        self.assertEqual(result["deviceId"], "track-0:device-0")

    def test_sidechain_mutation_binds_state_and_assigns_native_object(self):
        song = Song()
        device = song.tracks[0].devices[0]
        source = SimpleNamespace(identifier="bass", display_name="Bass")
        original = SimpleNamespace(identifier="none", display_name="No Input")
        channel = SimpleNamespace(identifier="post", display_name="Post FX")
        device.available_input_routing_types = (original, source)
        device.available_input_routing_channels = (channel,)
        device.input_routing_type, device.input_routing_channel = original, channel
        params = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_sidechain_routing", "params": params}, 3)
        change = {**params, "before": before, "changes": {"sourceTypeId": {"value": {"id": "bass", "name": "Bass"}}}}
        result = dispatch_request(song, {"method": "set_device_sidechain_routing", "params": change}, 3)
        self.assertIs(device.input_routing_type, source)
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(song.undo_boundaries, ["begin", "end"])
        with self.assertRaisesRegex(ValueError, "changed"):
            dispatch_request(song, {"method": "set_device_sidechain_routing", "params": change}, 3)

    def test_audio_mutations_have_isolated_undo_boundaries(self):
        for method, extra in (
            ("set_audio_clip_state", {"changes": {"gain": {"value": 0.25}}}),
            ("add_audio_warp_marker", {"beatTime": 1, "sampleTime": 0.5}),
            ("move_audio_warp_marker", {"beatTime": 2, "targetBeatTime": 2.5}),
            ("remove_audio_warp_marker", {"beatTime": 2}),
            ("quantize_audio_clip", {"grid": "1_4", "amount": 1, "beforeSwingAmount": 0}),
        ):
            with self.subTest(method=method):
                song = Song()
                clip = song.tracks[0].clip_slots[2].clip
                clip.warp_markers = (SimpleNamespace(sample_time=0, beat_time=0),
                    SimpleNamespace(sample_time=1, beat_time=2), SimpleNamespace(sample_time=2, beat_time=4))
                def native(*args):
                    self.assertEqual(song.undo_boundaries, ["begin"])
                    clip.pitch_fine = 5
                clip.add_warp_marker = clip.move_warp_marker = clip.remove_warp_marker = clip.quantize = native
                params = {"trackId": "track-0", "clipId": "track-0:clip-2", **extra}
                before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
                live = SimpleNamespace(Song=SimpleNamespace(RecordingQuantization=SimpleNamespace(rec_q_quarter=1)))
                with patch("bridge.Live", live):
                    result = dispatch_request(song, {"method": method, "params": {**params, "before": before}}, 3)
                self.assertEqual(song.undo_boundaries, ["begin", "end"])
                self.assertEqual(result["gain"]["value"] if method == "set_audio_clip_state" else result["pitch"]["fine"],
                    0.25 if method == "set_audio_clip_state" else 5)
                song.undo_boundaries.clear()
                with self.assertRaisesRegex(ValueError, "state changed"):
                    dispatch_request(song, {"method": method, "params": {**params, "before": before}}, 3)
                self.assertEqual(song.undo_boundaries, [])

    def test_audio_mutation_failures_close_their_undo_step(self):
        class RejectGain(AudioClip):
            def __setattr__(self, name, value):
                if name == "gain" and getattr(self, "reject_gain", False):
                    raise RuntimeError("native edit failed")
                super().__setattr__(name, value)
        for method, extra in (
            ("set_audio_clip_state", {"changes": {"gain": {"value": 0.25}}}),
            ("add_audio_warp_marker", {"beatTime": 1, "sampleTime": 0.5}),
            ("move_audio_warp_marker", {"beatTime": 2, "targetBeatTime": 2.5}),
            ("remove_audio_warp_marker", {"beatTime": 2}),
            ("quantize_audio_clip", {"grid": "1_4", "amount": 1, "beforeSwingAmount": 0}),
        ):
            with self.subTest(method=method):
                song = Song()
                clip = RejectGain()
                song.tracks[0].clip_slots[2].clip = clip
                clip.reject_gain = True
                clip.warp_markers = (SimpleNamespace(sample_time=0, beat_time=0),
                    SimpleNamespace(sample_time=1, beat_time=2), SimpleNamespace(sample_time=2, beat_time=4))
                def native(*args):
                    self.assertEqual(song.undo_boundaries, ["begin"])
                    raise RuntimeError("native edit failed")
                clip.add_warp_marker = clip.move_warp_marker = clip.remove_warp_marker = clip.quantize = native
                params = {"trackId": "track-0", "clipId": "track-0:clip-2", **extra}
                before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
                live = SimpleNamespace(Song=SimpleNamespace(RecordingQuantization=SimpleNamespace(rec_q_quarter=1)))
                with patch("bridge.Live", live):
                    with self.assertRaisesRegex(RuntimeError, "native edit failed"):
                        dispatch_request(song, {"method": method, "params": {**params, "before": before}}, 3)
                self.assertEqual(song.undo_boundaries, ["begin", "end"])
                self.assertEqual(dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3), before)

    def test_audio_state_exposes_loop_bounds_in_current_units(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.loop_start, clip.loop_end = 1, 3
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": {"trackId": "track-0", "clipId": "track-0:clip-2"}}, 3)
        self.assertEqual(result["loop"], {"enabled": True, "unit": "beats", "startBeats": 1.0, "endBeats": 3.0})
        clip.warping = False
        clip.looping = False
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": {"trackId": "track-0", "clipId": "track-0:clip-2"}}, 3)
        self.assertEqual(result["loop"], {"enabled": False, "unit": "seconds", "startSeconds": 1.0, "endSeconds": 3.0})

    def test_crop_audio_clip_rejects_changed_loop_before_native_call(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.loop_start, clip.loop_end = 1, 3
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        def crop():
            self.assertEqual(boundaries, ["begin"])
            clip.start_marker, clip.end_marker = 0, 2
            clip.loop_start, clip.loop_end = 0, 2
        clip.crop = crop
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        clip.loop_end = 4
        with self.assertRaisesRegex(ValueError, "state changed"):
            dispatch_request(song, {"method": "crop_audio_clip", "params": {**params, "before": before}}, 3)
        self.assertEqual(clip.start_marker, 0)
        clip.loop_end = 3
        result = dispatch_request(song, {"method": "crop_audio_clip", "params": {**params, "before": before}}, 3)
        self.assertEqual(result["markers"], {"unit": "beats", "startBeats": 0.0, "endBeats": 2.0})
        self.assertEqual(result["loop"]["endBeats"], 2)
        self.assertEqual(boundaries, ["begin", "end"])

    def test_crop_audio_clip_unavailable_api_and_failure_close_undo_step(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        boundaries = []
        song.begin_undo_step = lambda: boundaries.append("begin")
        song.end_undo_step = lambda: boundaries.append("end")
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        with self.assertRaisesRegex(ValueError, "crop API required"):
            dispatch_request(song, {"method": "crop_audio_clip", "params": {**params, "before": before}}, 3)
        self.assertEqual(boundaries, [])
        def crop():
            raise RuntimeError("native crop failed")
        clip.crop = crop
        with self.assertRaisesRegex(RuntimeError, "native crop failed"):
            dispatch_request(song, {"method": "crop_audio_clip", "params": {**params, "before": before}}, 3)
        self.assertEqual(boundaries, ["begin", "end"])
        self.assertEqual(clip.end_marker, 8)

    def test_quantize_audio_clip_uses_native_grid_and_rejects_stale_markers(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0.26),)
        native_grid = object()
        def quantize(grid, amount):
            self.assertIs(grid, native_grid)
            self.assertEqual(amount, 0.75)
            clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0),)
        clip.quantize = quantize
        params = {"trackId": "track-0", "clipId": "track-0:clip-2", "grid": "1_8_triplet", "amount": 0.75, "beforeSwingAmount": 0}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        live = SimpleNamespace(Song=SimpleNamespace(RecordingQuantization=SimpleNamespace(rec_q_eight_triplet=native_grid)))
        with patch("bridge.Live", live):
            song.swing_amount = 0.5
            with self.assertRaisesRegex(ValueError, "swing.*changed"):
                dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, "before": before}}, 3)
            song.swing_amount = 0
            for changes in ({"grid": "none"}, {"amount": -0.1}, {"amount": 1.1}, {"amount": True}, {"amount": float("nan")}):
                with self.assertRaisesRegex(ValueError, "grid|amount"):
                    dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, **changes, "before": before}}, 3)
            result = dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, "before": before}}, 3)
            self.assertEqual(result["warpMarkers"]["markers"], [{"sampleTime": 0.13, "beatTime": 0.0}])
            with self.assertRaisesRegex(ValueError, "state changed"):
                dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, "before": before}}, 3)

    def test_quantize_audio_clip_all_native_grids_and_unavailable_enum(self):
        for grid, attribute in (
            ("1_4", "rec_q_quarter"), ("1_8", "rec_q_eight"),
            ("1_8_triplet", "rec_q_eight_triplet"), ("1_8_and_triplet", "rec_q_eight_eight_triplet"),
            ("1_16", "rec_q_sixtenth"), ("1_16_triplet", "rec_q_sixtenth_triplet"),
            ("1_16_and_triplet", "rec_q_sixtenth_sixtenth_triplet"), ("1_32", "rec_q_thirtysecond"),
        ):
            with self.subTest(grid=grid):
                song = Song()
                clip = song.tracks[0].clip_slots[2].clip
                clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0.26),)
                native_grid = object()
                def quantize(value, amount):
                    self.assertIs(value, native_grid)
                    self.assertEqual(amount, 1)
                    clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0),)
                clip.quantize = quantize
                params = {"trackId": "track-0", "clipId": "track-0:clip-2", "grid": grid, "amount": 1, "beforeSwingAmount": 0}
                before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
                with patch("bridge.Live", None):
                    with self.assertRaisesRegex(ValueError, "grid unavailable"):
                        dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, "before": before}}, 3)
                live = SimpleNamespace(Song=SimpleNamespace(RecordingQuantization=SimpleNamespace(**{attribute: native_grid})))
                with patch("bridge.Live", live):
                    result = dispatch_request(song, {"method": "quantize_audio_clip", "params": {**params, "before": before}}, 3)
                self.assertEqual(result["warpMarkers"]["markers"], [{"sampleTime": 0.13, "beatTime": 0.0}])

    def test_add_audio_warp_marker_returns_native_anchor_and_rejects_stale_state(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warp_markers = (SimpleNamespace(sample_time=0, beat_time=0), SimpleNamespace(sample_time=2, beat_time=4))
        def add(marker):
            if not isinstance(marker, SimpleNamespace):
                raise TypeError("native warp marker object required")
            clip.warp_markers = (clip.warp_markers[0], SimpleNamespace(
                sample_time=marker.sample_time, beat_time=marker.beat_time), clip.warp_markers[-1])
        clip.add_warp_marker = add
        params = {"trackId": "track-0", "clipId": "track-0:clip-2", "beatTime": 1, "sampleTime": 0.6}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        result = dispatch_request(song, {"method": "add_audio_warp_marker", "params": {**params, "before": before}}, 3)
        self.assertEqual(result["warpMarkers"]["markers"][1], {"sampleTime": 0.6, "beatTime": 1.0})
        with self.assertRaisesRegex(ValueError, "state changed"):
            dispatch_request(song, {"method": "add_audio_warp_marker", "params": {**params, "before": before}}, 3)

    def test_add_audio_warp_marker_uses_native_time_conversion_when_sample_omitted(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        class Marker:
            def __init__(self, sample_time, beat_time):
                self.sample_time, self.beat_time = sample_time, beat_time
        clip.warp_markers = (Marker(0, 0), Marker(2, 4))
        clip.sample_rate = 48000
        clip.beat_to_sample_time = lambda beat: 24000 * beat
        clip.add_warp_marker = lambda marker: setattr(clip, "warp_markers", (
            clip.warp_markers[0], marker, clip.warp_markers[-1]))
        params = {"trackId": "track-0", "clipId": "track-0:clip-2", "beatTime": 1}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        result = dispatch_request(song, {"method": "add_audio_warp_marker", "params": {**params, "before": before}}, 3)
        self.assertEqual(result["warpMarkers"]["markers"][1], {"sampleTime": 0.5, "beatTime": 1.0})

    def test_audio_source_time_conversion_uses_native_clip_mapping_not_sparse_markers(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.sample_rate = 48000
        clip.sample_length = 48000
        clip.warp_markers = tuple(SimpleNamespace(sample_time=s, beat_time=b) for s, b in ((0, 0), (1, 2)))
        clip.sample_to_beat_time = lambda samples: samples / 24000 + (samples / 48000) ** 2
        request = {"method": "get_audio_source_beat_times", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-2", "sourceSeconds": [0.5]}}
        result = dispatch_request(song, request, 3)
        self.assertEqual(result["points"], [{"sourceSeconds": 0.5, "beatTime": 1.25}])
        self.assertEqual(result["stateVersion"], 3)
        clip.warping = False
        with self.assertRaisesRegex(ValueError, "warped"):
            dispatch_request(song, request, 3)

    def test_remove_audio_warp_marker_returns_remaining_native_positions(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warp_markers = tuple(SimpleNamespace(sample_time=s, beat_time=b) for s, b in (
            (0, 0), (0.6, 1.2), (2, 4), (2.01, 4.02)))
        def remove(beat):
            clip.warp_markers = tuple(m for m in clip.warp_markers if m.beat_time != beat)
        clip.remove_warp_marker = remove
        params = {"trackId": "track-0", "clipId": "track-0:clip-2", "beatTime": 1.2}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        result = dispatch_request(song, {"method": "remove_audio_warp_marker", "params": {**params, "before": before}}, 3)
        self.assertEqual([m["beatTime"] for m in result["warpMarkers"]["markers"]], [0, 4, 4.02])
        with self.assertRaisesRegex(ValueError, "state changed"):
            dispatch_request(song, {"method": "remove_audio_warp_marker", "params": {**params, "before": before}}, 3)
        for beat in (3, 4.02, float("nan"), True):
            with self.assertRaisesRegex(ValueError, "marker"):
                dispatch_request(song, {"method": "remove_audio_warp_marker", "params": {
                    **params, "before": result, "beatTime": beat}}, 4)
        self.assertEqual(len(clip.warp_markers), 3)

    def test_move_audio_warp_marker_uses_native_distance_and_rejects_crossing(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warp_markers = tuple(SimpleNamespace(sample_time=s, beat_time=b) for s, b in (
            (0, 0), (0.6, 1.2), (2, 4), (2.01, 4.02)))
        def move(beat, distance):
            marker = next(m for m in clip.warp_markers if m.beat_time == beat)
            marker.beat_time += distance
        clip.move_warp_marker = move
        params = {"trackId": "track-0", "clipId": "track-0:clip-2", "beatTime": 1.2, "targetBeatTime": 1.0}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        result = dispatch_request(song, {"method": "move_audio_warp_marker", "params": {**params, "before": before}}, 3)
        self.assertEqual(result["warpMarkers"]["markers"][1], {"sampleTime": 0.6, "beatTime": 1.0})
        with self.assertRaisesRegex(ValueError, "state changed"):
            dispatch_request(song, {"method": "move_audio_warp_marker", "params": {**params, "before": before}}, 3)
        for beat, target in ((1.0, 4.0), (3.0, 2.0), (4.02, 4.01)):
            current = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 4)
            with self.assertRaisesRegex(ValueError, "marker|neighbor"):
                dispatch_request(song, {"method": "move_audio_warp_marker", "params": {
                    **params, "before": current, "beatTime": beat, "targetBeatTime": target}}, 4)
        self.assertEqual(clip.warp_markers[1].beat_time, 1.0)

    def test_audio_state_exposes_native_warp_marker_positions(self):
        song = Song()
        song.tracks[0].clip_slots[2].clip.warp_markers = (
            SimpleNamespace(sample_time=0.13, beat_time=0.0),
            SimpleNamespace(sample_time=0.64, beat_time=1.0),
        )
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-2"
        }}, 3)
        self.assertEqual(result["warpMarkers"], {"supported": True, "markers": [
            {"sampleTime": 0.13, "beatTime": 0.0},
            {"sampleTime": 0.64, "beatTime": 1.0},
        ]})

    def test_audio_state_distinguishes_empty_warp_markers_from_unavailable_api(self):
        song = Song()
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        self.assertEqual(result["warpMarkers"], {"supported": False, "markers": []})
        song.tracks[0].clip_slots[2].clip.warp_markers = ()
        result = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        self.assertEqual(result["warpMarkers"], {"supported": True, "markers": []})

    def test_audio_mutation_rejects_native_warp_marker_changes_after_planning(self):
        song = Song()
        clip = song.tracks[0].clip_slots[2].clip
        clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0.25),)
        params = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        before = dispatch_request(song, {"method": "get_audio_clip_state", "params": params}, 3)
        clip.warp_markers = (SimpleNamespace(sample_time=0.13, beat_time=0.0),)
        with self.assertRaisesRegex(ValueError, "audio clip identity or state changed"):
            dispatch_request(song, {"method": "set_audio_clip_state", "params": {
                **params, "before": before, "changes": {"gain": {"value": 0.75}}
            }}, 3)
        self.assertEqual(clip.gain, before["gain"]["value"])

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

    def test_groove_base_choices_use_native_enum_values(self):
        song = Song()
        class NativeGrid(int):
            pass
        for attribute, value in (("gb_four", 10), ("gb_eight", 11), ("gb_eight_triplet", 12),
                ("gb_sixteen", 3), ("gb_sixteen_triplet", 14), ("gb_thirtytwo", 15)):
            setattr(NativeGrid, attribute, NativeGrid(value))
        song.groove_pool.grooves[0].base = NativeGrid.gb_sixteen
        live = None
        with patch("bridge.Live", live):
            before = dispatch_request(song, {"method": "get_song_musical_context"}, 3)
            grid = before["groove"]["pool"][0]["baseGrid"]
            self.assertEqual(grid["name"], "1_16")
            self.assertIn({"value": 14, "name": "1_16_triplet"}, grid["choices"])
            params = {"grooveId": "groove-0", "before": before,
                "changes": {"baseGrid": {"value": {"value": 14, "name": "1_16_triplet"}}}}
            result = dispatch_request(song, {"method": "set_groove", "params": params}, 3)
            self.assertEqual(result["groove"]["pool"][0]["base"], 14)
            self.assertEqual(song.undo_boundaries, ["begin", "end"])

    def test_clip_groove_context_captures_source_and_shared_dependencies(self):
        song = Song()
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        result = dispatch_request(song, {"method": "get_clip_groove_context", "params": target}, 3)
        self.assertEqual(result["stateVersion"], 3)
        self.assertEqual(result["source"]["type"], "midi")
        self.assertIn("notes", result["source"]["content"])
        self.assertEqual(result["musicalContext"]["groove"]["pool"][0]["velocityAmount"], -25)
        self.assertEqual(result["timing"]["clipId"], target["clipId"])
        audio_target = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        audio = dispatch_request(song, {"method": "get_clip_groove_context", "params": audio_target}, 3)
        self.assertEqual(audio["source"]["type"], "audio")
        self.assertEqual(audio["source"]["content"], dispatch_request(song, {"method": "get_audio_clip_state", "params": audio_target}, 3))
        song.tracks[0].clip_slots[0].has_clip = False
        with self.assertRaisesRegex(ValueError, "empty"):
            dispatch_request(song, {"method": "get_clip_groove_context", "params": target}, 3)

    def test_groove_edit_binds_pool_and_balances_undo(self):
        song = Song()
        before = dispatch_request(song, {"method": "get_song_musical_context"}, 3)
        params = {"grooveId": "groove-0", "before": before, "changes": {
            "timingAmount": {"value": 70}, "velocityAmount": {"value": -40}, "name": {"value": "Bass Swing"}}}
        result = dispatch_request(song, {"method": "set_groove", "params": params}, 3)
        self.assertEqual(result["groove"]["pool"][0]["timingAmount"], 70)
        self.assertEqual(result["groove"]["pool"][0]["velocityAmount"], -40)
        self.assertEqual(result["groove"]["pool"][0]["name"], "Bass Swing")
        self.assertEqual(song.undo_boundaries, ["begin", "end"])
        with self.assertRaisesRegex(ValueError, "changed"):
            dispatch_request(song, {"method": "set_groove", "params": params}, 3)

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
        self.assertEqual(observed["groove"]["pool"][0]["velocityAmount"], -25.0)
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
        chain.mixer_device = SimpleNamespace(volume=volume, panning=pan, sends=[Parameter()])
        chain.mute, chain.solo = True, False
        song.tracks[0].devices = [rack]
        result = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        mixer = result["device"]["chains"][0]["mixer"]
        self.assertEqual(mixer.get("sends"), [{"index": 0, "value": 0.4,
            "min": 0.0, "max": 1.0, "enabled": True}])
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

    def test_return_chain_device_parameters_are_addressable(self):
        song = Song()
        rack = DrumRack()
        nested = DrumRack()
        rack.return_chains = [Chain("Mix Bus", [nested])]
        song.tracks[0].devices = [rack]
        path = "track-0:device-0/return-chain-0/device-0/chain-0/device-0"
        ids = {"trackId": "track-0", "deviceId": path}
        result = dispatch_request(song, {"method": "list_device_parameters", "params": ids}, 3)
        self.assertEqual(result["deviceId"], path)
        dispatch_request(song, {"method": "set_device_parameters", "params": {
            **ids, "changes": [{"id": "parameter-0", "value": 0.7}]}}, 3)
        self.assertEqual(nested.chains[0].devices[0].parameters[0].value, 0.7)
        self.assertEqual(rack.chains[0].devices[0].parameters[0].value, 0.4)
        for bad in ("return-chain--1", "return-chain-x", "return-chain-99", "returns-0"):
            with self.assertRaises(ValueError):
                dispatch_request(song, {"method": "list_device_parameters", "params": {
                    "trackId": "track-0", "deviceId": f"track-0:device-0/{bad}/device-0"}}, 3)

    def test_return_chain_mixer_and_name_are_addressable(self):
        song = Song()
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        rack = DrumRack()
        chain = Chain("Reverb", [])
        chain.mixer_device = SimpleNamespace(volume=Parameter(), panning=Parameter())
        chain.mute, chain.solo = False, False
        rack.return_chains = [chain]
        song.tracks[0].devices = [rack]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        def request(method, **changes):
            before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
            return dispatch_request(song, {"method": method, "params": {
                **ids, "chainId": "track-0:device-0/return-chain-0", "beforeDevice": before, **changes}}, 3)
        request("set_rack_chain_mixer", changes={"volume": 0.5, "mute": True})
        self.assertEqual(chain.mixer_device.volume.value, 0.5)
        self.assertTrue(chain.mute)
        request("rename_rack_chain", name="Room")
        self.assertEqual(chain.name, "Room")
        with self.assertRaises(ValueError):
            request("set_rack_chain_note_routing", changes={"inputNote": 36})

    def test_rack_send_batches_validate_before_any_write(self):
        song = Song()
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        rack = DrumRack()
        chain = rack.chains[0]
        volume, send = Parameter(), Parameter()
        chain.mixer_device = SimpleNamespace(volume=volume, panning=Parameter(), sends=[send])
        song.tracks[0].devices = [rack]
        ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        base = {**ids, "chainId": "track-0:device-0/chain-0", "beforeDevice": before}
        for sends in ([], [{"index": 1, "value": 0.5}], [{"index": True, "value": 0.5}],
                      [{"index": 0, "value": 2}], [{"index": 0, "value": float("nan")}],
                      [{"index": 0, "value": 0.5}, {"index": 0, "value": 0.6}]):
            with self.assertRaises(ValueError):
                dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
                    **base, "changes": {"volume": 0.8, "sends": sends}}}, 3)
            self.assertEqual(volume.value, 0.4)
            self.assertEqual(send.value, 0.4)
        send.is_enabled = False
        disabled = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        with self.assertRaises(ValueError):
            dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
                **base, "beforeDevice": disabled, "changes": {
                    "volume": 0.8, "sends": [{"index": 0, "value": 0.5}]}}}, 3)
        self.assertEqual(volume.value, 0.4)
        self.assertEqual(send.value, 0.4)
        send.is_enabled = True
        dispatch_request(song, {"method": "set_rack_chain_mixer", "params": {
            **base, "changes": {"sends": [{"index": 0, "value": 0.5}]}}}, 3)
        self.assertEqual(send.value, 0.5)

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

    def test_move_device_into_return_chain_of_nested_return_rack(self):
        song = Song()
        source, outer, rack = Device(), DrumRack(), DrumRack()
        outer.return_chains = [SimpleNamespace(name="Bus", devices=[rack])]
        target = SimpleNamespace(name="FX", devices=[])
        rack.return_chains = [target]
        song.tracks[0].devices = [outer, source]
        song.begin_undo_step = lambda: None
        song.end_undo_step = lambda: None
        def move(device, destination, position):
            song.tracks[0].devices.remove(device)
            destination.devices.insert(position, device)
            return position
        song.move_device = move
        rack_id = "track-0:device-0/return-chain-0/device-0"
        ids = {"trackId": "track-0", "deviceId": "track-0:device-1"}
        before = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 3)["device"]
        destination = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
            "trackId": "track-0", "deviceId": rack_id}}, 3)["device"]
        result = dispatch_request(song, {"method": "move_device_to_chain", "params": {
            **ids, "targetTrackId": "track-0", "targetChainId": rack_id + "/return-chain-0",
            "targetPosition": 0, "beforeDevice": before, "beforeTargetRack": destination}}, 3)
        self.assertIs(target.devices[0], source)
        self.assertEqual(result["device"]["id"], rack_id + "/return-chain-0/device-0")

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

    def test_quantized_grid_without_value_items_exposes_native_choice_labels(self):
        class GridParameter(QuantizedParameter):
            def __init__(self):
                super().__init__()
                self.name = self.original_name = "Grid"
                self.value_items = ()
                self.value = 0.0

            def str_for_value(self, value):
                return {0: "1/16", 1: "1/12", 2: "1/32"}[int(value)]

        song = Song()
        song.tracks[0].devices[0].parameters = [GridParameter()]
        result = dispatch_request(song, {"method": "list_device_parameters", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 3)
        self.assertEqual(result["parameters"][0]["valueItems"], [])
        self.assertEqual(result["parameters"][0]["nativeChoiceLabels"], [
            {"value": 0, "displayValue": "1/16"},
            {"value": 1, "displayValue": "1/12"},
            {"value": 2, "displayValue": "1/32"}])

    def test_parameter_write_does_not_enumerate_unrequested_choice_labels(self):
        class GridParameter(QuantizedParameter):
            def __init__(self):
                super().__init__()
                self.name = self.original_name = "Grid"
                self.value_items = ()

            def str_for_value(self, value):
                return {0: "1/16", 1: "1/12", 2: "1/32"}[int(value)]

        song = Song()
        song.tracks[0].devices[0].parameters = [GridParameter()]
        result = dispatch_request(song, {"method": "set_device_parameters", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0",
            "changes": [{"id": "parameter-0", "value": 2}]}}, 3)
        self.assertEqual(result["observedChanges"][0]["displayValue"], "1/32")
        self.assertNotIn("nativeChoiceLabels", result["observedChanges"][0])

    def test_group_api_discovery_requires_callable_native_methods(self):
        song = Song()
        song.group_tracks = lambda: None
        song.ungroup_track = True
        result = dispatch_request(song, {"method": "get_live_state"}, 4)
        self.assertEqual(result["nativeApiSupport"], {"groupTracks": True, "ungroupTrack": False})
        del song.group_tracks
        result = dispatch_request(song, {"method": "get_live_state"}, 4)
        self.assertFalse(result["nativeApiSupport"]["groupTracks"])

    def test_track_state_snapshot_is_one_native_callback_with_ordered_device_parameters(self):
        song = Song()
        result = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        self.assertEqual(result["stateVersion"], 6)
        self.assertEqual(result["trackId"], "track-0")
        self.assertEqual(result["track"]["name"], song.tracks[0].name)
        self.assertEqual(result["track"]["type"], "midi")
        self.assertEqual(result["mixer"]["volume"]["value"], song.tracks[0].mixer_device.volume.value)
        self.assertEqual(result["routing"]["output"]["type"]["name"], "Main")
        self.assertEqual([device["id"] for device in result["devices"]], ["track-0:device-0"])
        self.assertEqual(result["devices"][0]["parameters"][0]["originalName"], "Filter Freq")

    def test_track_state_recall_applies_complete_target_in_one_undo_step(self):
        song = Song()
        before = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        target = {
            "format": "cavi-track-state-v1",
            "track": {"name": "Saved Bass", "type": "midi", "isGroup": False},
            "mixer": {"volume": 0.5, "pan": -0.25, "mute": True, "solo": False,
                      "sends": [{"id": "send-0", "name": "Reverb", "value": 0.6}]},
            "routing": {"inputTypeId": "all-ins", "inputChannelId": "all-channels",
                        "outputTypeId": "main", "outputChannelId": "post-mixer", "monitoring": 1},
            "devices": [{"name": "Saved Device", "className": "PluginDevice", "type": "unknown",
                         "parameters": [{"originalName": "Filter Freq", "min": 0.0, "max": 1.0,
                                         "quantized": False, "valueItems": [], "value": 0.9},
                                        {"originalName": "Filter Type", "min": 0.0, "max": 2.0,
                                         "quantized": True, "valueItems": ["Low-pass", "Band-pass", "High-pass"], "value": 2.0}]}],
        }
        result = dispatch_request(song, {"method": "set_track_state_snapshot", "params": {
            "trackId": "track-0", "before": before, "target": target}}, 6)
        self.assertEqual(result["stateVersion"], 7)
        self.assertEqual(result["track"]["name"], "Saved Bass")
        self.assertEqual(result["mixer"]["volume"]["value"], 0.5)
        self.assertEqual(result["mixer"]["sends"][0]["value"], 0.6)
        self.assertEqual(result["routing"]["output"]["type"]["id"], "main")
        self.assertEqual(result["devices"][0]["parameters"][0]["value"], 0.9)
        self.assertEqual(song.undo_boundaries, ["begin", "end"])

    def test_track_state_recall_rolls_back_prior_writes_on_failure(self):
        song = Song()
        before = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        target = {
            "format": "cavi-track-state-v1",
            "track": {"name": "Should Roll Back", "type": "midi", "isGroup": False},
            "mixer": {"volume": 0.5, "pan": 0.0, "mute": False, "solo": False,
                      "sends": [{"id": "send-0", "name": "Reverb", "value": 0.2}]},
            "routing": {"inputTypeId": "all-ins", "inputChannelId": "all-channels",
                        "outputTypeId": "main", "outputChannelId": "post-mixer", "monitoring": 1},
            "devices": [{"name": "Device", "className": "PluginDevice", "type": "unknown",
                         "parameters": [{"originalName": "Filter Freq", "min": 0.0, "max": 1.0,
                                         "quantized": False, "valueItems": [], "value": 0.9},
                                        {"originalName": "Filter Type", "min": 0.0, "max": 2.0,
                                         "quantized": True, "valueItems": ["Low-pass", "Band-pass", "High-pass"], "value": 1.0}]}],
        }
        parameter = song.tracks[0].devices[0].parameters[0]
        parameter_type = type(parameter)
        class FailingParameter(parameter_type):
            @property
            def value(self):
                return self._value
            @value.setter
            def value(self, value):
                if value == 0.9:
                    raise RuntimeError("parameter write failed")
                self._value = value
        failing = FailingParameter()
        failing._value = parameter.value
        song.tracks[0].devices[0].parameters[0] = failing
        before = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        with self.assertRaisesRegex(RuntimeError, "parameter write failed"):
            dispatch_request(song, {"method": "set_track_state_snapshot", "params": {
                "trackId": "track-0", "before": before, "target": target}}, 6)
        after = dispatch_request(song, {"method": "get_track_state_snapshot", "params": {"trackId": "track-0"}}, 6)
        self.assertEqual(after, before)
        self.assertEqual(song.undo_boundaries, ["begin", "end"])

    def test_duplicate_parameter_names_report_exact_ambiguous_ids(self):
        song = Song()
        parameters = [Parameter(), Parameter(), Parameter()]
        parameters[0].name = "Win"
        parameters[1].name = "Win"
        parameters[2].name = "Activate"
        song.tracks[0].devices[0].parameters = parameters
        result = dispatch_request(song, {"method": "list_device_parameters", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 1)
        self.assertEqual(result.get("nameAmbiguities"), [{"name": "Win", "parameterIds": ["parameter-0", "parameter-1"]}])
        self.assertEqual([p["id"] for p in result["parameters"]], ["parameter-0", "parameter-1", "parameter-2"])
        parameters[1].name = "Other"
        result = dispatch_request(song, {"method": "list_device_parameters", "params": {
            "trackId": "track-0", "deviceId": "track-0:device-0"}}, 1)
        self.assertEqual(result["nameAmbiguities"], [])

    def test_track_resolution_rejects_noncanonical_and_out_of_range_ids(self):
        song = Song()
        for track_id in ["track--1", "0", "track-00", "track-999", None]:
            with self.subTest(track_id=track_id):
                with self.assertRaises(ValueError):
                    dispatch_request(song, {"method": "list_devices", "params": {"trackId": track_id}}, 1)
        result = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "track-0"}}, 1)
        self.assertEqual(result["trackId"], "track-0")

    def test_list_devices_supports_return_and_master_owners(self):
        song = Song()
        song.return_tracks[0].devices = [Device()]
        song.master_track.devices = [Device()]
        returned = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "return-0"}}, 1)
        mastered = dispatch_request(song, {"method": "list_devices", "params": {"trackId": "master"}}, 1)
        self.assertEqual(returned["devices"][0]["id"], "return-0:device-0")
        self.assertEqual(mastered["devices"][0]["id"], "master:device-0")
        for owner_id in ["return--1", "return-00", "return-999"]:
            with self.subTest(owner_id=owner_id):
                with self.assertRaises(ValueError):
                    dispatch_request(song, {"method": "list_devices", "params": {"trackId": owner_id}}, 1)

    def test_device_lifecycle_supports_return_and_master_owners(self):
        for owner_id in ["return-0", "master"]:
            with self.subTest(owner_id=owner_id):
                song = Song()
                owner = song.return_tracks[0] if owner_id == "return-0" else song.master_track
                owner.devices = [Device(), Device()]
                owner.delete_device = lambda index, owner=owner: owner.devices.pop(index)
                device_id = f"{owner_id}:device-0"
                hierarchy = dispatch_request(song, {"method": "get_device_hierarchy", "params": {
                    "trackId": owner_id, "deviceId": device_id,
                }}, 3)
                parameters = dispatch_request(song, {"method": "list_device_parameters", "params": {
                    "trackId": owner_id, "deviceId": device_id,
                }}, 3)
                self.assertEqual(hierarchy["device"]["id"], device_id)
                self.assertEqual(parameters["deviceId"], device_id)
                deleted = dispatch_request(song, {"method": "delete_device", "params": {
                    "trackId": owner_id, "deviceId": device_id,
                    "beforeDevice": {"name": owner.devices[0].name, "className": owner.devices[0].class_name},
                }}, 3)
                self.assertEqual(deleted["deletedDevice"]["id"], device_id)
                self.assertEqual(len(owner.devices), 1)

    def test_device_chain_snapshot_recall_is_atomic_for_bus_owners(self):
        for owner_id in ["return-0", "master"]:
            with self.subTest(owner_id=owner_id):
                song = Song()
                owner = song.return_tracks[0] if owner_id == "return-0" else song.master_track
                owner.devices = [Device()]
                before = dispatch_request(song, {"method": "get_device_chain_snapshot", "params": {"trackId": owner_id}}, 6)
                target = _persisted_device_chain(before)
                target["devices"][0]["name"] = "Saved Device"
                target["devices"][0]["parameters"][0]["value"] = 0.25
                result = dispatch_request(song, {"method": "set_device_chain_snapshot", "params": {
                    "trackId": owner_id, "before": before, "target": target,
                }}, 6)
                self.assertEqual(result["stateVersion"], 7)
                self.assertEqual(owner.devices[0].name, "Saved Device")
                self.assertEqual(owner.devices[0].parameters[0].value, 0.25)
                self.assertEqual(song.undo_boundaries[-2:], ["begin", "end"])

    def test_clip_resolution_rejects_negative_and_noncanonical_slot_ids(self):
        song = Song()
        song.tracks[0].clip_slots = [song.tracks[0].clip_slots[0]] * 2
        for clip_id in ["track-0:clip--1", "track-0:clip-00", "track-0:clip-999", None]:
            with self.subTest(clip_id=clip_id):
                with self.assertRaises(ValueError):
                    dispatch_request(song, {"method": "get_clip_timing", "params": {"trackId": "track-0", "clipId": clip_id}}, 1)
        song.tracks[0].arrangement_clips = [AudioClip()]
        with self.assertRaises(ValueError):
            dispatch_request(song, {"method": "get_audio_clip_state", "params": {"trackId": "track-0", "clipId": "track-0:arrangement-clip-00"}}, 1)

    def test_midi_rack_hierarchy_does_not_read_audio_only_mixer_properties(self):
        class MidiMixer:
            @property
            def volume(self):
                raise RuntimeError("MIDI chains don't have a volume parameter!")
        rack = NestedDevice("MIDI Effect Rack", "MidiEffectGroupDevice", 4)
        rack.can_have_chains = True
        chain = Chain("Arpeggiated", [])
        chain.mixer_device = MidiMixer()
        rack.chains = [chain]
        song = Song()
        song.tracks[0].devices = [rack]
        result = dispatch_request(song, {"method": "get_device_hierarchy", "params": {"trackId": "track-0", "deviceId": "track-0:device-0"}}, 1)
        self.assertEqual(result["device"]["chains"][0]["mixer"], {"volume": None, "pan": None, "sends": [], "mute": None, "solo": None})

    def test_parameter_batch_preflights_disabled_controls_before_any_write(self):
        song = Song()
        parameters = song.tracks[0].devices[0].parameters
        parameters[1].is_enabled = False
        before = [parameter.value for parameter in parameters]
        with self.assertRaisesRegex(ValueError, "parameter is disabled"):
            dispatch_request(song, {"method": "set_device_parameters", "params": {
                "trackId": "track-0", "deviceId": "track-0:device-0",
                "changes": [{"id": "parameter-0", "value": 0.8}, {"id": "parameter-1", "value": 2}]
            }}, 4)
        self.assertEqual([parameter.value for parameter in parameters], before)

    def test_parameter_recall_rechecks_device_and_full_state_before_writes(self):
        for mutation in ("class", "layout", "value"):
            song = Song()
            ids = {"trackId": "track-0", "deviceId": "track-0:device-0"}
            device = song.tracks[0].devices[0]
            before_device = dispatch_request(song, {"method": "get_device_hierarchy", "params": ids}, 4)["device"]
            before_parameters = dispatch_request(song, {"method": "list_device_parameters", "params": ids}, 4)["parameters"]
            if mutation == "class":
                device.class_name = "OtherDevice"
            elif mutation == "layout":
                device.parameters[0].original_name = "DifferentControl"
            else:
                device.parameters[0].value = 0.3
            unchanged = [p.value for p in device.parameters]
            with self.assertRaisesRegex(ValueError, "snapshot target changed"):
                dispatch_request(song, {"method": "set_device_parameters", "params": {
                    **ids, "beforeDevice": before_device, "beforeParameters": before_parameters,
                    "changes": [{"id": "parameter-0", "value": 0.8}]
                }}, 4)
            self.assertEqual([p.value for p in device.parameters], unchanged)

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

    def test_guarded_drum_variation_transform_rejects_stale_native_context(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        params = {**target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                  "gridReference": {"tempoBpm": 120,
                                    "timeSignature": {"numerator": 4, "denominator": 4}},
                  "operation": "apply_drum_variation",
                  "changes": [{"noteId": 7, "velocity": 90}], "newNotes": []}
        song.tempo = 121
        with self.assertRaisesRegex(ValueError, "song grid changed"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": params}, 3)
        song.tempo = 120
        clip.signature_numerator = 3
        with self.assertRaisesRegex(ValueError, "clip timing changed"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": params}, 3)

    def test_guarded_drum_variation_bounds_payload_and_rolls_back_added_notes(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        base = {**target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120,
                                  "timeSignature": {"numerator": 4, "denominator": 4},
                                  "setFingerprint": dispatch_request(song, {"method": "get_live_state"}, 3)["setFingerprint"]},
                "operation": "apply_drum_variation",
                "variation": {"range": {"startBeat": 0, "endBeat": 4}, "laneNotes": [60],
                              "grid": "straight16", "startBar": 0, "bars": 1, "seed": 132,
                              "stepBeats": .25, "timingAmount": 0, "velocityAmount": 32,
                              "preserveAccentsAbove": 101, "changedBefore": [before["notes"][0]],
                              "preservedNotes": [], "changes": [{"noteId": 7, "velocity": 90}],
                              "newNotes": [], "fill": None}}
        with self.assertRaisesRegex(ValueError, "at most 4096"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "changes": [], "newNotes": [{}] * 4097
            }}, 3)
        original_apply = clip.apply_note_modifications
        clip.apply_note_modifications = lambda notes: (_ for _ in ()).throw(ValueError("native apply failed"))
        with self.assertRaisesRegex(RuntimeError, "rollback was incomplete.*native apply failed"):
            added = {"pitch": 38, "start": 3, "duration": .125, "velocity": 100,
                     "velocityDeviation": 0, "releaseVelocity": 0, "probability": 1, "mute": False}
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "changes": [{"noteId": 7, "velocity": 90}],
                "newNotes": [added],
                "variation": {**base["variation"], "newNotes": [added],
                              "fill": {"note": 38, "grid": "straight16", "activeSteps": [13],
                                       "velocity": 100, "gate": .5}}
            }}, 3)
        clip.apply_note_modifications = original_apply
        self.assertEqual([note.note_id for note in clip.extended_notes], [7])
        self.assertEqual(clip.extended_notes[0].velocity, 100)
        original_add = clip.add_new_notes
        def partial_add(specs):
            original_add(specs[:1])
            raise ValueError("native add failed after partial write")
        clip.add_new_notes = partial_add
        with self.assertRaisesRegex(ValueError, "native add failed after partial write"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "changes": [{"noteId": 7, "velocity": 90}], "newNotes": [added],
                "variation": {**base["variation"], "newNotes": [added],
                              "fill": {"note": 38, "grid": "straight16", "activeSteps": [13],
                                       "velocity": 100, "gate": .5}}
            }}, 3)
        self.assertEqual([note.note_id for note in clip.extended_notes], [7])
        self.assertEqual(clip.extended_notes[0].velocity, 100)
        self.assertEqual(song.undo_boundaries[-2:], ["begin", "end"])

    def test_guarded_drum_variation_rolls_back_when_complete_readback_fails(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        fingerprint = dispatch_request(song, {"method": "get_live_state"}, 3)["setFingerprint"]
        params = {**target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                  "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
                                    "setFingerprint": fingerprint},
                  "operation": "apply_drum_variation", "changes": [{"noteId": 7, "velocity": 90}],
                  "newNotes": [], "variation": {
                      "range": {"startBeat": 0, "endBeat": 4}, "laneNotes": [60],
                      "grid": "straight16", "startBar": 0, "bars": 1, "seed": 132,
                      "stepBeats": .25, "timingAmount": 0, "velocityAmount": 32,
                      "preserveAccentsAbove": 101, "changedBefore": [before["notes"][0]],
                      "preservedNotes": [], "changes": [{"noteId": 7, "velocity": 90}],
                      "newNotes": [], "fill": None}}
        original_read = clip.get_all_notes_extended
        reads = 0
        def fail_after_write():
            nonlocal reads
            reads += 1
            if reads >= 3:
                raise ValueError("native readback failed")
            return original_read()
        clip.get_all_notes_extended = fail_after_write
        with self.assertRaisesRegex(ValueError, "native readback failed"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": params}, 3)
        self.assertEqual(clip.extended_notes[0].velocity, 100)
        self.assertEqual(song.undo_boundaries[-2:], ["begin", "end"])

    def test_guarded_drum_variation_never_uses_global_undo_for_failed_mutation(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        fingerprint = dispatch_request(song, {"method": "get_live_state"}, 3)["setFingerprint"]
        fill_note = {"pitch": 38, "start": 3, "duration": .125, "velocity": 100,
                     "velocityDeviation": 0, "releaseVelocity": 0, "probability": 1, "mute": False}
        variation = {"range": {"startBeat": 0, "endBeat": 4}, "laneNotes": [60],
                     "grid": "straight16", "startBar": 0, "bars": 1, "seed": 132,
                     "stepBeats": .25, "timingAmount": 0, "velocityAmount": 32,
                     "preserveAccentsAbove": 101, "changedBefore": [before["notes"][0]],
                     "preservedNotes": [], "changes": [{"noteId": 7, "velocity": 90}],
                     "newNotes": [fill_note], "fill": {"note": 38, "grid": "straight16",
                     "activeSteps": [13], "velocity": 100, "gate": .5}}
        undo_calls = []
        song.undo = lambda: undo_calls.append(True)
        clip.add_new_notes = lambda specs: (_ for _ in ()).throw(ValueError("native add rejected"))
        with self.assertRaisesRegex(ValueError, "native add rejected"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
                                  "setFingerprint": fingerprint},
                "operation": "apply_drum_variation", "changes": variation["changes"],
                "newNotes": [fill_note], "variation": variation
            }}, 3)
        self.assertEqual(undo_calls, [])
        self.assertEqual(clip.extended_notes[0].velocity, 100)

    def test_guarded_drum_variation_rejects_start_bar_beyond_planner_limit(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.length = 20000
        clip.loop_end = 20000
        clip.end_marker = 20000
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        fingerprint = dispatch_request(song, {"method": "get_live_state"}, 3)["setFingerprint"]
        variation = {"range": {"startBeat": 16384, "endBeat": 16388}, "laneNotes": [60],
                     "grid": "straight16", "startBar": 4096, "bars": 1, "seed": 0,
                     "stepBeats": .25, "timingAmount": 0, "velocityAmount": 0,
                     "preserveAccentsAbove": 110, "changedBefore": [],
                     "preservedNotes": before["notes"], "changes": [], "newNotes": [], "fill": None}
        with self.assertRaisesRegex(ValueError, "deterministic options"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
                                  "setFingerprint": fingerprint},
                "operation": "apply_drum_variation", "changes": [], "newNotes": [], "variation": variation
            }}, 3)

    def test_guarded_drum_variation_rejects_bypassed_semantics_and_fingerprint(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        fingerprint = dispatch_request(song, {"method": "get_live_state"}, 3)["setFingerprint"]
        variation = {"range": {"startBeat": 0, "endBeat": 4}, "laneNotes": [60],
                     "grid": "straight16", "startBar": 0, "bars": 1, "seed": 0,
                     "stepBeats": .25, "timingAmount": 0, "velocityAmount": 0,
                     "preserveAccentsAbove": 110, "changedBefore": [],
                     "preservedNotes": before["notes"], "changes": [], "newNotes": [], "fill": None}
        base = {**target, "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
                                  "setFingerprint": fingerprint},
                "operation": "apply_drum_variation", "changes": [], "newNotes": [], "variation": variation}
        with self.assertRaisesRegex(ValueError, "would not change"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": base}, 3)
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "gridReference": {**base["gridReference"], "setFingerprint": "wrong"}
            }}, 3)
        collision = {"pitch": 60, "start": 0, "duration": 0.25, "velocity": 90,
                     "velocityDeviation": 0, "releaseVelocity": 0, "probability": 1, "mute": False}
        with self.assertRaisesRegex(ValueError, "collision"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "newNotes": [collision],
                "variation": {**variation, "newNotes": [collision],
                              "fill": {"note": 60, "grid": "straight16", "activeSteps": [1],
                                       "velocity": 90, "gate": 1}}
            }}, 3)
        with self.assertRaisesRegex(ValueError, "deterministic plan"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "changes": [{"noteId": 7, "start": 5}],
                "variation": {**variation, "changes": [{"noteId": 7, "start": 5}],
                              "changedBefore": before["notes"], "preservedNotes": []}
            }}, 3)
        with self.assertRaisesRegex(ValueError, "deterministic plan"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "changes": [{"noteId": 7, "pitch": 61}],
                "variation": {**variation, "changes": [{"noteId": 7, "pitch": 61}],
                              "changedBefore": before["notes"], "preservedNotes": []}
            }}, 3)
        clip.extended_notes[0].start_time = -0.1
        clip.extended_notes[0].duration = .2
        crossing_before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        crossing = {**variation, "changedBefore": [], "preservedNotes": crossing_before["notes"]}
        with self.assertRaisesRegex(ValueError, "crosses"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "before": crossing_before, "variation": crossing
            }}, 3)
        clip.extended_notes[0].start_time = 0
        clip.extended_notes[0].duration = .5
        song.signature_numerator = 3
        song.signature_denominator = 8
        clip.signature_numerator = 3
        clip.signature_denominator = 8
        triplet_timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
        triplet_before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
        misaligned = {**variation, "grid": "eighthTriplet", "stepBeats": 1 / 3,
                      "range": {"startBeat": 0, "endBeat": 1.5}, "preservedNotes": triplet_before["notes"]}
        with self.assertRaisesRegex(ValueError, "bar-aligned"):
            dispatch_request(song, {"method": "transform_midi_notes", "params": {
                **base, "before": triplet_before, "clipTiming": triplet_timing,
                "gridReference": {**base["gridReference"],
                                  "timeSignature": {"numerator": 3, "denominator": 8}},
                "variation": misaligned
            }}, 3)

    def test_guarded_midi_humanization_binds_plan_and_rolls_back_atomically(self):
        def fixture():
            song = Song()
            clip = song.tracks[0].clip_slots[0].clip
            first = MidiNote(7)
            first.start_time = .01
            first.duration = .5
            second = MidiNote(8)
            second.pitch = 64
            second.start_time = 2
            second.duration = .5
            second.velocity = 90
            clip.extended_notes = [first, second]
            target = {"trackId": "track-0", "clipId": "track-0:clip-0"}
            before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": target}, 3)
            timing = dispatch_request(song, {"method": "get_clip_timing", "params": target}, 3)
            options = {"seed": 7, "gridBeats": .25, "maxTimingOffsetBeats": .05,
                       "maxVelocityOffset": 10}
            changes = [
                {"noteId": 7, "previous": before["notes"][0], "start": 0, "velocity": 108},
                {"noteId": 8, "previous": before["notes"][1],
                 "start": 2.0112491666339336, "velocity": 99},
            ]
            params = {**target, "expectedStateVersion": 3, "before": before,
                      "clipTiming": timing,
                      "gridReference": {"stateVersion": 3, "tempoBpm": 120,
                                        "timeSignature": {"numerator": 4, "denominator": 4},
                                        "setFingerprint": dispatch_request(song, {
                                            "method": "get_live_state"}, 3)["setFingerprint"]},
                      "operation": "apply_midi_humanization", "changes": changes,
                      "newNotes": [], "humanization": {"options": options,
                          "noteIds": [7, 8], "changes": changes}}
            return song, clip, params

        song, clip, params = fixture()
        result = dispatch_request(song, {"method": "transform_midi_notes", "params": params}, 3)
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["notes"][0]["start"], 0)
        self.assertEqual(result["notes"][1]["velocity"], 99)
        self.assertEqual(song.undo_boundaries[-2:], ["begin", "end"])

        stale_song, _, stale = fixture()
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            dispatch_request(stale_song, {"method": "transform_midi_notes", "params": {
                **stale, "gridReference": {**stale["gridReference"], "setFingerprint": "wrong"}
            }}, 3)
        with self.assertRaisesRegex(ValueError, "signed plan"):
            dispatch_request(stale_song, {"method": "transform_midi_notes", "params": {
                **stale, "changes": [{**stale["changes"][0], "velocity": 107}, stale["changes"][1]]
            }}, 3)

        failing_song, failing_clip, failing = fixture()
        apply_calls = 0
        def fail_once(notes):
            nonlocal apply_calls
            apply_calls += 1
            if apply_calls == 1:
                raise ValueError("native humanize failed")
            failing_clip.extended_notes = list(notes)
        failing_clip.apply_note_modifications = fail_once
        with self.assertRaisesRegex(ValueError, "native humanize failed"):
            dispatch_request(failing_song, {"method": "transform_midi_notes", "params": failing}, 3)
        self.assertEqual(failing_clip.extended_notes[0].start_time, .01)
        self.assertEqual(failing_clip.extended_notes[0].velocity, 100)
        self.assertEqual(failing_song.undo_boundaries[-2:], ["begin", "end"])

    def test_replace_midi_notes_removes_exact_ids_and_adds_replacements(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        first = MidiNote(7)
        preserved = MidiNote(8)
        preserved.pitch = 42
        clip.extended_notes = [first, preserved]
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        result = dispatch_request(song, {"method": "replace_midi_notes", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0", "removeNoteIds": [7],
            "expectedStateVersion": 3, "before": before, "clipTiming": timing,
            "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4}},
            "newNotes": [{"pitch": 36, "start": 1.0, "duration": 0.125,
                          "velocity": 110, "mute": False}]
        }}, 3)
        self.assertEqual(result["removedNoteIds"], [7])
        self.assertEqual(result["addedNoteIds"], [100])
        self.assertEqual([note["noteId"] for note in result["notes"]], [8, 100])
        self.assertEqual(result["stateVersion"], 4)

    def test_scale_melody_creation_binds_context_and_returns_complete_notes_atomically(self):
        song = Song()
        target = {"trackId": "track-1", "clipId": "track-1:clip-0"}
        before_context = dispatch_request(song, {"method": "get_song_musical_context"}, 1)
        before_slot = dispatch_request(song, {"method": "list_clips", "params": {
            "trackId": "track-1"
        }}, 1)["clips"][0]
        fingerprint = dispatch_request(song, {"method": "get_live_state"}, 1)["setFingerprint"]
        notes = [
            {"pitch": 60, "start": 0, "duration": .2, "velocity": 96, "mute": False},
            {"pitch": 64, "start": .5, "duration": .2, "velocity": 110, "mute": False},
        ]
        melody = {"grid": "straight16", "motifBars": 1, "repeats": 1,
                  "gate": .8, "velocity": 96, "basePitch": 60, "minPitch": 48, "maxPitch": 84,
                  "stepsPerMotif": 16, "stepBeats": .25, "motifLengthBeats": 4,
                  "motif": [
                      {"step": 0, "degree": 1, "octaveOffset": 0, "velocity": 96,
                       "pitch": 60, "pitchClass": 0, "noteName": "C"},
                      {"step": 2, "degree": 3, "octaveOffset": 0, "velocity": 110,
                       "pitch": 64, "pitchClass": 4, "noteName": "E"},
                  ], "notes": notes, "lengthBeats": 4,
                  "scale": {"name": "Major", "rootNote": 0, "rootName": "C",
                            "intervals": [0, 2, 4, 5, 7, 9, 11],
                            "pitchClasses": [0, 2, 4, 5, 7, 9, 11],
                            "noteNames": ["C", "D", "E", "F", "G", "A", "B"],
                            "degrees": [1, 2, 3, 4, 5, 6, 7], "family": "major"}}
        params = {**target, "expectedStateVersion": 1, "operation": "create_scale_melody_clip",
                  "name": "Lead Motif", "lengthBeats": 4, "notes": notes, "melody": melody,
                  "musicalContext": before_context,
                  "gridReference": {"stateVersion": 1, "setFingerprint": fingerprint,
                                    "tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
                                    "barLengthBeats": 4,
                                    "grids": {"straight16": {"stepsPerQuarter": 4, "stepsPerBar": 16,
                                                               "barBoundaryOnGrid": True}}},
                  "before": before_slot}
        target_slot = song.tracks[1].clip_slots[0]
        create_clip = target_slot.create_clip
        def create_with_native_note_order(length):
            create_clip(length)
            target_slot.clip.get_notes = lambda *args: tuple(reversed(target_slot.clip.notes))
        target_slot.create_clip = create_with_native_note_order
        result = dispatch_request(song, {"method": "create_midi_clip", "params": params}, 1)
        self.assertEqual(result["stateVersion"], 2)
        self.assertCountEqual(result["notes"], notes)
        self.assertEqual(song.undo_boundaries[-2:], ["begin", "end"])

        scene_changed_song = Song()
        scene_changed_params = {**params,
                                "musicalContext": dispatch_request(scene_changed_song, {
                                    "method": "get_song_musical_context"}, 1),
                                "gridReference": {**params["gridReference"], "setFingerprint":
                                    dispatch_request(scene_changed_song, {
                                        "method": "get_live_state"}, 1)["setFingerprint"]}}
        scene_changed_song.create_scene(0)
        with self.assertRaisesRegex(ValueError, "song grid changed"):
            dispatch_request(scene_changed_song, {
                "method": "create_midi_clip", "params": scene_changed_params}, 1)

        stale_song = Song()
        stale_song.root_note = 2
        with self.assertRaisesRegex(ValueError, "musical context changed"):
            dispatch_request(stale_song, {"method": "create_midi_clip", "params": params}, 1)

        failing_song = Song()
        failing_slot = failing_song.tracks[1].clip_slots[0]
        original_create = failing_slot.create_clip
        def create_with_failed_readback(length):
            original_create(length)
            failing_slot.clip.get_notes = lambda *args: (_ for _ in ()).throw(ValueError("native melody readback failed"))
        failing_slot.create_clip = create_with_failed_readback
        failing_params = {**params,
                          "musicalContext": dispatch_request(failing_song, {"method": "get_song_musical_context"}, 1),
                          "gridReference": {**params["gridReference"], "setFingerprint":
                              dispatch_request(failing_song, {"method": "get_live_state"}, 1)["setFingerprint"]}}
        with self.assertRaisesRegex(ValueError, "native melody readback failed"):
            dispatch_request(failing_song, {"method": "create_midi_clip", "params": failing_params}, 1)
        self.assertFalse(failing_slot.has_clip)
        self.assertEqual(failing_song.undo_boundaries[-2:], ["begin", "end"])

    def test_replace_midi_notes_rejects_stale_state_snapshot_and_unsafe_counts(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        base = {"trackId": "track-0", "clipId": "track-0:clip-0", "removeNoteIds": [7],
                "newNotes": [], "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4}}}
        with self.assertRaisesRegex(ValueError, "state version changed"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": base}, 4)
        clip.extended_notes[0].velocity = 12
        with self.assertRaisesRegex(ValueError, "changed since observation"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": base}, 3)
        current = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        with self.assertRaisesRegex(ValueError, "at most 4096"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": {
                **base, "before": current, "removeNoteIds": list(range(4097))
            }}, 3)
        clip.signature_numerator = 3
        with self.assertRaisesRegex(ValueError, "clip timing changed"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": {
                **base, "before": current
            }}, 3)
        clip.signature_numerator = 4
        song.tempo = 121
        with self.assertRaisesRegex(ValueError, "song grid changed"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": {
                **base, "before": current
            }}, 3)

    def test_replace_midi_notes_does_not_remove_old_notes_when_add_fails(self):
        song = Song()
        clip = song.tracks[0].clip_slots[0].clip
        clip.extended_notes = [MidiNote(7)]
        before = dispatch_request(song, {"method": "get_midi_clip_notes_extended", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        timing = dispatch_request(song, {"method": "get_clip_timing", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-0"
        }}, 3)
        clip.add_new_notes = lambda notes: (_ for _ in ()).throw(ValueError("native add failed"))
        with self.assertRaisesRegex(ValueError, "native add failed"):
            dispatch_request(song, {"method": "replace_midi_notes", "params": {
                "trackId": "track-0", "clipId": "track-0:clip-0", "removeNoteIds": [7],
                "newNotes": [{"pitch": 36, "start": 1, "duration": .25, "velocity": 100}],
                "expectedStateVersion": 3, "before": before, "clipTiming": timing,
                "gridReference": {"tempoBpm": 120, "timeSignature": {"numerator": 4, "denominator": 4}}
            }}, 3)
        self.assertEqual([note.note_id for note in clip.extended_notes], [7])

    def test_new_midi_note_defaults_extended_expression_fields(self):
        note = _new_midi_note({"pitch": 36, "start": 1.0, "duration": 0.125,
                              "velocity": 110, "mute": False})
        self.assertEqual(note["velocityDeviation"], 0)
        self.assertEqual(note["releaseVelocity"], 0)
        self.assertEqual(note["probability"], 1.0)

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

    def test_audio_clip_parameter_envelope_can_be_sampled_and_replaced(self):
        song = Song()
        clip = AudioClip()
        clip.is_midi_clip = False
        song.tracks[0].clip_slots[0].clip = clip
        params = {"trackId": "track-0", "clipId": "track-0:clip-0",
                  "deviceId": "track-0:device-0", "parameterId": "parameter-0"}
        missing = dispatch_request(song, {"method": "get_clip_parameter_envelope",
                                          "params": {**params, "sampleTimes": [0.0]}}, 3)
        self.assertFalse(missing["exists"])
        written = dispatch_request(song, {"method": "set_clip_parameter_envelope",
                                          "params": {**params, "points": [
                                              {"time": 0.0, "duration": 0.25, "value": 0.2},
                                              {"time": 0.5, "duration": 0.25, "value": 0.8}]}}, 3)
        self.assertEqual(written["samples"], [
            {"time": 0.0, "value": 0.2}, {"time": 0.5, "value": 0.8}])
        sampled = dispatch_request(song, {"method": "get_clip_parameter_envelope",
                                          "params": {**params, "sampleTimes": [0.0, 0.5]}}, 4)
        self.assertEqual(sampled["samples"], written["samples"])

    def test_looper_performance_context_and_state_write_recheck_routing(self):
        song = Song()
        track = song.tracks[0]
        track.has_audio_input = True
        looper = Device()
        looper.name = "Looper"
        looper.class_name = "Looper"
        looper.class_display_name = "Looper"
        controls = {
            "State": (("Stop", "Record", "Play", "Overdub"), 2),
            "Quantization": (("Global", "None", "1 Bar", "1/8T"), 2),
            "Monitor": (("Always", "Never", "Rec/OVR"), 0),
            "Song Control": (("None", "Start Song"), 1),
            "Tempo Control": (("None", "Follow song tempo"), 1),
        }
        looper.parameters = []
        for name, (choices, value) in controls.items():
            parameter = QuantizedParameter()
            parameter.name = name
            parameter.original_name = name
            parameter.value_items = choices
            parameter.max = float(len(choices) - 1)
            parameter.value = float(value)
            looper.parameters.append(parameter)
        track.devices[0] = looper
        target = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_looper_performance_context", "params": target}, 3)
        self.assertEqual(before["controls"]["State"]["displayValue"], "Play")
        self.assertEqual(before["controls"]["Quantization"]["displayValue"], "1 Bar")
        self.assertEqual(before["globalLaunchQuantization"]["name"], "2_bars")
        self.assertEqual(before["routing"]["input"]["type"]["name"], "All Ins")
        self.assertFalse(before["transport"]["isPlaying"])

        track.current_input_routing = "No Input"
        with self.assertRaisesRegex(ValueError, "Looper performance context changed"):
            dispatch_request(song, {"method": "set_looper_state", "params": {
                **target, "expectedStateVersion": 3, "before": before, "targetState": "Record"
            }}, 3)
        self.assertEqual(looper.parameters[0].value, 2)

        track.current_input_routing = "All Ins"
        song.is_playing = True
        with self.assertRaisesRegex(ValueError, "Looper performance context changed"):
            dispatch_request(song, {"method": "set_looper_state", "params": {
                **target, "expectedStateVersion": 3, "before": before, "targetState": "Record"
            }}, 3)
        self.assertEqual(looper.parameters[0].value, 2)
        song.is_playing = False
        changed = dispatch_request(song, {"method": "set_looper_state", "params": {
            **target, "expectedStateVersion": 3, "before": before, "targetState": "Record"
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertEqual(changed["controls"]["State"]["displayValue"], "Record")
        self.assertTrue(changed["stateParameterMatchesTarget"])
        self.assertNotIn("targetReached", changed)
        self.assertEqual(looper.parameters[0].value, 1)

    def test_beat_repeat_context_and_guarded_toggle_recheck_transport(self):
        song = Song()
        repeat = Device()
        repeat.name = "Beat Repeat"
        repeat.class_name = "BeatRepeat"
        repeat.class_display_name = "Beat Repeat"
        grid = Parameter()
        grid.name = grid.original_name = "Grid"
        grid.value = 7.0
        toggle = QuantizedParameter()
        toggle.name = toggle.original_name = "Repeat"
        toggle.value_items = ("Off", "On")
        toggle.max = 1.0
        toggle.value = 0.0
        repeat.parameters = [grid, toggle]
        song.tracks[0].devices[0] = repeat
        target = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_beat_repeat_performance_context", "params": target}, 3)
        self.assertEqual(before["controls"]["Repeat"]["valueItems"], ["Off", "On"])
        self.assertEqual(before["controls"]["Grid"]["value"], 7.0)
        song.is_playing = True
        with self.assertRaisesRegex(ValueError, "Beat Repeat performance context changed"):
            dispatch_request(song, {"method": "set_beat_repeat_enabled", "params": {
                **target, "expectedStateVersion": 3, "before": before, "enabled": True
            }}, 3)
        self.assertEqual(toggle.value, 0.0)
        song.is_playing = False
        changed = dispatch_request(song, {"method": "set_beat_repeat_enabled", "params": {
            **target, "expectedStateVersion": 3, "before": before, "enabled": True
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertTrue(changed["repeatParameterMatchesTarget"])
        self.assertEqual(toggle.value, 1.0)

    def test_beat_repeat_grid_maps_native_displays_and_rechecks_before_setting(self):
        song = Song()
        repeat = Device()
        repeat.name = "Beat Repeat"
        repeat.class_name = "BeatRepeat"
        class Grid(Parameter):
            def __init__(self):
                super().__init__()
                self.name = self.original_name = "Grid"
                self.min = 0.0
                self.max = 2.0
                self.value = 1.0

            def str_for_value(self, value):
                return {0: "1/4", 1: "1/8", 2: "1/16"}[int(value)]

        grid = Grid()
        toggle = QuantizedParameter()
        toggle.name = toggle.original_name = "Repeat"
        toggle.value_items = ("Off", "On")
        toggle.max = 1.0
        repeat.parameters = [grid, toggle]
        song.tracks[0].devices[0] = repeat
        target = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_beat_repeat_performance_context", "params": target}, 3)
        self.assertEqual(before["gridChoices"], [
            {"value": 0, "displayValue": "1/4"},
            {"value": 1, "displayValue": "1/8"},
            {"value": 2, "displayValue": "1/16"},
        ])
        song.tracks[0].current_input_routing = "No Input"
        with self.assertRaisesRegex(ValueError, "Beat Repeat performance context changed"):
            dispatch_request(song, {"method": "set_beat_repeat_grid", "params": {
                **target, "expectedStateVersion": 3, "before": before,
                "gridValue": 2, "gridDisplayValue": "1/16"
            }}, 3)
        self.assertEqual(grid.value, 1.0)
        song.tracks[0].current_input_routing = "All Ins"
        changed = dispatch_request(song, {"method": "set_beat_repeat_grid", "params": {
            **target, "expectedStateVersion": 3, "before": before,
            "gridValue": 2, "gridDisplayValue": "1/16"
        }}, 3)
        self.assertEqual(changed["stateVersion"], 4)
        self.assertTrue(changed["gridParameterMatchesTarget"])
        self.assertEqual(grid.value, 2.0)

        grid.str_for_value = lambda value: "1/16" if int(value) in (1, 2) else "1/4"
        ambiguous = dispatch_request(song, {"method": "get_beat_repeat_performance_context", "params": target}, 4)
        with self.assertRaisesRegex(ValueError, "exact native Beat Repeat grid choice"):
            dispatch_request(song, {"method": "set_beat_repeat_grid", "params": {
                **target, "expectedStateVersion": 4, "before": ambiguous,
                "gridValue": 1, "gridDisplayValue": "1/16"
            }}, 4)
        self.assertEqual(grid.value, 2.0)

    def test_beat_repeat_interval_uses_native_display_and_rechecks_context(self):
        song = Song()
        repeat = Device()
        repeat.name = "Beat Repeat"
        repeat.class_name = "BeatRepeat"

        class Timing(Parameter):
            def __init__(self, name, labels, value):
                super().__init__()
                self.name = self.original_name = name
                self.min = 0.0
                self.max = float(len(labels) - 1)
                self.value = float(value)
                self.labels = labels

            def str_for_value(self, value):
                return self.labels[int(value)]

        grid = Timing("Grid", ["1/8", "1/16"], 1)
        interval = Timing("Interval", ["1/4", "1/2", "1 Bar"], 2)
        toggle = QuantizedParameter()
        toggle.name = toggle.original_name = "Repeat"
        toggle.value_items = ("Off", "On")
        toggle.max = 1.0
        repeat.parameters = [grid, interval, toggle]
        song.tracks[0].devices[0] = repeat
        target = {"trackId": "track-0", "deviceId": "track-0:device-0"}
        before = dispatch_request(song, {"method": "get_beat_repeat_performance_context", "params": target}, 3)
        self.assertEqual(before["intervalChoices"], [
            {"value": 0, "displayValue": "1/4"},
            {"value": 1, "displayValue": "1/2"},
            {"value": 2, "displayValue": "1 Bar"},
        ])
        song.is_playing = True
        with self.assertRaisesRegex(ValueError, "Beat Repeat performance context changed"):
            dispatch_request(song, {"method": "set_beat_repeat_interval", "params": {
                **target, "expectedStateVersion": 3, "before": before,
                "intervalValue": 1, "intervalDisplayValue": "1/2"
            }}, 3)
        self.assertEqual(interval.value, 2.0)
        song.is_playing = False
        changed = dispatch_request(song, {"method": "set_beat_repeat_interval", "params": {
            **target, "expectedStateVersion": 3, "before": before,
            "intervalValue": 1, "intervalDisplayValue": "1/2"
        }}, 3)
        self.assertEqual(changed["controls"]["Interval"]["displayValue"], "1/2")
        self.assertTrue(changed["intervalParameterMatchesTarget"])
        interval.labels = ["1/4", "1/2", "1/2"]
        ambiguous = dispatch_request(song, {"method": "get_beat_repeat_performance_context", "params": target}, 4)
        with self.assertRaisesRegex(ValueError, "exact native Beat Repeat interval choice"):
            dispatch_request(song, {"method": "set_beat_repeat_interval", "params": {
                **target, "expectedStateVersion": 4, "before": ambiguous,
                "intervalValue": 2, "intervalDisplayValue": "1/2"
            }}, 4)
        self.assertEqual(interval.value, 1.0)


if __name__ == "__main__":
    unittest.main()
