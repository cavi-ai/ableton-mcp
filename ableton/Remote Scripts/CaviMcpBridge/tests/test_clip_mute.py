import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class ClipMuteTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.song.record_mode = self.song.session_record = False
        for track in self.song.tracks:
            track.is_foldable = False
            track.implicit_arm = False
            track.arm = track.is_frozen = False
            track.fired_slot_index = -1
            for slot in track.clip_slots:
                slot.is_triggered = False
                if slot.has_clip:
                    slot.clip.muted = slot.clip.is_recording = slot.clip.is_overdubbing = slot.clip.is_triggered = False
        self.args = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def call(self, name, args):
        return dispatch_request(self.song, {'method': name, 'params': args}, 3)

    def plan(self, mute=True, **changes):
        return {**self.args, 'before': self.call('get_clip_timing', self.args),
                'muteEditContext': self.call('get_clip_mute_edit_context', self.args),
                'expectedStateVersion': 3, 'changes': {'mute': mute, **changes}}

    def test_mute_and_restore_keep_playback_content_and_track_mixer(self):
        self.song.is_playing = True
        clip = self.song.tracks[0].clip_slots[0].clip
        clip.notes = [(60, 0, 1, 92, False)]
        for value in (True, False):
            result = self.call('set_clip_timing', self.plan(value))
            self.assertEqual(result['mute']['enabled'], value)
            self.assertEqual(clip.notes, [(60, 0, 1, 92, False)])
            self.assertTrue(self.song.is_playing)
            self.assertFalse(self.song.tracks[0].mute)

    def test_arrangement_audio_uses_the_same_identity_guard(self):
        clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
        clip.is_audio_clip, clip.warping = True, True
        clip.start_time, clip.end_time = 8, 12
        self.song.tracks[0].arrangement_clips = [clip]
        self.args['clipId'] = 'track-0:arrangement-clip-0'
        result = self.call('set_clip_timing', self.plan())
        self.assertTrue(result['mute']['enabled'])
        self.assertEqual((clip.start_time, clip.end_time), (8, 12))

    def test_equal_content_replacement_is_refused_before_write(self):
        plan = self.plan()
        slot = self.song.tracks[0].clip_slots[0]
        slot.clip = copy.deepcopy(slot.clip)
        with self.assertRaisesRegex(ValueError, 'identity|context'):
            self.call('set_clip_timing', plan)
        self.assertFalse(slot.clip.muted)

    def test_undo_entry_replacement_is_refused_before_write(self):
        plan = self.plan()
        slot = self.song.tracks[0].clip_slots[0]
        self.song.begin_undo_step = lambda: setattr(slot, 'clip', copy.deepcopy(slot.clip))
        with self.assertRaisesRegex(ValueError, 'identity|context|changed'):
            self.call('set_clip_timing', plan)
        self.assertFalse(slot.clip.muted)

    def test_no_op_does_not_open_undo_or_write(self):
        undo = []
        self.song.begin_undo_step = lambda: undo.append(True)
        self.assertFalse(self.call('set_clip_timing', self.plan(False))['mute']['enabled'])
        self.assertEqual(undo, [])

    def test_recording_pending_frozen_armed_and_unknown_scopes_refuse(self):
        for target, field, value in [('song', 'record_mode', True), ('song', 'session_record', True),
                                     ('song', 'is_counting_in', True), ('clip', 'is_recording', True),
                                     ('clip', 'is_overdubbing', True), ('clip', 'is_triggered', True),
                                     ('slot', 'is_triggered', True), ('track', 'fired_slot_index', 0),
                                     ('track', 'is_frozen', True), ('track', 'arm', True),
                                     ('track', 'implicit_arm', True), ('track', 'is_frozen', None)]:
            self.setUp()
            track = self.song.tracks[0]
            objects = {'song': self.song, 'track': track, 'slot': track.clip_slots[0], 'clip': track.clip_slots[0].clip}
            setattr(objects[target], field, value)
            with self.assertRaises(ValueError):
                self.plan()
            self.assertFalse(track.clip_slots[0].clip.muted)

    def test_missing_native_mute_context_cannot_bypass_guard(self):
        plan = self.plan()
        del plan['muteEditContext']
        with self.assertRaisesRegex(ValueError, 'context|identity'):
            self.call('set_clip_timing', plan)

    def test_mutation_callback_replacement_is_not_written_or_rolled_back(self):
        slot = self.song.tracks[0].clip_slots[0]
        original, replacement = slot.clip, copy.deepcopy(slot.clip)
        class CallbackClip(type(original)):
            @property
            def muted(self):
                return self._muted
            @muted.setter
            def muted(self, value):
                self._muted = value
                slot.clip = replacement
        original._muted = original.muted
        original.__class__ = CallbackClip
        with self.assertRaisesRegex(RuntimeError, 'partial|ownership|identity'):
            self.call('set_clip_timing', self.plan())
        self.assertFalse(replacement.muted)
        self.assertTrue(original.muted)

    def test_ignored_native_setter_never_returns_success(self):
        clip = self.song.tracks[0].clip_slots[0].clip
        class IgnoredClip(type(clip)):
            @property
            def muted(self):
                return False
            @muted.setter
            def muted(self, value):
                pass
        clip.__class__ = IgnoredClip
        with self.assertRaisesRegex((ValueError, RuntimeError), 'mute|partial|ownership'):
            self.call('set_clip_timing', self.plan())

    def test_recording_started_at_undo_entry_prevents_mute_write(self):
        plan = self.plan()
        self.song.begin_undo_step = lambda: setattr(self.song, 'record_mode', True)
        with self.assertRaisesRegex(ValueError, 'recording|context'):
            self.call('set_clip_timing', plan)
        self.assertFalse(self.song.tracks[0].clip_slots[0].clip.muted)

    def test_mixed_edit_rollback_preserves_a_later_manual_loop_change(self):
        clip = self.song.tracks[0].clip_slots[0].clip
        class LaterEdit(type(clip.view)):
            @property
            def grid_is_triplet(self):
                return False
            @grid_is_triplet.setter
            def grid_is_triplet(self, value):
                clip.loop_end = 99
                raise ValueError('later editor write failed')
        clip.view = LaterEdit(grid_quantization=clip.view.grid_quantization)
        with self.assertRaisesRegex(RuntimeError, 'partial|ownership'):
            self.call('set_clip_timing', self.plan(loop={'endBeats': 8}, editorGrid={'isTriplet': True}))
        self.assertEqual(clip.loop_end, 99)
        self.assertFalse(clip.muted)

    def test_mixed_edit_preserves_callback_change_before_later_write(self):
        clip = self.song.tracks[0].clip_slots[0].clip
        original_start = clip.loop_start
        class LaterLoopEdit(type(clip)):
            @property
            def loop_start(self):
                return self._loop_start
            @loop_start.setter
            def loop_start(self, value):
                self._loop_start = value
                self.loop_end = 99
        clip._loop_start = clip.loop_start
        clip.__class__ = LaterLoopEdit
        with self.assertRaisesRegex((ValueError, RuntimeError), 'changed|ownership'):
            self.call('set_clip_timing', self.plan(loop={'startBeats': 1, 'endBeats': 8}))
        self.assertEqual(clip.loop_end, 99)
        self.assertEqual(clip.loop_start, original_start)
        self.assertFalse(clip.muted)

    def test_mixed_editor_edit_accepts_equal_native_view_wrappers(self):
        clip = self.song.tracks[0].clip_slots[0].clip
        view = clip.view
        class ViewProxy:
            def __getattr__(self, name):
                return getattr(view, name)
            def __setattr__(self, name, value):
                setattr(view, name, value)
            def __eq__(self, other):
                return isinstance(other, ViewProxy)
        class NativeViews(type(clip)):
            @property
            def view(self):
                return ViewProxy()
        clip.__class__ = NativeViews
        self.assertIsNot(clip.view, clip.view)
        self.assertEqual(clip.view, clip.view)
        result = self.call('set_clip_timing', self.plan(editorGrid={'isTriplet': True}))
        self.assertTrue(result['mute']['enabled'])
        self.assertTrue(clip.view.grid_is_triplet)


if __name__ == '__main__':
    unittest.main()
