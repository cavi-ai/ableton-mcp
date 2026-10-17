import copy
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Parameter, Device, NestedDevice, Chain
from bridge import dispatch_request, SocketBridge


class AutomatedParameter(Parameter):
    def __init__(self):
        super().__init__()
        self.automation_state = 2
        self.calls, self.callback, self.deferred = 0, None, False

    def re_enable_automation(self):
        self.calls += 1
        if not self.deferred:
            self.automation_state, self.value = 1, .8
        if self.callback: self.callback()


def prepare():
    song = Song()
    song.tracks.append(copy.deepcopy(song.tracks[1]))
    song.tracks[2].is_foldable = True
    for owner in [*song.tracks, *song.return_tracks, song.master_track]:
        owner.devices = [Device()]
        owner.devices[0].parameters = [AutomatedParameter(), AutomatedParameter()]
        mixer = owner.mixer_device
        mixer.panning_mode = 0
        for name in ['volume', 'panning', 'left_split_stereo', 'right_split_stereo', 'crossfader', 'cue_volume']:
            setattr(mixer, name, AutomatedParameter())
        mixer.sends = [AutomatedParameter() for _ in song.return_tracks]
    return song


class ParameterAutomationTests(unittest.TestCase):
    def setUp(self): self.song = prepare()

    def call(self, name, params=None):
        return dispatch_request(self.song, {'method': name, 'params': params or {}}, 4)

    def context(self, **params):
        return self.call('get_parameter_automation_context', {'trackId': 'track-0', **params})

    def resume(self, before=None, **params):
        args = {'trackId': 'track-0', 'parameterId': 'volume', **params}
        return self.call('re_enable_parameter_automation', {**args, 'expectedStateVersion': 4,
                         'before': before or self.context(**args)})

    def test_read_lists_discoverable_mixer_controls_and_device_parameters_without_writes(self):
        view = self.context()
        self.assertEqual([p['id'] for p in view['controls']], ['volume', 'pan', 'left', 'right', 'send-0'])
        self.assertEqual(view['controls'][-1]['returnTrackId'], 'return-0')
        self.assertEqual(self.context(deviceId='track-0:device-0')['controls'][0]['id'], 'parameter-0')
        self.assertEqual([p['id'] for p in self.context(trackId='master')['controls']][-2:], ['cueVolume', 'crossfader'])
        self.assertEqual(self.song.tracks[0].mixer_device.volume.calls, 0)
        self.assertEqual(self.song.tracks[0].devices[0].parameters[0].calls, 0)

    def test_one_device_control_handoff_preserves_other_overrides(self):
        params = {'deviceId': 'track-0:device-0', 'parameterId': 'parameter-0'}
        result = self.resume(**params)
        self.assertTrue(result['verified'])
        self.assertTrue(result['reEnableRequested'])
        self.assertTrue(result['automationControlRestored'])
        self.assertEqual(result['observed']['controls'][0]['automationState']['value'], 1)
        selected, other = self.song.tracks[0].devices[0].parameters
        self.assertEqual(selected.calls, 1)
        self.assertEqual(other.calls, 0)
        self.assertEqual(other.automation_state, 2)

    def test_track_group_return_and_main_faders_are_exact_native_targets(self):
        for track_id in ['track-0', 'track-1', 'track-2', 'return-0', 'master']:
            result = self.resume(trackId=track_id)
            self.assertTrue(result['verified'], track_id)
            self.assertEqual(result['observed']['trackId'], track_id)
        for control in ['cueVolume', 'crossfader']:
            self.assertTrue(self.resume(trackId='master', parameterId=control)['verified'])

    def test_send_handoff_binds_exact_return_and_preserves_neighboring_controls(self):
        old = self.context(parameterId='send-0')
        self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
        with self.assertRaisesRegex(ValueError, 'changed'): self.resume(before=old, parameterId='send-0')
        self.assertTrue(self.resume(parameterId='send-0')['verified'])
        self.assertEqual(self.song.tracks[0].mixer_device.volume.calls, 0)

    def test_pan_mode_requires_the_selected_native_control_to_be_active(self):
        mixer = self.song.tracks[0].mixer_device
        for mode, control in [(0, 'left'), (0, 'right'), (1, 'pan'), (None, 'pan')]:
            mixer.panning_mode = mode
            with self.assertRaisesRegex(ValueError, 'mode'): self.resume(parameterId=control)
        mixer.panning_mode = 1
        self.assertTrue(self.resume(parameterId='left')['verified'])
        self.assertTrue(self.resume(parameterId='right')['verified'])

    def test_missing_api_automation_disabled_frozen_recording_and_count_in_refuse(self):
        p = self.song.tracks[0].mixer_device.volume
        for state in [0, 1, None, 9]:
            p.automation_state = state
            with self.assertRaisesRegex(ValueError, 'overridden'): self.resume()
        p.automation_state = 2
        p.re_enable_automation = None
        self.assertFalse(self.context(parameterId='volume')['controls'][0]['reEnableSupported'])
        with self.assertRaisesRegex(ValueError, 'supported'): self.resume()
        del p.re_enable_automation
        p.is_enabled = False
        with self.assertRaisesRegex(ValueError, 'enabled'): self.resume()
        p.is_enabled = True
        self.song.tracks[0].is_frozen = True
        with self.assertRaisesRegex(ValueError, 'frozen'): self.resume()
        self.song.tracks[0].is_frozen = False
        for flag in ['record_mode', 'session_record', 'is_counting_in']:
            setattr(self.song, flag, True)
            with self.assertRaisesRegex(ValueError, 'recording|count-in'): self.resume()
            setattr(self.song, flag, False)
        self.assertEqual(p.calls, 0)

    def test_unknown_native_controls_remain_explicit_in_read_context(self):
        self.song.tracks[0].mixer_device.left_split_stereo = None
        row = self.context(parameterId='left')['controls'][0]
        self.assertFalse(row['supported'])
        self.assertFalse(row['reEnableSupported'])
        with self.assertRaises(ValueError): self.resume(parameterId='left')

    def test_manual_edits_or_identical_native_replacement_invalidate_same_version_plans(self):
        for change in ['value', 'owner', 'mixer', 'parameter']:
            self.setUp()
            before = self.context(parameterId='volume')
            owner = self.song.tracks[0]
            if change == 'value': owner.mixer_device.volume.value = .6
            elif change == 'owner': self.song.tracks[0] = copy.deepcopy(owner)
            elif change == 'mixer': owner.mixer_device = copy.deepcopy(owner.mixer_device)
            else: owner.mixer_device.volume = AutomatedParameter()
            with self.assertRaisesRegex(ValueError, 'changed'): self.resume(before=before)

    def test_undo_entry_rechecks_target_before_calling_native_method(self):
        owner = self.song.tracks[0]
        original = owner.mixer_device.volume
        self.song.begin_undo_step = lambda: setattr(owner, 'mixer_device', copy.deepcopy(owner.mixer_device))
        with self.assertRaisesRegex(ValueError, 'changed'): self.resume()
        self.assertEqual(original.calls, 0)

    def test_nested_container_replacement_invalidates_confirmation_and_readback(self):
        for chain_kind in ['chains', 'return_chains']:
            for replacement in ['rack', 'chain']:
                for stage in ['before', 'undo', 'during']:
                    with self.subTest(chain_kind=chain_kind, replacement=replacement, stage=stage):
                        self.setUp()
                        owner = self.song.tracks[0]
                        leaf = owner.devices[0]
                        rack = NestedDevice('Rack', 'InstrumentGroupDevice')
                        rack.can_have_chains = True
                        chain = Chain('Chain', [leaf])
                        setattr(rack, chain_kind, [chain])
                        owner.devices = [rack]
                        segment = 'chain' if chain_kind == 'chains' else 'return-chain'
                        args = {'deviceId': f'track-0:device-0/{segment}-0/device-0', 'parameterId': 'parameter-0'}
                        before = self.context(**args)
                        parameter = leaf.parameters[0]
                        def replace():
                            if replacement == 'chain':
                                setattr(rack, chain_kind, [Chain('Chain', [leaf])])
                            else:
                                new_rack = copy.copy(rack)
                                setattr(new_rack, chain_kind, [chain])
                                owner.devices = [new_rack]
                        if stage == 'during':
                            parameter.callback = replace
                            result = self.resume(before=before, **args)
                            self.assertFalse(result['verified'])
                            self.assertTrue(result['partial'])
                            self.assertFalse(result['verification']['topologyStable'])
                            self.assertEqual(parameter.calls, 1)
                        else:
                            if stage == 'before': replace()
                            else: self.song.begin_undo_step = replace
                            with self.assertRaisesRegex(ValueError, 'changed'):
                                self.resume(before=before, **args)
                            self.assertEqual(parameter.calls, 0)

    def test_native_failure_or_replacement_reports_partial_without_rollback_or_replay(self):
        for replacement in [False, True]:
            self.setUp()
            p = self.song.tracks[0].mixer_device.volume
            def callback():
                if replacement: self.song.tracks[0].mixer_device.volume = AutomatedParameter()
                else: raise RuntimeError('native handoff refused')
            p.callback = callback
            result = self.resume()
            self.assertFalse(result['verified'])
            self.assertTrue(result['partial'])
            self.assertEqual(p.calls, 1)

    def test_deferred_readback_observes_without_repeating_native_command(self):
        p = self.song.tracks[0].mixer_device.volume
        p.deferred = True
        callbacks, replies = [], []
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
                                  schedule_message=lambda _, callback: callbacks.append(callback))
        socket = SimpleNamespace(sendall=lambda data: replies.append(json.loads(data)))
        bridge = SocketBridge(surface, '/unused-test-socket')
        bridge.state_version = 4
        args = {'trackId': 'track-0', 'parameterId': 'volume', 'expectedStateVersion': 4,
                'before': self.context(parameterId='volume')}
        bridge.requests.put((socket, {'id': 'handoff', 'method': 're_enable_parameter_automation', 'params': args}))
        bridge.drain()
        self.assertTrue(bridge.deferred_request)
        callbacks.pop(0)()
        self.assertEqual(len(replies), 0)
        p.automation_state = 1
        callbacks.pop(0)()
        self.assertTrue(replies[0]['result']['verified'])
        self.assertEqual(p.calls, 1)
        self.assertFalse(bridge.deferred_request)

    def test_unrelated_automated_values_and_advancing_playhead_do_not_invalidate_selected_plan(self):
        before = self.context(parameterId='volume')
        self.song.current_song_time += 10
        self.song.tracks[0].mixer_device.panning.value = .9
        self.assertTrue(self.resume(before=before)['verified'])

    def test_invalid_owner_parameter_and_cross_owner_device_ids_refuse(self):
        for params in [{'trackId': 'track-00'}, {'parameterId': 'send-00'}, {'deviceId': 'track-1:device-0'},
                       {'deviceId': 'track-0:device-0', 'parameterId': 'parameter-00'}, {'parameterId': 'cueVolume'}]:
            with self.assertRaises(ValueError): self.resume(**params)


if __name__ == '__main__': unittest.main()
