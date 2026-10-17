import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class AudioExportTests(unittest.TestCase):
    def source(self, song):
        return dispatch_request(song, {"method": "get_audio_export_source", "params": {}}, 3)

    def test_context_is_inert_and_binds_native_document_and_mix_controls(self):
        song = Song()
        before = self.source(song)
        self.assertEqual(before, self.source(song))
        song.tracks[0].mute = not song.tracks[0].mute
        self.assertNotEqual(before, self.source(song))
        self.assertNotEqual(before["identityToken"], self.source(Song())["identityToken"])

    def test_selected_routing_and_monitoring_changes_invalidate_the_context(self):
        for change in [lambda s: setattr(s.tracks[0], "current_output_routing", "No Output"),
                       lambda s: setattr(s.tracks[0], "current_monitoring_state", 2)]:
            song = Song()
            before = self.source(song)
            change(song)
            self.assertNotEqual(before, self.source(song))

    def test_playing_recording_arms_and_pending_launches_refuse(self):
        for change in [lambda s: setattr(s, "is_playing", True), lambda s: setattr(s, "record_mode", True),
                       lambda s: setattr(s.tracks[0], "arm", True), lambda s: setattr(s.tracks[0], "fired_slot_index", 0)]:
            song = Song()
            change(song)
            with self.assertRaises(ValueError):
                self.source(song)


if __name__ == "__main__":
    unittest.main()
