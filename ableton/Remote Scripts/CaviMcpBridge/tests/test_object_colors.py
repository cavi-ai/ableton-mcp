import copy
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from test_dispatch import Song, Clip
import object_colors


class ColorObject:
    def __init__(self, name, color=0x123456):
        self.name, self._color, self.color_index = name, color, 7
        self.is_audio_clip = False
        self.writes, self.callback, self.reject, self.rounded = 0, None, False, None

    @property
    def color(self):
        return self._color

    @color.setter
    def color(self, value):
        if self.reject:
            raise RuntimeError('native color write refused')
        self.writes += 1
        self.color_index = 2
        self._color = self.rounded if self.rounded is not None else value
        if self.callback:
            self.callback()


class ColorTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.master_track.name = 'Main'
        for owner in [*self.song.tracks, *self.song.return_tracks, self.song.master_track, *self.song.scenes]:
            owner.color, owner.color_index = 0x123456, 7
        self.song.tracks[0].clip_slots[0].clip = ColorObject('Session part')
        self.song.tracks[0].arrangement_clips = [ColorObject('Arrangement part')]
        self.song.tracks[0].arrangement_clips[0].start_time = 0
        self.song.tracks[0].arrangement_clips[0].end_time = 4
        self.ids = ['track-0', 'return-0', 'master', 'scene-0', 'track-0:clip-0', 'track-0:arrangement-clip-0']
        self.changes = [{'objectId': key, 'color': '#FF0000'} for key in self.ids]

    def source(self):
        return object_colors.source(self.song, {'objectIds': self.ids}, 3)

    def apply(self, before=None):
        return object_colors.write(self.song, {'changes': self.changes, 'before': before or self.source(), 'expectedStateVersion': 3}, 3)

    def test_read_preserves_focus_and_bulk_write_reports_each_native_value_in_one_undo_step(self):
        selection = copy.copy(self.song.view.__dict__)
        before = self.source()
        self.assertEqual(before, self.source())
        self.assertEqual(before['objects'][4]['color'], '#123456')
        result = self.apply(before)
        self.assertTrue(result['writeCompleted'])
        self.assertTrue(result['selectionUnchanged'])
        self.assertTrue(all(item['exactMatch'] for item in result['objects']))
        self.assertEqual(self.song.view.__dict__, selection)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_native_palette_adjustment_is_observed_and_never_reported_as_an_exact_match(self):
        target = self.song.tracks[0].clip_slots[0].clip
        target.rounded = 0xFF1234
        result = self.apply()
        self.assertTrue(result['writeCompleted'])
        item = result['objects'][4]
        self.assertFalse(item['exactMatch'])
        self.assertEqual(item['color'], '#FF1234')
        self.assertEqual(item['requestedColor'], '#FF0000')

    def test_same_version_manual_color_name_or_replacement_invalidates_plan_before_any_write(self):
        for change in ('color', 'name', 'replacement'):
            self.setUp()
            before = self.source()
            target = self.song.tracks[0].clip_slots[0].clip
            if change == 'replacement':
                self.song.tracks[0].clip_slots[0].clip = ColorObject(target.name)
            else:
                setattr(target, change, '#other' if change == 'name' else 0x654321)
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.apply(before)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_canonical_ids_nonempty_populated_targets_and_unique_bounded_lists_are_required(self):
        for ids in ([], ['track-00'], ['scene-00'], ['return-00'], ['track-0:clip-00'], ['track-0:clip-1'], ['device-0'], ['track-0'] * 2, ['track-0'] * 65):
            with self.assertRaises((ValueError, IndexError)):
                object_colors.source(self.song, {'objectIds': ids}, 3)
        for color in ('red', '#12345', '#GG0000', 0xFF0000, True):
            self.changes[0]['color'] = color
            with self.assertRaises(ValueError):
                self.apply()
        self.assertEqual(self.song.undo_boundaries, [])

    def test_failure_preserves_partial_observations_without_automatic_replay_or_undo(self):
        target = self.song.tracks[0].clip_slots[0].clip
        target.reject = True
        result = self.apply()
        self.assertFalse(result['writeCompleted'])
        self.assertTrue(result['inspectionRequired'])
        self.assertEqual(result['objects'][0]['color'], '#FF0000')
        self.assertFalse(result['objects'][4]['writeReturned'])
        self.assertEqual(result['objects'][4]['color'], '#123456')
        self.assertEqual(self.song.tracks[0].arrangement_clips[0].writes, 0)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_listener_reindexing_during_write_cannot_color_the_replacement_or_claim_success(self):
        first = self.song.tracks[0].clip_slots[0].clip
        second = self.song.tracks[0].arrangement_clips[0]
        replacement = ColorObject(second.name)
        replacement.start_time, replacement.end_time = 0, 4
        first.callback = lambda: self.song.tracks[0].arrangement_clips.__setitem__(0, replacement)
        result = self.apply()
        self.assertFalse(result['writeCompleted'])
        self.assertFalse(result['identityRetained'])
        self.assertEqual(second.writes, 0)
        self.assertEqual(replacement.writes, 0)

    def test_unsupported_color_access_is_reported_and_cannot_be_written(self):
        del self.song.master_track.color
        before = self.source()
        self.assertFalse(before['objects'][2]['supported'])
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            self.apply(before)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_same_object_rename_listener_stops_before_later_targets(self):
        target = self.song.tracks[0].clip_slots[0].clip
        target.callback = lambda: setattr(target, 'name', 'manual rename')
        result = self.apply()
        self.assertFalse(result['writeCompleted'])
        self.assertTrue(result['objects'][4]['writeReturned'])
        self.assertEqual(result['objects'][4]['name'], 'manual rename')
        self.assertEqual(self.song.tracks[0].arrangement_clips[0].writes, 0)

    def test_unassigned_scene_color_is_readable_and_can_receive_its_first_color(self):
        for color, index in ((0, None), (-1, -1)):
            self.setUp()
            self.song.scenes[0] = ColorObject('Scene', color)
            self.song.scenes[0].color_index = index
            before = self.source()
            self.assertEqual(before['objects'][3]['color'], None)
            self.assertTrue(before['objects'][3]['supported'])
            self.assertEqual(before['objects'][3]['colorIndex'], index)
            result = self.apply(before)
            self.assertTrue(result['writeCompleted'])
            self.assertTrue(result['objects'][3]['exactMatch'])


if __name__ == '__main__':
    unittest.main()
