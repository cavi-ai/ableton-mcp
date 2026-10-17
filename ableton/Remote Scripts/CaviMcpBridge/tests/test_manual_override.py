import copy
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Parameter, NestedDevice, Chain
from test_automation_handoff import prepare
from bridge import dispatch_request, SocketBridge


class OverrideParameter(Parameter):
    def __init__(self):
        self.ready = False
        super().__init__()
        self.automation_state = 1
        self.writes, self.callback = 0, None
        self.change_state = True
        self.ready = True

    @property
    def value(self): return self._value

    @value.setter
    def value(self, value):
        self._value = value
        if self.ready:
            self.writes += 1
            if self.change_state: self.automation_state = 2
            if self.callback: self.callback()

    def re_enable_automation(self): self.automation_state = 1


class ManualOverrideTests(unittest.TestCase):
    def setUp(self):
        self.song = prepare()
        for owner in [*self.song.tracks, *self.song.return_tracks, self.song.master_track]:
            owner.devices[0].parameters = [OverrideParameter(), OverrideParameter()]
            for name in ['volume', 'panning', 'left_split_stereo', 'right_split_stereo', 'crossfader', 'cue_volume']:
                setattr(owner.mixer_device, name, OverrideParameter())
            owner.mixer_device.sends = [OverrideParameter() for _ in self.song.return_tracks]

    def call(self, name, args):
        return dispatch_request(self.song, {'method': name, 'params': args}, 4)

    def source(self, **args):
        return self.call('get_parameter_override_context', {'trackId': 'track-0', 'parameterId': 'volume', 'value': .6, **args})

    def apply(self, before=None, **args):
        request = {'trackId': 'track-0', 'parameterId': 'volume', 'value': .6, **args}
        view = before or self.source(**args)
        view = {k: v for k, v in view.items() if k != 'sampledControl'}
        return self.call('override_parameter_automation', {**request, 'expectedStateVersion': 4, 'before': view})

    def test_plan_is_inert_and_active_automation_can_advance_before_confirmation(self):
        before = self.source()
        p = self.song.tracks[0].mixer_device.volume
        self.assertEqual(p.writes, 0)
        self.assertEqual(before['valuePolicy'], 'advancingAutomation')
        self.assertNotIn('value', before['controls'][0])
        self.assertEqual(before['sampledControl']['value'], .4)
        p._value = .2
        self.song.current_song_time += 8
        result = self.apply(before)
        self.assertTrue(result['verified'])
        self.assertTrue(result['automationOverridden'])
        self.assertEqual(p.writes, 1)
        self.assertAlmostEqual(p.value, .6)

    def test_existing_manual_value_and_new_manual_takeover_invalidate_old_plan(self):
        p = self.song.tracks[0].mixer_device.volume
        for initial in [1, 2]:
            p.automation_state = initial
            p._value = .4
            before = self.source()
            p.value = .5
            writes = p.writes
            with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before)
            self.assertEqual(p.writes, writes)
        p.automation_state = 2
        self.assertTrue(self.apply()['verified'])

    def test_exact_ordinary_group_return_main_send_and_device_targets(self):
        for track_id in ['track-0', 'track-2', 'return-0', 'master']:
            self.assertTrue(self.apply(trackId=track_id)['verified'])
        for key in ['send-0', 'pan']:
            self.assertTrue(self.apply(parameterId=key)['verified'])
        self.song.tracks[0].mixer_device.panning_mode = 1
        self.assertTrue(self.apply(parameterId='left')['verified'])
        self.assertTrue(self.apply(parameterId='right')['verified'])
        for key in ['cueVolume', 'crossfader']:
            self.assertTrue(self.apply(trackId='master', parameterId=key)['verified'])
        self.assertTrue(self.apply(deviceId='track-0:device-0', parameterId='parameter-0')['verified'])
        self.assertEqual(self.song.tracks[0].devices[0].parameters[1].writes, 0)

    def test_display_target_is_stable_across_current_value_changes(self):
        args = {'deviceId': 'track-0:device-0', 'parameterId': 'parameter-0', 'targetDisplay': '600 Hz'}
        before = self.source(**args, value=None)
        p = self.song.tracks[0].devices[0].parameters[0]
        p._value = .6001
        after = self.source(**args, value=None)
        self.assertEqual(before['target'], after['target'])
        self.assertTrue(self.apply(before, **args, value=None)['verified'])

    def test_invalid_targets_unknown_or_inactive_automation_and_unsafe_context_refuse(self):
        for args in [{'value': True}, {'value': float('nan')}, {'value': 1.1}, {'value': -.1},
                     {'value': .5, 'targetDisplay': '500 Hz'}, {'value': None}, {'value': None, 'targetDisplay': 'bad'},
                     {'value': None, 'targetDisplay': '20 dB'}]:
            with self.assertRaises(ValueError): self.source(**args)
        p = self.song.tracks[0].mixer_device.volume
        for state in [0, None, 9]:
            p.automation_state = state
            with self.assertRaisesRegex(ValueError, 'automation'): self.source()
        p.automation_state = 1
        for flag in ['record_mode', 'session_record', 'is_counting_in']:
            setattr(self.song, flag, True)
            with self.assertRaisesRegex(ValueError, 'recording|count-in'): self.source()
            setattr(self.song, flag, False)
        p.is_enabled = False
        with self.assertRaisesRegex(ValueError, 'enabled'): self.source()
        p.is_enabled = True
        self.song.tracks[0].is_frozen = True
        with self.assertRaisesRegex(ValueError, 'frozen'): self.source()
        self.song.tracks[0].is_frozen = False
        self.song.tracks[0].mixer_device.panning_mode = 1
        with self.assertRaisesRegex(ValueError, 'mode'): self.source(parameterId='pan')
        self.assertEqual(p.writes, 0)

    def test_quantized_values_are_integral_and_unit_resolution_refuses(self):
        p = self.song.tracks[0].devices[0].parameters[0]
        p.is_quantized, p.max = True, 3
        args = {'deviceId': 'track-0:device-0', 'parameterId': 'parameter-0'}
        with self.assertRaisesRegex(ValueError, 'integer'): self.source(**args, value=1.5)
        with self.assertRaisesRegex(ValueError, 'continuous'): self.source(**args, value=None, targetDisplay='500 Hz')
        self.assertTrue(self.apply(**args, value=2)['verified'])

    def test_rack_chain_and_return_replacements_refuse_before_write(self):
        owner = self.song.tracks[0]
        leaf = owner.devices[0]
        rack = NestedDevice('Rack', 'InstrumentGroupDevice')
        rack.can_have_chains, rack.chains = True, [Chain('Chain', [leaf])]
        owner.devices = [rack]
        args = {'deviceId': 'track-0:device-0/chain-0/device-0', 'parameterId': 'parameter-0'}
        before = self.source(**args)
        rack.chains = [Chain('Chain', [leaf])]
        with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before, **args)
        before = self.source(parameterId='send-0')
        self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
        with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before, parameterId='send-0')
        self.assertEqual(leaf.parameters[0].writes, 0)

    def test_undo_entry_rechecks_and_partial_native_failures_are_never_replayed(self):
        p = self.song.tracks[0].mixer_device.volume
        self.song.begin_undo_step = lambda: setattr(p, 'automation_state', 2)
        with self.assertRaisesRegex(ValueError, 'changed'): self.apply()
        self.assertEqual(p.writes, 0)
        del self.song.begin_undo_step
        p.automation_state = 1
        def callback(): raise RuntimeError('native failed after write')
        p.callback = callback
        result = self.apply()
        self.assertFalse(result['verified'])
        self.assertTrue(result['partial'])
        self.assertTrue(result['valueWriteRequested'])
        self.assertFalse(result['nativeReturned'])
        self.assertEqual(p.writes, 1)
        self.assertAlmostEqual(p.value, .6)

    def test_native_setter_return_without_override_is_not_verified(self):
        p = self.song.tracks[0].mixer_device.volume
        p.change_state = False
        result = self.apply()
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['automationOverridden'])
        self.assertFalse(result['verified'])
        self.assertEqual(p.writes, 1)

    def test_replacement_during_write_remains_partial_without_rollback(self):
        p = self.song.tracks[0].mixer_device.volume
        replacement = OverrideParameter()
        p.callback = lambda: setattr(self.song.tracks[0].mixer_device, 'volume', replacement)
        result = self.apply()
        self.assertFalse(result['verified'])
        self.assertFalse(result['verification']['topologyStable'])
        self.assertTrue(result['partial'])
        self.assertEqual(p.writes, 1)
        self.assertEqual(replacement.writes, 0)

    def test_deferred_receipt_observes_without_repeating_the_write(self):
        p = self.song.tracks[0].mixer_device.volume
        p.change_state = False
        callbacks, replies = [], []
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
                                  schedule_message=lambda _, callback: callbacks.append(callback))
        socket = SimpleNamespace(sendall=lambda data: replies.append(json.loads(data)))
        bridge = SocketBridge(surface, '/unused-test-socket')
        bridge.state_version = 4
        before = {k: v for k, v in self.source().items() if k != 'sampledControl'}
        args = {'trackId': 'track-0', 'parameterId': 'volume', 'value': .6, 'expectedStateVersion': 4, 'before': before}
        bridge.requests.put((socket, {'id': 'override', 'method': 'override_parameter_automation', 'params': args}))
        bridge.drain()
        callbacks.pop(0)()
        self.assertEqual(len(replies), 0)
        p.automation_state = 2
        callbacks.pop(0)()
        self.assertTrue(replies[0]['result']['verified'])
        self.assertEqual(p.writes, 1)


if __name__ == '__main__': unittest.main()
