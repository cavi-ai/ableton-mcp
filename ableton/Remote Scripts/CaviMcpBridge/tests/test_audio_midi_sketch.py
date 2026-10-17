import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class AudioMidiSketchTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = AudioClip()
        self.clip.warping = True
        self.clip.looping = True
        self.clip.loop_start = 4.0
        self.clip.loop_end = 8.0
        self.clip.sample_rate = 48000.0
        self.clip.sample_length = 480000
        self.clip.beat_to_sample_time = lambda beat: beat * 24000
        self.song.tracks[0].clip_slots[0].clip = self.clip

    def read(self, **options):
        return dispatch_request(self.song, {'method': 'get_audio_midi_sketch_source', 'params': {
            'trackId': 'track-0', 'clipId': 'track-0:clip-0', **options}}, 3)

    def test_current_loop_maps_to_native_source_seconds_without_writing(self):
        result = self.read()
        self.assertEqual(result['region'], {'kind': 'loop', 'startBeats': 4.0, 'endBeats': 8.0})
        self.assertEqual(result['sourceWindow']['startSeconds'], 2.0)
        self.assertEqual(result['sourceWindow']['durationSeconds'], 2.0)
        self.assertFalse(result['sourceWindow']['clampedToFile'])
        self.assertEqual(self.song.undo_boundaries, [])
        self.assertEqual(self.clip.loop_start, 4)

    def test_explicit_region_and_unlooped_markers_are_distinct(self):
        self.assertEqual(self.read(startBeats=5.0, endBeats=7.0)['region']['kind'], 'explicit')
        self.clip.looping = False
        result = self.read()
        self.assertEqual(result['region']['kind'], 'markers')
        self.assertEqual(result['region']['startBeats'], self.clip.start_marker)

    def test_projected_source_positions_are_clamped_with_explicit_evidence(self):
        result = self.read(startBeats=-1, endBeats=21)
        self.assertTrue(result['sourceWindow']['clampedToFile'])
        self.assertEqual(result['sourceWindow']['startSeconds'], 0)
        self.assertEqual(result['sourceWindow']['durationSeconds'], 10)
        self.assertEqual(result['sourceWindow']['requestedStartSeconds'], -0.5)

    def test_invalid_regions_and_excessive_windows_fail_before_analysis(self):
        for options in [dict(startBeats=2), dict(startBeats=3, endBeats=2),
                        dict(startBeats=float('nan'), endBeats=3), dict(startBeats=0, endBeats=257)]:
            with self.assertRaises(ValueError):
                self.read(**options)
        self.clip.sample_length = 48000 * 60
        with self.assertRaisesRegex(ValueError, '30'):
            self.read(startBeats=0, endBeats=80)

    def test_unwarped_and_missing_native_conversion_are_explicit(self):
        self.clip.warping = False
        with self.assertRaisesRegex(ValueError, 'warped'):
            self.read()
        self.clip.warping = True
        self.clip.beat_to_sample_time = None
        with self.assertRaisesRegex(ValueError, 'conversion'):
            self.read()

    def test_manual_region_edits_are_visible_on_the_next_read(self):
        self.read()
        self.clip.loop_start = 6
        self.assertEqual(self.read()['sourceWindow']['startSeconds'], 3)
