import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, DrumRack


class SessionOrientationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.song.view.detail_clip = self.clip

    def read(self):
        return dispatch_request(self.song, {"method": "get_session_orientation", "params": {}}, 4)

    def test_exact_displayed_clip_owner_is_used_when_selected_track_differs(self):
        self.song.view.selected_track = self.song.tracks[1]
        notes = copy.deepcopy([vars(n) for n in self.clip.extended_notes])
        result = self.read()
        self.assertEqual(result["selection"]["selectedTrack"]["id"], "track-1")
        self.assertEqual(result["focus"]["trackId"], "track-0")
        self.assertEqual(result["focus"]["status"], "available")
        self.assertEqual(result["focus"]["devices"][0]["name"], "Serum 2")
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["musicalContext"]["key"]["scaleName"], "Major")
        self.assertEqual([vars(n) for n in self.clip.extended_notes], notes)
        self.assertIs(self.song.view.detail_clip, self.clip)
        self.assertIs(self.song.view.selected_track, self.song.tracks[1])

    def test_no_clip_and_audio_produce_explicitly_unavailable_tonal_evidence(self):
        self.song.view.detail_clip = None
        self.assertEqual(self.read()["focus"]["status"], "no_clip")
        self.song.view.detail_clip = self.song.tracks[0].clip_slots[2].clip
        self.assertEqual(self.read()["focus"]["status"], "audio")

    def test_drums_and_recording_clips_are_not_interpreted_as_tonal_material(self):
        self.song.tracks[0].devices = [DrumRack()]
        self.assertEqual(self.read()["focus"]["status"], "drums")
        self.song.tracks[0].devices = []
        self.clip.is_recording = True
        self.assertEqual(self.read()["focus"]["status"], "recording")

    def test_note_limit_does_not_silently_sample_large_clips(self):
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        focus = self.read()["focus"]
        self.assertEqual(focus["status"], "note_limit")
        self.assertNotIn("notes", focus)
        self.assertEqual(focus["totalNotes"], 4097)

    def test_arrangement_focus_is_preserved_and_scope_is_loop_range(self):
        self.clip.start_time = 8.0
        self.clip.end_time = 12.0
        self.clip.is_audio_clip = False
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.song.tracks[0].clip_slots[0].has_clip = False
        focus = self.read()["focus"]
        self.assertEqual(focus["location"], "arrangement")
        self.assertEqual(focus["range"], {"startBeats": 0.0, "endBeats": 4.0})

    def test_unlooped_material_uses_explicit_markers(self):
        self.clip.looping = False
        self.clip.start_marker = 1.0
        self.clip.end_marker = 3.0
        focus = self.read()["focus"]
        self.assertEqual(focus["range"], {"startBeats": 1.0, "endBeats": 3.0})
        self.assertEqual(focus["rangeBasis"], "clip-markers")


if __name__ == "__main__":
    unittest.main()
