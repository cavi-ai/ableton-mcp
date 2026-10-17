import copy
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, MidiNote, AudioClip

class MidiExportTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.is_midi_clip = True
        self.clip.is_audio_clip = False
        self.clip.start_marker, self.clip.end_marker = 0., 4.
        self.clip.extended_notes = [MidiNote()]
        self.args = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}
        self.calls = []
        self.application = SimpleNamespace(view=SimpleNamespace(show_view=lambda v: self.calls.append(v), focus_view=lambda v: self.calls.append(v)))

    def source(self):
        return dispatch_request(self.song, {'method': 'get_midi_export_source', 'params': self.args}, 3)

    def select(self, before):
        return dispatch_request(self.song, {'method': 'select_midi_export_source', 'params': {**self.args, 'before': before, 'expectedStateVersion': 3}}, 3, self.application)

    def test_inert_source_binds_exact_clip_and_all_stored_note_properties(self):
        first = self.source()
        self.assertEqual(first, self.source())
        self.assertEqual(first['notes'][0]['noteId'], 7)
        self.assertEqual(first['trackUIPath'], '.Track[0]')
        self.clip.extended_notes[0].probability = .5
        self.assertNotEqual(first, self.source())
        token = self.source()['identityToken']
        self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.clip)
        self.assertNotEqual(token, self.source()['identityToken'])
        self.assertEqual(self.calls, [])

    def test_selection_preserves_material_and_rejects_intervening_edits(self):
        before = self.source()
        result = self.select(before)
        self.assertIs(self.song.view.selected_track, self.song.tracks[0])
        self.assertIs(self.song.view.detail_clip, self.clip)
        self.assertEqual(before['notes'], result['source']['notes'])
        self.assertEqual(before['timing'], {**result['source']['timing'], 'stateVersion': 3})
        self.assertEqual(self.calls, ['Session', 'Detail', 'Detail/Clip'])
        self.clip.name = 'Manual edit'
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.select(before)

    def test_audio_recording_playback_and_excessive_notes_refuse(self):
        self.song.tracks[0].clip_slots[0].clip = AudioClip()
        with self.assertRaisesRegex(ValueError, 'MIDI'):
            self.source()
        self.setUp()
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, 'stopped'):
            self.source()
        self.setUp()
        self.clip.extended_notes = [MidiNote()] * 4097
        with self.assertRaisesRegex(ValueError, '4096'):
            self.source()

    def test_untitled_sets_keep_native_identity_and_arrangement_selection(self):
        self.song.file_path = ''
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.clip.start_time, self.clip.end_time = 8., 12.
        self.args['clipId'] = 'track-0:arrangement-clip-0'
        before = self.source()
        self.assertEqual(before['filePath'], '')
        self.assertEqual(before['location'], 'arrangement')
        self.select(before)
        self.assertEqual(self.calls[0], 'Arranger')
