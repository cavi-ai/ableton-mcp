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

    def test_incomplete_native_copy_is_retained_without_naming(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            target.clip.pitch_coarse = 12

        self.track.clip_slots[0].duplicate_clip_to = broken
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertFalse(result["nameWriteRequested"])
        self.assertTrue(self.track.clip_slots[1].has_clip)
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

    def test_native_exception_after_creation_preserves_an_unconfirmed_copy(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            raise RuntimeError("native copy failed")

        self.track.clip_slots[0].duplicate_clip_to = broken
        result = self.duplicate(before)
        self.assertFalse(result["nativeReturned"])
        self.assertFalse(result["copyVerified"])
        self.assertIn("native copy failed", result["error"])
        self.assertTrue(self.track.clip_slots[1].has_clip)

    def test_failed_copy_verification_never_requests_cleanup(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            target.clip.pitch_coarse = 12

        self.track.clip_slots[0].duplicate_clip_to = broken

        def failed_cleanup():
            raise RuntimeError("cannot remove copy")

        self.track.clip_slots[1].delete_clip = failed_cleanup
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertNotIn("cannot remove copy", result["error"])
        self.assertTrue(self.track.clip_slots[1].has_clip)

    def test_midi_manual_note_edit_invalidates_without_state_version_change(self):
        self.track.clip_slots[0].clip = Song().tracks[0].clip_slots[0].clip
        self.track.clip_slots[0].clip.extended_notes = [MidiNote()]
        before = self.source()
        self.track.clip_slots[0].clip.extended_notes[0].velocity = 42
        with self.assertRaisesRegex(ValueError, "changed"):
            self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].has_clip)


class CrossTrackClipDuplicationTests(unittest.TestCase):
    source = ClipDuplicationTests.source
    duplicate = ClipDuplicationTests.duplicate

    def setUp(self):
        ClipDuplicationTests.setUp(self)
        destination = copy.deepcopy(self.track)
        destination.name = "Audio alternative"
        destination.has_audio_input, destination.has_midi_input = True, False
        self.song.tracks = [self.track, destination]
        self.destination = destination
        self.args.update(targetTrackId="track-1", targetClipId="track-1:clip-1")

    def test_audio_copy_uses_the_requested_destination_and_preserves_source_slots(self):
        result = self.duplicate(self.source())
        self.assertTrue(result["copyVerified"])
        self.assertEqual(result["trackId"], "track-1")
        self.assertEqual(result["sourceTrackId"], "track-0")
        self.assertEqual(result["copiedClipId"], "track-1:clip-1")
        self.assertEqual(self.destination.clip_slots[1].clip.name, "Alternative")
        self.assertFalse(self.track.clip_slots[1].has_clip)
        self.assertEqual(self.track.clip_slots[0].clip.name, "Vocal")

    def test_midi_copy_preserves_extended_notes_and_does_not_replace_target_devices(self):
        self.track.clip_slots[0].clip = Song().tracks[0].clip_slots[0].clip
        note = MidiNote()
        note.velocity, note.probability = 43, .6
        self.track.clip_slots[0].clip.extended_notes = [note]
        self.destination.has_midi_input, self.destination.has_audio_input = True, False
        devices = tuple(self.destination.devices)
        result = self.duplicate(self.source())
        copied = self.destination.clip_slots[1].clip.get_all_notes_extended()[0]
        self.assertTrue(result["copyVerified"])
        self.assertEqual((copied.velocity, copied.probability), (43, .6))
        self.assertEqual(tuple(self.destination.devices), devices)

    def test_destination_kind_occupancy_freeze_or_pending_launch_prevents_copy(self):
        changes = [lambda: setattr(self.destination, "has_audio_input", False),
                   lambda: setattr(self.destination, "is_frozen", True),
                   lambda: setattr(self.track, "is_frozen", True),
                   lambda: setattr(self.destination, "is_foldable", True),
                   lambda: setattr(self.destination.clip_slots[1], "is_triggered", True),
                   lambda: setattr(self.destination.clip_slots[1], "has_clip", True)]
        for change in changes:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.source()
            self.assertFalse(self.track.clip_slots[1].has_clip)

    def test_replaced_destination_or_changed_source_invalidates_a_same_version_plan(self):
        changes = [lambda: self.song.tracks.__setitem__(1, copy.deepcopy(self.destination)),
                   lambda: self.destination.clip_slots.__setitem__(1, copy.deepcopy(self.destination.clip_slots[1])),
                   lambda: setattr(self.destination, "name", "Renamed destination"),
                   lambda: setattr(self.track.clip_slots[0].clip, "pitch_coarse", 3)]
        for change in changes:
            self.setUp()
            before = self.source()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.duplicate(before)
            self.assertFalse(self.song.tracks[1].clip_slots[1].has_clip)

    def test_replaced_destination_during_copy_is_never_renamed_or_cleaned_up(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to
        replacement = copy.deepcopy(self.destination)
        replacement.clip_slots[1].has_clip = True
        replacement.clip_slots[1].clip = copy.deepcopy(self.track.clip_slots[0].clip)
        replacement.clip_slots[1].clip.name = "Manual content"

        def replacing(target):
            original(target)
            self.song.tracks[1] = replacement

        self.track.clip_slots[0].duplicate_clip_to = replacing
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertFalse(result["targetRetained"])
        self.assertFalse(result["nameWriteRequested"])
        self.assertEqual(replacement.clip_slots[1].clip.name, "Manual content")
        self.assertTrue(replacement.clip_slots[1].has_clip)

    def test_copy_readback_failure_retains_the_partial_destination_copy(self):
        before = self.source()
        original = self.track.clip_slots[0].duplicate_clip_to

        def broken(target):
            original(target)
            target.clip.pitch_coarse = 12

        self.track.clip_slots[0].duplicate_clip_to = broken
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertTrue(self.destination.clip_slots[1].has_clip)
        self.assertEqual(self.track.clip_slots[0].clip.pitch_coarse, 0)


if __name__ == "__main__":
    unittest.main()
