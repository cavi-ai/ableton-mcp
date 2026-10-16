import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, DrumRack


class ArrangementSectionTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.view.detail_clip = None
        for track in self.song.tracks:
            track.arrangement_clips = []
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.extended_notes = [MidiNote(7)]
        self.clip.start_time, self.clip.end_time = 16.0, 28.0
        self.clip.start_marker, self.clip.end_marker = 1.0, 10.0
        self.clip.loop_start, self.clip.loop_end = 2.0, 6.0
        self.song.tracks[0].arrangement_clips = [self.clip]

    def read(self, **changes):
        return dispatch_request(self.song, {"method": "analyze_arrangement_section", "params": {
            "startBeats": 17, "endBeats": 21, "trackIds": ["track-0"], **changes}}, 4)

    def test_single_callback_preserves_selection_content_and_transport(self):
        selected, detail = self.song.view.selected_track, self.song.view.detail_clip
        notes = copy.deepcopy([vars(n) for n in self.clip.extended_notes])
        result = self.read()
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["parts"][0]["clipId"], "track-0:arrangement-clip-0")
        self.assertEqual(result["parts"][0]["clipTiming"]["startMarkerBeats"], 1)
        self.assertEqual(result["range"], {"startBeats": 17, "endBeats": 21})
        self.assertIs(self.song.view.selected_track, selected)
        self.assertIs(self.song.view.detail_clip, detail)
        self.assertEqual([vars(n) for n in self.clip.extended_notes], notes)
        self.assertFalse(self.song.is_playing)

    def test_overlap_is_half_open_and_track_filter_is_exact(self):
        self.assertEqual(self.read(startBeats=28, endBeats=30)["parts"], [])
        self.assertEqual(self.read(startBeats=12, endBeats=16)["parts"], [])
        self.assertEqual(self.read(trackIds=["track-1"])["parts"], [])
        for changes in [{"endBeats": 17}, {"startBeats": -1}, {"endBeats": 1000},
                        {"trackIds": []}, {"trackIds": ["track-0", "track-0"]}, {"trackIds": ["master"]}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.read(**changes)

    def test_audio_drums_recording_and_note_limits_remain_explicit(self):
        for attribute, value, expected in [("is_audio_clip", True, "audio"), ("is_recording", True, "recording")]:
            setattr(self.clip, attribute, value)
            self.assertEqual(self.read()["parts"][0]["status"], expected)
            setattr(self.clip, attribute, False)
        self.song.tracks[0].devices = [DrumRack()]
        self.assertEqual(self.read()["parts"][0]["status"], "drums")
        self.song.tracks[0].devices = []
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        self.assertEqual(self.read()["parts"][0]["status"], "note_limit")

    def test_clip_and_track_bounds_reject_whole_request(self):
        self.song.tracks[0].arrangement_clips = [self.clip] * 129
        with self.assertRaisesRegex(ValueError, "128"):
            self.read()
        self.song.tracks = self.song.tracks * 33
        with self.assertRaisesRegex(ValueError, "64"):
            self.read(trackIds=None)

    def test_group_tracks_are_never_queried_as_clip_owners(self):
        class GroupTrack(type(self.song.tracks[1])):
            @property
            def arrangement_clips(self):
                raise AssertionError("Group arrangement_clips must never be read")
        group = copy.copy(self.song.tracks[1])
        group.__class__ = GroupTrack
        group.is_foldable = True
        group.fold_state = 0
        self.song.tracks[1] = group
        result = self.read(trackIds=None)
        self.assertEqual([track["id"] for track in result["tracks"]], ["track-0"])
        with self.assertRaisesRegex(ValueError, "Group"):
            self.read(trackIds=["track-1"])
