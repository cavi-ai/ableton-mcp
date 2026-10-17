import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, DrumRack, Parameter, Chain, Device


class RackPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.rack = DrumRack()
        self.rack.visible_macro_count = 2
        self.rack.variation_count = 2
        self.rack.selected_variation_index = 1
        self.rack.has_macro_mappings = True
        self.rack.parameters = [Parameter(), Parameter(), Parameter()]
        for i, parameter in enumerate(self.rack.parameters[1:]):
            parameter.original_name = 'Macro %s' % (i + 1)
            parameter.name = 'Brightness' if i == 0 else 'Space'
        self.target = self.rack.chains[0].devices[0].parameters[0]
        self.target.automation_state = 1
        self.rack.macro_mappings = [SimpleNamespace(
            index=0, parameter=self.target, path='Kick/Cutoff', mapping_min=0.1,
            mapping_max=0.9, mapping_min_string='100 Hz', mapping_max_string='900 Hz')]
        self.song.tracks[0].devices = [self.rack]

    def read(self, track_id='track-0', device_id='track-0:device-0'):
        return dispatch_request(self.song, {'method': 'get_rack_performance_context',
                                          'params': {'trackId': track_id, 'deviceId': device_id}}, 3)

    def test_macro_controls_link_native_ids_values_and_automation_without_writes(self):
        before = copy.deepcopy(self.rack.__dict__)
        result = self.read()
        self.assertEqual(result['stateVersion'], 3)
        self.assertTrue(result['macroLayoutKnown'])
        self.assertEqual(result['macros'][0]['parameter']['id'], 'parameter-1')
        self.assertEqual(result['macros'][0]['parameter']['name'], 'Brightness')
        self.assertEqual(result['variations'], {'count': 2, 'selectedIndex': 1, 'contentsAvailable': False})
        mapping = result['mappings'][0]
        self.assertEqual(mapping['target']['deviceId'], 'track-0:device-0/chain-0/device-0')
        self.assertEqual(mapping['target']['parameter']['id'], 'parameter-0')
        self.assertEqual(mapping['target']['parameter']['automationState'], {'value': 1, 'name': 'playing'})
        self.assertEqual(mapping['target']['parameter']['value'], self.target.value)
        self.assertEqual(mapping['minDisplay'], '100 Hz')
        self.assertEqual(self.rack.parameters[1].value, before['parameters'][1].value)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_duplicate_names_resolve_by_native_parameter_object(self):
        self.rack.chains.append(Chain('Kick', [Device()]))
        self.assertEqual(self.read()['mappings'][0]['target']['deviceId'],
                         'track-0:device-0/chain-0/device-0')

    def test_nested_rack_return_targets_have_exact_return_chain_ids(self):
        child = DrumRack()
        child.return_chains = [Chain('Reverb', [Device()])]
        self.rack.chains[0].devices = [child]
        self.rack.macro_mappings[0].parameter = child.return_chains[0].devices[0].parameters[1]
        mapping = self.read()['mappings'][0]
        self.assertEqual(mapping['target']['deviceId'],
                         'track-0:device-0/chain-0/device-0/return-chain-0/device-0')

    def test_missing_and_ambiguous_target_objects_are_not_guessed(self):
        self.rack.macro_mappings[0].parameter = Parameter()
        self.assertEqual(self.read()['mappings'][0]['resolution'], 'unresolved')
        self.assertIsNone(self.read()['mappings'][0]['target'])
        self.rack.macro_mappings[0].parameter = self.target
        self.rack.chains.append(Chain('Duplicate object', [self.rack.chains[0].devices[0]]))
        self.assertEqual(self.read()['mappings'][0]['resolution'], 'ambiguous')

    def test_unknown_macro_layout_and_unavailable_mappings_are_explicit(self):
        self.rack.parameters[1].original_name = 'Unknown'
        del self.rack.macro_mappings
        result = self.read()
        self.assertFalse(result['macroLayoutKnown'])
        self.assertEqual(result['macros'], [])
        self.assertFalse(result['mappingTargetsAvailable'])
        self.assertIsNone(result['mappings'])

    def test_mapped_rack_with_unavailable_targets_can_still_report_performance_support(self):
        del self.rack.macro_mappings
        self.rack.store_variation = lambda: None
        self.rack.recall_selected_variation = lambda: None
        result = self.read()
        self.assertTrue(result['hasMappings'])
        self.assertFalse(result['mappingTargetsAvailable'])
        self.assertFalse(result['operations']['mapTargets'])
        self.assertTrue(result['operations']['storeVariation'])
        self.assertTrue(result['operations']['recallVariation'])
        self.assertEqual(len(result['macros']), 2)

    def test_return_and_main_racks_use_the_observed_owner(self):
        for owner_id, owner in [('return-0', self.song.return_tracks[0]), ('master', self.song.master_track)]:
            owner.devices = [self.rack]
            owner.name = owner_id
            result = self.read(owner_id, owner_id + ':device-0')
            self.assertEqual(result['trackId'], owner_id)
            self.assertTrue(result['mappings'][0]['target']['deviceId'].startswith(owner_id + ':'))

    def test_non_rack_and_excessive_hierarchy_fail_closed(self):
        self.song.tracks[0].devices = [Device()]
        with self.assertRaisesRegex(ValueError, 'rack'):
            self.read()
        self.song.tracks[0].devices = [self.rack]
        self.rack.chains = [Chain('Large', [Device() for _ in range(513)])]
        with self.assertRaisesRegex(ValueError, 'limit'):
            self.read()

    def test_reads_observe_manual_edits_instead_of_cached_state(self):
        self.assertEqual(self.read()['macros'][0]['parameter']['value'], 0.4)
        self.rack.parameters[1].value = 0.7
        self.target.value = 0.8
        result = self.read()
        self.assertEqual(result['macros'][0]['parameter']['value'], 0.7)
        self.assertEqual(result['mappings'][0]['target']['parameter']['value'], 0.8)
