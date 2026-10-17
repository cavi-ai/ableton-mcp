import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import arrangement_recording as recording
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Clip


class ArrangementRecordingTests(unittest.TestCase):
    def setUp(self):
        recording._takes.clear()
        self.song = Song()
        for track in self.song.tracks:
            track.arm = False
            track.arrangement_clips = []
            track.playing_slot_index = -1
            track.fired_slot_index = -1
            track.back_to_arranger = False
        self.song.tracks[0].arm = True
        self.args = {'trackId': 'track-0', 'startBeats': 8, 'endBeats': 12}

    def call(self, method, params):
        return dispatch_request(self.song, {'method': method, 'params': params}, 4)

    def plan(self):
        return self.call('get_arrangement_recording_source', self.args)

    def start(self, before=None):
        return self.call('record_arrangement_take', {**self.args, 'before': before or self.plan()})

    def clip(self, start=8, end=12):
        clip = Clip()
        clip.start_time, clip.end_time, clip.length = start, end, end-start
        clip.is_audio_clip = False
        clip.is_recording = False
        self.song.tracks[0].arrangement_clips.append(clip)
        return clip

    def test_plan_is_inert_and_start_uses_native_punch_window(self):
        before = self.plan()
        self.assertFalse(self.song.record_mode)
        result = self.start(before)
        self.assertTrue(result['recordingRequested'])
        self.assertTrue(self.song.record_mode)
        self.assertTrue(self.song.is_playing)
        self.assertEqual((self.song.loop_start, self.song.loop_length, self.song.loop), (8, 4, False))
        self.assertTrue(self.song.punch_in and self.song.punch_out)
        self.assertFalse(self.song.session_automation_record)
        self.assertTrue(self.song.tracks[0].arm)

    def test_unsafe_states_refuse_without_writing(self):
        for change in [lambda: setattr(self.song, 'is_playing', True), lambda: setattr(self.song, 'record_mode', True),
                       lambda: setattr(self.song, 'session_record', True), lambda: setattr(self.song.tracks[1], 'arm', True),
                       lambda: setattr(self.song.tracks[0], 'is_frozen', True), lambda: setattr(self.song.tracks[0], 'back_to_arranger', True),
                       lambda: setattr(self.song.tracks[1], 'back_to_arranger', True), lambda: setattr(self.song.tracks[1], 'playing_slot_index', 0),
                       lambda: setattr(self.song.tracks[1], 'fired_slot_index', 0), lambda: self.clip(10, 14)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError): self.plan()
        self.setUp()
        for params in [{'startBeats': -1}, {'endBeats': 8}, {'endBeats': 1000}, {'startBeats': True}]:
            with self.assertRaises(ValueError): self.call('get_arrangement_recording_source', {**self.args, **params})
        self.assertFalse(self.song.is_playing)

    def test_changed_target_or_routing_invalidates_plan(self):
        before = self.plan()
        self.song.tracks[0].name = 'Changed'
        with self.assertRaises(ValueError): self.start(before)
        self.assertFalse(self.song.record_mode)

    def test_bridge_tick_ends_owned_recording_without_a_client_and_keeps_material(self):
        result = self.start()
        clip = self.clip()
        self.song.current_song_time = 12.1
        bridge = SocketBridge(SimpleNamespace(song=lambda: self.song), '/tmp/not-started-arrangement-test.sock')
        bridge.drain()
        self.assertFalse(self.song.record_mode)
        self.assertFalse(self.song.is_playing)
        self.assertTrue(self.song.tracks[0].arm)
        observed = self.call('get_arrangement_take', {'takeId': result['takeId']})
        self.assertEqual(observed['status'], 'stopped')
        self.assertTrue(observed['rangeCovered'])
        self.assertIs(self.song.tracks[0].arrangement_clips[0], clip)
        self.assertFalse(observed['performanceVerified'])

    def test_user_control_change_loses_ownership_without_stopping_their_transport(self):
        result = self.start()
        self.song.tracks[1].arm = True
        self.song.current_song_time = 13
        recording.advance(self.song)
        self.assertTrue(self.song.record_mode)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'ownership_lost')

    def test_cancel_retains_partial_take_and_requires_current_control_context(self):
        result = self.start()
        clip = self.clip(8, 9)
        before = self.call('get_arrangement_take', {'takeId': result['takeId']})
        self.call('finish_arrangement_take', {'takeId': result['takeId'], 'cancel': True, 'before': before})
        self.assertFalse(self.song.record_mode)
        self.assertFalse(self.song.is_playing)
        self.assertIs(self.song.tracks[0].arrangement_clips[0], clip)

    def test_start_failure_after_record_request_keeps_inspectable_handle(self):
        self.song.start_playing = lambda: (_ for _ in ()).throw(RuntimeError('start failed'))
        result = self.start()
        self.assertFalse(result['recordingVerified'])
        self.assertTrue(result['takeId'])
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'starting')
        self.assertTrue(recording.has_active())
        self.song.is_playing = True
        recording.advance(self.song)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'start_failed')
        self.assertFalse(self.song.record_mode)

    def test_count_in_does_not_end_the_take_before_the_input_window(self):
        result = self.start()
        self.song.is_counting_in = True
        self.song.current_song_time = 4
        recording.advance(self.song)
        self.assertTrue(self.song.record_mode)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'recording')

    def test_lost_handle_can_be_released_after_user_stops_transport(self):
        result = self.start()
        self.song.tracks[1].arm = True
        recording.advance(self.song)
        self.song.record_mode, self.song.is_playing = False, False
        before = self.call('get_arrangement_take', {'takeId': result['takeId']})
        self.assertTrue(self.call('finish_arrangement_take', {'takeId': result['takeId'], 'before': before})['released'])

    def test_deferred_start_and_stop_keep_tick_ownership_without_reissuing_commands(self):
        queued = []
        self.song.start_playing = lambda: queued.append('start')
        self.song.stop_playing = lambda: queued.append('stop')
        result = self.start()
        self.assertEqual(result['status'], 'starting')
        self.assertTrue(recording.has_active())
        self.assertEqual(queued, ['start'])
        self.song.is_playing = True
        recording.advance(self.song)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'recording')
        self.song.current_song_time = 12.1
        recording.advance(self.song)
        self.assertEqual(queued, ['start', 'stop'])
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'stopping')
        recording.advance(self.song)
        self.assertEqual(queued, ['start', 'stop'])
        self.song.is_playing = False
        recording.advance(self.song)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'stopped')

    def test_deferred_record_flag_is_observed_without_claiming_failed_cleanup(self):
        class DeferredSong(Song):
            def __setattr__(self, key, value):
                if key == 'record_mode' and getattr(self, 'defer_record', False):
                    self.pending_record = value
                else:
                    super().__setattr__(key, value)
        self.song.__class__ = DeferredSong
        self.song.defer_record = True
        result = self.start()
        self.assertEqual(result['status'], 'starting')
        self.song.defer_record = False
        self.song.record_mode = self.song.pending_record
        recording.advance(self.song)
        self.song.defer_record = True
        self.song.current_song_time = 12.1
        recording.advance(self.song)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'stopping')
        self.song.defer_record = False
        self.song.record_mode = self.song.pending_record
        recording.advance(self.song)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'stopped')

    def test_cancel_during_pending_setup_keeps_the_handle_until_start_and_stop_settle(self):
        class DeferredSong(Song):
            def __setattr__(self, key, value):
                if key in ('loop_start', 'record_mode') and getattr(self, 'defer_setup', False):
                    self.pending[key] = value
                else:
                    super().__setattr__(key, value)
        self.song.__class__ = DeferredSong
        self.song.pending, self.song.defer_setup = {}, True
        self.song.start_playing = lambda: None
        result = self.start()
        before = self.call('get_arrangement_take', {'takeId': result['takeId']})
        cancelled = self.call('finish_arrangement_take', {'takeId': result['takeId'], 'cancel': True, 'before': before})
        self.assertFalse(cancelled['released'])
        self.assertTrue(recording.has_active())
        self.song.defer_setup = False
        for key, value in self.song.pending.items(): setattr(self.song, key, value)
        self.song.is_playing = True
        recording.advance(self.song)
        self.assertFalse(self.song.is_playing)
        self.assertFalse(self.song.record_mode)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'cancelled')

    def test_late_start_after_observation_deadline_is_still_owned_and_stopped(self):
        self.song.start_playing = lambda: None
        result = self.start()
        recording.advance(self.song, now=recording._takes[result['takeId']]['startDeadline']+1)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'start_unverified')
        self.song.is_playing = True
        recording.advance(self.song)
        self.song.current_song_time = 12.1
        recording.advance(self.song)
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.call('get_arrangement_take', {'takeId': result['takeId']})['status'], 'stopped')
