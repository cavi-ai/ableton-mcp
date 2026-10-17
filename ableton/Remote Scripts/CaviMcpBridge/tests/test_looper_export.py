import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class LooperExportTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.has_audio_input = True
        self.track.has_midi_input = False
        self.track.arm = False
        self.track.fired_slot_index = -1
        self.device = self.track.devices[0]
        self.device.class_name = 'Looper'
        self.device.loop_length = 8.0
        self.device.tempo = 120.0
        self.device.parameters[0].original_name = 'State'
        self.device.parameters[0].is_quantized = True
        self.device.parameters[0].value_items = ['Stop', 'Record', 'Play', 'Overdub']
        self.device.parameters[0].value = 0
        self.device.parameters[0].min = 0
        self.device.parameters[0].max = 3
        self.calls = []
        def export(slot):
            self.calls.append(slot)
            slot.has_clip = True
            slot.clip = AudioClip()
            slot.clip.file_path = '/recorded/loop.wav'
        self.device.export_to_clip_slot = export
        self.args = {'trackId': 'track-0', 'deviceId': 'track-0:device-0',
                     'destinationTrackId': 'track-0', 'destinationClipId': 'track-0:clip-1'}

    def context(self):
        return dispatch_request(self.song, {'method': 'get_looper_export_context', 'params': self.args}, 3)

    def export(self, before):
        return dispatch_request(self.song, {'method': 'export_looper_clip', 'params': {
            **self.args, 'expectedStateVersion': 3, 'before': before, 'name': 'Kept loop'}}, 3)

    def test_inert_context_and_export_create_named_audio_clip_without_clearing_buffer(self):
        before = self.context()
        self.assertTrue(before['canExport'])
        self.assertEqual(before['loopLength'], 8)
        self.assertEqual(self.calls, [])
        result = self.export(before)
        self.assertTrue(result['exportRequested'])
        self.assertTrue(result['clipCreatedVerified'])
        self.assertFalse(result['bufferContentVerified'])
        self.assertEqual(self.track.clip_slots[1].clip.name, 'Kept loop')
        self.assertEqual(self.device.loop_length, 8)

    def test_native_replacement_and_manual_edits_invalidate_confirmation(self):
        for change in [lambda: setattr(self.device, 'loop_length', 4),
                       lambda: self.track.devices.__setitem__(0, copy.copy(self.device)),
                       lambda: self.track.clip_slots.__setitem__(1, copy.copy(self.track.clip_slots[1])),
                       lambda: setattr(self.device.parameters[0], 'value', 2)]:
            self.setUp()
            before = self.context()
            change()
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.export(before)
            self.assertEqual(self.calls, [])

    def test_unavailable_empty_recording_frozen_armed_and_occupied_targets_refuse(self):
        changes = [lambda: setattr(self.device, 'export_to_clip_slot', None),
                   lambda: setattr(self.device, 'loop_length', 0),
                   lambda: setattr(self.device.parameters[0], 'value', 1),
                   lambda: setattr(self.device.parameters[0], 'value', 3),
                   lambda: setattr(self.song, 'record_mode', True),
                   lambda: setattr(self.song, 'session_record', True),
                   lambda: setattr(self.track, 'is_frozen', True),
                   lambda: setattr(self.track, 'arm', True),
                   lambda: setattr(self.track, 'fired_slot_index', 1),
                   lambda: setattr(self.track.clip_slots[1], 'has_clip', True)]
        for change in changes:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.export(self.context())
            self.assertEqual(self.calls, [])

    def test_partial_native_failure_retains_created_material_without_retry(self):
        original = self.device.export_to_clip_slot
        def broken(slot):
            original(slot)
            raise RuntimeError('native export failed')
        self.device.export_to_clip_slot = broken
        result = self.export(self.context())
        self.assertTrue(result['exportRequested'])
        self.assertFalse(result['clipCreatedVerified'])
        self.assertIn('inspect', result['verificationError'])
        self.assertTrue(self.track.clip_slots[1].has_clip)
        self.assertEqual(len(self.calls), 1)

    def test_missing_native_export_or_length_is_reported_without_fabricated_support(self):
        del self.device.loop_length
        context = self.context()
        self.assertIsNone(context['loopLength'])
        self.assertFalse(context['canExport'])


if __name__ == '__main__':
    unittest.main()
