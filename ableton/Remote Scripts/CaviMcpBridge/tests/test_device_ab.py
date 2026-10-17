import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Device, NestedDevice, Chain


class CompareDevice(Device):
    def __init__(self):
        super().__init__()
        self.can_compare_ab = True
        self._using_b = False
        self.copy_calls = 0
        for parameter in self.parameters:
            parameter.automation_state = 0
        self.slots = [copy.deepcopy(self.parameters), copy.deepcopy(self.parameters)]
        self.slots[1][0].value = .8

    @property
    def is_using_compare_preset_b(self):
        return self._using_b

    @is_using_compare_preset_b.setter
    def is_using_compare_preset_b(self, value):
        self.slots[int(self._using_b)] = copy.deepcopy(self.parameters)
        self._using_b = value
        self.parameters = copy.deepcopy(self.slots[int(value)])

    def save_preset_to_compare_ab_slot(self):
        self.copy_calls += 1
        self.slots[int(not self._using_b)] = copy.deepcopy(self.parameters)


class DeviceABTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.device = CompareDevice()
        self.song.tracks[0].devices = [self.device]
        self.target = {'trackId': 'track-0', 'deviceId': 'track-0:device-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_device_ab_context', 'params': self.target}, 3)

    def apply(self, method, before=None, **args):
        return dispatch_request(self.song, {'method': method, 'params': {
            **self.target, **args, 'expectedStateVersion': 3, 'before': before or self.read()}}, 3)

    def test_read_is_observational_and_unsupported_devices_do_not_read_slot_properties(self):
        before = self.read()
        self.assertTrue(before['supported'])
        self.assertEqual(before['activeSlot'], 'A')
        self.assertFalse(before['otherSlotContentsAvailable'])
        self.assertEqual(self.device.copy_calls, 0)
        self.assertEqual(self.song.undo_boundaries, [])
        self.device.can_compare_ab = False
        result = self.read()
        self.assertFalse(result['supported'])
        self.assertIsNone(result['activeSlot'])

    def test_copy_requires_explicit_overwrite_and_does_not_claim_hidden_slot_verification(self):
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            self.apply('copy_device_ab_slot')
        self.assertEqual(self.device.copy_calls, 0)
        result = self.apply('copy_device_ab_slot', overwriteOtherSlot=True)
        self.assertTrue(result['copyRequested'])
        self.assertFalse(result['copyVerified'])
        self.assertTrue(result['observedCurrentStatePreserved'])
        self.assertEqual(self.device.copy_calls, 1)
        self.assertEqual(self.device.slots[1][0].value, .4)

    def test_selection_accepts_native_parameter_rebinding_and_reads_actual_slot_during_playback(self):
        self.song.is_playing = True
        original = self.device.parameters[0]
        result = self.apply('select_device_ab_slot', targetSlot='B')
        self.assertTrue(result['slotVerified'])
        self.assertEqual(result['after']['activeSlot'], 'B')
        self.assertEqual(result['after']['parameters'][0]['value'], .8)
        self.assertIsNot(self.device.parameters[0], original)
        self.assertTrue(self.song.is_playing)

    def test_manual_edits_and_equal_looking_device_replacements_invalidate(self):
        before = self.read()
        self.device.parameters[0].value = .6
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.apply('select_device_ab_slot', before, targetSlot='B')
        self.assertFalse(self.device.is_using_compare_preset_b)
        before = self.read()
        self.song.tracks[0].devices[0] = copy.deepcopy(self.device)
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.apply('copy_device_ab_slot', before, overwriteOtherSlot=True)
        self.assertEqual(self.device.copy_calls, 0)

    def test_recording_frozen_automation_and_unsupported_operations_are_refused(self):
        changes = [lambda: setattr(self.song, 'record_mode', True),
                   lambda: setattr(self.song, 'session_record', True),
                   lambda: setattr(self.song.tracks[0], 'is_frozen', True),
                   lambda: setattr(self.device.parameters[0], 'automation_state', 1),
                   lambda: setattr(self.device.parameters[0], 'automation_state', None),
                   lambda: setattr(self.device, 'can_compare_ab', False)]
        for change in changes:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.apply('select_device_ab_slot', targetSlot='B')
            self.assertFalse(self.device.is_using_compare_preset_b)

    def test_uncertain_native_copy_preserves_partial_state_and_reports_unverified(self):
        def failed_copy():
            self.device.copy_calls += 1
            raise RuntimeError('native copy failed after request')
        self.device.save_preset_to_compare_ab_slot = failed_copy
        result = self.apply('copy_device_ab_slot', overwriteOtherSlot=True)
        self.assertTrue(result['copyRequested'])
        self.assertFalse(result['copyVerified'])
        self.assertIn('native copy failed', result['verificationError'])
        self.assertEqual(self.device.copy_calls, 1)

    def nested(self):
        self.rack = NestedDevice('Rack', 'InstrumentGroupDevice')
        self.rack.can_have_chains = True
        self.rack.chains = [Chain('First', [self.device])]
        self.song.tracks[0].devices = [self.rack]
        self.target['deviceId'] = 'track-0:device-0/chain-0/device-0'

    def test_replaced_nested_container_invalidates_even_with_the_same_device_and_parameters(self):
        self.nested()
        before = self.read()
        self.rack.chains[0] = Chain('First', [self.device])
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.apply('select_device_ab_slot', before, targetSlot='B')
        self.assertFalse(self.device.is_using_compare_preset_b)

    def test_container_replacement_during_native_copy_leaves_an_unverified_receipt(self):
        self.nested()
        def copy_and_replace():
            self.device.copy_calls += 1
            self.rack.chains[0] = Chain('First', [self.device])
        self.device.save_preset_to_compare_ab_slot = copy_and_replace
        result = self.apply('copy_device_ab_slot', overwriteOtherSlot=True)
        self.assertIn('ownership changed', result.get('verificationError', ''))
        self.assertFalse(result.get('observedCurrentStatePreserved', False))
