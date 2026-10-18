import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiInsertionTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.extended_notes = [MidiNote(7)]
        self.clip.extended_notes[0].expression = object()
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}
        self.new = {'pitch': 67, 'start': 1.5, 'duration': .25, 'velocity': 83,
                    'velocityDeviation': -9, 'releaseVelocity': 47, 'probability': .75, 'mute': False}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_note_insertion_context', 'params': self.target}, 3)

    def apply(self, before, notes=None):
        return dispatch_request(self.song, {'method': 'insert_midi_notes', 'params': {
            **self.target, 'before': before, 'expectedStateVersion': 3,
            'notes': [self.new] if notes is None else notes}}, 3)

    def test_additions_keep_original_objects_expression_and_transport(self):
        original = self.clip.extended_notes[0]
        expression = original.expression
        self.song.is_playing = True
        before = self.read()
        result = self.apply(before)
        self.assertTrue(result['insertionVerified'])
        self.assertTrue(result['existingNotesPreserved'])
        self.assertEqual(result['addedNoteIds'], [100])
        self.assertEqual(result['observed']['notes'][1], {'noteId': 100, **self.new})
        self.assertIs(self.clip.extended_notes[0], original)
        self.assertIs(original.expression, expression)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_context_is_inert_and_replaced_native_clip_invalidates_same_version(self):
        before = self.read()
        self.assertEqual(self.song.undo_boundaries, [])
        self.assertEqual(before, self.read())
        self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.apply(before)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_changes_at_undo_entry_refuse_without_removing_manual_notes(self):
        for kind in ('content', 'recording', 'replacement'):
            self.setUp()
            before = self.read()
            original_begin = self.song.begin_undo_step
            def begin():
                original_begin()
                if kind == 'content': self.clip.extended_notes[0].velocity = 62
                elif kind == 'recording': self.song.record_mode = True
                else: self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
            self.song.begin_undo_step = begin
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.apply(before)
            self.assertEqual(len(self.clip.extended_notes), 1)
            if kind == 'content': self.assertEqual(self.clip.extended_notes[0].velocity, 62)
            self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_same_pitch_overlaps_and_invalid_notes_refuse_before_write(self):
        invalid = [[{**self.new, 'pitch': 60, 'start': .5}],
                   [self.new, {**self.new, 'start': 1.6}], [],
                   [{**self.new, 'probability': 1.1}], [{**self.new, 'start': float('nan')}],
                   [{**self.new, 'velocity': True}], [{**self.new, 'duration': 0}],
                   [{**self.new, 'noteId': 7}]]
        for notes in invalid:
            with self.subTest(notes=notes), self.assertRaises(ValueError): self.apply(self.read(), notes)
            self.assertEqual(self.song.undo_boundaries, [])
        # Adjacent same-pitch events and overlapping different pitches are valid.
        self.assertTrue(self.apply(self.read(), [{**self.new, 'pitch': 60, 'start': 1}])['insertionVerified'])

    def test_recording_frozen_pending_and_unknown_flags_refuse(self):
        for owner, key in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                           ('track', 'is_frozen'), ('clip', 'is_recording'), ('clip', 'is_overdubbing'),
                           ('clip', 'is_triggered')]:
            for value in (True, None):
                self.setUp()
                obj = self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0]
                setattr(obj, key, value)
                with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.apply(self.read())
                self.assertEqual(len(self.clip.extended_notes), 1)

    def test_partial_native_write_is_reported_without_rollback_or_replay(self):
        add = self.clip.add_new_notes
        def fail(notes):
            add(notes[:1])
            raise RuntimeError('native interrupted')
        self.clip.add_new_notes = fail
        result = self.apply(self.read(), [self.new, {**self.new, 'pitch': 69}])
        self.assertFalse(result['insertionVerified'])
        self.assertFalse(result['nativeReturned'])
        self.assertTrue(result['existingNotesPreserved'])
        self.assertEqual(result['addedNoteIds'], [100])
        self.assertIn('native interrupted', result['error'])
        self.assertEqual(len(self.clip.extended_notes), 2)

    def test_unexpected_native_content_or_lost_readback_never_reports_success(self):
        for kind in ('modified', 'readback', 'ids'):
            self.setUp()
            add = self.clip.add_new_notes
            def altered(notes):
                ids = add(notes)
                if kind == 'modified': self.clip.extended_notes[0].velocity = 12
                elif kind == 'readback': self.clip.get_all_notes_extended = lambda: (_ for _ in ()).throw(RuntimeError('read unavailable'))
                return (7,) if kind == 'ids' else ids
            self.clip.add_new_notes = altered
            result = self.apply(self.read())
            self.assertFalse(result['insertionVerified'])
            self.assertTrue(result['error'])
            self.assertEqual(len(self.clip.extended_notes), 2)

    def test_failed_undo_finalization_retains_receipt_and_reads_actual_notes(self):
        def fail_end():
            raise RuntimeError('undo close failed')
        self.song.end_undo_step = fail_end
        result = self.apply(self.read())
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['insertionVerified'])
        self.assertEqual(result['addedNoteIds'], [100])
        self.assertTrue(result['existingNotesPreserved'])
        self.assertIn('undo close failed', result['error'])
        self.assertEqual(len(self.clip.extended_notes), 2)

    def test_arrangement_identity_and_timing_are_guarded(self):
        self.clip.start_time, self.clip.end_time = 8., 12.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        before = self.read()
        self.assertEqual(before['location'], 'arrangement')
        self.clip.end_time = 13.
        with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before)
        self.assertTrue(self.apply(self.read())['insertionVerified'])

    def test_large_or_changing_sources_are_not_sampled(self):
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        with self.assertRaisesRegex(ValueError, '4096'): self.read()
        self.setUp()
        original = self.clip.get_all_notes_extended
        reads = 0
        def changing():
            nonlocal reads
            reads += 1
            self.clip.extended_notes[0].velocity = 80 + reads
            return original()
        self.clip.get_all_notes_extended = changing
        with self.assertRaisesRegex(ValueError, 'changed'): self.read()
