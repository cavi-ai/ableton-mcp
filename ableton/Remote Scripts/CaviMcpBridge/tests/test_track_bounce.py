import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class TrackBounceTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks[1].clip_slots = copy.deepcopy(self.song.tracks[0].clip_slots)
        for track in self.song.tracks:
            for slot in track.clip_slots:
                if slot.has_clip:
                    slot.clip.is_audio_clip = False

    def source(self, song):
        return dispatch_request(song, {'method': 'get_track_bounce_source', 'params': {'trackId': 'track-0'}}, 4)

    def test_read_binds_target_material_other_tracks_and_layout_without_mutation(self):
        song = self.song
        before = self.source(song)
        self.assertEqual(before, self.source(song))
        self.assertEqual(before['type'], 'midi')
        self.assertTrue(before['otherTracksToken'])
        self.assertEqual(before['layout'][0], {'location': 'session', 'index': 0})
        song.tracks[1].mute = not song.tracks[1].mute
        self.assertNotEqual(before['otherTracksDigest'], self.source(song)['otherTracksDigest'])
        before = self.source(song)
        song.tracks[1] = copy.deepcopy(song.tracks[1])
        self.assertNotEqual(before['otherTracksToken'], self.source(song)['otherTracksToken'])
        self.assertFalse(song.tracks[0].is_frozen)

    def test_target_parameter_edits_invalidate_source_digest(self):
        song = self.song
        before = self.source(song)
        song.tracks[0].devices[0].parameters[0].value = 0.7
        self.assertNotEqual(before['contentSha256'], self.source(song)['contentSha256'])

    def test_reading_another_target_does_not_invalidate_identity(self):
        before = self.source(self.song)
        dispatch_request(self.song, {'method': 'get_track_bounce_source', 'params': {'trackId': 'track-1'}}, 4)
        self.assertEqual(before['otherTracksToken'], self.source(self.song)['otherTracksToken'])

    def test_output_binds_selected_channel(self):
        before = self.source(self.song)
        track = self.song.tracks[0]
        track.current_output_sub_routing = '3/4'
        after = self.source(self.song)
        self.assertEqual(before['output']['type'], after['output']['type'])
        self.assertNotEqual(before['output']['channel'], after['output']['channel'])

    def test_audio_coverage_uses_active_clip_end_instead_of_independent_marker(self):
        clip = AudioClip()
        clip.file_path = '/sets/Bounce.wav'
        clip.sample_rate, clip.sample_length = 44100, 352800
        clip.end_marker, clip.loop_end = 24, 16
        clip.beat_to_sample_time = lambda beat: beat * 22050
        self.song.tracks[0].clip_slots[0].clip = clip
        for warped, looping, end, expected in [(True, False, 16, 352800), (True, True, 16, 352800), (False, False, 8, 352800)]:
            clip.warping, clip.looping, clip.loop_end = warped, looping, end
            self.assertEqual(self.source(self.song)['audioClips'][0]['requiredEndSamples'], expected)
