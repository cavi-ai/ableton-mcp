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
        self.copies = []
        def duplicate(clip, start):
            placed = copy.deepcopy(clip)
            placed.is_audio_clip = bool(getattr(clip, "is_audio_clip", False))
            placed.start_time, placed.end_time = start, start + clip.length
            self.track.arrangement_clips.append(placed)
            self.copies.append(placed)
            return placed
        self.track.duplicate_clip_to_arrangement = duplicate

    def call(self, method, extra=None, clip_id="track-0:clip-0", version=4):
        return dispatch_request(self.song, {"method": method, "params": {
            "trackId": "track-0", "clipId": clip_id, **(extra or {})}}, version)

    def plan(self, clip_id="track-0:clip-0"):
        before = self.call("get_session_clip_arrangement_source", clip_id=clip_id)
        return {"startBeats": 16, "endBeats": 16 + before["source"]["lengthBeats"],
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
        audio.warping = audio.looping = False
        audio.loop_start, audio.loop_end = .25, 2.
        self.assertEqual(self.call("get_clip_timing", clip_id="track-0:clip-2")["markers"],
                         {"supported": True, "unit": "seconds", "startSeconds": .25, "endSeconds": 2.})
        del clip.start_marker
        del clip.end_marker
        self.assertEqual(self.call("get_clip_timing")["markers"], {"supported": False})


if __name__ == "__main__":
    unittest.main()
