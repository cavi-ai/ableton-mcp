import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class NativeUnwarpedClip(AudioClip):
    def __init__(self):
        super().__init__()
        self.warping = self.looping = False
        self._loop_start, self._loop_end = .25, 2.
        self._marker_start, self._marker_end = 0., 4.
        self.marker_writes = []

    @property
    def start_marker(self): return self._marker_start
    @start_marker.setter
    def start_marker(self, value):
        if hasattr(self, 'marker_writes'): self.marker_writes.append(('start', value))

    @property
    def end_marker(self): return self._marker_end
    @end_marker.setter
    def end_marker(self, value):
        if hasattr(self, 'marker_writes'): self.marker_writes.append(('end', value))

    @property
    def loop_start(self): return self._loop_start
    @loop_start.setter
    def loop_start(self, value):
        self._loop_start = self._marker_start = value

    @property
    def loop_end(self): return self._loop_end
    @loop_end.setter
    def loop_end(self, value):
        if value > 2: return
        self._loop_end = self._marker_end = value


class UnwarpedRegionTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = NativeUnwarpedClip()
        self.song.tracks[0].clip_slots[2].clip = self.clip
        self.args = {'trackId': 'track-0', 'clipId': 'track-0:clip-2'}

    def call(self, method, args):
        return dispatch_request(self.song, {'method': method, 'params': args}, 3)

    def edit(self, **changes):
        return self.call('set_audio_clip_state', {**self.args, 'before': self.call('get_audio_clip_state', self.args),
                'changes': {key: {'value': value} for key, value in changes.items()}})

    def test_reads_use_the_active_second_range_not_stored_warped_markers(self):
        for method in ('get_clip_timing', 'get_audio_clip_state'):
            markers = self.call(method, self.args)['markers']
            self.assertEqual(markers['unit'], 'seconds')
            self.assertEqual((markers['startSeconds'], markers['endSeconds']), (.25, 2.))

    def test_start_only_preserves_the_active_end_without_redundant_marker_writes(self):
        result = self.edit(startMarkerSeconds=.5)
        self.assertEqual(result['markers']['startSeconds'], .5)
        self.assertEqual(result['markers']['endSeconds'], 2.)
        self.assertEqual(self.clip.marker_writes, [])

    def test_end_only_preserves_the_active_start(self):
        result = self.edit(endMarkerSeconds=1.5)
        self.assertEqual((result['markers']['startSeconds'], result['markers']['endSeconds']), (.25, 1.5))
        self.assertEqual(self.clip.marker_writes, [])

    def test_two_bounds_keep_the_clip_unwarped_and_nonlooping(self):
        result = self.edit(startMarkerSeconds=.75, endMarkerSeconds=1.5)
        self.assertEqual((self.clip.loop_start, self.clip.loop_end), (.75, 1.5))
        self.assertFalse(result['warping'])
        self.assertFalse(result['loop']['enabled'])
        self.assertEqual(self.clip.marker_writes, [])

    def test_arrangement_clip_reads_and_writes_use_the_same_active_units(self):
        self.clip.start_time, self.clip.end_time = 16., 20.
        self.song.tracks[0].arrangement_clips = [self.clip]
        self.args['clipId'] = 'track-0:arrangement-clip-0'
        result = self.edit(startMarkerSeconds=.5, endMarkerSeconds=1.5)
        self.assertEqual(result['markers'], {'unit': 'seconds', 'startSeconds': .5, 'endSeconds': 1.5})
        self.assertEqual(self.clip.marker_writes, [])

    def test_warped_audio_keeps_separate_markers_and_repeat_loop(self):
        self.song.tracks[0].clip_slots[2].clip = AudioClip()
        clip = self.song.tracks[0].clip_slots[2].clip
        before_loop = clip.loop_start, clip.loop_end
        result = self.edit(startMarkerBeats=1, endMarkerBeats=3)
        self.assertEqual(result['markers'], {'unit': 'beats', 'startBeats': 1., 'endBeats': 3.})
        self.assertEqual((clip.loop_start, clip.loop_end), before_loop)

    def test_crop_validation_uses_the_active_nonlooped_second_range(self):
        self.clip._loop_start, self.clip._marker_start, self.clip._marker_end = 1.5, 1.5, 1.
        cropped = []
        self.clip.crop = lambda: cropped.append((self.clip.loop_start, self.clip.loop_end))
        before = self.call('get_audio_clip_state', self.args)
        self.call('crop_audio_clip', {**self.args, 'before': before})
        self.assertEqual(cropped, [(1.5, 2.)])


if __name__ == '__main__': unittest.main()
