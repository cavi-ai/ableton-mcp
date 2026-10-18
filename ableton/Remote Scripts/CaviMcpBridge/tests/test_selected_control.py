import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Device, Parameter, Chain


class SelectedControlTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        for owner in self.song.tracks + self.song.return_tracks + [self.song.master_track]:
            owner.canonical_parent = self.song
            owner.devices = getattr(owner, 'devices', [])
            owner.mixer_device.canonical_parent = owner
            if owner is not self.song.master_track and not hasattr(owner.mixer_device, 'sends'):
                owner.mixer_device.sends = [Parameter() for _ in self.song.return_tracks]
            for device in owner.devices: self.attach(device, owner)
        self.device = self.song.tracks[0].devices[0]
        self.parameter = self.device.parameters[0]
        self.song.view.selected_parameter = self.parameter

    def attach(self, device, parent):
        device.canonical_parent = parent
        for parameter in device.parameters:
            parameter.canonical_parent = device
            parameter.automation_state = 0

    def read(self):
        return dispatch_request(self.song, {'method': 'get_selected_parameter_context', 'params': {}}, 4)

    def prepare(self, value=.6, **extra):
        selected = self.read()
        return dispatch_request(self.song, {'method': 'get_selected_parameter_edit_context', 'params': {
            'expectedSelectionToken': selected['selectionToken'], 'value': value, **extra}}, 4)

    def apply(self, source=None, value=.6, **extra):
        source = source or self.prepare(value, **extra)
        return dispatch_request(self.song, {'method': 'set_selected_parameter', 'params': {
            'expectedStateVersion': 4, 'expectedSelectionToken': source['selection']['selectionToken'],
            'value': value, 'before': source, **extra}}, 4)

    def test_read_resolves_current_parameter_without_changing_focus_or_value(self):
        before_track = self.song.view.selected_track
        result = self.read()
        self.assertEqual(result['status'], 'selected')
        self.assertEqual(result['target'], {'trackId': 'track-0', 'deviceId': 'track-0:device-0', 'parameterId': 'parameter-0'})
        self.assertEqual(result['control']['displayValue'], '400 Hz')
        self.assertEqual(self.read(), result)
        self.assertIs(self.song.view.selected_track, before_track)
        self.assertEqual(self.parameter.value, .4)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_raw_and_native_unit_edits_touch_only_selected_control_during_playback(self):
        self.song.is_playing = True
        other = self.device.parameters[1].value
        result = self.apply()
        self.assertTrue(result['verified'])
        self.assertTrue(result['selectionPreserved'])
        self.assertEqual(self.parameter.value, .6)
        self.assertEqual(self.device.parameters[1].value, other)
        self.assertTrue(self.song.is_playing)
        source = self.prepare(None, targetDisplay='500 Hz')
        result = self.apply(source, None, targetDisplay='500 Hz')
        self.assertTrue(result['verified'])
        self.assertEqual(self.parameter.str_for_value(self.parameter.value), '500 Hz')

    def test_nested_regular_and_return_chains_resolve_without_selected_track_assumption(self):
        for kind in ('chain', 'return-chain'):
            self.setUp()
            nested, chain = Device(), Chain('Layer', [])
            chain.devices = [nested]
            chain.canonical_parent = self.device
            self.device.can_have_chains = True
            self.device.chains = [chain] if kind == 'chain' else []
            self.device.return_chains = [chain] if kind == 'return-chain' else []
            self.attach(nested, chain)
            self.song.view.selected_track = self.song.tracks[1]
            self.song.view.selected_parameter = nested.parameters[1]
            target = self.read()['target']
            self.assertEqual(target, {'trackId': 'track-0', 'deviceId': f'track-0:device-0/{kind}-0/device-0', 'parameterId': 'parameter-1'})
            self.assertTrue(self.apply(value=2)['verified'])
            self.assertEqual(nested.parameters[1].value, 2)

    def test_return_and_main_devices_and_mixer_controls_resolve_exactly(self):
        for owner_id in ('return-0', 'master'):
            self.setUp()
            owner = self.song.return_tracks[0] if owner_id == 'return-0' else self.song.master_track
            device = Device()
            owner.devices = [device]
            self.attach(device, owner)
            self.song.view.selected_parameter = device.parameters[0]
            self.assertEqual(self.read()['target']['deviceId'], owner_id + ':device-0')
            parameter = Parameter()
            parameter.automation_state = 0
            parameter.canonical_parent = owner.mixer_device
            owner.mixer_device.volume = parameter
            self.song.view.selected_parameter = parameter
            result = self.read()
            self.assertEqual(result['target'], {'trackId': owner_id, 'parameterId': 'volume'})
            self.assertTrue(self.apply()['verified'])

    def test_same_version_selection_content_and_native_identity_changes_refuse(self):
        for kind in ('selection', 'value', 'identity'):
            self.setUp()
            source = self.prepare()
            if kind == 'selection': self.song.view.selected_parameter = self.device.parameters[1]
            elif kind == 'value': self.parameter.value = .7
            else:
                replacement = copy.deepcopy(self.device)
                self.song.tracks[0].devices[0] = replacement
                self.attach(replacement, self.song.tracks[0])
                self.song.view.selected_parameter = replacement.parameters[0]
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.apply(source)
            self.assertNotEqual(self.parameter.value, .6)

    def test_selection_change_at_undo_entry_refuses_before_value_write(self):
        source = self.prepare()
        begin = self.song.begin_undo_step
        def changed():
            begin()
            self.song.view.selected_parameter = self.device.parameters[1]
        self.song.begin_undo_step = changed
        with self.assertRaises(ValueError): self.apply(source)
        self.assertEqual(self.parameter.value, .4)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_active_or_unknown_automation_and_unsafe_edit_state_refuse(self):
        for state in (1, None, 9):
            self.parameter.automation_state = state
            with self.subTest(state=state), self.assertRaises(ValueError): self.prepare()
        self.parameter.automation_state = 2
        self.assertTrue(self.apply()['verified'])
        for owner, key in ((self.song, 'record_mode'), (self.song, 'session_record'), (self.song, 'is_counting_in'),
                           (self.song.tracks[0], 'is_frozen'), (self.parameter, 'is_enabled')):
            previous = getattr(owner, key)
            setattr(owner, key, None)
            with self.subTest(key=key), self.assertRaises(ValueError): self.prepare()
            setattr(owner, key, previous)

    def test_none_unavailable_and_unresolved_selection_are_distinct(self):
        self.song.view.selected_parameter = None
        self.assertEqual(self.read()['status'], 'none')
        del self.song.view.selected_parameter
        self.assertEqual(self.read()['status'], 'unavailable')
        hidden = Parameter()
        hidden.canonical_parent = self.device
        self.song.view.selected_parameter = hidden
        result = self.read()
        self.assertEqual(result['status'], 'unresolved')
        self.assertIsNone(result['target'])
        self.assertIsNone(result['selectionToken'])

    def test_invalid_raw_display_and_quantized_targets_refuse_without_writes(self):
        for value, extra in ((True, {}), (float('nan'), {}), (2, {}), (None, {'targetDisplay': '-inf dB'}),
                             (.6, {'targetDisplay': '500 Hz'})):
            with self.subTest(value=value, extra=extra), self.assertRaises(ValueError): self.prepare(value, **extra)
            self.assertEqual(self.parameter.value, .4)
        self.song.view.selected_parameter = self.device.parameters[1]
        with self.assertRaises(ValueError): self.prepare(1.5)
        with self.assertRaises(ValueError): self.prepare(None, targetDisplay='500 Hz')

    def test_post_write_finalization_failure_reports_observed_value_without_replay(self):
        def fail(): raise RuntimeError('undo close failed')
        self.song.end_undo_step = fail
        result = self.apply()
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertEqual(result['observed']['controls'][0]['value'], .6)
        self.assertIn('undo close failed', result['error'])
        self.assertEqual(self.parameter.value, .6)

    def test_bad_or_cyclic_ancestry_and_ambiguous_membership_never_guess(self):
        self.parameter.canonical_parent = SimpleNamespace(canonical_parent=None)
        self.assertEqual(self.read()['status'], 'unresolved')
        self.parameter.canonical_parent = self.device
        self.device.canonical_parent = self.device
        self.assertEqual(self.read()['status'], 'unresolved')
        self.device.canonical_parent = self.song.tracks[0]
        self.device.parameters.append(self.parameter)
        self.assertEqual(self.read()['status'], 'unresolved')

    def test_quantized_choices_are_read_from_native_formatter(self):
        self.song.view.selected_parameter = self.device.parameters[1]
        self.assertEqual(self.read()['control']['nativeChoiceLabels'], [
            {'value': 0, 'displayValue': 'Low-pass'}, {'value': 1, 'displayValue': 'Band-pass'},
            {'value': 2, 'displayValue': 'High-pass'}])

    def test_partial_write_selection_change_and_failed_observation_never_report_success(self):
        for mode in ('raise', 'selection', 'readback', 'noop'):
            self.setUp()
            song, other = self.song, self.device.parameters[1]
            class Changed(Parameter):
                mode = None
                @property
                def value(self):
                    if getattr(self, 'unreadable', False): raise RuntimeError('value read failed')
                    return self._value
                @value.setter
                def value(self, value):
                    if self.mode == 'noop': return
                    self._value = value
                    if self.mode == 'raise': raise RuntimeError('native write interrupted')
                    if self.mode == 'selection': song.view.selected_parameter = other
                    if self.mode == 'readback': self.unreadable = True
            parameter = Changed()
            self.device.parameters[0] = parameter
            self.attach(self.device, self.song.tracks[0])
            self.song.view.selected_parameter = parameter
            source = self.prepare()
            parameter.mode = mode
            result = self.apply(source)
            self.assertFalse(result['verified'])
            if mode == 'raise':
                self.assertFalse(result['nativeReturned'])
                self.assertEqual(result['observed']['controls'][0]['value'], .6)
            elif mode == 'selection': self.assertFalse(result['selectionPreserved'])
            elif mode == 'readback': self.assertFalse(result['observed']['controls'][0]['supported'])
            else: self.assertEqual(parameter.value, .4)

    def test_inactive_pan_mode_refuses_without_changing_mode(self):
        mixer = self.song.tracks[0].mixer_device
        mixer.panning = self.parameter
        self.parameter.canonical_parent = mixer
        mixer.panning_mode = 1
        self.assertEqual(self.read()['target'], {'trackId': 'track-0', 'parameterId': 'pan'})
        with self.assertRaises(ValueError): self.prepare()
        self.assertEqual(mixer.panning_mode, 1)
        self.assertEqual(self.parameter.value, .4)

    def test_unavailable_rack_ancestry_property_reports_unresolved(self):
        class UnavailableRack(Device):
            @property
            def return_chains(self): raise RuntimeError('return chains unavailable')
        rack, nested = UnavailableRack(), Device()
        chain = Chain('Layer', [nested])
        rack.can_have_chains, rack.chains = True, [chain]
        self.song.tracks[0].devices = [rack]
        self.attach(rack, self.song.tracks[0])
        chain.canonical_parent = rack
        self.attach(nested, chain)
        self.song.view.selected_parameter = nested.parameters[0]
        self.assertEqual(self.read()['status'], 'unresolved')
