import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class RecordingSetupTests(unittest.TestCase):
    def test_source_binds_native_document_and_readiness_without_writes(self):
        song = Song()
        source = dispatch_request(song, {'method': 'get_recording_setup_source'}, 4)
        self.assertEqual(source['filePath'], song.file_path)
        self.assertTrue(source['identityToken'])
        self.assertFalse(song.metronome)
        self.assertFalse(source['recording']['arrangement'])
        self.assertEqual(source['transport']['countInDuration']['value'], 1)

    def test_read_only_count_in_refuses_before_changing_metronome(self):
        song = Song()
        with self.assertRaisesRegex(ValueError, 'native UI'):
            dispatch_request(song, {'method': 'set_transport_context', 'params': {'changes': {
                'metronome': {'value': True}, 'countInDuration': {'value': 2}}}}, 4)
        self.assertFalse(song.metronome)
