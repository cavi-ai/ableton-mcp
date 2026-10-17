import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Clip, MidiNote, AudioClip


class TakeLane:
    def __init__(self, name, clips):
        self.name, self.arrangement_clips = name, clips


class TakeLaneTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.clip = Clip()
        self.clip.is_audio_clip = False
        self.clip.start_marker, self.clip.end_marker = 0.0, 4.0
        self.clip.start_time, self.clip.end_time = 4.0, 8.0
        self.clip.extended_notes = [MidiNote()]
        self.track.take_lanes = [TakeLane('Take 1', [self.clip])]
        self.existing = copy.deepcopy(self.clip)
        self.existing.name = 'Current comp'
        self.existing.start_time, self.existing.end_time = 12.0, 16.0
        self.track.arrangement_clips = [self.existing]
        self.args = {'trackId': 'track-0', 'takeClipId': 'track-0:take-lane-0:clip-0'}

    def read(self, selected=True):
        return dispatch_request(self.song, {'method': 'get_take_lane_context', 'params':
            self.args if selected else {'trackId': 'track-0'}}, 3)

    def test_inventory_separates_takes_from_comp_without_changing_focus_or_playback(self):
        selected_track = self.song.view.selected_track
        self.song.is_playing = True
        result = self.read(False)
        self.assertTrue(result['supported'])
        self.assertFalse(result['takePromotionSupported'])
        self.assertIsNone(result['selected'])
        self.assertEqual(result['lanes'][0]['clips'][0]['startBeats'], 4)
        self.assertEqual(result['arrangement'][0]['name'], 'Current comp')
        self.assertIs(self.song.view.selected_track, selected_track)
        self.assertTrue(self.song.is_playing)

    def test_selected_take_reports_complete_stored_notes_and_local_timing(self):
        selected = self.read()['selected']
        self.assertEqual(selected['content']['notes'][0], {'noteId': 7, 'pitch': 60, 'start': 0.0,
            'duration': 1.0, 'velocity': 100, 'velocityDeviation': 0, 'releaseVelocity': 64, 'probability': 1.0, 'mute': False})
        self.assertEqual(selected['content']['timing']['loopEnd'], 4)
        self.assertEqual(selected['startBeats'], 4)

    def test_native_replacements_change_identity_and_manual_edits_are_read_fresh(self):
        before = self.read()
        self.clip.extended_notes[0].velocity = 99
        self.assertEqual(self.read()['selected']['content']['notes'][0]['velocity'], 99)
        self.track.take_lanes[0] = copy.copy(self.track.take_lanes[0])
        self.assertNotEqual(self.read()['identityToken'], before['identityToken'])
        before = self.read()
        self.track.take_lanes[0].arrangement_clips[0] = copy.deepcopy(self.clip)
        self.assertNotEqual(self.read()['identityToken'], before['identityToken'])

    def test_audio_take_reports_source_and_seconds_for_unwarped_markers(self):
        audio = AudioClip()
        audio.start_time, audio.end_time = 4.0, 8.0
        audio.file_path, audio.warping = '/recorded/take.wav', False
        self.track.take_lanes[0].arrangement_clips[0] = audio
        selected = self.read()['selected']
        self.assertEqual(selected['content']['audio']['path'], '/recorded/take.wav')
        self.assertEqual(selected['content']['timing']['unit'], 'seconds')
        self.assertEqual(selected['endBeats'], 8)

    def test_missing_api_and_oversized_inventory_or_notes_are_explicit(self):
        del self.track.take_lanes
        self.assertFalse(self.read(False)['supported'])
        self.setUp()
        self.track.take_lanes *= 129
        with self.assertRaisesRegex(ValueError, '128'):
            self.read(False)
        self.setUp()
        self.clip.extended_notes *= 4097
        with self.assertRaisesRegex(ValueError, '4096'):
            self.read()

    def test_noncanonical_or_stale_ids_and_group_targets_refuse(self):
        for identity in ['track-0:take-lane-00:clip-0', 'track-1:take-lane-0:clip-0', 'track-0:take-lane-9:clip-0']:
            self.args['takeClipId'] = identity
            with self.assertRaises(ValueError):
                self.read()
        self.track.is_foldable = True
        with self.assertRaisesRegex(ValueError, 'ordinary'):
            self.read(False)


if __name__ == '__main__':
    unittest.main()
