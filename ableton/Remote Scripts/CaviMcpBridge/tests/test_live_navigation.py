import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from test_dispatch import Song, Device, Clip
import live_navigation


class AppView:
    def __init__(self):
        self.visible = {'Session', 'Detail', 'Detail/DeviceChain'}
        self.calls = []

    def is_view_visible(self, name):
        return name in self.visible

    def show_view(self, name):
        self.calls.append(('show', name))
        if name in ('Session', 'Arranger'):
            self.visible.difference_update(('Session', 'Arranger'))
        if name.startswith('Detail/'):
            self.visible.difference_update(('Detail/Clip', 'Detail/DeviceChain'))
            self.visible.add('Detail')
        self.visible.add(name)

    def focus_view(self, name):
        self.show_view(name)


class NavigationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.app = SimpleNamespace(view=AppView())
        self.song.master_track.name = 'Main'
        for owner in [*self.song.tracks, *self.song.return_tracks, self.song.master_track]:
            if not hasattr(owner, 'devices'):
                owner.devices = [Device()]
            owner.view = SimpleNamespace(selected_device=owner.devices[0])
            for device in owner.devices:
                device.view = SimpleNamespace(is_collapsed=True)
        self.song.view.selected_scene = self.song.scenes[0]
        self.song.view.highlighted_clip_slot = self.song.tracks[0].clip_slots[0]
        self.song.view.detail_clip = self.song.tracks[0].clip_slots[0].clip
        self.song.view.select_device = lambda d: setattr(self.song.view.selected_track.view, 'selected_device', d)
        self.params = {'trackId': 'track-0', 'clipId': 'track-0:clip-0', 'view': 'Session'}

    def source(self):
        return live_navigation.source(self.song, self.params, 3, self.app)

    def apply(self, before=None):
        return live_navigation.show(self.song, {**self.params, 'before': before or self.source(), 'expectedStateVersion': 3}, 3, self.app)

    def test_plan_is_inert_and_show_opens_exact_clip_without_content_or_transport_changes(self):
        original = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip.__dict__)
        before = self.source()
        self.assertEqual(before, self.source())
        self.assertEqual(self.app.view.calls, [])
        result = self.apply(before)
        self.assertTrue(result['selectionVerified'])
        self.assertTrue(result['viewsVerified'])
        self.assertTrue(result['controlsUnchanged'])
        self.assertIs(self.song.view.detail_clip, self.song.tracks[0].clip_slots[0].clip)
        self.assertIn('Detail/Clip', self.app.view.visible)
        self.assertEqual(original, self.song.tracks[0].clip_slots[0].clip.__dict__)
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_empty_session_slot_is_highlighted_without_creating_a_clip(self):
        self.params['clipId'] = 'track-0:clip-1'
        result = self.apply()
        self.assertTrue(result['selectionVerified'])
        self.assertEqual(result['target']['kind'], 'slot')
        self.assertFalse(self.song.tracks[0].clip_slots[1].has_clip)
        self.assertIs(self.song.view.highlighted_clip_slot, self.song.tracks[0].clip_slots[1])

    def test_arrangement_clip_and_return_device_have_exact_owners(self):
        clip = Clip()
        clip.start_time, clip.end_time = 8, 12
        clip.is_audio_clip = False
        self.song.tracks[0].arrangement_clips = [clip]
        self.params.update(clipId='track-0:arrangement-clip-0', view='Arranger')
        self.assertTrue(self.apply()['selectionVerified'])
        self.assertIs(self.song.view.detail_clip, clip)
        self.params = {'trackId': 'return-0', 'deviceId': 'return-0:device-0', 'view': 'Session'}
        self.assertTrue(self.apply()['selectionVerified'])
        self.assertIs(self.song.view.selected_track, self.song.return_tracks[0])

    def test_changed_selection_or_replaced_target_refuses_before_view_writes(self):
        for change in ('selection', 'slot', 'clip'):
            self.setUp()
            before = self.source()
            if change == 'selection': self.song.view.selected_track = self.song.tracks[1]
            if change == 'slot': self.song.tracks[0].clip_slots[0] = copy.deepcopy(self.song.tracks[0].clip_slots[0])
            if change == 'clip': self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
            with self.assertRaises(ValueError): self.apply(before)
            self.assertEqual(self.app.view.calls, [])

    def test_nested_device_reveals_its_group_and_binds_manual_view_and_arm_changes(self):
        group, child = self.song.tracks
        group.is_foldable, group.fold_state = True, 1
        child.is_grouped, child.group_track = True, group
        rack, device = child.devices[0], Device()
        device.view = SimpleNamespace(is_collapsed=True)
        chain = SimpleNamespace(devices=[device])
        rack.can_have_chains, rack.chains = True, [chain]
        rack.view.selected_chain, rack.view.is_showing_chain_devices = None, False
        self.params = {'trackId': 'track-1', 'deviceId': 'track-1:device-0/chain-0/device-0', 'view': 'Session'}
        before = self.source()
        child.arm = True
        with self.assertRaises(ValueError): self.apply(before)
        self.assertEqual(group.fold_state, 1)
        child.arm = False
        self.app.view.visible.discard('Detail/DeviceChain')
        with self.assertRaises(ValueError): self.apply(before)
        self.app.view.visible.add('Detail/DeviceChain')
        result = self.apply(before)
        self.assertTrue(result['showVerified'])
        self.assertEqual(group.fold_state, 0)
        self.assertIs(child.view.selected_device, device)
        self.assertFalse(device.view.is_collapsed)
        self.assertFalse(rack.view.is_collapsed)
        self.assertIs(rack.view.selected_chain, chain)
        self.assertTrue(rack.view.is_showing_chain_devices)
        self.assertTrue(result['deviceViewsVerified'])

    def test_ambiguous_noncanonical_or_incompatible_selectors_and_recording_refuse(self):
        for params in ({**self.params, 'deviceId': 'track-0:device-0'},
                       {**self.params, 'view': 'Arranger'},
                       {'trackId': 'track-0', 'deviceId': 'track-0:device-00', 'view': 'Session'},
                       {**self.params, 'clipId': 'track-0:clip-00'}):
            self.params = params
            with self.assertRaises(ValueError): self.source()
            self.assertEqual(self.app.view.calls, [])
        self.setUp()
        self.song.record_mode = True
        with self.assertRaises(ValueError): self.source()

    def test_return_and_main_monitoring_getters_are_not_read(self):
        class NoMonitor:
            def __init__(self, owner, main=False): self.owner, self.main = owner, main
            def __getattr__(self, name):
                if name == 'current_monitoring_state' or self.main and name in ('mute', 'solo', 'arm'):
                    raise RuntimeError('Main and Return Tracks have no monitoring state!')
                return getattr(self.owner, name)
        self.song.return_tracks[0] = NoMonitor(self.song.return_tracks[0])
        self.song.master_track = NoMonitor(self.song.master_track, main=True)
        self.assertTrue(self.apply()['showVerified'])

    def test_selection_listener_reindexing_cannot_verify_an_outdated_device_id(self):
        self.params = {'trackId': 'track-0', 'deviceId': 'track-0:device-0', 'view': 'Session'}
        owner = self.song.tracks[0]
        original = owner.devices[0]
        def select(device):
            inserted = Device()
            inserted.view = SimpleNamespace(is_collapsed=False)
            owner.devices.insert(0, inserted)
            owner.view.selected_device = device
        self.song.view.select_device = select
        result = self.apply()
        self.assertIs(owner.view.selected_device, original)
        self.assertFalse(result['targetIdentityRetained'])
        self.assertFalse(result['selectionVerified'])
        self.assertFalse(result['showVerified'])
        self.assertEqual(result['selection']['selectedDevice']['deviceId'], 'track-0:device-1')

    def test_partial_view_failure_is_observed_without_undo_or_replay(self):
        def fail(name):
            raise RuntimeError('native view failed')
        self.app.view.focus_view = fail
        result = self.apply()
        self.assertFalse(result['showVerified'])
        self.assertIn('native view failed', result['error'])
        self.assertTrue(result['inspectionRequired'])
        self.assertEqual(self.song.undo_boundaries, [])


if __name__ == '__main__':
    unittest.main()
