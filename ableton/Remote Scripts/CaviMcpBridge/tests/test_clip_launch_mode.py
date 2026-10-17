import copy
import unittest
from test_dispatch import Song, Clip
from bridge import dispatch_request


class ClipLaunchModeTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.clip = self.song.tracks[0].clip_slots[0].clip
        self.clip.launch_mode = 0
        self.params = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def read(self, method):
        return dispatch_request(self.song, {'method': method, 'params': self.params}, 4)

    def write(self, mode, before=None, context=None):
        return dispatch_request(self.song, {'method': 'set_clip_timing', 'params': {
            **self.params, 'before': before if before is not None else self.read('get_clip_timing'),
            'launchEditContext': context if context is not None else self.read('get_clip_launch_edit_context'),
            'changes': {'launchMode': mode}}}, 4)

    def test_reads_and_changes_all_modes_without_launching_or_changing_material(self):
        before = copy.deepcopy(self.clip.__dict__)
        for value, name in enumerate(('trigger', 'gate', 'toggle', 'repeat')):
            observed = self.write(value)
            self.assertEqual(observed['launchMode']['value'], value)
            self.assertEqual(observed['launchMode']['name'], name)
            self.assertTrue(observed['launchMode']['supported'])
        after = copy.deepcopy(self.clip.__dict__)
        before.pop('launch_mode'); after.pop('launch_mode')
        self.assertEqual(before, after)

    def test_same_value_replacement_and_movement_invalidate_native_identity(self):
        before, context = self.read('get_clip_timing'), self.read('get_clip_launch_edit_context')
        replacement = Clip(); replacement.launch_mode = 0
        self.song.tracks[0].clip_slots[0].clip = replacement
        with self.assertRaisesRegex(ValueError, 'identity|context|changed'):
            self.write(2, before, context)
        self.assertEqual(replacement.launch_mode, 0)

    def test_recording_playback_frozen_and_pending_launches_are_refused(self):
        for owner, field in ((self.song, 'record_mode'), (self.song, 'session_record'),
                             (self.song, 'is_playing'), (self.clip, 'is_triggered'),
                             (self.clip, 'is_recording'), (self.song.tracks[0], 'is_frozen')):
            previous = getattr(owner, field, False)
            setattr(owner, field, True)
            with self.assertRaisesRegex(ValueError, 'recording|stopped|frozen|pending'):
                self.read('get_clip_launch_edit_context')
            setattr(owner, field, previous)
        self.assertEqual(self.clip.launch_mode, 0)

    def test_invalid_values_and_missing_context_cannot_write(self):
        for value in (True, -1, 4, 'toggle'):
            with self.assertRaisesRegex(ValueError, 'launchMode|launch mode'):
                self.write(value)
        with self.assertRaisesRegex(ValueError, 'context|identity'):
            dispatch_request(self.song, {'method': 'set_clip_timing', 'params': {
                **self.params, 'changes': {'launchMode': 2}}}, 4)
        self.assertEqual(self.clip.launch_mode, 0)

    def test_unavailable_mode_is_unknown_and_cannot_be_written(self):
        del self.clip.launch_mode
        self.assertEqual(self.read('get_clip_timing')['launchMode'], {'supported': False})
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.read('get_clip_launch_edit_context')

    def test_setter_replacement_is_partial_and_does_not_rollback_detached_clip(self):
        replacement = Clip(); replacement.launch_mode = 2
        song = self.song
        class ReplacingClip(Clip):
            @property
            def launch_mode(self):
                return getattr(self, '_mode', 0)
            @launch_mode.setter
            def launch_mode(self, value):
                self._mode = value
                if value == 2:
                    song.tracks[0].clip_slots[0].clip = replacement
        original = ReplacingClip()
        song.tracks[0].clip_slots[0].clip = original
        with self.assertRaisesRegex(RuntimeError, 'identity|ownership'):
            self.write(2)
        self.assertEqual(original.launch_mode, 2)
        self.assertIs(song.tracks[0].clip_slots[0].clip, replacement)

    def test_replacement_during_an_earlier_setting_prevents_launch_write(self):
        replacement = Clip(); replacement.launch_mode = 0
        song = self.song
        class ReplacingClip(Clip):
            launch_mode = 0
            @property
            def loop_end(self):
                return getattr(self, '_end', 4)
            @loop_end.setter
            def loop_end(self, value):
                self._end = value
                if value == 8:
                    song.tracks[0].clip_slots[0].clip = replacement
        original = ReplacingClip()
        song.tracks[0].clip_slots[0].clip = original
        before, context = self.read('get_clip_timing'), self.read('get_clip_launch_edit_context')
        with self.assertRaisesRegex(RuntimeError, 'identity|ownership'):
            dispatch_request(song, {'method': 'set_clip_timing', 'params': {
                **self.params, 'before': before, 'launchEditContext': context,
                'changes': {'loop': {'endBeats': 8}, 'launchMode': 2}}}, 4)
        self.assertEqual(original.launch_mode, 0)
        self.assertEqual(replacement.launch_mode, 0)

    def test_native_mode_readback_must_match_requested_value(self):
        class IgnoringClip(Clip):
            @property
            def launch_mode(self):
                return 0
            @launch_mode.setter
            def launch_mode(self, value):
                pass
        self.song.tracks[0].clip_slots[0].clip = IgnoringClip()
        with self.assertRaisesRegex(ValueError, 'readback|requested'):
            self.write(2)


if __name__ == '__main__':
    unittest.main()
