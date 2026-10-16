import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip, MidiNote


class ClipDuplicationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.clip_slots[0].clip = AudioClip()
        self.args = {"trackId": "track-0", "sourceClipId": "track-0:clip-0",
                     "targetClipId": "track-0:clip-1", "expectedStateVersion": 3, "name": "Alternative"}

    def source(self):
        return dispatch_request(self.song, {"method": "get_clip_duplication_source", "params": self.args}, 3)

    def duplicate(self, before):
        return dispatch_request(self.song, {"method": "duplicate_clip", "params": {**self.args, "before": before}}, 3)

    def test_named_audio_copy_preserves_source_and_verifies_exposed_content(self):
        before = self.source()
        result = self.duplicate(before)
        self.assertTrue(result["copyVerified"])
        self.assertEqual(self.track.clip_slots[1].clip.name, "Alternative")
        self.assertEqual(self.track.clip_slots[0].clip.name, "Vocal")
        self.assertEqual(self.track.clip_slots[1].clip.pitch_coarse, 0)

    def test_manual_source_edits_and_native_replacements_refuse_without_writing(self):
        for change in [lambda: setattr(self.track.clip_slots[0].clip, "pitch_coarse", 2),
                       lambda: self.track.clip_slots.__setitem__(1, copy.deepcopy(self.track.clip_slots[1])),
                       lambda: setattr(self.track.clip_slots[0], "clip", copy.deepcopy(self.track.clip_slots[0].clip))]:
            self.setUp()
            before = self.source()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.duplicate(before)
            self.assertFalse(self.track.clip_slots[1].has_clip)

    def test_unwarped_audio_uses_seconds_without_changing_source(self):
        self.track.clip_slots[0].clip.warping = False
        before = self.source()
        self.assertEqual(before["source"]["audio"]["markers"]["unit"], "seconds")
        self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].clip.warping)

    def test_incomplete_native_copy_is_cleaned_up(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            target.clip.pitch_coarse = 12

        self.track.clip_slots[0].duplicate_clip_to = broken
        with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
            self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].has_clip)
        self.assertEqual(self.track.clip_slots[0].clip.pitch_coarse, 0)

    def test_recording_pending_launches_and_missing_guard_refuse(self):
        for change in [lambda: setattr(self.song, "record_mode", True),
                       lambda: setattr(self.track.clip_slots[0].clip, "is_recording", True),
                       lambda: setattr(self.track.clip_slots[1], "is_triggered", True)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.source()
        self.setUp()
        with self.assertRaisesRegex(ValueError, "changed"):
            self.duplicate(None)

    def test_midi_copy_preserves_all_stored_note_properties(self):
        self.track.clip_slots[0].clip = Song().tracks[0].clip_slots[0].clip
        self.track.clip_slots[0].clip.extended_notes = [MidiNote()]
        result = self.duplicate(self.source())
        self.assertTrue(result["copyVerified"])
        self.assertEqual(self.track.clip_slots[1].clip.get_all_notes_extended()[0].velocity, 100)

    def test_native_exception_after_creation_cleans_up_and_cleanup_failure_is_explicit(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            raise RuntimeError("native copy failed")

        self.track.clip_slots[0].duplicate_clip_to = broken
        with self.assertRaisesRegex(RuntimeError, "native copy failed"):
            self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].has_clip)

        def failed_cleanup():
            raise RuntimeError("cannot remove copy")

        self.track.clip_slots[1].delete_clip = failed_cleanup
        with self.assertRaisesRegex(RuntimeError, "cleanup failed: cannot remove copy"):
            self.duplicate(before)
        self.assertTrue(self.track.clip_slots[1].has_clip)

    def test_midi_manual_note_edit_invalidates_without_state_version_change(self):
        self.track.clip_slots[0].clip = Song().tracks[0].clip_slots[0].clip
        self.track.clip_slots[0].clip.extended_notes = [MidiNote()]
        before = self.source()
        self.track.clip_slots[0].clip.extended_notes[0].velocity = 42
        with self.assertRaisesRegex(ValueError, "changed"):
            self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].has_clip)


if __name__ == "__main__":
    unittest.main()
