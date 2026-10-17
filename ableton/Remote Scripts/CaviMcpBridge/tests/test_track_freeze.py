import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class TrackFreezeTests(unittest.TestCase):
    def source(self, song):
        return dispatch_request(song, {'method': 'get_track_freeze_source', 'params': {'trackId': 'track-0'}}, 4)

    def test_read_binds_exposed_material_and_native_objects_without_selection(self):
        song = Song()
        before = self.source(song)
        self.assertEqual(before, self.source(song))
        self.assertEqual(before['uiPath'], '.Track[0]')
        song.tracks[0].devices[0].parameters[0].value = 0.7
        self.assertNotEqual(before['contentSha256'], self.source(song)['contentSha256'])
        before = self.source(song)
        song.tracks[0].clip_slots[0].clip = copy.deepcopy(song.tracks[0].clip_slots[0].clip)
        self.assertNotEqual(before['identityToken'], self.source(song)['identityToken'])
        self.assertFalse(song.tracks[0].is_frozen)

    def test_readiness_exposes_playback_arm_pending_and_recording(self):
        song = Song()
        song.is_playing = True
        song.tracks[0].arm = True
        song.tracks[0].fired_slot_index = 0
        source = self.source(song)
        self.assertTrue(source['readiness']['playing'])
        self.assertTrue(source['readiness']['armed'])
        self.assertTrue(source['readiness']['pending'])

    def test_native_setter_is_never_attempted(self):
        song = Song()
        with self.assertRaisesRegex(ValueError, 'native UI'):
            dispatch_request(song, {'method': 'set_track_freeze_state', 'params': {}}, 4)
        self.assertFalse(song.tracks[0].is_frozen)

    def test_non_rack_chain_properties_are_not_read(self):
        song = Song()
        class NonRack(type(song.tracks[0].devices[0])):
            @property
            def chains(self):
                raise RuntimeError('not a rack')
            @property
            def return_chains(self):
                raise RuntimeError('not a rack')
        song.tracks[0].devices[0].__class__ = NonRack
        self.assertTrue(self.source(song)['identityToken'])
