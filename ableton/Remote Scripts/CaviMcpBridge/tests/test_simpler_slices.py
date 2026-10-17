import copy
import unittest
import test_simpler_sample
from bridge import dispatch_request
from test_simpler_sample import Sample
from test_dispatch import Device, DrumRack


class SliceSample(Sample):
    def __init__(self, original):
        self.__dict__.update(original.__dict__)
        self.slices, self.edits, self.fail_at, self.after_edit = (0, 24000), [], None, None

    def clear_slices(self):
        self.slices = (self.start_marker,)
        self.edits.append(('clear',))
        if self.after_edit:
            self.after_edit()

    def insert_slice(self, frame):
        self.edits.append(('insert', frame))
        if frame == self.fail_at:
            raise RuntimeError('native slice insertion failed')
        self.slices = tuple(sorted(set((*self.slices, frame))))
        if self.after_edit:
            self.after_edit()


class SimplerSliceTests(unittest.TestCase):
    def setUp(self):
        fixture = test_simpler_sample.SimplerSampleTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.load()
        self.song, self.device, self.params = fixture.song, fixture.device, fixture.params
        self.device.sample = SliceSample(self.device.sample)
        self.device.pad_slicing = True
        self.song.undo_boundaries.clear()

    def read(self):
        return dispatch_request(self.song, {'method': 'get_simpler_sample_state', 'params': self.params}, 4)

    def edit(self, before=None, **extra):
        return dispatch_request(self.song, {'method': 'set_simpler_manual_slices', 'params': {
            **self.params, 'expectedStateVersion': 4, 'before': self.read() if before is None else before,
            'slicesFrames': [0, 12000, 36000], 'slicingPlaybackMode': 1, **extra}}, 4)

    def test_manual_layout_selects_slicing_and_disables_pad_slicing_without_reloading(self):
        original, selected = self.device.sample, self.song.view.selected_track
        result = self.edit()
        self.assertTrue(result['verified'])
        self.assertTrue(result['sampleIdentityRetained'])
        self.assertEqual(result['sample']['slicesFrames'], [0, 12000, 36000])
        self.assertEqual(result['playbackMode']['value'], 2)
        self.assertEqual(result['sample']['nativeControls']['slicing_style'], 3)
        self.assertEqual(result['nativeControls']['slicing_playback_mode'], 1)
        self.assertFalse(result['nativeControls']['pad_slicing'])
        self.assertIs(self.device.sample, original)
        self.assertEqual(self.device.calls, [original.file_path])
        self.assertIs(self.song.view.selected_track, selected)
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_invalid_layouts_and_unsupported_targets_refuse_before_any_edit(self):
        for frames in [[], [1000], [0, 0], [0, 36000, 12000], [0, -1], [0, True],
                       [0, 1.5], [0, 48000], list(range(65))]:
            with self.assertRaises(ValueError):
                self.edit(slicesFrames=frames)
            self.assertEqual(self.device.sample.edits, [])
            self.assertEqual(self.device.playback_mode, 1)
        for change in [lambda: setattr(self.song, 'is_playing', True),
                       lambda: setattr(self.song, 'session_record', True),
                       lambda: setattr(self.song.tracks[0], 'arm', True),
                       lambda: setattr(self.device, 'multi_sample_mode', True),
                       lambda: setattr(self.device.sample, 'insert_slice', None)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.edit()
            self.assertEqual(self.device.sample.edits, [])

    def test_manual_slice_or_parameter_edit_with_same_version_invalidates_plan(self):
        for change in [lambda: setattr(self.device.sample, 'slices', (0, 8000)),
                       lambda: setattr(self.device.sample, 'slicing_sensitivity', .2),
                       lambda: setattr(self.device.parameters[0], 'value', .8),
                       lambda: setattr(self.device, 'sample', copy.deepcopy(self.device.sample))]:
            self.setUp()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, 'context changed'):
                self.edit(before)
            self.assertEqual(self.device.sample.edits, [])

    def test_identical_manual_layout_is_not_cleared_again(self):
        self.edit()
        self.device.sample.edits.clear()
        with self.assertRaisesRegex(ValueError, 'unchanged'):
            self.edit()
        self.assertEqual(self.device.sample.edits, [])

    def test_partial_insert_or_owner_replacement_stops_without_rollback(self):
        self.device.sample.fail_at = 36000
        with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
            self.edit()
        self.assertEqual(self.device.sample.slices, (0, 12000))
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])
        self.setUp()
        original = self.device.sample
        original.after_edit = lambda: self.song.tracks[0].devices.__setitem__(0, Device())
        with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
            self.edit()
        self.assertEqual(original.edits, [('clear',)])

    def test_readback_clamping_and_unexpected_warp_edits_never_report_verified(self):
        for kind in ('clamp', 'warp'):
            self.setUp()
            def change():
                if kind == 'clamp':
                    self.device.sample.slices = (0,)
                else:
                    self.device.sample.warping = True
            self.device.sample.after_edit = change
            with self.assertRaisesRegex(RuntimeError, 'partial.*inspect'):
                self.edit()

    def test_nested_rack_slice_edit_preserves_siblings(self):
        rack, sibling = DrumRack(), Device()
        rack.chains[0].devices = [self.device, sibling]
        self.song.tracks[0].devices = [rack]
        self.params['deviceId'] = 'track-0:device-0/chain-0/device-0'
        self.assertTrue(self.edit()['verified'])
        self.assertIs(rack.chains[0].devices[1], sibling)


if __name__ == '__main__':
    unittest.main()
