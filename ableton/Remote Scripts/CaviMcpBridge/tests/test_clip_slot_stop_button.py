import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, ClipSlot


class EditableSlot(ClipSlot):
    def __init__(self):
        super().__init__(False)
        self._stop, self.mode, self.after_write = True, None, None
        self.is_triggered, self.will_record_on_start = False, False

    @property
    def has_stop_button(self):
        return self._stop

    @has_stop_button.setter
    def has_stop_button(self, value):
        if self.mode == 'ignore' and value is False:
            return
        if self.mode == 'rollback-fails' and value is True:
            raise RuntimeError('restore refused')
        self._stop = value
        if self.after_write:
            self.after_write()
        if value is False and self.mode in ('partial', 'rollback-fails'):
            raise RuntimeError('partial native failure')


class ClipSlotStopButtonTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        for track in self.song.tracks:
            track.playing_slot_index, track.fired_slot_index = -1, -1
            track.fold_state = 0
            for slot in track.clip_slots:
                slot.has_stop_button, slot.will_record_on_start, slot.is_triggered = True, False, False
        self.slot = EditableSlot()
        self.song.tracks[1].clip_slots[0] = self.slot

    def read(self):
        return dispatch_request(self.song, {'method': 'get_scene_launch_context', 'params': {'sceneId': 'scene-0'}}, 4)

    def edit(self, before=None, **extra):
        return dispatch_request(self.song, {'method': 'set_clip_slot_stop_button', 'params': {
            'trackId': 'track-1', 'clipId': 'track-1:clip-0', 'sceneId': 'scene-0',
            'expectedStateVersion': 4, 'hasStopButton': False,
            'before': self.read() if before is None else before, **extra}}, 4)

    def test_exact_empty_slot_edits_and_restore_preserve_playback_selection_and_content(self):
        selected, original = self.song.view.selected_track, self.song.tracks[0].clip_slots[0].clip
        result = self.edit()
        self.assertTrue(result['verified'])
        self.assertFalse(result['hasStopButton'])
        self.assertEqual(result['stateVersion'], 5)
        self.assertEqual(self.read()['tracks'][1]['slot']['action'], 'empty-no-stop')
        self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])
        self.assertFalse(self.song.is_playing)
        self.assertFalse(self.song.scenes[0].is_triggered)
        self.assertIs(self.song.view.selected_track, selected)
        self.assertIs(self.song.tracks[0].clip_slots[0].clip, original)
        self.edit(hasStopButton=True)
        self.assertTrue(self.slot.has_stop_button)

    def test_changed_native_metadata_and_same_metadata_replacements_refuse_before_write(self):
        for change in [lambda: setattr(self.song, 'tempo', 130),
                       lambda: setattr(self.song.tracks[1], 'arm', True),
                       lambda: self.song.tracks[1].clip_slots.__setitem__(0, copy.deepcopy(self.slot)),
                       lambda: setattr(self, 'song', copy.deepcopy(self.song))]:
            self.setUp()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, 'context changed'):
                self.edit(before)
            self.assertTrue(self.slot.has_stop_button)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_occupied_group_frozen_recording_and_pending_launch_slots_refuse(self):
        for change in [lambda: (setattr(self.slot, 'has_clip', True), setattr(self.slot, 'clip', self.song.tracks[0].clip_slots[0].clip)),
                       lambda: setattr(self.song.tracks[1], 'is_foldable', True),
                       lambda: setattr(self.song.tracks[1], 'is_frozen', True),
                       lambda: setattr(self.song, 'session_record', True),
                       lambda: setattr(self.song, 'record_mode', True),
                       lambda: setattr(self.slot, 'is_triggered', True),
                       lambda: setattr(self.song.tracks[1], 'fired_slot_index', 0)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.edit()
            self.assertTrue(self.slot.has_stop_button)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_bad_arguments_no_op_and_missing_baseline_refuse(self):
        for extra in [{'expectedStateVersion': True}, {'hasStopButton': 0}, {'hasStopButton': True},
                      {'before': {}}, {'clipId': 'track-0:clip-0'}, {'sceneId': 'scene-1'}]:
            with self.assertRaises(ValueError):
                self.edit(**extra)
            self.assertTrue(self.slot.has_stop_button)

    def test_silent_and_partial_native_failures_restore_only_the_owned_flag(self):
        for mode in ('ignore', 'partial'):
            self.setUp()
            self.slot.mode = mode
            with self.assertRaisesRegex(RuntimeError, 'mismatch|partial native failure'):
                self.edit()
            self.assertTrue(self.slot.has_stop_button)
            self.assertEqual(self.song.undo_boundaries, ['begin', 'end'])

    def test_rollback_failure_is_explicit_and_native_replacement_is_not_overwritten(self):
        self.slot.mode = 'rollback-fails'
        with self.assertRaisesRegex(RuntimeError, 'rollback failed.*restore refused'):
            self.edit()
        self.assertFalse(self.slot.has_stop_button)
        self.setUp()
        replacement = EditableSlot()
        self.slot.after_write = lambda: self.song.tracks[1].clip_slots.__setitem__(0, replacement)
        with self.assertRaisesRegex(RuntimeError, 'ownership.*unconfirmed|rollback skipped'):
            self.edit()
        self.assertIs(self.song.tracks[1].clip_slots[0], replacement)
        self.assertTrue(replacement.has_stop_button)


if __name__ == '__main__':
    unittest.main()
