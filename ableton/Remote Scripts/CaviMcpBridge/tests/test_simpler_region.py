import copy
import unittest
import test_simpler_sample
from bridge import dispatch_request
from test_simpler_sample import Sample
from test_dispatch import Device, DrumRack


class BoundedSample(Sample):
    def __init__(self, original):
        self.__dict__.update(original.__dict__)
        self.edits, self.fail_end = [], False
        self.after_edit = None

    def __setattr__(self, name, value):
        if name in ('start_marker', 'end_marker'):
            if name == 'end_marker' and self.fail_end:
                raise RuntimeError('native setter failed')
            start = value if name == 'start_marker' else self.start_marker
            end = value if name == 'end_marker' else self.end_marker
            if not 0 <= start < end < self.length:
                raise ValueError('crossing marker assignment')
            self.edits.append((name, value))
        super().__setattr__(name, value)
        if name in ('start_marker', 'end_marker') and self.after_edit:
            self.after_edit(name)


class SimplerRegionTests(unittest.TestCase):
    def setUp(self):
        fixture = test_simpler_sample.SimplerSampleTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.load()
        self.song, self.device, self.params = fixture.song, fixture.device, fixture.params
        self.device.sample.end_marker = 47999
        self.device.sample = BoundedSample(self.device.sample)
        self.song.undo_boundaries.clear()

    def read(self):
        return dispatch_request(self.song, {'method': 'get_simpler_sample_state', 'params': self.params}, 4)

    def edit(self, before=None, **extra):
        return dispatch_request(self.song, {'method': 'set_simpler_sample_region', 'params': {
            **self.params, 'expectedStateVersion': 4, 'before': self.read() if before is None else before,
            'region': {'startMarkerFrames': 12000, 'endMarkerFrames': 36000}, **extra}}, 4)

    def test_exact_frame_region_is_applied_without_replacing_sample_or_selection(self):
        sample, selected, before = self.device.sample, self.song.view.selected_track, self.read()
        receipt = self.edit()
        self.assertTrue(receipt['verified'])
        self.assertEqual(receipt['region'], {'startMarkerFrames': 12000, 'endMarkerFrames': 36000})
        self.assertEqual(receipt['sample']['path'], before['sample']['path'])
        self.assertIs(self.device.sample, sample)
        self.assertIs(self.song.view.selected_track, selected)
        self.assertEqual(self.device.calls, [sample.file_path])
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_disjoint_regions_move_the_outer_marker_first(self):
        self.device.sample.start_marker, self.device.sample.end_marker = 0, 10000
        self.device.sample.edits.clear()
        self.edit()
        self.assertEqual(self.device.sample.edits, [('end_marker', 36000), ('start_marker', 12000)])
        self.device.sample.edits.clear()
        self.edit(region={'startMarkerFrames': 0, 'endMarkerFrames': 6000})
        self.assertEqual(self.device.sample.edits, [('start_marker', 0), ('end_marker', 6000)])

    def test_same_object_manual_edit_or_owner_replacement_refuses_before_writing(self):
        for change in [lambda: setattr(self.device.sample, 'gain', .7),
                       lambda: setattr(self.device.sample, 'start_marker', 1),
                       lambda: setattr(self.device.sample, 'slicing_sensitivity', .9),
                       lambda: self.song.tracks[0].devices.__setitem__(0, copy.deepcopy(self.device)),
                       lambda: setattr(self.device, 'sample', copy.deepcopy(self.device.sample))]:
            self.setUp()
            before = self.read()
            change()
            self.device.sample.edits.clear()
            with self.assertRaisesRegex(ValueError, 'context changed'):
                self.edit(before)
            self.assertEqual(self.device.sample.edits, [])

    def test_invalid_noop_empty_and_active_regions_refuse_before_writing(self):
        for region in [{}, {'startMarkerFrames': 0, 'endMarkerFrames': 47999},
                       {'startMarkerFrames': True, 'endMarkerFrames': 10},
                       {'startMarkerFrames': -1, 'endMarkerFrames': 10},
                       {'startMarkerFrames': 20, 'endMarkerFrames': 10},
                       {'startMarkerFrames': 0, 'endMarkerFrames': 99999}]:
            with self.assertRaises(ValueError):
                self.edit(region=region)
        self.assertEqual(self.device.sample.edits, [])
        for change in [lambda: setattr(self.song, 'is_playing', True),
                       lambda: setattr(self.song, 'session_record', True),
                       lambda: setattr(self.song.tracks[0], 'arm', True),
                       lambda: setattr(self.song.tracks[0], 'current_monitoring_state', 0),
                       lambda: setattr(self.song.tracks[0], 'is_frozen', True),
                       lambda: setattr(self.song.tracks[0], 'fired_slot_index', 0),
                       lambda: setattr(self.device, 'multi_sample_mode', True),
                       lambda: setattr(self.device, 'sample', None)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.edit()

    def test_nested_device_and_sibling_preservation(self):
        rack, sibling = DrumRack(), Device()
        rack.chains[0].devices = [self.device, sibling]
        self.song.tracks[0].devices = [rack]
        self.params['deviceId'] = 'track-0:device-0/chain-0/device-0'
        self.assertTrue(self.edit()['verified'])
        self.assertIs(rack.chains[0].devices[1], sibling)

    def test_native_failure_reports_partial_region_without_global_undo(self):
        self.device.sample.fail_end = True
        with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
            self.edit()
        self.assertEqual(self.device.sample.start_marker, 12000)
        self.assertEqual(self.device.sample.end_marker, 47999)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_replaced_owner_during_first_setter_prevents_the_second_assignment(self):
        original = self.device.sample
        original.after_edit = lambda name: self.song.tracks[0].devices.__setitem__(0, Device())
        with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
            self.edit()
        self.assertEqual(original.edits, [('start_marker', 12000)])
        self.assertEqual(original.end_marker, 47999)

    def test_native_clamping_or_unexpected_warp_change_never_reports_verified(self):
        for kind in ('clamp', 'warp'):
            self.setUp()
            def change(name):
                if kind == 'clamp':
                    self.device.sample.__dict__['start_marker'] = 11999
                else:
                    self.device.sample.warping = True
            self.device.sample.after_edit = change
            with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
                self.edit()


if __name__ == '__main__':
    unittest.main()
