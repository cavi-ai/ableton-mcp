import copy
import os
import sys
import tempfile
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Device, DrumRack


class Sample:
    def __init__(self, **values):
        self.__dict__.update(values)


class Simpler(Device):
    def __init__(self):
        super().__init__()
        self.name = self.class_display_name = 'Simpler'
        self.class_name = 'OriginalSimpler'
        self.sample, self.multi_sample_mode = None, False
        self.playback_mode, self.playing_position_enabled = 0, False
        self.pad_slicing, self.slicing_playback_mode, self.retrigger, self.voices = False, 0, True, 6
        self.calls, self.failure = [], None

    def replace_sample(self, path):
        self.calls.append(path)
        self.sample = Sample(file_path=path, length=48000, sample_rate=48000, start_marker=0,
                             end_marker=48000, gain=.5, warping=False, warp_mode=0, slices=(0, 24000),
                             slicing_style=0, slicing_sensitivity=.5, slicing_beat_division=4, slicing_region_count=8,
                             warp_markers=[Sample(sample_time=0, beat_time=0), Sample(sample_time=1, beat_time=2)])
        if self.failure == 'mismatch':
            self.sample.file_path = path + '.other'
        if self.failure == 'partial':
            raise RuntimeError('native import failed after changing sample')


class SimplerSampleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.join(self.directory.name, 'tone.wav')
        with open(self.path, 'wb') as file:
            file.write(b'fixture audio')
        self.song, self.device = Song(), Simpler()
        self.song.tracks[0].devices = [self.device]
        self.params = {'trackId': 'track-0', 'deviceId': 'track-0:device-0'}

    def read(self):
        return dispatch_request(self.song, {'method': 'get_simpler_sample_state', 'params': self.params}, 4)

    def load(self, before=None, **extra):
        info = os.stat(self.path)
        return dispatch_request(self.song, {'method': 'load_simpler_sample', 'params': {**self.params,
            'expectedStateVersion': 4, 'sourcePath': self.path,
            'sourceFile': {'size': str(info.st_size), 'mtimeNs': str(info.st_mtime_ns), 'device': str(info.st_dev), 'inode': str(info.st_ino)},
            'before': self.read() if before is None else before, 'allowReplace': False, 'playbackMode': 1, **extra}}, 4)

    def test_empty_read_and_native_load_report_frames_mode_and_preserve_other_state(self):
        selected = self.song.view.selected_track
        before = self.read()
        self.assertIsNone(before['sample'])
        self.assertEqual(self.device.calls, [])
        result = self.load(before)
        self.assertTrue(result['verified'])
        self.assertEqual(result['sample']['path'], self.path)
        self.assertEqual(result['sample']['lengthFrames'], 48000)
        self.assertEqual(result['sample']['slicesFrames'], [0, 24000])
        self.assertEqual(result['playbackMode'], {'value': 1, 'name': 'one-shot'})
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])
        self.assertIs(self.song.view.selected_track, selected)
        self.assertFalse(self.song.is_playing)

    def test_existing_sample_requires_explicit_replacement(self):
        self.load()
        with self.assertRaisesRegex(ValueError, 'allowReplace'):
            self.load()
        self.load(allowReplace=True)
        self.assertEqual(self.device.calls, [self.path, self.path])

    def test_same_metadata_device_sample_parameter_or_document_replacement_refuses(self):
        for change in [lambda: self.song.tracks[0].devices.__setitem__(0, copy.deepcopy(self.device)),
                       lambda: self.device.parameters.__setitem__(0, copy.deepcopy(self.device.parameters[0])),
                       lambda: setattr(self.device, 'sample', copy.deepcopy(self.device.sample)),
                       lambda: setattr(self, 'song', copy.deepcopy(self.song))]:
            self.setUp()
            self.load()
            self.device.calls.clear()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, 'context changed'):
                self.load(before, allowReplace=True)
            self.assertEqual(self.device.calls, [])

    def test_nested_simpler_resolves_exact_drum_chain_and_preserves_siblings(self):
        rack = DrumRack()
        rack.chains[0].devices = [self.device, Device()]
        self.song.tracks[0].devices = [rack]
        self.params['deviceId'] = 'track-0:device-0/chain-0/device-0'
        sibling = rack.chains[0].devices[1]
        self.assertTrue(self.load()['verified'])
        self.assertIs(rack.chains[0].devices[1], sibling)

    def test_same_object_warp_and_slicing_edits_invalidate_confirmation(self):
        for change in [lambda: setattr(self.device.sample, 'slicing_sensitivity', .9),
                       lambda: setattr(self.device.sample, 'slicing_style', 2),
                       lambda: setattr(self.device.sample, 'slicing_beat_division', 6),
                       lambda: setattr(self.device.sample, 'slicing_region_count', 16),
                       lambda: setattr(self.device.sample.warp_markers[1], 'beat_time', 4),
                       lambda: setattr(self.device.sample, 'texture_flux', 10),
                       lambda: setattr(self.device, 'pad_slicing', True),
                       lambda: setattr(self.device, 'slicing_playback_mode', 1)]:
            self.setUp()
            self.load()
            self.device.calls.clear()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, 'context changed'):
                self.load(before, allowReplace=True)
            self.assertEqual(self.device.calls, [])

    def test_unsupported_frozen_recording_and_active_targets_refuse_without_import(self):
        for change in [lambda: setattr(self.device, 'multi_sample_mode', True),
                       lambda: setattr(self.device, 'class_name', 'MultiSampler'),
                       lambda: setattr(self.song.tracks[0], 'is_frozen', True),
                       lambda: setattr(self.song.tracks[0], 'arm', True),
                       lambda: setattr(self.song.tracks[0], 'current_monitoring_state', 0),
                       lambda: setattr(self.song.tracks[0], 'fired_slot_index', 0),
                       lambda: setattr(self.song, 'is_playing', True),
                       lambda: setattr(self.song, 'record_mode', True),
                       lambda: setattr(self.song, 'session_record', True),
                       lambda: setattr(self.device, 'playing_position_enabled', True)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.load()
            self.assertEqual(self.device.calls, [])

    def test_changed_file_metadata_and_invalid_arguments_refuse_before_import(self):
        for extra in [{'sourceFile': {}}, {'sourcePath': 'relative.wav'}, {'playbackMode': 3},
                      {'allowReplace': 1}, {'expectedStateVersion': True}, {'before': {}}]:
            with self.assertRaises(ValueError):
                self.load(**extra)
            self.assertEqual(self.device.calls, [])

    def test_partial_import_or_readback_failure_is_explicit_and_never_claims_rollback(self):
        for mode in ['partial', 'mismatch']:
            self.setUp()
            self.device.failure = mode
            with self.assertRaisesRegex(RuntimeError, 'inspect.*before.*retry|inspect.*before.*retrying'):
                self.load()
            self.assertEqual(self.device.calls, [self.path])
            self.assertIsNotNone(self.device.sample)
            self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])


if __name__ == '__main__':
    unittest.main()
