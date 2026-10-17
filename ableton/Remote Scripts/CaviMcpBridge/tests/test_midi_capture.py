import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote


class MidiCaptureTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks[0].arm = True
        self.song.tracks[0].clip_slots[0].clip.is_playing = False
        self.song.tracks[0].clip_slots[0].clip.extended_notes = [MidiNote(1)]
        self.calls = []
        def capture(destination):
            self.calls.append(destination)
            slot = self.song.tracks[0].clip_slots[1]
            slot.create_clip(4)
            slot.clip.extended_notes = [MidiNote(99)]
        self.song.capture_midi = capture

    def context(self):
        return dispatch_request(self.song, {'method': 'get_midi_capture_context'}, 3)

    def capture(self, before, **options):
        return dispatch_request(self.song, {'method': 'capture_midi_session', 'params': {
            'expectedStateVersion': 3, 'before': before, **options}}, 3)

    def test_global_read_shows_armed_and_monitored_tracks_without_mutation(self):
        self.song.tracks[1].current_monitoring_state = 0
        result = self.context()
        self.assertEqual(result['possibleTrackIds'], ['track-0', 'track-1'])
        self.assertEqual(result['overdubClipIds'], [])
        self.assertFalse(result['bufferContentsAvailable'])
        self.assertEqual(result['tempo'], 120)
        self.assertNotIn('currentSongTime', result['transport'])
        self.assertEqual(self.calls, [])

    def test_capture_returns_nonempty_clip_evidence_and_preserves_existing_notes(self):
        original = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip.extended_notes)
        result = self.capture(self.context())
        self.assertTrue(result['captureRequested'])
        self.assertTrue(result['captureVerified'])
        self.assertTrue(result['existingContentPreserved'])
        self.assertEqual(result['changedSlots'][0]['clipId'], 'track-0:clip-1')
        self.assertEqual(result['changedSlots'][0]['noteCountAfter'], 1)
        self.assertEqual([note.__dict__ for note in self.song.tracks[0].clip_slots[0].clip.extended_notes],
                         [note.__dict__ for note in original])

    def test_manual_notes_monitoring_routes_and_equal_looking_replacements_invalidate(self):
        changes = [lambda: setattr(self.song.tracks[0].clip_slots[0].clip.extended_notes[0], 'velocity', 50),
                   lambda: setattr(self.song, 'tempo', 130),
                   lambda: setattr(self.song.tracks[1], 'current_monitoring_state', 0),
                   lambda: setattr(self.song.tracks[0], 'current_input_routing', 'No Input'),
                   lambda: self.song.tracks[0].clip_slots.__setitem__(1, copy.deepcopy(self.song.tracks[0].clip_slots[1]))]
        for change in changes:
            self.setUp()
            before = self.context()
            change()
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.capture(before)
            self.assertEqual(self.calls, [])

    def test_monitored_unarmed_playing_clip_requires_explicit_overdub_scope(self):
        self.song.tracks[0].arm = False
        self.song.tracks[0].current_monitoring_state = 0
        self.song.tracks[0].clip_slots[0].clip.is_playing = True
        before = self.context()
        self.assertEqual(before['overdubClipIds'], ['track-0:clip-0'])
        with self.assertRaisesRegex(ValueError, 'playing'):
            self.capture(before)
        self.capture(before, allowExistingClipChanges=True)
        self.assertEqual(self.calls, [1])

    def test_clock_advance_is_not_a_false_stale_state_but_recording_and_pending_launches_refuse(self):
        before = self.context()
        self.song.current_song_time += 2
        self.capture(before)
        for change in [lambda: setattr(self.song, 'record_mode', True),
                       lambda: setattr(self.song.tracks[1], 'fired_slot_index', 0)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.capture(self.context())
            self.assertEqual(self.calls, [])

    def test_empty_native_result_is_not_reported_as_a_verified_capture(self):
        self.song.capture_midi = lambda destination: self.calls.append(destination)
        result = self.capture(self.context())
        self.assertFalse(result['captureVerified'])
        self.assertEqual(result['changedSlots'], [])

    def test_native_tempo_change_is_reported_separately_from_clip_verification(self):
        capture = self.song.capture_midi
        def change_tempo(destination):
            capture(destination)
            self.song.tempo = 125
        self.song.capture_midi = change_tempo
        result = self.capture(self.context())
        self.assertEqual(result['tempoBefore'], 120)
        self.assertEqual(result['tempoAfter'], 125)
        self.assertTrue(result['captureVerified'])
