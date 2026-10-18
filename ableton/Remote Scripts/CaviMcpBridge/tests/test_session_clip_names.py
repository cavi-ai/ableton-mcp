import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class SessionClipNamesTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.owner = self.song.tracks[0]
        self.slot = self.owner.clip_slots[0]
        self.clip = self.slot.clip
        self.clip.notes = [(60,0.,1.,100,False)]
        self.ids = {"trackId":"track-0", "clipId":"track-0:clip-0"}

    def read(self):
        return dispatch_request(self.song, {"method":"get_session_clip_name_context", "params":self.ids}, 4)

    def rename(self, before=None, name="Verse — piano"):
        before = self.read() if before is None else before
        target = {"targetType":"clip", "trackId":"track-0", "targetId":"track-0:clip-0", "previousName":before["clip"]["name"], "name":name}
        return dispatch_request(self.song, {"method":"rename_session_object", "params":{
            **self.ids, "expectedStateVersion":4, "before":before, "name":name, "target":target}}, 4)

    def test_read_is_inert_and_rename_preserves_material_playback_and_selection(self):
        self.song.is_playing = True
        self.clip.is_playing = True
        original_notes = copy.deepcopy(self.clip.notes)
        selected = self.song.view.selected_track
        before = self.read()
        self.assertEqual(before, self.read())
        self.assertEqual(self.song.undo_boundaries, [])
        result = self.rename(before)
        self.assertTrue(result["verified"], result)
        self.assertTrue(result["targetRetained"])
        self.assertTrue(result["slotPreserved"])
        self.assertEqual(result["target"]["name"], "Verse — piano")
        self.assertEqual(self.clip.notes, original_notes)
        self.assertTrue(self.song.is_playing)
        self.assertIs(self.song.view.selected_track, selected)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_same_version_manual_name_or_native_layout_changes_refuse(self):
        for change in ("name", "clip", "slot", "scene", "track", "other-slot"):
            self.setUp()
            before = self.read()
            if change == "name": self.clip.name = "Manual label"
            elif change == "clip": self.slot.clip = copy.deepcopy(self.clip)
            elif change == "slot": self.owner.clip_slots[0] = copy.deepcopy(self.slot)
            elif change == "scene": self.song.scenes.reverse()
            elif change == "track": self.song.tracks[0] = copy.deepcopy(self.owner)
            else: self.owner.clip_slots[1] = copy.deepcopy(self.owner.clip_slots[1])
            with self.assertRaises(ValueError): self.rename(before)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_undo_entry_replacement_refuses_before_name_write(self):
        before = self.read()
        self.song.begin_undo_step = lambda: setattr(self.slot, "clip", copy.deepcopy(self.clip))
        with self.assertRaises(ValueError): self.rename(before)
        self.assertEqual(self.clip.name, "Loop")
        self.assertEqual(self.slot.clip.name, "Loop")

    def test_noop_has_no_write_or_undo_step(self):
        result = self.rename(name="Loop")
        self.assertTrue(result["verified"])
        self.assertFalse(result["writeRequested"])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_undo_finalization_failure_preserves_actual_name_and_unverified_receipt(self):
        def failure(): raise RuntimeError("end failed")
        self.song.end_undo_step = failure
        result = self.rename()
        self.assertFalse(result["verified"])
        self.assertTrue(result["nativeReturned"])
        self.assertEqual(result["observed"]["clip"]["name"], "Verse — piano")
        self.assertIn("end failed", result["error"])

    def test_audio_source_and_duplicate_labels_remain_intact(self):
        self.clip = AudioClip()
        self.clip.file_path = "/Samples/Original.wav"
        self.slot.clip = self.clip
        neighbor = copy.deepcopy(self.clip)
        self.owner.clip_slots[1].has_clip = True
        self.owner.clip_slots[1].clip = neighbor
        before_path = self.clip.file_path
        result = self.rename(name=neighbor.name)
        self.assertTrue(result["verified"])
        self.assertEqual(self.clip.file_path, before_path)
        self.assertEqual(neighbor.name, self.clip.name)

    def test_invalid_ids_empty_slots_names_and_unbound_legacy_request_refuse(self):
        for ids in ({"trackId":"track-00", "clipId":"track-00:clip-0"}, {"trackId":"track-0", "clipId":"track-0:clip-00"},
                    {"trackId":"track-0", "clipId":"track-0:arrangement-clip-0"}, {"trackId":"track-0", "clipId":"track-0:clip-1"}):
            self.ids = ids
            with self.assertRaises(ValueError): self.read()
        self.setUp()
        for name in ("", "  ", "line\nbreak", "x"*256):
            with self.assertRaises(ValueError): self.rename(name=name)
        with self.assertRaises(ValueError):
            dispatch_request(self.song, {"method":"rename_session_object", "params":{"target":{
                "targetType":"clip", "trackId":"track-0", "targetId":"track-0:clip-0", "previousName":"Loop", "name":"Unsafe"}}}, 4)
        self.assertEqual(self.clip.name, "Loop")

    def test_runtime_recording_length_does_not_invalidate_a_label_plan(self):
        before = self.read()
        self.clip.length = 64
        self.clip.is_recording = True
        self.clip.is_playing = True
        self.song.is_playing = True
        self.song.session_record = True
        result = self.rename(before)
        self.assertTrue(result["verified"])
        self.assertEqual(self.clip.length, 64)
        self.assertTrue(self.clip.is_recording)
        self.assertTrue(self.song.session_record)

    def test_session_names_keep_the_existing_255_character_limit(self):
        result = self.rename(name="x"*255)
        self.assertTrue(result["verified"])
        self.assertEqual(self.clip.name, "x"*255)

    def test_setter_failure_before_or_after_write_is_not_replayed(self):
        for after in (False, True):
            self.setUp()
            class UncertainClip(type(self.clip)):
                @property
                def name(clip): return clip.label
                @name.setter
                def name(clip, value):
                    clip.calls += 1
                    if after: clip.label = value
                    raise RuntimeError("name write failed")
            uncertain = UncertainClip.__new__(UncertainClip)
            uncertain.__dict__.update(self.clip.__dict__)
            uncertain.label, uncertain.calls = "Loop", 0
            self.slot.clip = uncertain
            result = self.rename()
            self.assertTrue(result["writeRequested"])
            self.assertFalse(result["nativeReturned"])
            self.assertFalse(result["verified"])
            self.assertEqual(result["observed"]["clip"]["name"], "Verse — piano" if after else "Loop")
            self.assertEqual(uncertain.calls, 1)

    def test_lost_owner_after_write_is_unverified_without_a_success_target(self):
        def replace(): self.song.tracks[0] = copy.deepcopy(self.owner)
        self.song.end_undo_step = replace
        result = self.rename()
        self.assertTrue(result["nativeReturned"])
        self.assertFalse(result["targetRetained"])
        self.assertFalse(result["verified"])
        self.assertNotIn("target", result)

    def test_bounds_refuse_without_name_writes(self):
        for kind in ("tracks", "slots", "scenes"):
            self.setUp()
            if kind == "tracks": self.song.tracks *= 129
            elif kind == "slots": self.owner.clip_slots *= 1366
            else: self.song.scenes *= 2049
            with self.assertRaises(ValueError): self.read()
            self.assertEqual(self.clip.name, "Loop")


if __name__ == "__main__": unittest.main()
