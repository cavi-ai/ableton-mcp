import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Scene, ClipSlot, AudioClip, MidiNote


class SceneCaptureTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_playing = True
        self.song.view.selected_scene = self.song.scenes[0]
        self.song.tracks[0].clip_slots = [ClipSlot(), ClipSlot(False)]
        self.song.tracks[0].clip_slots[0].clip.extended_notes = [MidiNote()]
        self.song.tracks[0].clip_slots[0].clip.is_audio_clip = False
        self.song.tracks[1].clip_slots = [ClipSlot(False), ClipSlot()]
        self.song.tracks[1].clip_slots[1].clip = AudioClip()
        self.song.tracks[1].has_audio_input = True
        self.song.tracks[1].has_midi_input = False
        for i, track in enumerate(self.song.tracks):
            track.playing_slot_index = i
            for slot in track.clip_slots:
                slot.is_triggered = False
                slot.has_stop_button = True
                if slot.has_clip:
                    slot.clip.is_playing = True
                    slot.clip.is_triggered = False
        self.calls = []
        self.song.capture_and_insert_scene = self.native_capture
        self.args = {"afterSceneId": "scene-0", "name": "Jam — verse", "expectedStateVersion": 3}

    def native_capture(self):
        self.calls.append("capture")
        index = self.song.scenes.index(self.song.view.selected_scene) + 1
        scene = Scene()
        self.song.scenes.insert(index, scene)
        for track in self.song.tracks:
            active = track.playing_slot_index
            slot = ClipSlot(False)
            slot.is_triggered = False
            slot.has_stop_button = True
            if active >= 0:
                slot.has_clip = True
                slot.clip = copy.deepcopy(track.clip_slots[active].clip)
                track.clip_slots[active].clip.is_playing = False
                slot.clip.is_playing = True
                for note in getattr(slot.clip, "extended_notes", []):
                    note.note_id += 100
            track.clip_slots.insert(index, slot)
            if active >= 0:
                track.playing_slot_index = index
        self.song.view.selected_scene = scene

    def context(self):
        return dispatch_request(self.song, {"method": "get_session_scene_capture_context", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": "capture_session_scene", "params": {**self.args, "before": before}}, 3)

    def test_capture_mixed_playing_clips_once_retains_sources_and_remaps_ids(self):
        before = self.context()
        source = self.song.tracks[1].clip_slots[1].clip
        self.assertEqual(self.calls, [])
        self.song.current_song_time += 2
        result = self.execute(before)
        self.assertTrue(result["captureVerified"])
        self.assertTrue(result["sourcePreserved"])
        self.assertFalse(result["originalPlaybackRetained"])
        self.assertTrue(result["capturedPlaybackVerified"])
        self.assertTrue(result["existingLayoutPreserved"])
        self.assertEqual(result["sceneId"], "scene-1")
        self.assertEqual(result["scene"]["name"], self.args["name"])
        self.assertIs(self.song.tracks[1].clip_slots[2].clip, source)
        self.assertEqual(result["sources"][1]["currentClipId"], "track-1:clip-2")
        self.assertEqual(self.calls, ["capture"])
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_source_edits_playing_changes_anchor_and_native_replacements_refuse(self):
        for change in [lambda: setattr(self.song.tracks[0].clip_slots[0].clip.extended_notes[0], "velocity", 42),
                       lambda: setattr(self.song.tracks[0], "playing_slot_index", -1),
                       lambda: setattr(self.song.view, "selected_scene", self.song.scenes[1]),
                       lambda: self.song.tracks.__setitem__(0, copy.deepcopy(self.song.tracks[0])),
                       lambda: setattr(self.song.tracks[1].clip_slots[1].clip, "pitch_coarse", 7)]:
            self.setUp()
            before = self.context()
            change()
            with self.assertRaises(ValueError):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_recording_count_in_pending_and_stopped_refuse(self):
        for change in [lambda: setattr(self.song, "record_mode", True),
                       lambda: setattr(self.song, "session_record", True),
                       lambda: setattr(self.song, "is_counting_in", True),
                       lambda: setattr(self.song, "is_playing", False),
                       lambda: setattr(self.song.tracks[0], "fired_slot_index", -2),
                       lambda: setattr(self.song.tracks[0].clip_slots[1], "is_triggered", True),
                       lambda: setattr(self.song.tracks[0].clip_slots[0].clip, "is_recording", True),
                       lambda: setattr(self.song.tracks[0], "is_frozen", True),
                       lambda: setattr(self.song.tracks[0], "arm", True),
                       lambda: setattr(self.song.tracks[1], "implicit_arm", True)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.context()

    def test_undo_entry_rechecks_before_capture(self):
        before = self.context()
        def begin():
            self.song.undo_boundaries.append("begin")
            self.song.tracks[0].clip_slots[0].clip.name = "Manual edit"
        self.song.begin_undo_step = begin
        with self.assertRaises(ValueError):
            self.execute(before)
        self.assertEqual(self.calls, [])

    def test_native_exception_retains_unconfirmed_scene_without_naming_or_deleting(self):
        before = self.context()
        def fail():
            self.native_capture()
            raise RuntimeError("native reply lost")
        self.song.capture_and_insert_scene = fail
        result = self.execute(before)
        self.assertFalse(result["captureVerified"])
        self.assertFalse(result["nativeReturned"])
        self.assertIsNone(result["sceneId"])
        self.assertEqual(len(self.song.scenes), 3)
        self.assertNotEqual(self.song.scenes[1].name, self.args["name"])
        self.assertIn("native reply lost", result["error"])

    def test_source_change_during_native_call_skips_name_and_retains_partial_work(self):
        before = self.context()
        def change():
            self.native_capture()
            self.song.tracks[0].clip_slots[0].clip.extended_notes[0].velocity = 42
        self.song.capture_and_insert_scene = change
        result = self.execute(before)
        self.assertFalse(result["captureVerified"])
        self.assertFalse(result["nameWriteReturned"])
        self.assertFalse(result["sourcePreserved"])
        self.assertEqual(len(self.song.scenes), 3)

    def test_wrong_copy_or_topology_never_reports_verified(self):
        for change in [lambda: setattr(self.song.tracks[0].clip_slots[1].clip.extended_notes[0], "pitch", 99),
                       lambda: self.song.scenes.append(Scene()),
                       lambda: setattr(self.song, "is_playing", False)]:
            self.setUp()
            before = self.context()
            def wrong():
                self.native_capture()
                change()
            self.song.capture_and_insert_scene = wrong
            result = self.execute(before)
            self.assertFalse(result["captureVerified"])
            self.assertFalse(result["nameWriteReturned"])
            self.assertGreaterEqual(len(self.song.scenes), 3)

    def test_finalizer_and_name_callbacks_cannot_verify_changed_readiness(self):
        for at_name in (False, True):
            for change in [lambda: setattr(self.song, "record_mode", True),
                           lambda: setattr(self.song, "is_counting_in", True),
                           lambda: setattr(self.song.tracks[0], "fired_slot_index", -2),
                           lambda: setattr(self.song.tracks[0].clip_slots[0], "is_triggered", True)]:
                self.setUp()
                before = self.context()
                if at_name:
                    desired = self.args["name"]
                    class HookScene(Scene):
                        def __setattr__(scene, key, value):
                            object.__setattr__(scene, key, value)
                            if key == "name" and value == desired:
                                change()
                    def native():
                        self.native_capture()
                        self.song.scenes[1].__class__ = HookScene
                    self.song.capture_and_insert_scene = native
                else:
                    self.song.end_undo_step = change
                result = self.execute(before)
                self.assertFalse(result["captureVerified"])
                self.assertTrue(result["nativeReturned"])
                self.assertEqual(len(self.song.scenes), 3)
                self.assertTrue(result.get("error") or result.get("observationError"))

    def test_native_start_marker_changes_are_reported_separately_from_material(self):
        before = self.context()
        def phase():
            self.native_capture()
            self.song.tracks[1].clip_slots[1].clip.start_marker = 2
        self.song.capture_and_insert_scene = phase
        result = self.execute(before)
        self.assertTrue(result["captureVerified"])
        self.assertFalse(result["rows"][1]["contentMatched"])
        self.assertTrue(result["rows"][1]["materialMatched"])
        self.assertFalse(result["rows"][1]["startMarkerMatched"])
        self.assertEqual(result["rows"][1]["startMarkers"]["captured"]["startBeats"], 2)

    def test_missing_expected_captures_cannot_verify_playback(self):
        for missing in ([0], [0, 1]):
            self.setUp()
            before = self.context()
            def remove():
                for index in missing:
                    slot = self.song.tracks[index].clip_slots[1]
                    slot.has_clip, slot.clip = False, None
            self.song.end_undo_step = remove
            result = self.execute(before)
            self.assertFalse(result["captureVerified"])
            self.assertFalse(result["capturedPlaybackVerified"])

    def test_capacity_empty_playback_bad_name_and_missing_guards_refuse(self):
        for change in [lambda: self.args.update(afterSceneId="scene-00"),
                       lambda: self.song.tracks.extend([self.song.tracks[0]] * 255),
                       lambda: setattr(self.song.tracks[0], "playing_slot_index", -1) or setattr(self.song.tracks[1], "playing_slot_index", -1),
                       lambda: setattr(self.song, "scenes", [Scene()] * 1024)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.context()
        self.setUp()
        before = self.context()
        for name in ["", "bad\nname", "a" * 129]:
            self.args["name"] = name
            with self.assertRaises(ValueError):
                self.execute(before)
        self.args["name"] = "Valid"
        self.args.pop("expectedStateVersion")
        with self.assertRaises(ValueError):
            self.execute(before)
