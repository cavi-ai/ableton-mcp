import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, Clip


class MarkerClip(Clip):
    def __setattr__(self, name, value):
        if name in ('start_marker', 'end_marker') and hasattr(self, 'writes'):
            if name == 'start_marker' and value >= self.end_marker: raise ValueError('inverted intermediate markers')
            if name == 'end_marker' and value <= self.start_marker: raise ValueError('inverted intermediate markers')
            self.writes.append((name, value))
            object.__setattr__(self, name, value)
            if self.on_write: self.on_write(name)
        else: object.__setattr__(self, name, value)


class MidiClipMarkerTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = MarkerClip()
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.start_marker, self.clip.end_marker = 0., 4.
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.clip.writes, self.clip.on_write = [], None
        self.song.tracks[0].clip_slots[0].clip = self.clip
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_clip_marker_context', 'params': self.target}, 3)

    def plan(self, **markers):
        before = self.read()
        return {**self.target, 'expectedStateVersion': 3, 'before': before,
                'markers': {**{k: before['clipTiming']['markers'][k] for k in ('startBeats', 'endBeats')}, **markers}}

    def apply(self, plan):
        return dispatch_request(self.song, {'method': 'set_midi_clip_markers', 'params': plan}, 3)

    def test_disjoint_range_uses_valid_order_and_preserves_notes_loops_and_playback(self):
        self.song.is_playing = True
        before = self.read()
        result = self.apply(self.plan(startBeats=8, endBeats=12))
        self.assertTrue(result['markersVerified'])
        self.assertTrue(result['notesPreserved'])
        self.assertTrue(result['loopPreserved'])
        self.assertTrue(result['unrequestedTimingPreserved'])
        self.assertFalse(result['hiddenExpressionVerified'])
        self.assertEqual(self.clip.writes, [('end_marker', 12), ('start_marker', 8)])
        self.assertEqual(result['observed']['notes'], before['notes'])
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])
        self.assertTrue(self.song.is_playing)
        self.clip.writes.clear()
        self.assertTrue(self.apply(self.plan(startBeats=1, endBeats=3))['markersVerified'])
        self.assertEqual(self.clip.writes, [('start_marker', 1), ('end_marker', 3)])

    def test_same_values_are_inert_and_one_bound_does_not_write_the_other(self):
        result = self.apply(self.plan())
        self.assertTrue(result['markersVerified'])
        self.assertFalse(result['writeRequested'])
        self.assertFalse(result['nativeReturned'])
        self.assertEqual(self.song.undo_boundaries, [])
        result = self.apply(self.plan(endBeats=3))
        self.assertTrue(result['markersVerified'])
        self.assertEqual(self.clip.writes, [('end_marker', 3)])

    def test_omitted_bound_changes_are_not_treated_as_native_rounding(self):
        self.clip.on_write = lambda name: object.__setattr__(self.clip, 'end_marker', 4.0000001)
        result = self.apply(self.plan(startBeats=1))
        self.assertFalse(result['markersVerified'])
        self.assertTrue(result['error'])
        self.assertEqual(self.clip.end_marker, 4.0000001)
        self.assertEqual(self.clip.writes, [('start_marker', 1)])

    def test_no_op_requires_exact_marker_retention(self):
        plan = self.plan()
        get_notes = self.clip.get_all_notes_extended
        reads = 0
        def changing_notes():
            nonlocal reads
            reads += 1
            if reads == 3: object.__setattr__(self.clip, 'end_marker', 4.0000001)
            return get_notes()
        self.clip.get_all_notes_extended = changing_notes
        result = self.apply(plan)
        self.assertFalse(result['markersVerified'])
        self.assertTrue(result['error'])
        self.assertEqual(self.clip.writes, [])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_issued_bound_allows_native_rounding(self):
        self.clip.on_write = lambda name: object.__setattr__(self.clip, 'start_marker', 1.0000001)
        result = self.apply(self.plan(startBeats=1))
        self.assertTrue(result['markersVerified'])
        self.assertEqual(result['observed']['clipTiming']['markers']['startBeats'], 1.0000001)
        self.assertEqual(self.clip.end_marker, 4.)

    def test_replacement_note_timing_and_undo_entry_changes_refuse(self):
        for entered in (False, True):
            for kind in ('identity', 'notes', 'timing', 'recording'):
                self.setUp()
                plan = self.plan(startBeats=1, endBeats=3)
                def change():
                    if kind == 'identity': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
                    elif kind == 'notes': self.clip.extended_notes[0].velocity = 31
                    elif kind == 'timing': self.clip.loop_end = 8
                    else: self.song.record_mode = True
                if entered:
                    begin = self.song.begin_undo_step
                    def enter(): begin(); change()
                    self.song.begin_undo_step = enter
                else: change()
                with self.subTest(entered=entered, kind=kind), self.assertRaises(ValueError): self.apply(plan)
                self.assertEqual(self.clip.writes, [])

    def test_manual_changes_between_setters_stop_without_reverting_them(self):
        for kind in ('note', 'loop', 'recording'):
            self.setUp()
            def changed(name):
                if kind == 'note': self.clip.extended_notes[0].velocity = 31
                elif kind == 'loop': self.clip.loop_end = 8
                else: self.song.record_mode = True
            self.clip.on_write = changed
            result = self.apply(self.plan(startBeats=8, endBeats=12))
            self.assertFalse(result['markersVerified'])
            self.assertEqual(self.clip.writes, [('end_marker', 12)])
            self.assertEqual(self.clip.start_marker, 0.)
            self.assertEqual(self.clip.end_marker, 12.)
            self.assertTrue(result['error'])
            if kind == 'note': self.assertEqual(self.clip.extended_notes[0].velocity, 31)

    def test_recording_frozen_pending_and_unknown_states_refuse(self):
        for owner, field in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                             ('clip', 'is_recording'), ('clip', 'is_overdubbing'), ('clip', 'is_triggered'), ('track', 'is_frozen')]:
            for value in (True, None):
                self.setUp()
                setattr(self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0], field, value)
                with self.subTest(field=field, value=value), self.assertRaises(ValueError): self.apply(self.plan(endBeats=3))
                self.assertEqual(self.clip.writes, [])

    def test_nonlooped_markers_refuse_without_setters_or_undo(self):
        self.clip.looping = False
        with self.assertRaisesRegex(ValueError, 'loop-enabled'):
            self.apply(self.plan(startBeats=1, endBeats=3))
        self.assertEqual(self.clip.writes, [])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_invalid_targets_and_regions_refuse_before_writing(self):
        for markers in ({}, {'startBeats': 2}, {'startBeats': 3, 'endBeats': 2}, {'startBeats': -1, 'endBeats': 4},
                        {'startBeats': True, 'endBeats': 4}, {'startBeats': 0, 'endBeats': float('nan')},
                        {'startBeats': 0, 'endBeats': 3, 'loop': False}):
            plan = self.plan()
            plan['markers'] = markers
            with self.subTest(markers=markers), self.assertRaises(ValueError): self.apply(plan)
        self.assertEqual(self.clip.writes, [])
        self.target['clipId'] = 'track-0:clip-00'
        with self.assertRaises(ValueError): self.read()

    def test_partial_setter_and_undo_failure_keep_actual_results(self):
        for kind in ('setter', 'undo', 'readback'):
            self.setUp()
            if kind == 'setter': self.clip.on_write = lambda name: (_ for _ in ()).throw(RuntimeError('setter interrupted'))
            if kind == 'undo': self.song.end_undo_step = lambda: (_ for _ in ()).throw(RuntimeError('undo close failed'))
            if kind == 'readback': self.clip.on_write = lambda name: setattr(self.clip, 'get_all_notes_extended', lambda: (_ for _ in ()).throw(RuntimeError('unavailable')))
            result = self.apply(self.plan(startBeats=1, endBeats=3))
            self.assertTrue(result['writeRequested'])
            self.assertFalse(result['markersVerified'])
            self.assertTrue(result['error'] or result['observationError'])
            self.assertEqual(self.clip.start_marker, 1.)
            self.assertLessEqual(len(self.clip.writes), 2)

    def test_arrangement_and_complete_bounded_note_context(self):
        self.clip.start_time, self.clip.end_time = 16., 20.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        self.assertTrue(self.apply(self.plan(startBeats=1, endBeats=3))['markersVerified'])
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        with self.assertRaises(ValueError): self.read()


if __name__ == '__main__': unittest.main()
