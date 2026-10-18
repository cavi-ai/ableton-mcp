import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Device, Parameter, QuantizedParameter, Chain


class SwitchDevice(Device):
    def __init__(self):
        self.name, self.class_name, self.class_display_name = 'EQ Eight', 'Eq8', 'EQ Eight'
        self.type, self.can_have_chains, self.can_have_drum_pads = 2, False, False
        power = QuantizedParameter()
        power.name = power.original_name = 'Device On'
        power.min, power.max, power.value = 0., 1., 1.
        power.automation_state = 0
        self.parameters = [power, Parameter()]
        self.parent_active = True

    @property
    def is_active(self):
        return self.parent_active and self.parameters[0].value == 1


class DeviceBypassTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.device = SwitchDevice()
        self.song.tracks[0].devices = [self.device]
        self.ids = {'trackId': 'track-0', 'deviceId': 'track-0:device-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_device_activation_context', 'params': self.ids}, 4)

    def apply(self, before=None, active=False):
        return dispatch_request(self.song, {'method': 'set_device_active', 'params': {
            **self.ids, 'expectedStateVersion': 4, 'before': before or self.read(), 'active': active}}, 4)

    def test_inert_read_and_single_power_write_preserve_playback_selection_and_other_values(self):
        self.song.is_playing = True
        selection = self.song.view.selected_track
        before = self.read()
        self.assertTrue(before['localActive'])
        self.assertTrue(before['effectiveActive'])
        self.assertEqual(self.song.undo_boundaries, [])
        other = self.device.parameters[1].value
        result = self.apply(before)
        self.assertTrue(result['verified'])
        self.assertTrue(result['valueWriteRequested'])
        self.assertFalse(result['after']['localActive'])
        self.assertFalse(result['device']['active'])
        self.assertEqual(self.device.parameters[1].value, other)
        self.assertTrue(self.song.is_playing)
        self.assertIs(self.song.view.selected_track, selection)

    def test_same_version_power_automation_and_native_replacement_invalidate_plan(self):
        for change in ('value', 'automation', 'device', 'parameter'):
            self.setUp()
            before = self.read()
            if change == 'value': self.device.parameters[0].value = 0
            elif change == 'automation': self.device.parameters[0].automation_state = 1
            elif change == 'device': self.song.tracks[0].devices[0] = copy.deepcopy(self.device)
            else: self.device.parameters[0] = copy.deepcopy(self.device.parameters[0])
            with self.assertRaises(ValueError): self.apply(before)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_active_unknown_automation_and_unsafe_flags_refuse(self):
        for attr, value in [('automation_state', 1), ('automation_state', None), ('is_enabled', False)]:
            self.setUp()
            setattr(self.device.parameters[0], attr, value)
            with self.assertRaises(ValueError): self.apply()
        for owner, attr, value in [('song', 'record_mode', True), ('song', 'session_record', True),
                                   ('song', 'is_counting_in', None), ('track', 'is_frozen', None)]:
            self.setUp()
            setattr(self.song if owner == 'song' else self.song.tracks[0], attr, value)
            with self.assertRaises(ValueError): self.apply()

    def test_rechecks_native_identity_at_undo_entry(self):
        before = self.read()
        self.song.begin_undo_step = lambda: setattr(self.song.tracks[0], 'devices', [copy.deepcopy(self.device)])
        with self.assertRaises(ValueError): self.apply(before)
        self.assertEqual(self.device.parameters[0].value, 1)

    def test_finalization_error_retains_actual_write_and_does_not_replay(self):
        self.song.end_undo_step = lambda: (_ for _ in ()).throw(RuntimeError('end failed'))
        result = self.apply()
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertFalse(result['after']['localActive'])
        self.assertIn('end failed', result['error'])

    def test_noop_does_not_write_or_create_undo_step(self):
        result = self.apply(active=True)
        self.assertTrue(result['verified'])
        self.assertFalse(result['valueWriteRequested'])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_native_readback_mismatch_does_not_verify_a_returned_setter(self):
        class UnchangedPower(QuantizedParameter):
            @property
            def value(self): return 1.
            @value.setter
            def value(self, value): pass
        power = UnchangedPower()
        power.name = power.original_name = 'Device On'
        power.min, power.max, power.automation_state = 0., 1., 0
        self.device.parameters[0] = power
        result = self.apply()
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertTrue(result['after']['localActive'])

    def test_parent_activation_change_at_undo_entry_refuses_without_power_write(self):
        rack = SwitchDevice()
        rack.can_have_chains = True
        rack.chains = [Chain('Layer', [self.device])]
        self.song.tracks[0].devices = [rack]
        self.ids['deviceId'] += '/chain-0/device-0'
        before = self.read()
        self.song.begin_undo_step = lambda: setattr(rack.parameters[0], 'value', 0)
        with self.assertRaises(ValueError): self.apply(before)
        self.assertEqual(self.device.parameters[0].value, 1)

    def test_nested_control_reports_local_on_separately_from_parent_off(self):
        rack = SwitchDevice()
        rack.can_have_chains = True
        rack.chains = [Chain('Layer', [self.device])]
        rack.parameters[0].value = 0
        self.device.parent_active = False
        self.song.tracks[0].devices = [rack]
        self.ids['deviceId'] += '/chain-0/device-0'
        self.assertTrue(self.read()['localActive'])
        self.assertFalse(self.read()['effectiveActive'])
        self.assertFalse(self.read()['ancestors'][0]['active'])
        self.assertTrue(self.apply()['verified'])
        result = self.apply(active=True)
        self.assertTrue(result['verified'])
        self.assertTrue(result['after']['localActive'])
        self.assertFalse(result['after']['effectiveActive'])
        self.assertEqual(rack.parameters[0].value, 0)

    def test_unsupported_or_ambiguous_power_never_falls_back_to_another_parameter(self):
        for kind in ('missing', 'ambiguous', 'range'):
            self.setUp()
            if kind == 'missing': self.device.parameters = self.device.parameters[1:]
            elif kind == 'ambiguous': self.device.parameters.append(copy.deepcopy(self.device.parameters[0]))
            else: self.device.parameters[0].max = 3
            self.assertFalse(self.read()['supported'])
            with self.assertRaises(ValueError): self.apply()

    def test_return_and_main_owners_and_already_overridden_power(self):
        for owner_id in ('return-0', 'master'):
            self.setUp()
            owner = self.song.return_tracks[0] if owner_id == 'return-0' else self.song.master_track
            owner.devices = [self.device]
            self.device.parameters[0].automation_state = 2
            self.ids = {'trackId': owner_id, 'deviceId': owner_id + ':device-0'}
            result = self.apply()
            self.assertTrue(result['verified'])
            self.assertEqual(self.device.parameters[0].automation_state, 2)


if __name__ == '__main__': unittest.main()
