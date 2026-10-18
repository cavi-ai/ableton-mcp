import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiNoteSelectionTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.get_notes_by_id = lambda ids: copy.deepcopy([n for n in self.clip.extended_notes if n.note_id in ids])
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.selected = [self.clip.extended_notes[0]]
        self.clip.get_selected_notes_extended = lambda: self.selected
        self.song.view.detail_clip = self.clip
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_note_selection', 'params': self.target}, 3)

    def plan(self, token=None, note_id=7):
        before = dispatch_request(self.song, {'method': 'get_midi_clip_notes_extended', 'params': self.target}, 3)
        return {**self.target, 'expectedStateVersion': 3, 'before': before,
                'propertyEditContext': dispatch_request(self.song, {'method':'get_midi_note_edit_context','params':self.target}, 3),
                'clipTiming': dispatch_request(self.song, {'method': 'get_clip_timing', 'params': self.target}, 3),
                'expectedNoteSelectionToken': token or self.read()['selectionToken'],
                'changes': [{'noteId': note_id, 'previous': next(n for n in before['notes'] if n['noteId'] == note_id), 'velocity': 70}]}

    def apply(self, plan):
        return dispatch_request(self.song, {'method': 'set_midi_note_properties', 'params': plan}, 3)

    def test_read_is_inert_and_selected_notes_are_not_the_whole_clip(self):
        result = self.read()
        self.assertEqual(result['status'], 'selected')
        self.assertEqual(result['noteIds'], [7])
        self.assertEqual(result['notes'][0]['releaseVelocity'], 64)
        self.assertTrue(result['selectionToken'])
        self.assertEqual(self.read(), result)
        self.assertEqual(self.song.undo_boundaries, [])
        self.assertEqual(self.clip.extended_notes[0].velocity, 100)

    def test_empty_hidden_and_unsupported_selections_are_distinct(self):
        self.selected = []
        self.assertEqual(self.read()['status'], 'empty')
        self.assertEqual(self.read()['noteIds'], [])
        self.song.view.detail_clip = None
        hidden = self.read()
        self.assertEqual(hidden['status'], 'not_detail_clip')
        self.assertIsNone(hidden['noteIds'])
        self.assertIsNone(hidden['selectionToken'])
        self.song.view.detail_clip = self.clip
        self.clip.get_selected_notes_extended = None
        self.assertEqual(self.read()['status'], 'unavailable')
        self.assertIsNone(self.read()['noteIds'])

    def test_guarded_edit_changes_only_a_selected_note(self):
        self.apply(self.plan())
        self.assertEqual([note.velocity for note in self.clip.extended_notes], [70, 100])
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_selection_focus_and_replaced_clip_refuse_at_same_version(self):
        for change in ('selected', 'focus', 'replacement'):
            self.setUp()
            plan = self.plan()
            if change == 'selected': self.selected = [self.clip.extended_notes[1]]
            if change == 'focus': self.song.view.detail_clip = None
            if change == 'replacement':
                replacement = copy.deepcopy(self.clip)
                self.song.tracks[0].clip_slots[0].clip = replacement
                self.song.view.detail_clip = replacement
            with self.subTest(change=change), self.assertRaises(ValueError): self.apply(plan)
            self.assertEqual(self.song.undo_boundaries, [])
            self.assertEqual(self.clip.extended_notes[0].velocity, 100)

    def test_unselected_note_recording_and_empty_selection_refuse_before_write(self):
        for change in ('unselected', 'empty', 'recording', 'frozen'):
            self.setUp()
            plan = self.plan(note_id=8 if change == 'unselected' else 7)
            if change == 'empty': self.selected = []
            if change == 'recording': self.song.record_mode = True
            if change == 'frozen': self.song.tracks[0].is_frozen = True
            with self.subTest(change=change), self.assertRaises(ValueError): self.apply(plan)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_selection_must_stay_stable_during_read_and_is_never_truncated(self):
        calls = []
        def moving():
            calls.append(True)
            return [self.clip.extended_notes[len(calls) % 2]]
        self.clip.get_selected_notes_extended = moving
        with self.assertRaises(ValueError): self.read()
        self.clip.get_selected_notes_extended = lambda: [MidiNote(i) for i in range(4097)]
        with self.assertRaises(ValueError): self.read()

    def test_undo_entry_changes_are_refused_without_reverting_manual_edits(self):
        for change in ('selection', 'recording', 'replacement', 'notes'):
            self.setUp()
            plan = self.plan()
            begin = self.song.begin_undo_step
            def changed_begin():
                begin()
                if change == 'selection': self.selected = [self.clip.extended_notes[1]]
                if change == 'recording': self.song.record_mode = True
                if change == 'replacement':
                    replacement = copy.deepcopy(self.clip)
                    self.song.tracks[0].clip_slots[0].clip = replacement
                    self.song.view.detail_clip = replacement
                if change == 'notes': self.clip.extended_notes[0].velocity = 90
            self.song.begin_undo_step = changed_begin
            with self.subTest(change=change), self.assertRaises(ValueError): self.apply(plan)
            self.assertEqual(self.clip.extended_notes[0].velocity, 90 if change == 'notes' else 100)
            self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_arrangement_clip_selection_retains_timeline_identity(self):
        self.clip.start_time, self.clip.end_time = 16, 20
        self.clip.is_audio_clip = False
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        result = self.read()
        self.assertEqual(result['location'], 'arrangement')
        self.assertEqual(result['timeline']['startBeats'], 16)
        self.apply(self.plan())
        self.assertEqual(self.clip.extended_notes[0].velocity, 70)


if __name__ == '__main__': unittest.main()
