import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, Clip


class RetrogradeTests(unittest.TestCase):
    def setUp(self):
        self.song = Song(); self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.start_marker, self.clip.end_marker = 0., 4.
        self.clip.is_audio_clip = False
        self.clip.extended_notes = []
        for note_id, pitch, start, duration in [(1,60,0.,.5),(2,64,1.,1.),(3,67,3.,.5),(4,72,4.,1.)]:
            note = MidiNote(note_id); note.pitch, note.start_time, note.duration = pitch, start, duration
            self.clip.extended_notes.append(note)
        self.clip.get_notes_by_id = lambda ids: [copy.copy(n) for n in self.clip.extended_notes if n.note_id in ids]
        self.ids = {"trackId":"track-0", "clipId":"track-0:clip-0"}
        self.operation = {"type":"reverseTime", "startBeats":0., "endBeats":4.}
        self.calls = []
        base = self.clip.apply_note_modifications
        def apply(notes): self.calls.append([n.note_id for n in notes]); base(notes)
        self.clip.apply_note_modifications = apply

    def read(self):
        return dispatch_request(self.song, {"method":"get_midi_retrograde_context", "params":self.ids}, 4)

    def apply(self, before=None, note_ids=None):
        before = self.read() if before is None else before
        ids = [1,2,3] if note_ids is None else note_ids
        from midi_retrograde import plan
        changes = plan(before["notes"], ids, self.operation)
        return dispatch_request(self.song, {"method":"transform_midi_notes", "params":{
            **self.ids,"expectedStateVersion":4,"before":before,"operation":self.operation,"noteIds":ids,"changes":changes}}, 4)

    def test_reverses_spans_once_and_preserves_all_other_exposed_state(self):
        before = self.read(); self.song.is_playing = True
        result = self.apply(before)
        self.assertTrue(result["reversalVerified"], result)
        self.assertTrue(result["noteIdsPreserved"])
        self.assertTrue(result["unrequestedNotesPreserved"])
        self.assertTrue(result["clipTimingPreserved"])
        self.assertFalse(result["hiddenExpressionVerified"])
        self.assertEqual(self.calls, [[1,2,3]])
        actual = {n["noteId"]:n for n in result["observed"]["notes"]}
        for old in before["notes"]:
            expected = {**old, "start":4-(old["start"]+old["duration"])} if old["noteId"] in [1,2,3] else old
            self.assertEqual(actual[old["noteId"]], expected)
        self.assertTrue(self.song.is_playing)

    def test_double_reverse_returns_exposed_notes_and_symmetric_noop_has_no_undo(self):
        before = self.read()["notes"]
        self.apply(); self.apply()
        self.assertEqual(self.read()["notes"], before)
        self.setUp(); self.clip.extended_notes[0].start_time = 1.75
        result = self.apply(note_ids=[1])
        self.assertTrue(result["reversalVerified"])
        self.assertFalse(result["writeRequested"])
        self.assertFalse(result["nativeReturned"])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_selected_span_bounds_ids_and_new_same_pitch_overlap_refuse(self):
        for ids in ([], [1,1], [99], [4]):
            with self.assertRaises(ValueError): self.apply(note_ids=ids)
        self.clip.extended_notes[3].pitch = 60
        self.clip.extended_notes[3].start_time = 3.5
        with self.assertRaisesRegex(ValueError, "overlap"): self.apply(note_ids=[1])
        self.assertEqual(self.calls, [])

    def test_stale_replacement_timing_and_undo_entry_changes_prevent_writes(self):
        for change in ("notes", "replacement", "timing", "undo"):
            self.setUp(); before = self.read()
            if change == "notes": self.clip.extended_notes[0].velocity += 1
            elif change == "replacement": self.song.tracks[0].clip_slots[0].clip = copy.copy(self.clip)
            elif change == "timing": self.clip.loop_end += 1
            else: self.song.begin_undo_step = lambda: setattr(self.clip.extended_notes[0], "velocity", 5)
            with self.assertRaises(ValueError): self.apply(before)
            self.assertEqual(self.calls, [])

    def test_partial_native_failure_retains_actual_notes_without_replay(self):
        def partial(notes):
            self.calls.append([n.note_id for n in notes])
            self.clip.extended_notes[0] = notes[0]
            raise RuntimeError("partially applied")
        self.clip.apply_note_modifications = partial
        result = self.apply()
        self.assertFalse(result["reversalVerified"])
        self.assertFalse(result["nativeReturned"])
        self.assertEqual(result["observed"]["notes"][0]["start"], 3.5)
        self.assertEqual(result["observed"]["notes"][1]["start"], 1)
        self.assertEqual(len(self.calls), 1)

    def test_recording_frozen_unknown_and_pending_launch_refuse(self):
        for owner, flag in [(self.song,"record_mode"),(self.song,"is_counting_in"),(self.song.tracks[0],"is_frozen"),(self.clip,"is_triggered")]:
            setattr(owner, flag, True)
            with self.assertRaises(ValueError): self.apply()
            setattr(owner, flag, False)
        del self.clip.is_recording
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(self.calls, [])

    def test_arrangement_owner_and_interval_supported_and_canonical_ids_required(self):
        self.clip.start_time, self.clip.end_time = 16., 20.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.ids["clipId"] = "track-0:arrangement-clip-0"
        self.assertTrue(self.apply()["reversalVerified"])
        self.ids["clipId"] = "track-0:arrangement-clip-00"
        with self.assertRaises(ValueError): self.read()

    def test_dense_legal_source_does_not_require_all_pairs(self):
        from midi_retrograde import plan
        notes = [{"noteId":i,"pitch":60,"start":i*.2 if i<2048 else 1100+(i-2048)*.2,"duration":.05} for i in range(4096)]
        changes = plan(notes, list(range(2048)), {"type":"reverseTime","startBeats":0.,"endBeats":1024.})
        self.assertEqual(len(changes), 2048)

    def test_index_matches_pairwise_oracle_with_existing_overlaps(self):
        import random
        from midi_retrograde import plan
        rng = random.Random(17)
        def overlap(a,b): return max(a["start"],b["start"]) < min(a["start"]+a["duration"],b["start"]+b["duration"])-2e-7
        for _ in range(100):
            notes = [{"noteId":i,"pitch":60+rng.randrange(3),"start":rng.randrange(24)/4,"duration":rng.randrange(1,7)/4} for i in range(12)]
            ids = [n["noteId"] for n in notes if rng.random()<.5] or [0]
            after = [{**n,"start":8-(n["start"]+n["duration"])} if n["noteId"] in ids else n for n in notes]
            collision = any(a["pitch"]==b["pitch"] and overlap(after[i],after[j]) and not overlap(a,b) for i,a in enumerate(notes) for j,b in enumerate(notes) if j>i)
            if collision:
                with self.assertRaisesRegex(ValueError,"overlap"): plan(notes,ids,{"type":"reverseTime","startBeats":0,"endBeats":8})
            else: plan(notes,ids,{"type":"reverseTime","startBeats":0,"endBeats":8})
