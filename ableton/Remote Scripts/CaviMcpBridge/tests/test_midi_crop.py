import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiCropTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.start_marker, self.clip.end_marker = 0., 8.
        self.clip.loop_start, self.clip.loop_end = 2., 6.
        self.clip.extended_notes = [MidiNote(7), MidiNote(8)]
        self.clip.extended_notes[1].start_time = 3.
        self.calls = 0
        def crop():
            self.calls += 1
            self.clip.extended_notes = [self.clip.extended_notes[1]]
            self.clip.extended_notes[0].start_time = 1.
            self.clip.loop_start, self.clip.loop_end = 0., 4.
            self.clip.start_marker, self.clip.end_marker = 0., 4.
        self.clip.crop = crop
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_midi_crop_context', 'params': self.target}, 3)

    def apply(self, before):
        return dispatch_request(self.song, {'method': 'crop_midi_clip', 'params': {
            **self.target, 'expectedStateVersion': 3, 'before': before}}, 3)

    def test_native_crop_is_one_guarded_action_with_complete_observation(self):
        self.song.is_playing = True
        before = self.read()
        self.assertEqual(before['selectedRegion'], {'fromLoop': True, 'startBeats': 2., 'endBeats': 6.})
        self.assertEqual(self.read(), before)
        self.assertEqual(self.calls, 0)
        result = self.apply(before)
        self.assertTrue(result['nativeReturned'])
        self.assertTrue(result['targetIdentityPreserved'])
        self.assertTrue(result['readbackAvailable'])
        self.assertTrue(result['notesChanged'])
        self.assertTrue(result['timingChanged'])
        self.assertFalse(result['hiddenExpressionVerified'])
        self.assertEqual(result['observed']['notes'][0]['noteId'], 8)
        self.assertEqual(result['observed']['notes'][0]['start'], 1.)
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])
        self.assertTrue(self.song.is_playing)

    def test_nonlooped_preview_uses_markers_not_loop_points(self):
        self.clip.looping = False
        self.assertEqual(self.read()['selectedRegion'], {'fromLoop': False, 'startBeats': 0., 'endBeats': 8.})

    def test_replacement_notes_timing_and_undo_entry_changes_refuse(self):
        for entered in (False, True):
            for kind in ('identity', 'notes', 'timing', 'recording'):
                self.setUp()
                before = self.read()
                def change():
                    if kind == 'identity': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
                    elif kind == 'notes': self.clip.extended_notes[0].velocity = 31
                    elif kind == 'timing': self.clip.loop_end = 5.
                    else: self.song.record_mode = True
                if entered:
                    begin = self.song.begin_undo_step
                    def enter(): begin(); change()
                    self.song.begin_undo_step = enter
                else: change()
                with self.subTest(entered=entered, kind=kind), self.assertRaises(ValueError): self.apply(before)
                self.assertEqual(self.calls, 0)
                if kind == 'notes': self.assertEqual(self.clip.extended_notes[0].velocity, 31)

    def test_recording_frozen_pending_unknown_unsupported_and_invalid_regions_refuse(self):
        for owner, field in [('song', 'record_mode'), ('song', 'session_record'), ('song', 'is_counting_in'),
                             ('clip', 'is_recording'), ('clip', 'is_overdubbing'), ('clip', 'is_triggered'), ('track', 'is_frozen')]:
            for value in (True, None):
                self.setUp()
                setattr(self.song if owner == 'song' else self.clip if owner == 'clip' else self.song.tracks[0], field, value)
                with self.subTest(field=field, value=value), self.assertRaises(ValueError): self.apply(self.read())
                self.assertEqual(self.calls, 0)
        self.setUp()
        self.clip.crop = None
        with self.assertRaises(ValueError): self.apply(self.read())
        for start, end in ((2, 2), (-1, 4), (0, float('nan')), (float('inf'), 4)):
            self.setUp()
            self.clip.loop_start, self.clip.loop_end = start, end
            with self.assertRaises(ValueError): self.read()

    def test_native_partial_failure_retains_actual_notes_and_does_not_replay(self):
        crop = self.clip.crop
        def partial(): crop(); raise RuntimeError('native interrupted')
        self.clip.crop = partial
        result = self.apply(self.read())
        self.assertFalse(result['nativeReturned'])
        self.assertTrue(result['writeRequested'])
        self.assertTrue(result['readbackAvailable'])
        self.assertEqual(self.calls, 1)
        self.assertIn('native interrupted', result['error'])
        self.assertEqual([n.note_id for n in self.clip.extended_notes], [8])

    def test_missing_readback_and_undo_failure_keep_dispatch_facts(self):
        for kind in ('readback', 'undo'):
            self.setUp()
            crop = self.clip.crop
            def changed():
                crop()
                if kind == 'readback': self.clip.get_all_notes_extended = lambda: (_ for _ in ()).throw(RuntimeError('unavailable'))
            self.clip.crop = changed
            if kind == 'undo': self.song.end_undo_step = lambda: (_ for _ in ()).throw(RuntimeError('undo close failed'))
            result = self.apply(self.read())
            self.assertTrue(result['nativeReturned'])
            self.assertEqual(self.calls, 1)
            if kind == 'readback': self.assertFalse(result['readbackAvailable']); self.assertIn('unavailable', result['observationError'])
            else: self.assertIn('undo close failed', result['error'])

    def test_arrangement_identity_survives_timing_changes_but_replacement_does_not(self):
        self.clip.start_time, self.clip.end_time = 16., 20.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.target['clipId'] = 'track-0:arrangement-clip-0'
        crop = self.clip.crop
        def changed(): crop(); self.clip.end_time = 19.
        self.clip.crop = changed
        result = self.apply(self.read())
        self.assertTrue(result['targetIdentityPreserved'])
        self.assertEqual(result['observed']['timeline']['endBeats'], 19.)
        self.target['clipId'] = 'track-0:arrangement-clip-00'
        with self.assertRaises(ValueError): self.read()

    def test_replacement_after_crop_is_reported_instead_of_claiming_preservation(self):
        crop = self.clip.crop
        def replaced():
            crop()
            self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
        self.clip.crop = replaced
        result = self.apply(self.read())
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['targetIdentityPreserved'])
        self.assertIn('target changed', result['error'])

    def test_large_note_and_collection_reads_refuse_without_sampling(self):
        self.clip.extended_notes = [MidiNote(i) for i in range(4097)]
        with self.assertRaises(ValueError): self.read()
        self.setUp()
        self.song.tracks[0].clip_slots *= 4097
        with self.assertRaises(ValueError): self.read()


if __name__ == '__main__': unittest.main()
