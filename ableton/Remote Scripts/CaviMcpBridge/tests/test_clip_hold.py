import importlib
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from test_dispatch import Song, Clip, Track
from bridge import dispatch_request, SocketBridge


class ClipHoldTests(unittest.TestCase):
    def setUp(self):
        if 'clip_hold' in sys.modules:
            sys.modules['clip_hold']._holds.clear()
            sys.modules['clip_hold']._sources.clear()
        self.song = Song(); self.song.is_playing = True
        self.track = self.song.tracks[0]
        self.clip = self.track.clip_slots[0].clip
        self.clip.launch_mode = 1
        self.clip.is_midi_clip = True
        self.clip.is_audio_clip = False
        self.clip.is_recording = False
        self.clip.is_overdubbing = False
        self.clip.is_triggered = False
        self.track.clip_slots[0].is_triggered = False
        self.calls = []
        def button(state):
            self.calls.append(state)
            self.clip.held = state
            if state:
                self.clip.is_playing = True
                self.track.playing_slot_index = 0
            elif self.clip.launch_mode == 1:
                self.clip.is_playing = False
                self.track.playing_slot_index = -1
        self.clip.set_fire_button_state = button
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}

    def tearDown(self):
        if 'clip_hold' in sys.modules:
            module = sys.modules['clip_hold']; module.shutdown(self.song)
            module._holds.clear(); module._sources.clear()

    def source(self, **extra):
        return dispatch_request(self.song, {'method': 'get_session_clip_hold_source', 'params': {**self.target, **extra}}, 3)

    def start(self, **extra):
        return dispatch_request(self.song, {'method': 'hold_session_clip', 'params': {
            **self.target, 'expectedStateVersion': 3, 'durationSeconds': 1,
            'before': self.source(**extra), **extra}}, 3)

    def read(self, hold_id=None):
        return dispatch_request(self.song, {'method': 'get_session_clip_hold', 'params': {'holdId': hold_id} if hold_id else {}}, 4)

    def test_native_display_tick_releases_without_a_connected_client(self):
        result = self.start(); module = importlib.import_module('clip_hold')
        bridge = SocketBridge(SimpleNamespace(song=lambda: self.song), '/tmp/clip-hold-not-started.sock'); bridge.state_version = 4
        with patch('clip_hold.time.monotonic', return_value=module._holds[result['holdId']]['deadline'] + 1):
            bridge.drain()
        self.assertEqual(self.calls, [True, False]); self.assertEqual(bridge.state_version, 5)
        observed = self.read(result['holdId'])
        self.assertEqual(observed['status'], 'complete'); self.assertTrue(observed['releaseCallReturned'])
        self.assertFalse(observed['buttonStateVerified']); self.assertFalse(observed['isPlaying'])

    def test_bridge_shutdown_releases_only_the_retained_press(self):
        self.start(); bridge = SocketBridge(SimpleNamespace(song=lambda: self.song), '/tmp/clip-hold-not-started.sock')
        bridge.stop(); self.assertEqual(self.calls, [True, False]); self.assertTrue(self.song.is_playing)

    def test_native_replacement_before_confirmation_cannot_press(self):
        before = self.source(); replacement = Clip(); replacement.__dict__.update(self.clip.__dict__)
        self.track.clip_slots[0].clip = replacement
        with self.assertRaisesRegex(ValueError, 'changed'):
            dispatch_request(self.song, {'method': 'hold_session_clip', 'params': {
                **self.target, 'expectedStateVersion': 3, 'durationSeconds': 1, 'before': before}}, 3)
        self.assertEqual(self.calls, [])

    def test_replacement_after_press_releases_original_not_replacement(self):
        replacement = Clip(); replacement.launch_mode = 1; replacement.calls = []
        replacement.set_fire_button_state = replacement.calls.append
        press = self.clip.set_fire_button_state
        def replacing(state):
            press(state)
            if state:
                self.track.clip_slots[0].clip = replacement
        self.clip.set_fire_button_state = replacing
        result = self.start()
        self.assertEqual(result['status'], 'interrupted'); self.assertEqual(self.calls, [True, False])
        self.assertEqual(replacement.calls, []); self.assertIsNone(result['clipId'])

    def test_failed_release_is_retained_and_never_silently_replayed(self):
        press = self.clip.set_fire_button_state
        def failing(state):
            if not state:
                self.calls.append(False); raise RuntimeError('release unavailable')
            press(state)
        self.clip.set_fire_button_state = failing
        result = self.start(); module = importlib.import_module('clip_hold')
        module.advance(self.song, now=module._holds[result['holdId']]['deadline'] + 1)
        observed = self.read(result['holdId']); self.assertEqual(observed['status'], 'cleanup_failed')
        self.assertFalse(observed['releaseCallReturned']); self.assertTrue(observed['cleanupErrors'])
        module.advance(self.song, now=module._holds[result['holdId']]['deadline'] + 2)
        self.assertEqual(self.calls, [True, False]); self.assertEqual(len(self.read()['holds']), 1)

    def test_track_reservation_precedes_deferred_native_playback_flags(self):
        # Live can defer all playback flags until after a press returns.
        self.clip.set_fire_button_state = self.calls.append
        second = Clip(); second.__dict__.update(self.clip.__dict__)
        second_calls = []; second.set_fire_button_state = second_calls.append
        self.track.clip_slots[1] = SimpleNamespace(clip=second, has_clip=True, is_triggered=False)
        first = self.start()
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-1'}
        with self.assertRaisesRegex(ValueError, 'track.*hold'):
            self.start()
        self.assertEqual(self.calls, [True]); self.assertEqual(second_calls, [])
        # Another native track remains independently usable.
        other = Track(); other.clip_slots = [SimpleNamespace(clip=second, has_clip=True, is_triggered=False)]
        self.song.tracks.append(other)
        self.target = {'trackId': 'track-2', 'clipId': 'track-2:clip-0'}
        self.start(); self.assertEqual(second_calls, [True])

    def test_failed_release_reserves_track_until_explicit_retry_succeeds(self):
        def failing(state):
            self.calls.append(state)
            if not state: raise RuntimeError('release unavailable')
        self.clip.set_fire_button_state = failing
        result = self.start(); module = importlib.import_module('clip_hold')
        module.advance(self.song, now=module._holds[result['holdId']]['deadline'] + 1)
        before = dispatch_request(self.song, {'method': 'get_session_clip_hold_source', 'params': {'holdId': result['holdId']}}, 4)
        with self.assertRaisesRegex(ValueError, 'failed release'):
            dispatch_request(self.song, {'method': 'finish_session_clip_hold', 'params': {
                'holdId': result['holdId'], 'expectedStateVersion': 4, 'before': before}}, 4)
        with self.assertRaisesRegex(ValueError, 'track.*hold'):
            self.source()
        self.clip.set_fire_button_state = self.calls.append
        finished = dispatch_request(self.song, {'method': 'finish_session_clip_hold', 'params': {
            'holdId': result['holdId'], 'cancel': True, 'expectedStateVersion': 4, 'before': before}}, 4)
        self.assertTrue(finished['releaseCallReturned']); self.assertTrue(finished['handleReleased'])
        self.source(); self.assertEqual(self.calls, [True, False, False])

    def test_track_insertion_resolves_current_ids_and_releases_original_clip(self):
        result = self.start(); self.song.tracks.insert(0, Track()); module = importlib.import_module('clip_hold')
        self.assertEqual(self.read(result['holdId'])['clipId'], 'track-1:clip-0')
        module.advance(self.song, now=module._holds[result['holdId']]['deadline'] + 1)
        self.assertEqual(self.calls, [True, False])

    def test_early_cancel_uses_stable_finish_context_and_retains_global_playback(self):
        result = self.start(); module = importlib.import_module('clip_hold')
        before = dispatch_request(self.song, {'method': 'get_session_clip_hold_source', 'params': {'holdId': result['holdId']}}, 4)
        self.clip.playing_position = 2.0
        observed = dispatch_request(self.song, {'method': 'finish_session_clip_hold', 'params': {
            'holdId': result['holdId'], 'cancel': True, 'expectedStateVersion': 4, 'before': before}}, 4)
        self.assertTrue(observed['handleReleased']); self.assertTrue(observed['releaseCallReturned'])
        self.assertEqual(self.calls, [True, False]); self.assertTrue(self.song.is_playing)
        self.assertEqual(module.read(self.song, {}, 5)['holds'], [])

    def test_repeat_release_does_not_stop_clip_or_change_mode(self):
        self.clip.launch_mode = 3
        result = self.start(); module = importlib.import_module('clip_hold')
        module.advance(self.song, now=module._holds[result['holdId']]['deadline'] + 1)
        self.assertTrue(self.clip.is_playing); self.assertEqual(self.clip.launch_mode, 3)
        self.assertEqual(self.calls, [True, False])

    def test_active_clip_requires_explicit_allow_playing_and_duplicate_holds_are_refused(self):
        self.clip.is_playing = True; self.track.playing_slot_index = 0
        with self.assertRaisesRegex(ValueError, 'allowPlaying'):
            self.source()
        self.start(allowPlaying=True)
        with self.assertRaisesRegex(ValueError, 'active hold'):
            self.start(allowPlaying=True)
        self.assertEqual(self.calls, [True])

    def test_clip_stop_state_allows_repeated_holds_but_other_session_playback_refuses(self):
        self.track.playing_slot_index = -2  # Native Clip Stop state after Gate release.
        self.start()
        module = importlib.import_module('clip_hold'); module.shutdown(self.song)
        module._holds.clear()
        self.track.playing_slot_index = 1
        with self.assertRaisesRegex(ValueError, 'another Session clip'):
            self.source()
        self.assertEqual(self.calls, [True, False])

    def test_recording_armed_frozen_pending_and_wrong_modes_refuse_before_press(self):
        for owner, field, value in ((self.song, 'record_mode', True), (self.song, 'session_record', True),
                                    (self.song, 'is_playing', False), (self.track, 'arm', True),
                                    (self.track, 'is_frozen', True), (self.track, 'fired_slot_index', 0),
                                    (self.clip, 'launch_mode', 0), (self.clip, 'launch_mode', 2)):
            previous = getattr(owner, field); setattr(owner, field, value)
            with self.assertRaises(ValueError): self.source()
            setattr(owner, field, previous)
        self.assertEqual(self.calls, [])

    def test_invalid_duration_cannot_press_and_press_error_attempts_release(self):
        before = self.source()
        for duration in (True, float('nan'), .1, 9):
            with self.assertRaisesRegex(ValueError, 'duration'):
                dispatch_request(self.song, {'method': 'hold_session_clip', 'params': {
                    **self.target, 'expectedStateVersion': 3, 'durationSeconds': duration, 'before': before}}, 3)
        press = self.clip.set_fire_button_state
        def failing(state):
            press(state)
            if state: raise RuntimeError('press result unknown')
        self.clip.set_fire_button_state = failing
        with self.assertRaisesRegex(RuntimeError, 'hold|press'):
            self.start()
        self.assertEqual(self.calls, [True, False]); self.assertEqual(len(self.read()['holds']), 1)


if __name__ == '__main__': unittest.main()
