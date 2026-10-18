import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Clip, AudioClip, MidiNote


class ClipRemovalTests(unittest.TestCase):
    def configure(self, location="session", alias=False):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.clip = Clip()
        self.clip.is_audio_clip = False
        self.clip.extended_notes = [MidiNote()]
        self.other = copy.deepcopy(self.clip)
        self.other.name = "Other phrase"
        self.calls = []
        self.location, self.alias = location, alias
        if location == "session":
            for slot, clip in zip(self.track.clip_slots, (self.clip, self.other)):
                slot.has_clip, slot.clip = True, clip
            self.slot = self.track.clip_slots[0]
            def delete():
                self.calls.append(self.clip)
                self.slot.has_clip, self.slot.clip = False, None
            self.slot.delete_clip = delete
            clip_id = "track-0:clip-0"
            self.method = "delete_session_object" if alias else "delete_clip"
        else:
            self.clip.start_time, self.clip.end_time = 8, 12
            self.other.start_time, self.other.end_time = 32, 36
            self.track.arrangement_clips = [self.clip, self.other]
            def delete(clip):
                self.calls.append(clip)
                self.track.arrangement_clips.remove(clip)
            self.track.delete_clip = delete
            clip_id = "track-0:arrangement-clip-0"
            self.method = "delete_arrangement_clip"
        self.args = {"trackId": "track-0", "clipId": clip_id, "location": location, "expectedStateVersion": 3}
        if alias:
            self.args["target"] = {"targetType": "clip", "trackId": "track-0", "targetId": clip_id, "name": self.clip.name}

    def context(self):
        return dispatch_request(self.song, {"method": "get_clip_removal_source", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": self.method, "params": {**self.args, "before": before}}, 3)

    def test_all_three_entry_points_bind_full_source_and_remove_only_target(self):
        for location, alias in (("session", False), ("session", True), ("arrangement", False)):
            self.configure(location, alias)
            before = self.context()
            self.assertEqual(self.calls, [])
            self.assertEqual(before["source"]["notes"][0]["pitch"], 60)
            self.assertTrue(before["scope"]["wholeClip"])
            self.assertFalse(before["scope"]["restorableSnapshot"])
            result = self.execute(before)
            self.assertTrue(result["deletionVerified"], result)
            self.assertTrue(result["targetCleared"])
            self.assertTrue(result["ownerRetained"])
            self.assertTrue(result["otherClipsRetained"])
            self.assertEqual(self.calls, [self.clip])
            if location == "session":
                self.assertFalse(self.slot.has_clip)
                self.assertIs(self.track.clip_slots[1].clip, self.other)
                if alias:
                    self.assertEqual(result["deleted"]["targetId"], self.args["clipId"])
            else:
                self.assertEqual(result["clips"][0]["id"], "track-0:arrangement-clip-0")
                self.assertIs(self.track.arrangement_clips[0], self.other)
            self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_same_version_notes_timing_and_native_clip_replacement_refuse(self):
        for location in ("session", "arrangement"):
            for action in ("notes", "timing", "replace", "track", "other"):
                self.configure(location)
                before = self.context()
                if action == "notes":
                    self.clip.extended_notes[0].velocity = 42
                elif action == "timing":
                    self.clip.loop_end = 3
                elif action == "replace":
                    if location == "session":
                        self.slot.clip = copy.deepcopy(self.clip)
                    else:
                        self.track.arrangement_clips[0] = copy.deepcopy(self.clip)
                elif action == "track":
                    self.song.tracks[0] = copy.deepcopy(self.track)
                else:
                    self.other.name = "Manual edit"
                with self.assertRaisesRegex(ValueError, "changed"):
                    self.execute(before)
                self.assertEqual(self.calls, [])

    def test_scene_slot_and_track_reordering_refuse(self):
        for action in ("scene", "slot", "track"):
            self.configure()
            before = self.context()
            if action == "scene":
                self.song.scenes.reverse()
            elif action == "slot":
                self.track.clip_slots.reverse()
            else:
                self.song.tracks.reverse()
            with self.assertRaisesRegex(ValueError, "changed|empty|unknown"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_undo_entry_edit_prevents_native_deletion(self):
        for location in ("session", "arrangement"):
            self.configure(location)
            before = self.context()
            self.song.begin_undo_step = lambda: setattr(self.clip.extended_notes[0], "pitch", 12)
            with self.assertRaisesRegex(ValueError, "changed"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_native_failure_before_or_after_deletion_reports_actual_clearance(self):
        for location in ("session", "arrangement"):
            for after in (False, True):
                self.configure(location)
                before = self.context()
                native = self.slot.delete_clip if location == "session" else self.track.delete_clip
                def fail(*args):
                    if after:
                        native(*args)
                    raise RuntimeError("native deletion failed")
                if location == "session":
                    self.slot.delete_clip = fail
                else:
                    self.track.delete_clip = fail
                result = self.execute(before)
                self.assertTrue(result["deletionRequested"])
                self.assertFalse(result["nativeReturned"])
                self.assertFalse(result["deletionVerified"])
                self.assertEqual(result["targetCleared"], after)
                self.assertTrue(result["otherClipsRetained"])
                self.assertIn("native deletion failed", result["error"])
                self.assertEqual(len(self.calls), int(after))

    def test_native_noop_or_other_clip_loss_never_claims_verified(self):
        for location in ("session", "arrangement"):
            for action in ("noop", "other_loss"):
                self.configure(location)
                before = self.context()
                def incorrect(*args):
                    self.calls.append(True)
                    if action == "other_loss":
                        if location == "session":
                            self.track.clip_slots[1].has_clip, self.track.clip_slots[1].clip = False, None
                        else:
                            self.track.arrangement_clips.remove(self.other)
                if location == "session":
                    self.slot.delete_clip = incorrect
                else:
                    self.track.delete_clip = incorrect
                result = self.execute(before)
                self.assertFalse(result["deletionVerified"])
                self.assertFalse(result["targetCleared"])
                self.assertEqual(result["otherClipsRetained"], action == "noop")
                self.assertEqual(len(self.calls), 1)

    def test_undo_finalization_error_retains_actual_deletion_receipt(self):
        self.configure()
        before = self.context()
        def fail():
            raise RuntimeError("undo finalization failed")
        self.song.end_undo_step = fail
        result = self.execute(before)
        self.assertFalse(result["deletionVerified"])
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["targetCleared"])
        self.assertIn("undo finalization failed", result["error"])

    def test_owner_loss_reports_unknown_clearance_without_followup_writes(self):
        self.configure()
        before = self.context()
        def delete():
            self.calls.append(True)
            self.song.tracks[0] = copy.deepcopy(self.track)
        self.slot.delete_clip = delete
        result = self.execute(before)
        self.assertFalse(result["deletionVerified"])
        self.assertFalse(result["ownerRetained"])
        self.assertIsNone(result["targetCleared"])
        self.assertEqual(len(self.calls), 1)

    def test_audio_settings_are_bound_before_removal(self):
        for location in ("session", "arrangement"):
            self.configure(location)
            self.clip = AudioClip()
            self.clip.file_path = "/samples/voice.wav"
            if location == "session":
                self.slot.clip = self.clip
            else:
                self.clip.start_time, self.clip.end_time = 8, 12
                self.track.arrangement_clips[0] = self.clip
            before = self.context()
            self.clip.pitch_coarse += 1
            with self.assertRaisesRegex(ValueError, "changed"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_recording_frozen_pending_empty_and_noncanonical_targets_refuse(self):
        for action in ("record", "session_record", "count_in", "frozen", "pending", "empty", "track_id", "clip_id"):
            self.configure()
            if action == "record": self.song.record_mode = True
            elif action == "session_record": self.song.session_record = True
            elif action == "count_in": self.song.is_counting_in = True
            elif action == "frozen": self.track.is_frozen = True
            elif action == "pending": self.slot.is_triggered = True
            elif action == "empty": self.slot.has_clip, self.slot.clip = False, None
            elif action == "track_id": self.args["trackId"] = "track-00"
            else: self.args["clipId"] = "track-0:clip-00"
            with self.assertRaises(ValueError): self.context()
            self.assertEqual(self.calls, [])

    def test_explicit_playing_clip_deletion_does_not_stop_global_transport(self):
        self.configure()
        self.song.is_playing, self.clip.is_playing = True, True
        result = self.execute(self.context())
        self.assertTrue(result["deletionVerified"])
        self.assertTrue(self.song.is_playing)

    def test_metadata_only_and_mismatched_generic_target_refuse(self):
        self.configure(alias=True)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.execute({"name": self.clip.name})
        before = self.context()
        self.args["target"]["targetId"] = "track-0:clip-1"
        with self.assertRaises(ValueError): self.execute(before)
        self.assertEqual(self.calls, [])

    def test_invalidated_deleted_native_object_is_not_dereferenced(self):
        class NativeClip(Clip):
            def __init__(self):
                super().__init__()
                self.valid = True
                self.is_audio_clip = False
                self.extended_notes = [MidiNote()]
                self.start_time, self.end_time = 8, 12
            def __getattribute__(self, name):
                if name not in ("valid", "__dict__", "__class__") and not object.__getattribute__(self, "valid"):
                    raise RuntimeError("deleted native object")
                return object.__getattribute__(self, name)
            def __eq__(self, other):
                return object.__getattribute__(self, "valid") and self is other
        for location in ("session", "arrangement"):
            self.configure(location)
            self.clip = NativeClip()
            if location == "session":
                self.slot.clip = self.clip
                def delete():
                    self.calls.append(True)
                    self.clip.valid = False
                    self.slot.has_clip, self.slot.clip = False, None
                self.slot.delete_clip = delete
            else:
                self.track.arrangement_clips[0] = self.clip
                def delete(clip):
                    self.calls.append(True)
                    self.track.arrangement_clips.pop(0)
                    clip.valid = False
                self.track.delete_clip = delete
            result = self.execute(self.context())
            self.assertTrue(result["deletionVerified"], result)
            self.assertEqual(len(self.calls), 1)

    def test_excessive_source_notes_or_inventory_refuses_without_sampling(self):
        for action in ("notes", "slots", "clips"):
            self.configure("arrangement" if action == "clips" else "session")
            if action == "notes": self.clip.extended_notes = [MidiNote()] * 4097
            elif action == "slots": self.track.clip_slots *= 2049
            else: self.track.arrangement_clips *= 2049
            with self.assertRaisesRegex(ValueError, "4096"): self.context()
            self.assertEqual(self.calls, [])

    def test_inventory_reader_owner_change_invalidates_clearance_flags(self):
        self.configure()
        before = self.context()
        parent = self
        class OtherClip(Clip):
            @property
            def name(self):
                if not parent.slot.has_clip:
                    parent.song.tracks[0] = copy.copy(parent.track)
                return self._name
            @name.setter
            def name(self, value):
                self._name = value
        replacement = OtherClip()
        replacement.name = self.other.name
        self.track.clip_slots[1].clip = replacement
        # The replacement is part of the confirmed context; only its later read changes ownership.
        before = self.context()
        result = self.execute(before)
        self.assertFalse(result["ownerRetained"])
        self.assertFalse(result["deletionVerified"])
        self.assertIsNone(result["targetCleared"])
