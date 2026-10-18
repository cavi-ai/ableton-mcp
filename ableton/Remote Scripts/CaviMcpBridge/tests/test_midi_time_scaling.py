import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiTimeScalingTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.start_marker, self.clip.end_marker = 0, 4
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.extended_notes = [MidiNote(7), MidiNote(8), MidiNote(9)]
        for note, start in zip(self.clip.extended_notes, (0, 1, 3)):
            note.start_time, note.duration = start, .25
        self.clip.extended_notes[1].pitch = 64
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}
        before = self.read()
        self.params = {**self.target, 'expectedStateVersion': 3, 'before': before,
                       'operation': {'type': 'scaleTime', 'factor': 2, 'originBeats': 0},
                       'noteIds': [7, 8], 'changes': [
                           {'noteId': n['noteId'], 'previous': n, 'start': n['start'] * 2,
                            'duration': n['duration'] * 2} for n in before['notes'][:2]], 'newNotes': []}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_note_removal_context', 'params': self.target}, 3)

    def apply(self):
        return dispatch_request(self.song, {'method': 'transform_midi_notes', 'params': self.params}, 3)

    def test_scale_preserves_ids_other_fields_bounds_and_playback(self):
        self.song.is_playing = True
        result = self.apply()
        self.assertTrue(result['timeScalingVerified'])
        self.assertEqual([(n.note_id, n.start_time, n.duration) for n in self.clip.extended_notes],
                         [(7, 0, .5), (8, 2, .5), (9, 3, .25)])
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_native_note_collection_is_passed_back_without_list_conversion(self):
        collection = tuple(self.clip.extended_notes[:2])
        self.clip.get_notes_by_id = lambda ids: collection
        apply = self.clip.apply_note_modifications
        def typed_apply(notes):
            if notes is not collection: raise TypeError('native collection required')
            apply(notes)
        self.clip.apply_note_modifications = typed_apply
        self.assertTrue(self.apply()['timeScalingVerified'])

    def test_tampered_derived_changes_refuse_before_mutation(self):
        self.params['changes'][0]['duration'] = .75
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(self.song.undo_boundaries, [])

    def test_nonzero_loop_origin_and_arrangement_coordinates(self):
        self.clip.loop_start, self.clip.loop_end = 2, 8
        self.clip.start_marker, self.clip.end_marker = 0, 8
        for note in self.clip.extended_notes: note.start_time += 2
        self.clip.start_time, self.clip.end_time = 100, 106
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        before = self.read()
        self.params.update(self.target, before=before,
                           operation={'type': 'scaleTime', 'factor': .5, 'originBeats': 2},
                           changes=[{'noteId': n['noteId'], 'previous': n,
                                     'start': 2 + (n['start'] - 2) * .5,
                                     'duration': n['duration'] * .5} for n in before['notes'][:2]])
        result = self.apply()
        self.assertTrue(result['timeScalingVerified'])
        self.assertEqual(self.clip.extended_notes[1].start_time, 2.5)
        self.assertEqual((self.clip.start_time, self.clip.end_time), (100, 106))

    def test_nonlooping_uses_markers_and_preserves_repeat_bounds(self):
        self.clip.looping = False
        self.clip.loop_end = 1
        self.params['before'] = self.read()
        result = self.apply()
        self.assertTrue(result['timeScalingVerified'])
        self.assertEqual(self.clip.loop_end, 1)
        self.assertEqual(self.clip.end_marker, 4)

    def test_invalid_or_overflowing_operations_and_collisions_refuse(self):
        for change in (lambda p: p['operation'].update(factor=1),
                       lambda p: p['operation'].update(factor=True),
                       lambda p: p['operation'].update(originBeats=-1),
                       lambda p: p.update(noteIds=[7, 7]),
                       lambda p: p.update(noteIds=[9]),
                       lambda p: p['operation'].update(gridBeats=.25)):
            self.setUp()
            change(self.params)
            with self.assertRaises(ValueError): self.apply()
            self.assertEqual(self.song.undo_boundaries, [])
        self.setUp()
        self.clip.extended_notes[2].start_time = 2
        self.clip.extended_notes[2].pitch = 64
        self.params['before'] = self.read()
        with self.assertRaisesRegex(ValueError, 'collision'): self.apply()

    def test_unsafe_and_unknown_edit_flags_refuse(self):
        for owner, key in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                           ('track', 'is_frozen'), ('clip', 'is_recording'), ('clip', 'is_overdubbing'), ('clip', 'is_triggered')]:
            for value in (True, None):
                self.setUp()
                obj = self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0]
                setattr(obj, key, value)
                self.params['before'] = self.read()
                with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.apply()
                self.assertEqual(self.song.undo_boundaries, [])

    def test_identity_manual_content_timing_and_recording_changes_refuse(self):
        for kind in ('identity', 'note', 'timing', 'record'):
            self.setUp()
            if kind == 'identity': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
            elif kind == 'note': self.clip.extended_notes[0].velocity = 42
            elif kind == 'timing': self.clip.loop_end = 8
            else: self.song.record_mode = True
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.apply()
            self.assertEqual(self.song.undo_boundaries, [])

    def test_change_at_undo_entry_is_preserved(self):
        begin = self.song.begin_undo_step
        def changed():
            begin()
            self.clip.extended_notes[0].velocity = 42
        self.song.begin_undo_step = changed
        with self.assertRaises(ValueError): self.apply()
        self.assertEqual(self.clip.extended_notes[0].velocity, 42)
        self.assertEqual(self.clip.extended_notes[1].start_time, 1)

    def test_ignored_and_partial_writes_are_reported_without_rollback(self):
        for partial in (False, True):
            self.setUp()
            def apply(notes):
                if partial:
                    self.clip.extended_notes = [notes[0], MidiNote(8), self.clip.extended_notes[2]]
                    raise RuntimeError('partial write')
                self.clip.extended_notes = [MidiNote(7), MidiNote(8), self.clip.extended_notes[2]]
            self.clip.apply_note_modifications = apply
            result = self.apply()
            self.assertFalse(result['timeScalingVerified'])
            self.assertIsNotNone(result['error'])
            if partial: self.assertEqual(self.clip.extended_notes[0].duration, .5)


if __name__ == '__main__': unittest.main()
