import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, ClipSlot, MidiNote


class ClipVariationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.clip_slots = [ClipSlot(), ClipSlot(False), ClipSlot(False)]
        self.source = self.track.clip_slots[0].clip
        self.source.extended_notes = [MidiNote(7), MidiNote(9)]
        self.source.extended_notes[1].pitch = 38
        self.source.start_marker = 0.0
        self.source.end_marker = 4.0
        self.song.view.detail_clip = self.source
        self.song.view.highlighted_clip_slot = self.track.clip_slots[0]
        self.song.view.selected_scene = self.song.scenes[0]

    def call(self, method, params=None, version=4):
        return dispatch_request(self.song, {"method": method, "params": params or {}}, version)

    def plan(self):
        return {"expectedStateVersion": 4, "trackId": "track-0", "sourceClipId": "track-0:clip-0",
                "before": self.call("get_midi_clip_variation_context", {"trackId": "track-0", "sourceClipId": "track-0:clip-0"}),
                "variants": [{"clipId": "track-0:clip-1", "name": "Sparse"},
                             {"clipId": "track-0:clip-2", "name": "Swing"}]}

    def test_selection_resolves_detail_clip_without_changing_focus(self):
        result = self.call("get_selection_context")
        self.assertEqual(result["selectedTrack"]["id"], "track-0")
        self.assertEqual(result["detailClip"]["clipId"], "track-0:clip-0")
        self.assertEqual(result["detailClip"]["type"], "midi")
        self.assertEqual(result["highlightedClipSlot"]["clipId"], "track-0:clip-0")
        self.assertIs(self.song.view.detail_clip, self.source)

    def test_selection_handles_empty_slots_return_main_and_no_clip(self):
        self.song.view.detail_clip = None
        self.song.view.highlighted_clip_slot = self.track.clip_slots[1]
        result = self.call("get_selection_context")
        self.assertIsNone(result["detailClip"])
        self.assertFalse(result["highlightedClipSlot"]["hasClip"])
        self.song.view.selected_track = self.song.return_tracks[0]
        self.assertEqual(self.call("get_selection_context")["selectedTrack"]["id"], "return-0")
        self.song.view.selected_track = self.song.master_track
        self.assertEqual(self.call("get_selection_context")["selectedTrack"]["id"], "master")

    def test_group_tracks_do_not_expose_arrangement_clips(self):
        class Group:
            name = "Group"
            is_foldable = True
            @property
            def arrangement_clips(self):
                raise RuntimeError("Main, Group and Return Tracks have no arrangement clips")
        group = Group()
        group.clip_slots = [ClipSlot(False)]
        self.song.tracks.append(group)
        self.song.view.selected_track = group
        self.song.view.highlighted_clip_slot = group.clip_slots[0]
        result = self.call("get_selection_context")
        self.assertEqual(result["selectedTrack"]["type"], "group")
        self.assertEqual(result["detailClip"]["clipId"], "track-0:clip-0")
        self.assertEqual(result["highlightedClipSlot"]["clipId"], "track-2:clip-0")

    def test_selection_skips_non_rack_chain_properties(self):
        class NonRack:
            name = "Instrument"
            can_have_chains = False
            @property
            def chains(self):
                raise RuntimeError("device cannot have chains")
        selected = SimpleNamespace(name="Effect")
        self.track.devices = [NonRack(), selected]
        self.track.view = SimpleNamespace(selected_device=selected)
        self.assertEqual(self.call("get_selection_context")["selectedDevice"]["deviceId"], "track-0:device-1")

    def test_selection_resolves_arrangement_and_nested_device(self):
        selected = SimpleNamespace(name="Nested")
        self.track.devices = [SimpleNamespace(name="Rack", can_have_chains=True,
            chains=[SimpleNamespace(devices=[selected])], return_chains=[])]
        self.track.view = SimpleNamespace(selected_device=selected)
        self.track.arrangement_clips = [copy.deepcopy(self.source)]
        self.song.view.detail_clip = self.track.arrangement_clips[0]
        result = self.call("get_selection_context")
        self.assertEqual(result["detailClip"]["location"], "arrangement")
        self.assertEqual(result["selectedDevice"]["deviceId"], "track-0:device-0/chain-0/device-0")

    def test_readback_failure_and_incomplete_cleanup_are_explicit(self):
        plan = self.plan()
        original = self.track.clip_slots[0].duplicate_clip_to
        def corrupt(target):
            original(target)
            target.clip.extended_notes[0].velocity = 1
        self.track.clip_slots[0].duplicate_clip_to = corrupt
        with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
            self.call("duplicate_midi_clip_variations", plan)
        self.assertFalse(self.track.clip_slots[1].has_clip)
        def failed_cleanup():
            raise RuntimeError("delete failed")
        self.track.clip_slots[1].delete_clip = failed_cleanup
        with self.assertRaisesRegex(RuntimeError, "cleanup was incomplete"):
            self.call("duplicate_midi_clip_variations", plan)

    def test_copy_preserves_source_and_verifies_both_copies_in_one_undo_step(self):
        before = copy.deepcopy(self.source.__dict__)
        result = self.call("duplicate_midi_clip_variations", self.plan())
        self.assertEqual([item["name"] for item in result["variants"]], ["Sparse", "Swing"])
        self.assertEqual(result["stateVersion"], 5)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])
        self.assertEqual([note.velocity for note in self.source.extended_notes],
                         [note.velocity for note in before["extended_notes"]])
        self.assertEqual(self.source.name, before["name"])
        self.assertEqual(result["variants"][0]["source"]["notes"], result["source"]["notes"])

    def test_manual_note_edit_or_occupied_target_invalidates_the_plan(self):
        plan = self.plan()
        self.source.extended_notes[0].velocity = 77
        with self.assertRaisesRegex(ValueError, "changed"):
            self.call("duplicate_midi_clip_variations", plan)
        self.assertFalse(self.track.clip_slots[1].has_clip)
        plan = self.plan()
        self.track.clip_slots[2].create_clip(4)
        with self.assertRaisesRegex(ValueError, "changed|empty"):
            self.call("duplicate_midi_clip_variations", plan)
        self.assertFalse(self.track.clip_slots[1].has_clip)

    def test_partial_failure_removes_only_new_copies(self):
        plan = self.plan()
        original_duplicate = self.track.clip_slots[0].duplicate_clip_to
        def fail_second(target):
            original_duplicate(target)
            if target is self.track.clip_slots[2]:
                raise RuntimeError("duplicate failure")
        self.track.clip_slots[0].duplicate_clip_to = fail_second
        with self.assertRaisesRegex(RuntimeError, "duplicate failure"):
            self.call("duplicate_midi_clip_variations", plan)
        self.assertTrue(self.track.clip_slots[0].has_clip)
        self.assertFalse(self.track.clip_slots[1].has_clip)
        self.assertFalse(self.track.clip_slots[2].has_clip)

    def test_recording_and_frozen_tracks_are_refused(self):
        self.song.session_record = True
        with self.assertRaisesRegex(ValueError, "record"):
            self.plan()
        self.song.session_record = False
        self.track.is_frozen = True
        with self.assertRaisesRegex(ValueError, "frozen"):
            self.plan()

    def test_one_shot_launch_uses_song_quantization_not_clip_property_values(self):
        for requested, expected in ((0, self.song.clip_trigger_quantization), (1, 0), (2, 1), (12, 11), (14, 13)):
            with self.subTest(requested=requested):
                self.call("launch_clip", {"trackId": "track-0", "clipId": "track-0:clip-0", "launchQuantization": requested})
                self.assertEqual(self.track.clip_slots[0].last_launch_quantization, expected)


if __name__ == "__main__":
    unittest.main()
