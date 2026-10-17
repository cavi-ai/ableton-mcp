import copy
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from test_dispatch import Song, DrumRack, NestedDevice
import midi_import


class MidiImportTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[-1]
        self.track.devices = []
        self.track.mute = True
        self.track.current_monitoring_state = 2
        self.track.current_output_routing = self.track.available_output_routing_types[-1]
        self.params = {'trackId': 'track-1', 'clipId': 'track-1:clip-0'}

    def test_read_is_inert_and_binds_replaced_native_objects(self):
        before = midi_import.source(self.song, self.params, 3)
        self.assertEqual(midi_import.source(self.song, self.params, 3), before)
        self.assertIs(self.song.view.selected_track, self.song.tracks[0])
        self.song.tracks[-1] = copy.deepcopy(self.track)
        self.assertNotEqual(midi_import.source(self.song, self.params, 3)['identityToken'], before['identityToken'])

    def test_selection_binds_an_empty_session_slot_without_creating_content(self):
        before = midi_import.source(self.song, self.params, 3)
        calls = []
        app = SimpleNamespace(view=SimpleNamespace(show_view=lambda name: calls.append(name), focus_view=lambda name: calls.append(name)))
        result = midi_import.select(self.song, {**self.params, 'before': before, 'expectedStateVersion': 3}, 3, app)
        self.assertEqual(result['source']['stateVersion'], 4)
        self.assertIs(self.song.view.highlighted_clip_slot, self.track.clip_slots[0])
        self.assertFalse(self.track.clip_slots[0].has_clip)
        self.assertEqual(calls, ['Session', 'Session'])

    def test_occupied_or_unsafe_staging_refuses(self):
        for change in ('occupied', 'output', 'armed', 'playing', 'not-last'):
            self.setUp()
            if change == 'occupied': self.track.clip_slots[1].create_clip(4)
            if change == 'output': self.track.current_output_routing = self.track.available_output_routing_types[0]
            if change == 'armed': self.track.arm = True
            if change == 'playing': self.song.is_playing = True
            if change == 'not-last': self.song.tracks.append(copy.deepcopy(self.track))
            with self.assertRaises(ValueError): midi_import.source(self.song, self.params, 3)

    def test_observation_reports_imported_clip_and_structure_without_note_equivalence_claim(self):
        before = midi_import.source(self.song, self.params, 3)
        self.track.clip_slots[0].create_clip(8)
        result = midi_import.inspect(self.song, before['identityToken'], 4)
        self.assertTrue(result['existingStructurePreserved'])
        self.assertEqual(result['targetClips'][0]['id'], 'track-1:clip-0')
        self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
        self.assertFalse(midi_import.inspect(self.song, before['identityToken'], 4)['existingStructurePreserved'])

    def test_existing_group_does_not_read_unsupported_arrangement_clips(self):
        class Group(type(self.song.tracks[0])):
            is_foldable = True
            @property
            def arrangement_clips(self):
                raise RuntimeError('Group has no Arrangement clips')
        self.song.tracks[0].__class__ = Group
        before = midi_import.source(self.song, self.params, 3)
        self.track.clip_slots[0].create_clip(8)
        self.assertTrue(midi_import.inspect(self.song, before['identityToken'], 4)['existingStructurePreserved'])

    def test_nested_rack_replacement_invalidates_context_and_structure(self):
        rack = DrumRack()
        self.song.tracks[0].devices = [rack]
        before = midi_import.source(self.song, self.params, 3)
        rack.chains[0].devices[0] = NestedDevice('Different child', 'OriginalSimpler')
        self.assertFalse(midi_import.inspect(self.song, before['identityToken'], 3)['existingStructurePreserved'])
        self.assertNotEqual(midi_import.source(self.song, self.params, 3)['identityToken'], before['identityToken'])
