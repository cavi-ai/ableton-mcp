import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class ArrangementPlacementContextTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.arrangement_clips = []
        self.track.clip_slots[0].clip.extended_notes = [MidiNote(7)]
        self.track.clip_slots[0].clip.start_marker = 0
        self.track.clip_slots[0].clip.end_marker = 4
        self.copies = []
        def duplicate(clip, start):
            placed = copy.deepcopy(clip)
            placed.is_audio_clip = bool(getattr(clip, "is_audio_clip", False))
            length = max(clip.loop_end - clip.loop_start, clip.loop_end - clip.start_marker) if clip.looping else clip.end_marker - clip.start_marker
            placed.start_time, placed.end_time = start, start + length
            self.track.arrangement_clips.append(placed)
            self.copies.append(placed)
            return placed
        self.track.duplicate_clip_to_arrangement = duplicate

    def call(self, method, extra=None, clip_id="track-0:clip-0", version=4):
        return dispatch_request(self.song, {"method": method, "params": {
            "trackId": "track-0", "clipId": clip_id, **(extra or {})}}, version)

    def plan(self, clip_id="track-0:clip-0"):
        before = self.call("get_session_clip_arrangement_source", clip_id=clip_id)
        return {"startBeats": 16, "endBeats": 16 + before["placement"]["lengthBeats"], "placement": before['placement'],
                "expectedStateVersion": 4, "source": before["source"],
                "beforeArrangement": before["beforeArrangement"], "sourceGuard": before["sourceGuard"]}

    def test_changed_note_or_loop_rejects_same_version_before_copy(self):
        for field in ("note", "loop"):
            with self.subTest(field=field):
                self.setUp()
                plan = self.plan()
                clip = self.track.clip_slots[0].clip
                if field == "note":
                    clip.extended_notes[0].velocity = 17
                else:
                    clip.loop_start = 0.25
                with self.assertRaisesRegex(ValueError, "source context changed"):
                    self.call("place_session_clip_in_arrangement", plan)
                self.assertEqual(self.copies, [])

    def test_identical_clip_track_or_document_replacement_invalidates_native_identity(self):
        for target in ("clip", "track", "song"):
            with self.subTest(target=target):
                self.setUp()
                plan = self.plan()
                if target == "clip":
                    slot = self.track.clip_slots[0]
                    slot.clip = copy.deepcopy(slot.clip)
                elif target == "track":
                    self.song.tracks[0] = copy.deepcopy(self.track)
                else:
                    self.song = copy.deepcopy(self.song)
                with self.assertRaisesRegex(ValueError, "source context changed"):
                    self.call("place_session_clip_in_arrangement", plan)
                self.assertEqual(self.copies, [])

    def test_audio_pitch_change_and_unwarped_or_frozen_source_are_refused(self):
        plan = self.plan("track-0:clip-2")
        self.track.clip_slots[2].clip.pitch_fine = 9
        with self.assertRaisesRegex(ValueError, "source context changed"):
            self.call("place_session_clip_in_arrangement", plan, "track-0:clip-2")
        self.track.clip_slots[2].clip.warping = False
        with self.assertRaisesRegex(ValueError, "unwarped"):
            self.plan("track-0:clip-2")
        self.track.is_frozen = True
        with self.assertRaisesRegex(ValueError, "frozen"):
            self.plan()
        self.assertEqual(self.copies, [])

    def test_fresh_context_places_copy_and_stale_version_refuses_before_write(self):
        plan = self.plan()
        with self.assertRaisesRegex(ValueError, "state version"):
            self.call("place_session_clip_in_arrangement", plan, version=5)
        self.assertEqual(self.copies, [])
        result = self.call("place_session_clip_in_arrangement", plan)
        self.assertEqual(result["placedClip"]["startBeats"], 16)
        self.assertEqual(result["placedClip"]["endBeats"], 20)
        self.assertEqual(len(self.copies), 1)

    def test_interval_mismatch_reports_expected_and_observed_span(self):
        duplicate = self.track.duplicate_clip_to_arrangement
        def changed_span(clip, start):
            placed = duplicate(clip, start)
            placed.end_time += 2
            return placed
        self.track.duplicate_clip_to_arrangement = changed_span
        self.track.delete_clip = lambda clip: self.track.arrangement_clips.remove(clip)
        result = self.call('place_session_clip_in_arrangement', self.plan())
        self.assertFalse(result['placementVerified'])
        self.assertRegex(result['error'], r'expected.*16.*20.*observed.*16.*22')
        self.assertEqual(len(self.track.arrangement_clips), 1)

    def test_offset_loop_span_and_inside_loop_entry(self):
        clip = self.track.clip_slots[0].clip
        clip.loop_start, clip.loop_end, clip.end_marker, clip.length = 2, 8, 8, 6
        before = self.call('get_session_clip_arrangement_source')
        self.assertEqual(before['placement']['lengthBeats'], 8)
        self.assertEqual(before['placement']['leadInBeats'], 2)
        result = self.call('place_session_clip_in_arrangement', self.plan())
        self.assertTrue(result['placementVerified'])
        self.assertEqual(result['placedClip']['endBeats'], 24)
        self.setUp()
        clip = self.track.clip_slots[0].clip
        clip.start_marker, clip.loop_start, clip.loop_end = 2, 1, 3
        self.assertEqual(self.call('get_session_clip_arrangement_source')['placement']['lengthBeats'], 2)

    def test_marker_range_for_nonlooped_clips_and_missing_markers_refuse(self):
        clip = self.track.clip_slots[0].clip
        clip.looping, clip.start_marker, clip.end_marker = False, 1, 3.5
        self.assertEqual(self.call('get_session_clip_arrangement_source')['placement']['lengthBeats'], 2.5)
        del clip.start_marker
        with self.assertRaisesRegex(ValueError, 'marker|range'): self.plan()

    def test_tail_overlap_and_undo_entry_changes_refuse_before_copy(self):
        clip = self.track.clip_slots[0].clip
        clip.loop_start, clip.loop_end, clip.end_marker, clip.length = 2, 8, 8, 6
        other = copy.deepcopy(clip)
        other.is_audio_clip, other.start_time, other.end_time = False, 22, 26
        self.track.arrangement_clips = [other]
        with self.assertRaisesRegex(ValueError, 'overlap'):
            self.call('place_session_clip_in_arrangement', self.plan())
        self.assertEqual(self.copies, [])
        self.track.arrangement_clips = []
        plan = self.plan()
        begin = self.song.begin_undo_step
        def changed():
            begin()
            clip.start_marker = .5
        self.song.begin_undo_step = changed
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.call('place_session_clip_in_arrangement', plan)
        self.assertEqual(self.copies, [])

    def test_native_exception_with_partial_copy_is_retained_and_reported(self):
        duplicate = self.track.duplicate_clip_to_arrangement
        def partial(clip, start):
            duplicate(clip, start)
            raise RuntimeError('native interrupted')
        self.track.duplicate_clip_to_arrangement = partial
        result = self.call('place_session_clip_in_arrangement', self.plan())
        self.assertFalse(result['nativeReturned'])
        self.assertFalse(result['placementVerified'])
        self.assertEqual(len(result['clips']), 1)
        self.assertIsNone(result['placedClip'])
        self.assertIn('native interrupted', result['error'])

    def test_capacity_reserves_one_copy_and_observes_the_full_limit(self):
        template = self.track.clip_slots[0].clip
        for index in range(4095):
            clip = copy.copy(template)
            clip.is_audio_clip, clip.start_time, clip.end_time = False, 100 + index * 10, 104 + index * 10
            self.track.arrangement_clips.append(clip)
        self.assertTrue(self.call('place_session_clip_in_arrangement', self.plan())['placementVerified'])
        self.assertEqual(len(self.track.arrangement_clips), 4096)
        self.assertEqual(len(self.call('get_session_clip_arrangement_source')['beforeArrangement']), 4096)
        plan = self.plan()
        plan.update(startBeats=32, endBeats=36)
        with self.assertRaisesRegex(ValueError, 'capacity|4096'):
            self.call('place_session_clip_in_arrangement', plan)
        self.assertEqual(len(self.copies), 1)

    def test_timing_reports_actual_markers_separately_from_loop_bounds(self):
        clip = self.track.clip_slots[0].clip
        clip.start_marker, clip.end_marker = 0.75, 3.5
        clip.loop_start, clip.loop_end = 1.0, 3.0
        timing = self.call("get_clip_timing")
        self.assertEqual(timing["markers"], {"supported": True, "unit": "beats", "startBeats": 0.75, "endBeats": 3.5})
        self.assertEqual(timing["loop"]["startBeats"], 1.0)
        placed = copy.deepcopy(clip)
        placed.is_audio_clip, placed.start_time, placed.end_time = False, 16, 20
        self.track.arrangement_clips = [placed]
        self.assertEqual(self.call("get_clip_timing", clip_id="track-0:arrangement-clip-0")["markers"], timing["markers"])
        audio = self.track.clip_slots[2].clip
        audio.warping = False
        self.assertEqual(self.call("get_clip_timing", clip_id="track-0:clip-2")["markers"],
                         {"supported": True, "unit": "seconds", "startSeconds": 0.0, "endSeconds": 8.0})
        del clip.start_marker
        del clip.end_marker
        self.assertEqual(self.call("get_clip_timing")["markers"], {"supported": False})


if __name__ == "__main__":
    unittest.main()
