import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip, MidiNote


class ClipEntryTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.song.record_mode = self.song.session_record = False
        self.track = self.song.tracks[0]
        self.track.is_foldable = self.track.arm = self.track.implicit_arm = self.track.is_frozen = False
        self.track.fired_slot_index = -1
        self.slot = self.track.clip_slots[0]
        self.slot.is_triggered = False
        self.prepare(self.slot.clip)
        self.args = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def prepare(self, clip):
        clip.is_playing = clip.is_recording = clip.is_overdubbing = clip.is_triggered = False
        clip.start_marker, clip.end_marker = 0., 4.
        if not isinstance(clip, AudioClip):
            clip.is_audio_clip = False
            clip.extended_notes = [MidiNote(1), MidiNote(2)]
        return clip

    def call(self, method, params):
        return dispatch_request(self.song, {'method': method, 'params': params}, 3)

    def source(self):
        return self.call('get_session_clip_entry_context', self.args)

    def plan(self, start=1, unit='beats'):
        return {**self.args, 'expectedStateVersion': 3, 'before': self.source(), 'start': start, 'unit': unit}

    def test_midi_entry_keeps_complete_material_loop_and_other_playback(self):
        self.song.is_playing = True
        plan = self.plan()
        result = self.call('set_session_clip_entry', plan)
        self.assertTrue(result['verified'])
        self.assertTrue(self.song.is_playing)
        expected = copy.deepcopy(plan['before']['content'])
        expected['timing']['markers']['startBeats'] = 1
        self.assertEqual(result['observed']['content'], expected)

    def test_warped_and_unwarped_audio_keep_source_pitch_gain_and_loop(self):
        for warped, unit in [(True, 'beats'), (False, 'seconds')]:
            self.slot.clip = self.prepare(AudioClip())
            self.slot.clip.warping = warped
            self.slot.clip.looping = warped
            if not warped:
                self.unwarped_native_clip()
            plan = self.plan(.5, unit)
            result = self.call('set_session_clip_entry', plan)
            self.assertTrue(result['verified'])
            self.assertEqual(result['observed']['content']['audio']['source'], plan['before']['content']['audio']['source'])
            expected_loop = copy.deepcopy(plan['before']['content']['timing']['loop'])
            if not warped:
                expected_loop['startSeconds'] = .5
            self.assertEqual(result['observed']['content']['timing']['loop'], expected_loop)

    def unwarped_native_clip(self):
        clip = self.slot.clip
        class Unwarped(type(clip)):
            @property
            def start_marker(self): return self._start_marker
            @start_marker.setter
            def start_marker(self, value): pass
            @property
            def loop_start(self): return self._loop_start
            @loop_start.setter
            def loop_start(self, value):
                self._loop_start = self._start_marker = value
        clip._start_marker, clip._loop_start = clip.start_marker, clip.loop_start
        clip.__class__ = Unwarped
        return clip

    def test_unwarped_entry_binds_active_range_instead_of_stored_warped_end(self):
        self.slot.clip = self.prepare(AudioClip())
        self.slot.clip.warping = self.slot.clip.looping = False
        self.slot.clip.loop_end = 2
        self.unwarped_native_clip()
        before = self.source()
        self.assertEqual(before['end'], 2)
        self.assertEqual(before['entryProperty'], 'loop_start')
        with self.assertRaises(ValueError):
            self.call('set_session_clip_entry', self.plan(2, 'seconds'))
        result = self.call('set_session_clip_entry', self.plan(.5, 'seconds'))
        self.assertTrue(result['verified'])
        self.assertEqual(self.slot.clip.loop_start, .5)
        self.assertEqual(self.slot.clip.end_marker, 4)

    def test_unwarped_no_op_retains_different_stored_marker_start(self):
        self.slot.clip = self.prepare(AudioClip())
        self.slot.clip.warping = self.slot.clip.looping = False
        clip = self.unwarped_native_clip()
        clip._loop_start, clip._start_marker = 1, 0
        opened = []
        self.song.begin_undo_step = lambda: opened.append(True)
        plan = self.plan(1, 'seconds')
        result = self.call('set_session_clip_entry', plan)
        self.assertTrue(result['verified'])
        self.assertTrue(result['retainedStateVerified'])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(result['observed']['content'], plan['before']['content'])
        self.assertEqual(opened, [])

    def test_equal_content_replacement_invalidates_plan(self):
        plan = self.plan()
        self.slot.clip = copy.deepcopy(self.slot.clip)
        with self.assertRaisesRegex(ValueError, 'changed|identity'):
            self.call('set_session_clip_entry', plan)
        self.assertEqual(self.slot.clip.start_marker, 0)

    def test_undo_entry_replacement_is_not_written(self):
        plan = self.plan()
        self.song.begin_undo_step = lambda: setattr(self.slot, 'clip', copy.deepcopy(self.slot.clip))
        with self.assertRaisesRegex(ValueError, 'changed|identity'):
            self.call('set_session_clip_entry', plan)
        self.assertEqual(self.slot.clip.start_marker, 0)

    def test_same_version_note_or_loop_change_invalidates_plan(self):
        for change in [lambda c: setattr(c.extended_notes[0], 'velocity', 12), lambda c: setattr(c, 'loop_end', 9)]:
            self.setUp()
            plan = self.plan()
            change(self.slot.clip)
            with self.assertRaisesRegex(ValueError, 'changed|context'):
                self.call('set_session_clip_entry', plan)
            self.assertEqual(self.slot.clip.start_marker, 0)

    def test_active_unsafe_and_unknown_controls_refuse(self):
        for owner, name, value in [('clip', 'is_playing', True), ('clip', 'is_triggered', True),
                ('clip', 'is_recording', True), ('clip', 'is_overdubbing', True), ('slot', 'is_triggered', True),
                ('track', 'arm', True), ('track', 'implicit_arm', True), ('track', 'is_frozen', True),
                ('track', 'fired_slot_index', 0), ('song', 'record_mode', True), ('song', 'session_record', True),
                ('song', 'is_counting_in', True), ('clip', 'is_playing', None)]:
            self.setUp()
            target = {'clip': self.slot.clip, 'slot': self.slot, 'track': self.track, 'song': self.song}[owner]
            setattr(target, name, value)
            with self.assertRaises(ValueError):
                self.source()

    def test_recording_started_at_undo_entry_prevents_write(self):
        plan = self.plan()
        self.song.begin_undo_step = lambda: setattr(self.song, 'record_mode', True)
        with self.assertRaises(ValueError):
            self.call('set_session_clip_entry', plan)
        self.assertEqual(self.slot.clip.start_marker, 0)

    def test_no_op_does_not_open_undo(self):
        opened = []
        self.song.begin_undo_step = lambda: opened.append(True)
        result = self.call('set_session_clip_entry', self.plan(0))
        self.assertTrue(result['verified'])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(opened, [])

    def test_invalid_units_positions_and_arrangement_ids_refuse(self):
        for start, unit in [(4, 'beats'), (True, 'beats'), (float('nan'), 'beats'), (1, 'seconds')]:
            with self.assertRaises(ValueError):
                self.call('set_session_clip_entry', self.plan(start, unit))
        self.args['clipId'] = 'track-0:arrangement-clip-0'
        with self.assertRaisesRegex(ValueError, 'Session'):
            self.source()

    def test_callback_replacement_preserves_the_new_owner(self):
        original, replacement = self.slot.clip, copy.deepcopy(self.slot.clip)
        slot = self.slot
        class Callback(type(original)):
            @property
            def start_marker(self): return self._start_marker
            @start_marker.setter
            def start_marker(self, value):
                self._start_marker = value
                slot.clip = replacement
        original._start_marker = original.start_marker
        original.__class__ = Callback
        result = self.call('set_session_clip_entry', self.plan())
        self.assertFalse(result['verified'])
        self.assertFalse(result['targetRetained'])
        self.assertEqual(replacement.start_marker, 0)

    def test_ignored_setter_and_callback_material_changes_never_verify(self):
        for callback in [lambda c: None, lambda c: setattr(c.extended_notes[0], 'pitch', 72)]:
            self.setUp()
            clip = self.slot.clip
            class Callback(type(clip)):
                @property
                def start_marker(self): return self._start_marker
                @start_marker.setter
                def start_marker(self, value): callback(self)
            clip._start_marker = clip.start_marker
            clip.__class__ = Callback
            result = self.call('set_session_clip_entry', self.plan())
            self.assertFalse(result['verified'])
            self.assertTrue(result['writeRequested'])

    def test_undo_completion_failure_remains_explicit_without_rollback(self):
        plan = self.plan()
        self.song.end_undo_step = lambda: (_ for _ in ()).throw(RuntimeError('undo completion failed'))
        result = self.call('set_session_clip_entry', plan)
        self.assertFalse(result['verified'])
        self.assertTrue(result['nativeReturned'])
        self.assertEqual(self.slot.clip.start_marker, 1)


if __name__ == '__main__': unittest.main()
