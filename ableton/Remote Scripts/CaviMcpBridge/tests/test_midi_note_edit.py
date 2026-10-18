import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiNoteEditTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.clip.get_notes_by_id = lambda ids: copy.deepcopy([n for n in self.clip.extended_notes if n.note_id in ids])
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_note_edit_context', 'params': self.target}, 3)

    def plan(self, changes=None):
        before = self.read()
        return {**self.target, 'expectedStateVersion': 3, 'propertyEditContext': before,
                'changes': [{'noteId': 7, 'previous': before['notes'][0], 'velocity': 70}] if changes is None else changes}

    def apply(self, plan):
        return dispatch_request(self.song, {'method': 'set_midi_note_properties', 'params': plan}, 3)

    def test_exact_edit_preserves_ids_unrequested_notes_timing_focus_and_playback(self):
        self.song.is_playing = True
        before = self.read()
        self.assertEqual(self.read(), before)
        plan = self.plan()
        plan['changes'][0].update(pitch=62, start=.25, duration=.5, probability=.75,
                                  velocityDeviation=-4, releaseVelocity=59, mute=True)
        result = self.apply(plan)
        self.assertTrue(result['editVerified'])
        self.assertTrue(result['noteIdsPreserved'])
        self.assertTrue(result['unrequestedNotesPreserved'])
        self.assertTrue(result['clipTimingPreserved'])
        self.assertFalse(result['hiddenExpressionVerified'])
        self.assertEqual([n.velocity for n in self.clip.extended_notes], [70, 100])
        self.assertEqual(result['notes'][0]['noteId'], 7)
        self.assertEqual(result['notes'][0], {'noteId': 7, 'pitch': 62, 'start': .25, 'duration': .5,
                         'velocity': 70, 'probability': .75, 'velocityDeviation': -4, 'releaseVelocity': 59, 'mute': True})
        self.assertEqual(len(result['observed']['notes']), 2)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_same_value_noop_never_calls_native_or_opens_undo(self):
        plan = self.plan()
        plan['changes'][0]['velocity'] = 100
        self.clip.apply_note_modifications = lambda notes: self.fail('unexpected native write')
        result = self.apply(plan)
        self.assertTrue(result['editVerified'])
        self.assertFalse(result['writeRequested'])
        self.assertFalse(result['nativeReturned'])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_same_version_replacement_manual_edit_timing_and_undo_entry_changes_refuse(self):
        for at_undo in (False, True):
            for kind in ('identity', 'note', 'timing', 'recording'):
                self.setUp()
                plan = self.plan()
                def change():
                    if kind == 'identity': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
                    elif kind == 'note': self.clip.extended_notes[1].velocity = 31
                    elif kind == 'timing': self.clip.loop_end = 8
                    else: self.song.record_mode = True
                if at_undo:
                    begin = self.song.begin_undo_step
                    def entered(): begin(); change()
                    self.song.begin_undo_step = entered
                else: change()
                with self.subTest(kind=kind, at_undo=at_undo), self.assertRaises(ValueError): self.apply(plan)
                self.assertEqual(self.clip.extended_notes[0].velocity, 100)
                if kind == 'note': self.assertEqual(self.clip.extended_notes[1].velocity, 31)

    def test_recording_pending_frozen_unknown_and_unsupported_refuse(self):
        for owner, field in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                             ('track', 'is_frozen'), ('clip', 'is_recording'), ('clip', 'is_overdubbing'), ('clip', 'is_triggered')]:
            for value in (True, None):
                self.setUp()
                obj = self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0]
                setattr(obj, field, value)
                with self.subTest(field=field, value=value), self.assertRaises(ValueError): self.apply(self.plan())
                self.assertEqual(self.song.undo_boundaries, [])
        self.setUp()
        self.clip.apply_note_modifications = None
        with self.assertRaises(ValueError): self.apply(self.plan())

    def test_changes_during_native_vector_preparation_refuse_before_apply(self):
        plan = self.plan()
        get = self.clip.get_notes_by_id
        def moving(ids):
            result = get(ids)
            self.clip.extended_notes[1].velocity = 31
            return result
        self.clip.get_notes_by_id = moving
        self.clip.apply_note_modifications = lambda notes: self.fail('unexpected native write')
        with self.assertRaises(ValueError): self.apply(plan)
        self.assertEqual([n.velocity for n in self.clip.extended_notes], [100, 31])

    def test_duplicate_unknown_empty_invalid_and_forged_prior_values_refuse(self):
        note = self.read()['notes'][0]
        for changes in ([], [{'noteId': 7, 'previous': note}], [{'noteId': 7, 'previous': note, 'velocity': 70}]*2,
                        [{'noteId': 9, 'previous': note, 'velocity': 70}], [{'noteId': True, 'previous': note, 'mute': True}],
                        [{'noteId': 7, 'previous': note, 'velocity': 128}], [{'noteId': 7, 'previous': note, 'probability': float('nan')}],
                        [{'noteId': 7, 'previous': note, 'expression': []}], [{'noteId': 7, 'previous': {**note, 'velocity': 9}, 'velocity': 70}]):
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.apply(self.plan(changes))
        self.assertEqual(self.song.undo_boundaries, [])

    def test_partial_native_write_and_undo_failure_are_reported_without_rollback(self):
        for kind in ('apply', 'undo', 'unrequested', 'readback'):
            self.setUp()
            calls = []
            original = self.clip.apply_note_modifications
            def changed(notes):
                calls.append(True)
                original(notes)
                if kind == 'apply': raise RuntimeError('native interrupted')
                if kind == 'unrequested': self.clip.extended_notes[1].velocity = 31
                if kind == 'readback': self.clip.get_all_notes_extended = lambda: (_ for _ in ()).throw(RuntimeError('unavailable'))
            self.clip.apply_note_modifications = changed
            if kind == 'undo': self.song.end_undo_step = lambda: (_ for _ in ()).throw(RuntimeError('undo close failed'))
            result = self.apply(self.plan())
            self.assertFalse(result['editVerified'])
            self.assertTrue(result['writeRequested'])
            self.assertEqual(self.clip.extended_notes[0].velocity, 70)
            self.assertEqual(len(calls), 1)
            if kind == 'readback': self.assertTrue(result['observationError'])
            else: self.assertTrue(result['error'])

    def test_arrangement_and_canonical_bounded_targets(self):
        self.clip.start_time, self.clip.end_time = 16, 20
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        self.assertTrue(self.apply(self.plan())['editVerified'])
        self.target['clipId'] = 'track-0:arrangement-clip-00'
        with self.assertRaises(ValueError): self.read()


if __name__ == '__main__': unittest.main()
