import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Clip, AudioClip, MidiNote


class ArrangementMoveTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.clip = Clip()
        self.clip.is_audio_clip = False
        self.clip.start_time, self.clip.end_time = 8, 12
        self.clip.extended_notes = [MidiNote()]
        self.other = copy.deepcopy(self.clip)
        self.other.name = "Other phrase"
        self.other.start_time, self.other.end_time = 32, 36
        self.track.arrangement_clips = [self.clip, self.other]
        self.calls = []
        def duplicate(clip, start):
            self.calls.append(("copy", clip, start))
            result = copy.deepcopy(clip)
            result.start_time, result.end_time = start, start + clip.end_time - clip.start_time
            self.track.arrangement_clips.append(result)
            self.track.arrangement_clips.sort(key=lambda item: item.start_time)
            return result
        def delete(clip):
            self.calls.append(("delete", clip))
            self.track.arrangement_clips.remove(clip)
        self.track.duplicate_clip_to_arrangement = duplicate
        self.track.delete_clip = delete
        self.args = {"trackId": "track-0", "clipId": "track-0:arrangement-clip-0",
                     "startBeats": 10, "expectedStateVersion": 3}

    def context(self):
        return dispatch_request(self.song, {"method": "get_arrangement_move_source", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": "move_arrangement_clip",
                                "params": {**self.args, "before": before}}, 3)

    def test_self_overlap_move_verifies_material_before_removing_staging(self):
        before = self.context()
        self.assertEqual(self.calls, [])
        self.assertEqual(before["stagingStartBeats"], 37)
        result = self.execute(before)
        self.assertTrue(result["moveVerified"])
        self.assertTrue(result["existingIntervalsPreserved"])
        self.assertFalse(result["sourceRetained"])
        self.assertIsNone(result["stagingClip"])
        self.assertEqual(result["movedClip"]["startBeats"], 10)
        self.assertEqual(result["movedClip"]["endBeats"], 14)
        self.assertEqual(result["observedDestination"]["notes"], before["source"]["notes"])
        self.assertEqual([call[0] for call in self.calls], ["copy", "delete", "copy", "delete"])
        self.assertIs(self.track.arrangement_clips[1], self.other)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_move_before_source_re_resolves_index_ids(self):
        self.args["startBeats"] = 0
        result = self.execute(self.context())
        self.assertTrue(result["moveVerified"])
        self.assertEqual(result["movedClip"]["id"], "track-0:arrangement-clip-0")
        self.assertEqual(result["movedClip"]["startBeats"], 0)

    def test_noop_skips_native_writes_and_undo(self):
        self.args["startBeats"] = 8
        result = self.execute(self.context())
        self.assertTrue(result["moveVerified"])
        self.assertTrue(result["sourceRetained"])
        self.assertFalse(result["moveRequested"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_same_version_source_layout_and_native_replacement_refuse(self):
        for change in (lambda: setattr(self.clip.extended_notes[0], "velocity", 42),
                       lambda: setattr(self.clip, "loop_end", 3),
                       lambda: self.track.arrangement_clips.__setitem__(0, copy.deepcopy(self.clip)),
                       lambda: self.song.tracks.__setitem__(0, copy.deepcopy(self.track)),
                       lambda: setattr(self.other, "start_time", 33)):
            self.setUp()
            before = self.context()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_undo_entry_edit_refuses_before_staging(self):
        before = self.context()
        self.song.begin_undo_step = lambda: setattr(self.clip.extended_notes[0], "pitch", 42)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.execute(before)
        self.assertEqual(self.calls, [])

    def test_bad_staging_content_or_interval_retains_original(self):
        for change in (lambda c: setattr(c.extended_notes[0], "pitch", 12),
                       lambda c: setattr(c, "start_time", c.start_time + 1)):
            self.setUp()
            before, native = self.context(), self.track.duplicate_clip_to_arrangement
            def duplicate(clip, start):
                created = native(clip, start)
                change(created)
                return created
            self.track.duplicate_clip_to_arrangement = duplicate
            result = self.execute(before)
            self.assertFalse(result["moveVerified"])
            self.assertTrue(result["sourceRetained"])
            self.assertFalse(result["sourceRemovalRequested"])
            self.assertIsNotNone(result["stagingClip"])
            self.assertEqual(len(self.calls), 1)

    def test_stage_content_read_editing_original_prevents_source_deletion(self):
        before, native = self.context(), self.track.duplicate_clip_to_arrangement
        def duplicate(clip, start):
            created = native(clip, start)
            def notes():
                self.clip.extended_notes[0].pitch = 12
                return created.extended_notes
            created.get_all_notes_extended = notes
            return created
        self.track.duplicate_clip_to_arrangement = duplicate
        result = self.execute(before)
        self.assertFalse(result["moveVerified"])
        self.assertFalse(result["sourceRemovalRequested"])
        self.assertIs(self.track.arrangement_clips[0], self.clip)
        self.assertEqual(len(self.calls), 1)

    def test_failed_source_removal_keeps_stage_and_never_reconstructs(self):
        for after in (False, True):
            self.setUp()
            before, native = self.context(), self.track.delete_clip
            def delete(clip):
                if after:
                    native(clip)
                raise RuntimeError("source delete failed")
            self.track.delete_clip = delete
            result = self.execute(before)
            self.assertFalse(result["moveVerified"])
            self.assertTrue(result["sourceRemovalRequested"])
            self.assertFalse(result["sourceRemovalReturned"])
            self.assertFalse(result["destinationCopyRequested"])
            self.assertEqual(result["sourceRetained"], not after)
            self.assertIsNotNone(result["stagingClip"])
            self.assertEqual(sum(c[0] == "copy" for c in self.calls), 1)

    def test_failed_destination_copy_keeps_stage_and_reports_unknown_partial(self):
        for after in (False, True):
            self.setUp()
            before, native = self.context(), self.track.duplicate_clip_to_arrangement
            def duplicate(clip, start):
                if start == self.args["startBeats"]:
                    if after:
                        native(clip, start)
                    raise RuntimeError("destination failed")
                return native(clip, start)
            self.track.duplicate_clip_to_arrangement = duplicate
            result = self.execute(before)
            self.assertFalse(result["moveVerified"])
            self.assertFalse(result["sourceRetained"])
            self.assertTrue(result["destinationCopyRequested"])
            self.assertFalse(result["destinationCopyReturned"])
            self.assertFalse(result["stagingRemovalRequested"])
            self.assertIsNotNone(result["stagingClip"])
            self.assertIsNone(result["movedClip"])
            self.assertEqual(len(self.track.arrangement_clips), 3 if after else 2)

    def test_bad_destination_retains_stage(self):
        before, native = self.context(), self.track.duplicate_clip_to_arrangement
        def duplicate(clip, start):
            created = native(clip, start)
            if start == self.args["startBeats"]:
                created.extended_notes[0].pitch = 12
            return created
        self.track.duplicate_clip_to_arrangement = duplicate
        result = self.execute(before)
        self.assertFalse(result["moveVerified"])
        self.assertFalse(result["stagingRemovalRequested"])
        self.assertIsNotNone(result["stagingClip"])
        self.assertIsNotNone(result["movedClip"])
        self.assertEqual(len(self.calls), 3)

    def test_staging_delete_or_undo_failure_reports_actual_destination(self):
        for phase in ("stage_delete", "undo_end"):
            self.setUp()
            before, native = self.context(), self.track.delete_clip
            def delete(clip):
                if clip != self.clip:
                    raise RuntimeError("staging delete failed")
                native(clip)
            def end():
                raise RuntimeError("undo finalization failed")
            if phase == "stage_delete":
                self.track.delete_clip = delete
            else:
                self.song.end_undo_step = end
            result = self.execute(before)
            self.assertFalse(result["moveVerified"])
            self.assertTrue(result["destinationCopyReturned"])
            self.assertEqual(result["movedClip"]["startBeats"], 10)
            self.assertIsNotNone(result["error"])
            self.assertEqual(result["stagingClip"] is not None, phase == "stage_delete")

    def test_audio_move_preserves_exposed_settings_and_reference(self):
        self.clip = AudioClip()
        self.clip.start_time, self.clip.end_time = 8, 12
        self.clip.file_path = "/samples/voice.wav"
        self.track.arrangement_clips[0] = self.clip
        self.track.has_audio_input, self.track.has_midi_input = True, False
        before = self.context()
        result = self.execute(before)
        self.assertTrue(result["moveVerified"])
        self.assertEqual(result["observedDestination"]["audio"]["source"], before["source"]["audio"]["source"])

    def test_unsafe_and_ambiguous_targets_refuse(self):
        for change in (lambda: self.args.update(startBeats=33),
                       lambda: self.args.update(startBeats=float("inf")),
                       lambda: self.args.update(startBeats=True),
                       lambda: self.args.update(trackId="track-00"),
                       lambda: self.args.update(clipId="track-0:clip-0"),
                       lambda: setattr(self.track, "is_frozen", True),
                       lambda: setattr(self.track, "is_foldable", True),
                       lambda: setattr(self.song, "record_mode", True),
                       lambda: setattr(self.song, "session_record", True),
                       lambda: setattr(self.song, "is_counting_in", True)):
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.context()
            self.assertEqual(self.calls, [])

    def test_capacity_reserves_one_extra_clip_and_noop_still_works(self):
        for index in range(4094):
            clip = copy.deepcopy(self.clip)
            clip.start_time, clip.end_time = 100 + index * 4, 104 + index * 4
            self.track.arrangement_clips.append(clip)
        with self.assertRaisesRegex(ValueError, "4095"):
            self.context()
        self.args["startBeats"] = 8
        self.assertTrue(self.execute(self.context())["moveVerified"])
        self.assertEqual(self.calls, [])

    def test_legacy_metadata_only_confirmation_refuses(self):
        with self.assertRaisesRegex(ValueError, "changed"):
            self.execute({"id": self.args["clipId"], "name": self.clip.name})
        self.assertEqual(self.calls, [])

    def test_staging_is_after_both_destination_and_existing_material(self):
        self.args["startBeats"] = 100
        before = self.context()
        self.assertEqual(before["endBeats"], 104)
        self.assertEqual(before["stagingStartBeats"], 105)
        self.assertTrue(self.execute(before)["moveVerified"])

    def test_last_staging_capacity_returns_verified_move(self):
        for index in range(4093):
            clip = copy.deepcopy(self.clip)
            clip.start_time, clip.end_time = 100 + index * 4, 104 + index * 4
            self.track.arrangement_clips.append(clip)
        result = self.execute(self.context())
        self.assertTrue(result["moveVerified"])
        self.assertEqual(len(self.track.arrangement_clips), 4095)

    def test_observation_failure_invalidates_prior_preservation_flags(self):
        before, native = self.context(), self.track.duplicate_clip_to_arrangement
        def duplicate(clip, start):
            created = native(clip, start)
            created.extended_notes[0].pitch = 12
            reads = []
            def notes():
                reads.append(True)
                if len(reads) > 1 and original in self.track.arrangement_clips:
                    self.track.arrangement_clips.remove(original)
                return created.extended_notes
            original = clip
            created.get_all_notes_extended = notes
            return created
        self.track.duplicate_clip_to_arrangement = duplicate
        result = self.execute(before)
        self.assertFalse(result["moveVerified"])
        self.assertFalse(result["sourcePreserved"])
        self.assertIsNone(result["sourceRetained"])
        self.assertIn("observationError", result)

    def test_original_reader_invalidating_staging_prevents_source_removal(self):
        before, native = self.context(), self.track.duplicate_clip_to_arrangement
        def notes():
            for item in self.track.arrangement_clips:
                if item != self.clip and item != self.other:
                    item.extended_notes[0].pitch = 12
            return self.clip.extended_notes
        self.clip.get_all_notes_extended = notes
        def duplicate(clip, start):
            created = native(clip, start)
            # Native copies read their own notes, not a Python callback copied from the fixture.
            created.__dict__.pop("get_all_notes_extended", None)
            return created
        self.track.duplicate_clip_to_arrangement = duplicate
        result = self.execute(before)
        self.assertFalse(result["sourceRemovalRequested"])
        self.assertTrue(result["sourceRetained"])
        self.assertEqual(self.clip.extended_notes[0].pitch, 60)
        self.assertEqual(len(self.calls), 1)

    def test_destination_reader_invalidating_staging_prevents_staging_removal(self):
        before, native = self.context(), self.track.duplicate_clip_to_arrangement
        staging = []
        def duplicate(clip, start):
            created = native(clip, start)
            if start != self.args["startBeats"]:
                staging.append(created)
            else:
                def notes():
                    staging[0].extended_notes[0].pitch = 12
                    return created.extended_notes
                created.get_all_notes_extended = notes
            return created
        self.track.duplicate_clip_to_arrangement = duplicate
        result = self.execute(before)
        self.assertFalse(result["stagingRemovalRequested"])
        self.assertFalse(result["moveVerified"])
        self.assertIsNotNone(result["stagingClip"])
        self.assertEqual(result["observedDestination"]["notes"][0]["pitch"], 60)
