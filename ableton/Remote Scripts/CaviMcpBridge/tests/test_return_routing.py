import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request


class ReturnRoutingTests(unittest.TestCase):
    def setUp(self):
        self.bus = SimpleNamespace(name='C-Room', output_routing_type='Main', output_routing_channel='',
                                   available_output_routing_types=['Main', 'Ext. Out'],
                                   available_output_routing_channels=[''])
        self.song = SimpleNamespace(return_tracks=[self.bus], tracks=[], scenes=[], tempo=120, master_track=object())

    def read(self, return_id='return-0'):
        return dispatch_request(self.song, {'method': 'get_return_routing',
                                'params': {'returnTrackId': return_id}}, 7)

    def test_reads_exact_return_destination_without_writes(self):
        before = copy.deepcopy(vars(self.bus))
        result = self.read()
        self.assertEqual(result['stateVersion'], 7)
        self.assertEqual(result['returnTrackId'], 'return-0')
        self.assertEqual(result['name'], 'C-Room')
        self.assertTrue(result['output']['supported'])
        self.assertEqual(result['output']['type'], {'id': 'Main', 'name': 'Main'})
        self.assertEqual(result['output']['channel'], {'id': '', 'name': ''})
        self.assertEqual([row['id'] for row in result['output']['availableTypes']], ['Main', 'Ext. Out'])
        self.assertEqual(vars(self.bus), before)

    def test_missing_native_properties_are_explicitly_unavailable(self):
        del self.bus.output_routing_channel
        output = self.read()['output']
        self.assertFalse(output['supported'])
        self.assertIsNone(output['type'])
        self.assertIsNone(output['channel'])
        self.assertEqual(output['availableTypes'], [])

    def test_refuses_noncanonical_wrong_owner_and_missing_return(self):
        for return_id in ('return-00', 'return-1', 'return--1', 'return-١', 'track-0', 'master', None):
            with self.subTest(return_id=return_id), self.assertRaises(ValueError):
                self.read(return_id)

    def test_refuses_excessive_choices_without_partial_results(self):
        self.bus.available_output_routing_types = ['Main'] * 513
        with self.assertRaisesRegex(ValueError, '512'):
            self.read()


if __name__ == '__main__':
    unittest.main()
