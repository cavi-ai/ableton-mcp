import copy
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
import test_clip_duplication as fixtures
import clip_duplication


class SessionCopyGuardTests(unittest.TestCase):
    setUp = fixtures.ClipDuplicationTests.setUp
    source = fixtures.ClipDuplicationTests.source
    duplicate = fixtures.ClipDuplicationTests.duplicate

    def test_undo_entry_source_edit_refuses_before_copy(self):
        before = self.source()
        self.song.begin_undo_step = lambda: setattr(self.track.clip_slots[0].clip, "pitch_coarse", 12)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.duplicate(before)
        self.assertFalse(self.track.clip_slots[1].has_clip)

    def test_scene_and_unrelated_slot_replacement_invalidate_plan(self):
        for action in ("scene", "slot"):
            self.setUp()
            before = self.source()
            if action == "scene":
                self.song.scenes.reverse()
            else:
                # A slot outside the source/target pair still belongs to their layout.
                self.track.clip_slots.append(copy.deepcopy(self.track.clip_slots[1]))
            with self.assertRaisesRegex(ValueError, "changed"):
                self.duplicate(before)
            self.assertFalse(self.track.clip_slots[1].has_clip)

    def test_count_in_and_noncanonical_ids_refuse(self):
        self.song.is_counting_in = True
        with self.assertRaises(ValueError):
            self.source()
        self.setUp()
        for field, value in (("trackId", "track-00"), ("sourceClipId", "track-0:clip-00"), ("targetClipId", "track-0:clip-01")):
            previous = self.args[field]
            self.args[field] = value
            with self.assertRaises(ValueError):
                self.source()
            self.args[field] = previous

    def test_partial_copy_is_observed_without_deletion(self):
        before = self.source()
        native = self.track.clip_slots[0].duplicate_clip_to
        def broken(target):
            native(target)
            target.clip.pitch_coarse = 12
        self.track.clip_slots[0].duplicate_clip_to = broken
        self.track.clip_slots[1].delete_clip = lambda: self.fail("must not remove a partial copy")
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertTrue(result["copyRequested"])
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["targetOccupied"])
        self.assertFalse(result["nameWriteRequested"])
        self.assertEqual(self.track.clip_slots[1].clip.name, "Vocal")

    def test_native_exception_after_creation_retains_actual_observation(self):
        before = self.source()
        native = self.track.clip_slots[0].duplicate_clip_to
        def broken(target):
            native(target)
            raise RuntimeError("failed after creating")
        self.track.clip_slots[0].duplicate_clip_to = broken
        result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertFalse(result["nativeReturned"])
        self.assertTrue(result["targetOccupied"])
        self.assertEqual(result["observedCopy"]["name"], "Vocal")
        self.assertIn("failed after creating", result["error"])

    def test_generic_alias_requires_guard_and_copies_only_following_empty_slot(self):
        self.args.pop("name")
        target = {"targetType":"clip", "trackId":"track-0", "targetId":"track-0:clip-0", "destinationId":"track-0:clip-1", "name":"Vocal"}
        with self.assertRaises(ValueError):
            dispatch_request(self.song, {"method":"duplicate_session_object", "params":{"target":target}}, 3)
        before = self.source()
        slots_before = len(self.track.clip_slots)
        result = dispatch_request(self.song, {"method":"duplicate_session_object", "params":{**self.args,"before":before,"target":target}}, 3)
        self.assertTrue(result["copyVerified"])
        self.assertEqual(result["target"], target)
        self.assertEqual(len(self.track.clip_slots), slots_before)
        self.assertEqual(self.track.clip_slots[1].clip.name, "Vocal")

    def test_readers_invalidating_source_or_copy_prevent_naming(self):
        for invalidated in ("source", "copy"):
            self.setUp()
            before = self.source()
            native = clip_duplication._content
            def reading(song, track_id, clip_id, version):
                result = native(song, track_id, clip_id, version)
                if self.track.clip_slots[1].has_clip:
                    if invalidated == "source" and clip_id == self.args["targetClipId"]:
                        self.track.clip_slots[0].clip.pitch_coarse = 12
                    elif invalidated == "copy" and clip_id == self.args["sourceClipId"]:
                        self.track.clip_slots[1].clip.pitch_coarse = 12
                return result
            with patch.object(clip_duplication, "_content", reading):
                result = self.duplicate(before)
            self.assertFalse(result["copyVerified"])
            self.assertFalse(result["nameWriteRequested"])
            self.assertTrue(self.track.clip_slots[1].has_clip)

    def test_undo_finalization_failure_retains_written_copy_and_actual_flags(self):
        before = self.source()
        def failure():
            raise RuntimeError("undo end failed")
        self.song.end_undo_step = failure
        result = self.duplicate(before)
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["nameWriteReturned"])
        self.assertTrue(result["targetOccupied"])
        self.assertFalse(result["copyVerified"])
        self.assertIn("undo end failed", result["error"])

    def test_noop_and_native_failure_do_not_trigger_cleanup_or_replay(self):
        for fails in (False, True):
            self.setUp()
            before = self.source()
            calls = []
            def native(target):
                calls.append(target)
                if fails:
                    raise RuntimeError("copy unavailable")
            self.track.clip_slots[0].duplicate_clip_to = native
            result = self.duplicate(before)
            self.assertEqual(len(calls), 1)
            self.assertFalse(result["copyVerified"])
            self.assertEqual(result["nativeReturned"], not fails)
            self.assertFalse(result["targetOccupied"])

    def test_playback_continues_and_bounds_refuse_without_copy(self):
        self.song.is_playing = True
        self.assertTrue(self.duplicate(self.source())["copyVerified"])
        self.assertTrue(self.song.is_playing)
        self.setUp()
        self.track.clip_slots *= 1366
        with self.assertRaisesRegex(ValueError, "4096"):
            self.source()

    def test_final_copy_reader_changing_other_metadata_invalidates_receipt(self):
        before = self.source()
        native = clip_duplication._content
        def reading(song, track_id, clip_id, version):
            result = native(song, track_id, clip_id, version)
            if clip_id == self.args["targetClipId"] and result["name"] == "Alternative":
                self.track.clip_slots[2].clip.name = "Manual change during final read"
            return result
        with patch.object(clip_duplication, "_content", reading):
            result = self.duplicate(before)
        self.assertFalse(result["copyVerified"])
        self.assertFalse(result["otherClipsRetained"])
        self.assertEqual(result["clips"][2]["name"], "Manual change during final read")


if __name__ == "__main__":
    unittest.main()
