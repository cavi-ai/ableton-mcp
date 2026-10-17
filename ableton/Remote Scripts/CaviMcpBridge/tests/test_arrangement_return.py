import copy
import importlib
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Track, ClipSlot, Clip
from bridge import dispatch_request, SocketBridge


class ReturnTrack(Track):
    def __init__(self):
        super().__init__()
        self.clip_slots = [ClipSlot()]
        self.clip_slots[0].clip.is_playing = True
        self.clip_slots[0].clip.is_recording = False
        self.clip_slots[0].clip.is_overdubbing = False
        self.arrangement_clips = []
        self.playing_slot_index = 0
        self._override = True
        self.writes = []
        self.fail = False
        self.defer = False
        self.after_return = None

    @property
    def back_to_arranger(self):
        return self._override

    @back_to_arranger.setter
    def back_to_arranger(self, value):
        self.writes.append(value)
        if self.fail:
            raise RuntimeError('return refused')
        if not self.defer:
            self._override = value
            self.playing_slot_index = -2
            self.clip_slots[0].clip.is_playing = False
        if self.after_return:
            self.after_return()


class ArrangementReturnTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks = [ReturnTrack(), ReturnTrack()]
        self.song.is_playing = True
        self.song.view.selected_track = self.song.tracks[1]
        self.target = {'trackIds': ['track-0']}

    def tearDown(self):
        importlib.import_module('clip_hold')._holds.clear()

    def source(self):
        return dispatch_request(self.song, {'method': 'get_arrangement_return_source', 'params': self.target}, 4)

    def start(self, before=None):
        return dispatch_request(self.song, {'method': 'return_tracks_to_arrangement', 'params': {
            **self.target, 'expectedStateVersion': 4, 'before': before or self.source()}}, 4)

    def test_running_return_only_changes_exact_target_and_does_not_seek_or_stop(self):
        before = self.source()
        self.assertEqual(self.song.tracks[0].writes, [])
        self.song.current_song_time += 2  # A running clock must not invalidate the plan.
        controls = (self.song.is_playing, self.song.current_song_time, self.song.loop,
                    self.song.loop_start, self.song.loop_length, self.song.tempo)
        result = self.start(before)
        self.assertTrue(result['returned']); self.assertFalse(result['partial'])
        self.assertEqual(self.song.tracks[0].writes, [False])
        self.assertEqual(self.song.tracks[1].writes, [])
        self.assertTrue(self.song.tracks[1].back_to_arranger)
        self.assertEqual(controls, (self.song.is_playing, self.song.current_song_time, self.song.loop,
                                  self.song.loop_start, self.song.loop_length, self.song.tempo))
        self.assertIs(self.song.view.selected_track, self.song.tracks[1])
        self.assertFalse(result['playheadWriteRequested'])

    def test_stopped_and_already_returned_track_is_a_no_op(self):
        self.song.is_playing = False
        self.song.tracks[0]._override = False
        self.song.tracks[0].playing_slot_index = -1
        result = self.start()
        self.assertTrue(result['returned']); self.assertEqual(result['requestedTrackIds'], [])
        self.assertEqual(self.song.tracks[0].writes, []); self.assertFalse(self.song.is_playing)

    def test_same_valued_track_or_active_clip_replacement_invalidates_confirmation(self):
        for replacement in ('track', 'clip'):
            before = self.source()
            if replacement == 'track':
                self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            else:
                self.song.tracks[0].clip_slots[0].clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.start(before)
            self.assertEqual(self.song.tracks[0].writes, [])

    def test_changed_arrangement_clip_identity_invalidates_confirmation(self):
        clip = Clip(); clip.start_time = 0; clip.end_time = 4
        clip.is_audio_clip = False
        self.song.tracks[0].arrangement_clips = [clip]
        before = self.source()
        self.song.tracks[0].arrangement_clips[0] = copy.deepcopy(clip)
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.start(before)
        self.assertEqual(self.song.tracks[0].writes, [])

    def test_native_replacement_during_first_write_never_writes_replacement(self):
        first, second = self.song.tracks
        replacement = ReturnTrack()
        first.after_return = lambda: self.song.tracks.__setitem__(1, replacement)
        self.target['trackIds'] = ['track-0', 'track-1']
        result = self.start()
        self.assertTrue(result['partial']); self.assertFalse(result['returned'])
        self.assertEqual(first.writes, [False]); self.assertEqual(second.writes, [])
        self.assertEqual(replacement.writes, [])

    def test_partial_failure_retains_successful_return_without_rollback(self):
        self.target['trackIds'] = ['track-0', 'track-1']
        self.song.tracks[1].fail = True
        result = self.start()
        self.assertTrue(result['partial']); self.assertIn('return refused', result['error'])
        self.assertFalse(self.song.tracks[0].back_to_arranger)
        self.assertTrue(self.song.tracks[1].back_to_arranger)
        self.assertEqual(self.song.tracks[0].writes, [False]); self.assertTrue(self.song.is_playing)

    def test_manual_control_change_stops_remaining_writes_and_reports_partial(self):
        self.target['trackIds'] = ['track-0', 'track-1']
        self.song.tracks[0].after_return = lambda: setattr(self.song, 'loop', not self.song.loop)
        result = self.start()
        self.assertTrue(result['partial']); self.assertFalse(result['verification']['controlsPreserved'])
        self.assertEqual(self.song.tracks[1].writes, [])

    def test_groups_recording_pending_launches_armed_and_frozen_tracks_refuse(self):
        cases = ((self.song, 'record_mode', True), (self.song, 'session_record', True),
                 (self.song, 'is_counting_in', True), (self.song.tracks[0], 'arm', True),
                 (self.song.tracks[0], 'is_frozen', True), (self.song.tracks[0], 'is_foldable', True),
                 (self.song.tracks[0], 'fired_slot_index', -2),
                 (self.song.tracks[0].clip_slots[0].clip, 'is_recording', True))
        for owner, key, value in cases:
            previous = getattr(owner, key, False); setattr(owner, key, value)
            with self.assertRaises(ValueError): self.source()
            setattr(owner, key, previous)
        self.assertEqual(self.song.tracks[0].writes, [])

    def test_unresolved_hold_ownership_refuses_return_until_release(self):
        module = importlib.import_module('clip_hold')
        for status in ('active', 'cleanup_failed'):
            module._holds['owned'] = {'track': self.song.tracks[0], 'status': status}
            with self.assertRaisesRegex(ValueError, 'hold'):
                self.source()
        module._holds.clear()
        self.source()

    def test_malformed_scopes_and_unknown_playback_state_refuse(self):
        for ids in ([], ['master'], ['track-0', 'track-0'], ['track-99'], ['track--1']):
            self.target['trackIds'] = ids
            with self.assertRaises(ValueError): self.source()
        self.target['trackIds'] = ['track-0']; self.song.tracks[0].playing_slot_index = -3
        with self.assertRaises(ValueError): self.source()

    def test_manual_arm_during_readback_prevents_success(self):
        module = importlib.import_module('arrangement_return')
        operation = module.begin(self.song, {**self.target, 'expectedStateVersion': 4, 'before': self.source()}, 4)
        self.song.tracks[0].arm = True
        result = module.complete(self.song, operation, 5)
        self.assertFalse(result['returned']); self.assertFalse(result['verification']['targetsSafe'])
        self.assertTrue(result['partial']); self.assertEqual(self.song.tracks[0].writes, [False])

    def test_failed_readback_schedule_reports_partial_without_repeating_return(self):
        replies = []
        def schedule(delay, callback):
            raise RuntimeError('scheduler unavailable')
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None, schedule_message=schedule)
        client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
        bridge = SocketBridge(surface, '/unused'); bridge.state_version = 4
        bridge.requests.put((client, {'id': 1, 'method': 'return_tracks_to_arrangement', 'params': {
            **self.target, 'expectedStateVersion': 4, 'before': self.source()}}))
        bridge.drain()
        self.assertTrue(replies[0]['result']['partial'])
        self.assertIn('scheduler unavailable', replies[0]['result']['error'])
        self.assertFalse(bridge.deferred_request); self.assertEqual(self.song.tracks[0].writes, [False])

    def test_socket_bridge_observes_deferred_return_without_reissuing_command(self):
        self.song.tracks[0].defer = True
        callbacks = []; replies = []
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
                                  schedule_message=lambda delay, callback: callbacks.append(callback))
        client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
        bridge = SocketBridge(surface, '/unused'); bridge.state_version = 4
        bridge.requests.put((client, {'id': 1, 'method': 'return_tracks_to_arrangement', 'params': {
            **self.target, 'expectedStateVersion': 4, 'before': self.source()}}))
        bridge.drain(); self.assertEqual(replies, []); self.assertTrue(bridge.deferred_request)
        callbacks.pop(0)(); self.assertEqual(replies, [])
        self.song.tracks[0]._override = False; self.song.tracks[0].playing_slot_index = -2
        callbacks.pop(0)()
        self.assertTrue(replies[0]['result']['returned']); self.assertFalse(bridge.deferred_request)
        self.assertEqual(self.song.tracks[0].writes, [False])


if __name__ == '__main__': unittest.main()
