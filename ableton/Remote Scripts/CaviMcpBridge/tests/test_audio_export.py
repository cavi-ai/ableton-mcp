import os
import sys
import unittest
import copy

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class AudioExportTests(unittest.TestCase):
    def test_render_targets_keep_native_order_names_and_known_audio_output(self):
        song = Song()
        song.tracks[0].name = song.tracks[1].name = 'Same part'
        song.tracks[0].has_audio_output = True
        song.tracks[1].has_audio_output = False
        song.return_tracks[0].has_audio_output = True
        before = self.source(song)
        self.assertEqual(before['renderTargets'], [
            {'trackId': 'track-0', 'name': 'Same part', 'hasAudioOutput': True},
            {'trackId': 'track-1', 'name': 'Same part', 'hasAudioOutput': False},
            {'trackId': 'return-0', 'name': song.return_tracks[0].name, 'hasAudioOutput': True}])
        song.tracks[1].has_audio_output = True
        self.assertNotEqual(before, self.source(song))
        song.tracks[1].has_audio_output = None
        self.assertIsNone(self.source(song)['renderTargets'][1]['hasAudioOutput'])
        self.assertEqual(song.undo_boundaries, [])

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

    def test_crossfader_track_group_and_return_membership_changes_bind_at_the_same_version(self):
        song = Song()
        song.tracks[1].is_foldable = True
        song.tracks[1].fold_state = 0
        song.tracks[0].is_grouped = True
        song.tracks[0].group_track = song.tracks[1]
        for track in [*song.tracks, *song.return_tracks]:
            track.mixer_device.crossfade_assign = 1
        for track in [*song.tracks, *song.return_tracks]:
            before = self.source(song)
            track.mixer_device.crossfade_assign = 0
            after = self.source(song)
            self.assertEqual(before['stateVersion'], after['stateVersion'])
            self.assertNotEqual(before, after)
        rows = after['crossfader']['tracks']
        self.assertEqual(rows[0]['groupTrackId'], 'track-1')
        self.assertTrue(rows[1]['isGroup'])
        self.assertEqual(rows[2]['trackId'], 'return-0')

    def test_same_valued_native_mixers_and_main_parameter_replacements_change_export_identity(self):
        for target in ('track', 'return', 'main', 'parameter'):
            song = Song()
            before = self.source(song)
            if target == 'parameter':
                mixer = song.master_track.mixer_device
                mixer.crossfader = copy.deepcopy(mixer.crossfader)
            else:
                track = {'track': song.tracks[0], 'return': song.return_tracks[0], 'main': song.master_track}[target]
                track.mixer_device = copy.deepcopy(track.mixer_device)
            after = self.source(song)
            self.assertEqual(before['stateVersion'], after['stateVersion'])
            self.assertNotEqual(before, after)
            self.assertNotEqual(before['crossfader']['identityToken'], after['crossfader']['identityToken'])

    def test_crossfader_automation_and_availability_are_observed_without_write_requirements(self):
        song = Song()
        parameter = song.master_track.mixer_device.crossfader
        parameter.automation_state = 0
        parameter.is_enabled = True
        parameter.is_quantized = False
        before = self.source(song)
        parameter.automation_state = 1
        automated = self.source(song)
        self.assertNotEqual(before, automated)
        self.assertEqual(automated['crossfader']['position']['automationState']['value'], 1)
        self.assertEqual(automated, self.source(song))
        self.assertEqual(song.undo_boundaries, [])
        self.assertFalse(automated['crossfader']['tracks'][0]['assignment']['supported'])

    def test_playing_recording_arms_and_pending_launches_refuse(self):
        for change in [lambda s: setattr(s, "is_playing", True), lambda s: setattr(s, "record_mode", True),
                       lambda s: setattr(s.tracks[0], "arm", True), lambda s: setattr(s.tracks[0], "fired_slot_index", 0)]:
            song = Song()
            change(song)
            with self.assertRaises(ValueError):
                self.source(song)


if __name__ == "__main__":
    unittest.main()
