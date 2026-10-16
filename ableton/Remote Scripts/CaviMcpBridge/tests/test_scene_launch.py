import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, ClipSlot


class SceneLaunchTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        for track in self.song.tracks:
            track.playing_slot_index, track.fired_slot_index = -1, -1
            for slot in track.clip_slots:
                slot.has_stop_button, slot.will_record_on_start = True, False
        self.song.tracks[1].arm = True

    def read(self, scene_id="scene-0"):
        return dispatch_request(self.song, {"method": "get_scene_launch_context", "params": {"sceneId": scene_id}}, 4)

    def launch(self, baseline, **extra):
        return dispatch_request(self.song, {"method": "launch_scene", "params": {
            "sceneId": "scene-0", "expectedStateVersion": 4, "before": baseline, **extra}}, 4)

    def test_read_shows_clip_stop_and_recording_context_without_mutating(self):
        before = self.read()
        self.assertEqual(before["tracks"][0]["slot"]["action"], "launch-clip")
        self.assertEqual(before["tracks"][1]["slot"]["action"], "empty-stop")
        self.assertTrue(before["tracks"][1]["armed"])
        self.assertIn("recording", before)
        self.assertFalse(self.song.scenes[0].is_triggered)
        result = self.launch(before, forceLegato=True)
        self.assertTrue(result["launchRequested"])
        self.assertFalse(result["playbackVerified"])
        self.assertTrue(self.song.scenes[0].last_force_legato)

    def test_manual_changes_reject_at_native_boundary_without_launching(self):
        changes = [lambda: setattr(self.song.tracks[1].clip_slots[0], "has_stop_button", False),
                   lambda: setattr(self.song.tracks[0].clip_slots[0].clip, "launch_mode", 2),
                   lambda: setattr(self.song.tracks[1], "arm", False),
                   lambda: setattr(self.song, "tempo", 126),
                   lambda: setattr(self.song.scenes[0], "name", "Other"),
                   lambda: setattr(self.song.tracks[0], "fired_slot_index", 1)]
        for change in changes:
            self.setUp()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, "context changed"):
                self.launch(before)
            self.assertFalse(self.song.scenes[0].is_triggered)

    def test_same_metadata_replacement_and_document_switch_invalidate_native_identity(self):
        before = self.read()
        self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
        with self.assertRaisesRegex(ValueError, "context changed"):
            self.launch(before)
        before = self.read()
        self.song = copy.deepcopy(self.song)
        with self.assertRaisesRegex(ValueError, "context changed"):
            self.launch(before)

    def test_bad_scope_missing_baseline_or_version_refuse_without_firing(self):
        for key in ["scene--1", "scene-01", "scene-2", "other"]:
            with self.assertRaises(ValueError):
                self.read(key)
        before = self.read()
        for extra in [{"before": None}, {"expectedStateVersion": 3}, {"forceLegato": 1}]:
            with self.assertRaises(ValueError):
                self.launch(before, **extra)
        self.song.tracks *= 129
        with self.assertRaises(ValueError):
            self.read()

    def test_other_scene_read_does_not_invalidate_the_first_plan(self):
        before = self.read()
        self.read("scene-1")
        self.assertTrue(self.launch(before)["launchRequested"])

    def test_empty_slots_groups_and_scene_overrides_are_explicit(self):
        self.song.tracks[1].clip_slots[0].has_stop_button = False
        self.song.tracks[1].clip_slots[0].will_record_on_start = True
        self.song.scenes[0].tempo_enabled, self.song.scenes[0].tempo = True, 128
        before = self.read()
        self.assertEqual(before["tracks"][1]["slot"]["action"], "empty-no-stop")
        self.assertTrue(before["tracks"][1]["slot"]["willRecordOnStart"])
        self.assertEqual(before["scene"]["tempo"], {"enabled": True, "bpm": 128})
        self.song.tracks[1].is_foldable, self.song.tracks[1].fold_state = True, 0
        self.song.tracks[1].can_be_armed = False
        group = self.read()["tracks"][1]
        self.assertEqual(group["slot"]["action"], "group-slot")
        self.assertIsNone(group["playingSlotIndex"])
        self.assertIsNone(group["monitoring"])


if __name__ == "__main__":
    unittest.main()
