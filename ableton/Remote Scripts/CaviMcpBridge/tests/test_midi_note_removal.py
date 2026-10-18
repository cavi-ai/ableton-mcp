import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiNoteRemovalTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.extended_notes = [MidiNote(i) for i in (7, 8, 9)]
        self.clip.extended_notes[1].expression = object()
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_note_removal_context', 'params': self.target}, 3)

    def apply(self, before, ids=None):
        return dispatch_request(self.song, {'method': 'remove_midi_notes', 'params': {
            **self.target, 'before': before, 'expectedStateVersion': 3,
            'noteIds': [7] if ids is None else ids}}, 3)

    def test_delete_exact_ids_preserves_other_objects_expression_timing_and_playback(self):
        original = self.clip.extended_notes[1]
        expression = original.expression
        self.song.is_playing = True
        before = self.read()
        result = self.apply(before)
        self.assertTrue(result['removalVerified'])
        self.assertTrue(result['unrequestedNotesPreserved'])
        self.assertEqual(result['removedNoteIds'], [7])
        self.assertEqual(result['remainingRequestedNoteIds'], [])
        self.assertEqual([n['noteId'] for n in result['observed']['notes']], [8, 9])
        self.assertIs(self.clip.extended_notes[0], original)
        self.assertIs(original.expression, expression)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_inert_source_and_same_version_manual_changes_refuse(self):
        for kind in ('identity', 'note', 'timing'):
            self.setUp()
            before = self.read()
            self.assertEqual(self.read(), before)
            self.assertEqual(self.song.undo_boundaries, [])
            if kind == 'identity': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
            elif kind == 'note': self.clip.extended_notes[0].velocity = 52
            else: self.clip.loop_end = 8
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'changed'): self.apply(before)
            self.assertEqual(len(self.clip.extended_notes), 3)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_changes_at_undo_entry_do_not_erase_manual_work(self):
        for kind in ('note', 'recording', 'identity'):
            self.setUp()
            before = self.read()
            begin = self.song.begin_undo_step
            def changed():
                begin()
                if kind == 'note': self.clip.extended_notes[0].velocity = 52
                elif kind == 'recording': self.song.record_mode = True
                else: self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
            self.song.begin_undo_step = changed
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.apply(before)
            self.assertEqual(len(self.clip.extended_notes), 3)
            if kind == 'note': self.assertEqual(self.clip.extended_notes[0].velocity, 52)
            self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_empty_duplicate_unknown_and_invalid_ids_refuse_before_write(self):
        for ids in ([], [7, 7], [100], [True], [-1], [7.0], '7'):
            with self.subTest(ids=ids), self.assertRaises(ValueError): self.apply(self.read(), ids)
            self.assertEqual(len(self.clip.extended_notes), 3)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_recording_frozen_pending_unknown_and_unsupported_targets_refuse(self):
        for owner, key in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                           ('track', 'is_frozen'), ('clip', 'is_recording'), ('clip', 'is_overdubbing'), ('clip', 'is_triggered')]:
            for value in (True, None):
                self.setUp()
                obj = self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0]
                setattr(obj, key, value)
                with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.apply(self.read())
                self.assertEqual(len(self.clip.extended_notes), 3)
        self.setUp()
        self.clip.remove_notes_by_id = None
        self.assertFalse(self.read()['removeSupported'])
        with self.assertRaises(ValueError): self.apply(self.read())

    def test_partial_deletion_is_retained_and_reports_remaining_targets(self):
        remove = self.clip.remove_notes_by_id
        def interrupted(ids):
            remove(ids[:1])
            raise RuntimeError('native interrupted')
        self.clip.remove_notes_by_id = interrupted
        result = self.apply(self.read(), [7, 8])
        self.assertFalse(result['removalVerified'])
        self.assertFalse(result['nativeReturned'])
        self.assertTrue(result['unrequestedNotesPreserved'])
        self.assertEqual(result['removedNoteIds'], [7])
        self.assertEqual(result['remainingRequestedNoteIds'], [8])
        self.assertIn('native interrupted', result['error'])
        self.assertEqual([n.note_id for n in self.clip.extended_notes], [8, 9])

    def test_native_noop_or_collateral_edits_never_report_success(self):
        for kind in ('noop', 'unrequested', 'added', 'modified'):
            self.setUp()
            remove = self.clip.remove_notes_by_id
            def wrong(ids):
                if kind != 'noop': remove(ids)
                if kind == 'unrequested': remove([8])
                elif kind == 'added': self.clip.extended_notes.append(MidiNote(10))
                elif kind == 'modified': self.clip.extended_notes[0].velocity = 27
            self.clip.remove_notes_by_id = wrong
            result = self.apply(self.read())
            self.assertFalse(result['removalVerified'])
            self.assertTrue(result['error'])
            if kind == 'unrequested': self.assertEqual(result['removedNoteIds'], [7, 8])
            elif kind == 'added': self.assertEqual(result['unexpectedAddedNoteIds'], [10])
            elif kind == 'modified': self.assertFalse(result['unrequestedNotesPreserved'])

    def test_lost_readback_reports_unknown_removal_without_reconstructing_notes(self):
        remove = self.clip.remove_notes_by_id
        def unreadable(ids):
            remove(ids)
            self.clip.get_all_notes_extended = lambda: (_ for _ in ()).throw(RuntimeError('read unavailable'))
        self.clip.remove_notes_by_id = unreadable
        result = self.apply(self.read())
        self.assertFalse(result['removalVerified'])
        self.assertIsNone(result['observed'])
        self.assertIsNone(result['removedNoteIds'])
        self.assertIsNone(result['unrequestedNotesPreserved'])
        self.assertIn('read unavailable', result['error'])
        self.assertEqual([n.note_id for n in self.clip.extended_notes], [8, 9])

    def test_undo_finalization_error_retains_actual_deletion_receipt(self):
        def fail(): raise RuntimeError('undo close failed')
        self.song.end_undo_step = fail
        result = self.apply(self.read())
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['removalVerified'])
        self.assertEqual(result['removedNoteIds'], [7])
        self.assertIn('undo close failed', result['error'])

    def test_arrangement_timeline_change_refuses_and_empty_result_is_valid(self):
        self.clip.start_time, self.clip.end_time = 8., 12.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        before = self.read()
        self.assertEqual(before['location'], 'arrangement')
        self.clip.end_time = 13.
        with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before)
        self.assertTrue(self.apply(self.read(), [7, 8, 9])['removalVerified'])
        self.assertEqual(self.clip.extended_notes, [])

    def test_large_and_changing_sources_are_never_sampled(self):
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        with self.assertRaisesRegex(ValueError, '4096'): self.read()
        self.setUp()
        read = self.clip.get_all_notes_extended
        count = 0
        def changing():
            nonlocal count
            count += 1
            self.clip.extended_notes[0].velocity = count
            return read()
        self.clip.get_all_notes_extended = changing
        with self.assertRaisesRegex(ValueError, 'changed'): self.read()
