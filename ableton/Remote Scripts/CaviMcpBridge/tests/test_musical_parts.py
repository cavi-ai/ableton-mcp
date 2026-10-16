import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, DrumRack


class MusicalPartsTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.song.view.detail_clip = self.clip

    def read(self, parts=None):
        return dispatch_request(self.song, {"method": "analyze_midi_parts", "params": {
            "parts": parts if parts is not None else [{"trackId": "track-0", "clipId": "track-0:clip-0"}]
        }}, 4)

    def test_explicit_parts_are_read_together_without_selection_or_note_changes(self):
        selected = self.song.view.selected_track
        displayed = self.song.view.detail_clip
        notes = copy.deepcopy([vars(n) for n in self.clip.extended_notes])
        slot = self.song.tracks[0].clip_slots[1]
        slot.clip, slot.has_clip = copy.copy(self.clip), True
        second = slot.clip
        second.extended_notes = [MidiNote(9)]
        parts = [{"trackId": "track-0", "clipId": f"track-0:clip-{i}"} for i in (1, 0)]
        result = self.read(parts)
        self.assertEqual([p["clipId"] for p in result["parts"]], [p["clipId"] for p in parts])
        self.assertEqual(result["stateVersion"], 4)
        self.assertEqual(result["parts"][1]["status"], "available")
        self.assertEqual(result["parts"][1]["range"], {"startBeats": 0.0, "endBeats": 4.0})
        self.assertEqual(result["parts"][1]["track"]["id"], "track-0")
        self.assertEqual(result["parts"][1]["devices"][0]["name"], "Serum 2")
        self.assertIs(self.song.view.selected_track, selected)
        self.assertIs(self.song.view.detail_clip, displayed)
        self.assertEqual([vars(n) for n in self.clip.extended_notes], notes)

    def test_audio_drums_recording_and_large_clips_are_explicit_exclusions(self):
        audio = {"trackId": "track-0", "clipId": "track-0:clip-2"}
        self.assertEqual(self.read([audio])["parts"][0]["status"], "audio")
        self.song.tracks[0].devices = [DrumRack()]
        self.assertEqual(self.read()["parts"][0]["status"], "drums")
        self.song.tracks[0].devices = []
        self.clip.is_recording = True
        self.assertEqual(self.read()["parts"][0]["status"], "recording")
        self.clip.is_recording = False
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        part = self.read()["parts"][0]
        self.assertEqual(part["status"], "note_limit")
        self.assertNotIn("notes", part)

    def test_bad_empty_duplicate_and_mismatched_references_are_rejected(self):
        one = {"trackId": "track-0", "clipId": "track-0:clip-0"}
        for parts in ([], [one] * 2, [one] * 9, [None], [{"trackId": "track-1", "clipId": "track-0:clip-0"}]):
            with self.subTest(parts=parts), self.assertRaises(ValueError):
                self.read(parts)

    def test_total_note_limit_rejects_whole_request_instead_of_sampling(self):
        from types import SimpleNamespace
        parts = []
        self.song.tracks[0].clip_slots = []
        for index in range(5):
            clip = copy.copy(self.clip)
            clip.extended_notes = [MidiNote(i) for i in range(4096)]
            self.song.tracks[0].clip_slots.append(SimpleNamespace(has_clip=True, clip=clip))
            parts.append({"trackId": "track-0", "clipId": f"track-0:clip-{index}"})
        with self.assertRaisesRegex(ValueError, "16384"):
            self.read(parts)

    def test_arrangement_part_reports_timeline_but_analyzes_local_markers(self):
        self.clip.start_time, self.clip.end_time = 12.0, 16.0
        self.clip.looping = False
        self.clip.start_marker, self.clip.end_marker = 1.0, 3.0
        self.song.tracks[0].arrangement_clips = [self.clip]
        part = self.read([{"trackId": "track-0", "clipId": "track-0:arrangement-clip-0"}])["parts"][0]
        self.assertEqual(part["location"], "arrangement")
        self.assertEqual(part["timeline"]["startBeats"], 12.0)
        self.assertEqual(part["rangeBasis"], "clip-markers")
        self.assertEqual(part["range"], {"startBeats": 1.0, "endBeats": 3.0})


if __name__ == "__main__":
    unittest.main()
