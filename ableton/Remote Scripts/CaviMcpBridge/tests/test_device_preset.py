import copy
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class DevicePresetTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.device = self.song.tracks[0].devices[0]
        for owner in list(self.song.return_tracks) + [self.song.master_track]:
            owner.devices = []
        self.song.tracks[0].view = SimpleNamespace(selected_device=None)
        def select(device):
            self.song.view.selected_track.view.selected_device = device
        self.song.view.select_device = select
        self.args = {'trackId': 'track-0', 'deviceId': 'track-0:device-0'}
        self.calls = []
        self.application = SimpleNamespace(view=SimpleNamespace(show_view=lambda name: self.calls.append(name), focus_view=lambda name: self.calls.append(name)))

    def source(self):
        return dispatch_request(self.song, {'method': 'get_device_preset_source', 'params': self.args}, 3)

    def test_source_is_inert_and_binds_native_target_and_exposed_material(self):
        before = self.source()
        self.assertEqual(before, self.source())
        self.assertIsNone(self.song.tracks[0].view.selected_device)
        self.device.parameters[0].value = .7
        self.assertNotEqual(before['contentSha256'], self.source()['contentSha256'])
        self.song.tracks[0].devices[0] = copy.deepcopy(self.device)
        self.assertNotEqual(before['identityToken'], self.source()['identityToken'])

    def test_selection_rechecks_then_focuses_only_the_exact_device_without_editing_it(self):
        before = self.source()
        result = dispatch_request(self.song, {'method': 'select_device_preset_source', 'params': {
            **self.args, 'name': 'Kept sound', 'expectedStateVersion': 3, 'before': before}}, 3, self.application)
        self.assertIs(self.song.view.selected_track, self.song.tracks[0])
        self.assertIs(self.song.tracks[0].view.selected_device, self.device)
        self.assertEqual(result['source']['name'], 'Kept sound')
        self.assertEqual(before['snapshot']['parameters'], result['source']['snapshot']['parameters'])
        self.assertEqual(before['identityToken'], result['source']['identityToken'])
        self.assertEqual(self.calls, ['Detail', 'Detail/DeviceChain'])

    def test_duplicate_or_unsafe_names_refuse_before_source_rename(self):
        for name in ['../bad', '', self.song.tracks[1].devices[0].name]:
            before = self.source()
            with self.assertRaisesRegex(ValueError, 'name'):
                dispatch_request(self.song, {'method': 'select_device_preset_source', 'params': {
                    **self.args, 'name': name, 'expectedStateVersion': 3, 'before': before}}, 3, self.application)
            self.assertEqual(self.device.name, before['name'])

    def test_ui_identity_binds_owner_hierarchy_and_nested_chain_index(self):
        from device_preset import _ui_identity
        track = self.song.tracks[0]
        self.assertEqual(self.source()['uiIdentity'], {'trackPath': '.Track[0]', 'devicePath': 'TrackView.Device[0]', 'chains': []})
        group = self.song.tracks[1]
        group.is_foldable = True
        track.is_grouped, track.group_track = True, group
        self.assertEqual(_ui_identity(self.song, track, 'track-0', self.args['deviceId'])['trackPath'], '.GroupTrack[0].Track[0]')
        rack = SimpleNamespace(chains=[SimpleNamespace(devices=[self.device]), SimpleNamespace(devices=[self.device])], return_chains=[])
        track.devices = [rack]
        identity = _ui_identity(self.song, track, 'track-0', 'track-0:device-0/chain-1/device-0')
        self.assertEqual(identity['devicePath'], 'TrackView.Device[0].Device[0]')
        self.assertEqual(identity['chains'], [{'rackUIId': 'TrackView.Device[0]', 'index': 1, 'count': 2}])
        self.song.master_track.devices = [self.device]
        self.assertEqual(_ui_identity(self.song, self.song.master_track, 'master', 'master:device-0')['trackPath'], '.MainTrack')
        self.song.return_tracks[0].devices = [self.device]
        self.assertEqual(_ui_identity(self.song, self.song.return_tracks[0], 'return-0', 'return-0:device-0')['trackPath'], '.ReturnTrack[0]')

    def test_changed_material_and_unsafe_readiness_refuse_before_selection(self):
        before = self.source()
        self.device.parameters[0].value = .8
        with self.assertRaisesRegex(ValueError, 'changed'):
            dispatch_request(self.song, {'method': 'select_device_preset_source', 'params': {
                **self.args, 'expectedStateVersion': 3, 'before': before}}, 3, self.application)
        self.assertEqual(self.calls, [])
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, 'stopped'):
            self.source()
