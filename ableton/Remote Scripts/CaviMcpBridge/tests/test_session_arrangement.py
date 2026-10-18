import copy
import os
import sys
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class SessionArrangementTests(unittest.TestCase):
    def setUp(self):
        import session_arrangement as module
        self.module = module
        module._recordings.clear()
        self.song = Song()
        self.song.start_time = 8
        self.song.get_current_beats_song_time = lambda: SimpleNamespace(bars=17, beats=1, sub_division=1, ticks=1)
        self.song.is_counting_in = False
        self.song.count_in_duration = 0
        self.song.current_song_time = 64
        self.song.loop = self.song.punch_in = self.song.punch_out = False
        self.args = {"startBeats": 64, "endBeats": 72}
        for track in self.song.tracks:
            track.is_foldable = False
            track.can_be_armed = True
            track.arm = False
            track.implicit_arm = False
            track.arrangement_clips = []
            for slot in track.clip_slots:
                if slot.has_clip:
                    slot.clip.is_recording = slot.clip.is_triggered = False
                    if not hasattr(slot.clip, 'is_audio_clip'):
                        slot.clip.is_audio_clip = False

    def call(self, name, params=None, version=3):
        if name == 'finish_session_arrangement_recording':
            params = {'expectedStateVersion': version, **(params or {})}
        return dispatch_request(self.song, {"method": name, "params": params or {}}, version)

    def start(self):
        before = self.call("get_session_arrangement_source", self.args)
        return self.call("record_session_arrangement", {**self.args, "expectedStateVersion": 3, "before": before})

    def test_starts_global_recording_without_arms_and_stops_on_native_ticks(self):
        result = self.start()
        self.assertTrue(self.song.record_mode)
        self.assertTrue(self.song.is_playing)
        self.assertFalse(any(t.arm for t in self.song.tracks))
        self.assertEqual(result["status"], "recording")
        # Musical performance changes are allowed; these are what is captured.
        self.song.tracks[0].playing_slot_index = 1
        self.song.tracks[0].mute = True
        self.song.tempo = 110
        self.song.current_song_time = 72.05
        self.module.advance(self.song)
        result = self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})
        self.assertEqual(result["status"], "stopped")
        self.assertTrue(result["stopVerified"])
        self.assertFalse(result["performanceVerified"])
        self.assertTrue(self.song.tracks[0].mute)

    def test_preparation_and_global_recording_scope_must_be_safe(self):
        for change in [lambda: setattr(self.song, "is_playing", True),
                       lambda: setattr(self.song, "current_song_time", 63),
                       lambda: setattr(self.song, "loop", True),
                       lambda: setattr(self.song, "punch_in", True),
                       lambda: setattr(self.song, "session_automation_record", True),
                       lambda: setattr(self.song, "count_in_duration", 4),
                       lambda: setattr(self.song.tracks[1], "arm", True),
                       lambda: setattr(self.song.tracks[1], "implicit_arm", True),
                       lambda: setattr(self.song.tracks[1], "fired_slot_index", 0)]:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.start()
            self.assertFalse(self.song.record_mode)

    def test_existing_material_at_or_after_start_refuses_on_every_track(self):
        clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
        clip.start_time, clip.end_time = 60, 68
        self.song.tracks[1].arrangement_clips = [clip]
        with self.assertRaisesRegex(ValueError, "after|append"):
            self.start()
        clip.end_time = 64
        self.start()

    def test_undo_entry_change_refuses_before_recording(self):
        before = self.call("get_session_arrangement_source", self.args)
        self.song.begin_undo_step = lambda: setattr(self.song.tracks[1], "arm", True)
        with self.assertRaises(ValueError):
            self.call("record_session_arrangement", {**self.args, "expectedStateVersion": 3, "before": before})
        self.assertFalse(self.song.record_mode)
        self.assertEqual(self.module._recordings, {})

    def test_changed_arms_relinquish_ownership_without_stopping_other_recording(self):
        result = self.start()
        self.song.tracks[1].arm = True
        self.module.advance(self.song)
        state = self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})
        self.assertEqual(state["status"], "ownership_lost")
        self.assertTrue(self.song.record_mode)
        self.assertTrue(self.song.is_playing)
        response = self.call("finish_session_arrangement_recording", {"recordingId": result["recordingId"], "cancel": True, "before": state})
        self.assertFalse(response["released"])

    def test_early_stop_confirmation_ignores_growing_clips_and_clock(self):
        result = self.start()
        before = self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})
        self.song.current_song_time = 65
        clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
        clip.start_time, clip.end_time = 64, 65
        self.song.tracks[0].arrangement_clips.append(clip)
        response = self.call("finish_session_arrangement_recording", {"recordingId": result["recordingId"], "cancel": True, "before": before})
        self.assertTrue(response["released"])
        self.assertEqual(response["status"], "cancelled")
        self.assertEqual(len(self.song.tracks[0].arrangement_clips), 1)

    def test_stop_commands_can_settle_on_later_ticks(self):
        result = self.start()
        self.song.stop_playing = lambda: None
        self.song.current_song_time = 72
        self.module.advance(self.song)
        state = self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})
        self.assertEqual(state["status"], "stopping")
        self.assertFalse(state["stopVerified"])
        self.song.is_playing = False
        self.module.advance(self.song)
        self.assertEqual(self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})["status"], "stopped")

    def test_clock_deadline_and_bridge_shutdown_stop_owned_recording(self):
        for shutdown in [False, True]:
            self.setUp()
            result = self.start()
            if shutdown:
                self.module.shutdown(self.song)
            else:
                self.module.advance(self.song, now=time.monotonic()+301)
            state = self.call("get_session_arrangement_recording", {"recordingId": result["recordingId"]})
            self.assertEqual(state["status"], "interrupted")
            self.assertFalse(self.song.record_mode)
            self.assertFalse(self.song.is_playing)

    def test_equal_content_object_replacement_invalidates_start(self):
        before = self.call('get_session_arrangement_source', self.args)
        self.song.tracks[0].clip_slots[0] = copy.deepcopy(self.song.tracks[0].clip_slots[0])
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.call('record_session_arrangement', {**self.args, 'expectedStateVersion': 3, 'before': before})
        self.assertFalse(self.song.record_mode)

    def test_group_arm_getter_is_not_read_and_overview_is_read_only(self):
        group = self.song.tracks[1]
        class Group(type(group)):
            @property
            def arm(self):
                raise RuntimeError('Group arm cannot be read')
        group.__class__ = Group
        group.is_foldable = True
        state = self.call('get_session_arrangement_recording')
        self.assertEqual(state['preparation']['appendAfterBeats'], 0)
        self.assertFalse(self.song.record_mode)
        self.start()

    def test_count_in_is_retained_and_not_misreported_as_failed_start(self):
        self.song.count_in_duration = 2
        self.song.start_playing = lambda: setattr(self.song, 'is_counting_in', True)
        state = self.start()
        self.module.advance(self.song, time.monotonic()+4)
        self.assertEqual(self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})['status'], 'starting')
        self.song.is_counting_in = False
        self.song.is_playing = True
        self.module.advance(self.song)
        self.assertTrue(self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})['recordingActiveObserved'])

    def test_unconfirmed_start_can_be_explicitly_cancelled(self):
        self.song.start_playing = lambda: None
        state = self.start()
        self.module.advance(self.song, time.monotonic()+4)
        before = self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})
        self.assertEqual(before['status'], 'start_unverified')
        result = self.call('finish_session_arrangement_recording', {'recordingId': state['recordingId'], 'cancel': True, 'before': before})
        self.assertFalse(result['released'])
        self.assertFalse(result['stopVerified'])
        self.song.is_playing = True
        self.module.advance(self.song)
        self.assertTrue(self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})['stopVerified'])
        self.assertFalse(self.song.record_mode)

    def test_post_start_undo_error_retains_handle_and_stops_owned_partial_recording(self):
        def fail():
            raise RuntimeError('undo finalization failed')
        self.song.end_undo_step = fail
        state = self.start()
        self.assertEqual(state['status'], 'interrupted')
        self.assertIn('undo finalization failed', state['startError'])
        self.assertTrue(state['stopVerified'])
        self.assertEqual(len(self.call('get_session_arrangement_recording')['recordings']), 1)

    def test_inventory_failure_does_not_block_handle_recovery_or_owned_stop(self):
        state = self.start()
        original = self.module._inventory
        def unavailable(song):
            raise ValueError('clip inventory exceeds limit')
        self.module._inventory = unavailable
        try:
            listing = self.call('get_session_arrangement_recording')
            self.assertEqual(listing['recordings'][0]['recordingId'], state['recordingId'])
            before = self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})
            self.assertFalse(before['capturedClipsAvailable'])
            result = self.call('finish_session_arrangement_recording', {'recordingId': state['recordingId'], 'cancel': True, 'before': before})
            self.assertTrue(result['released'])
            self.assertTrue(result['stopVerified'])
            self.assertIn('exceeds limit', result['inspectionError'])
        finally:
            self.module._inventory = original

    def test_pending_start_shutdown_retains_cleanup_for_native_observation(self):
        self.song.start_playing = lambda: None
        state = self.start()
        self.module.shutdown(self.song)
        pending = self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})
        self.assertFalse(pending['stopVerified'])
        self.assertTrue(pending['controlContext']['cancelRequested'])
        self.song.is_playing = True
        self.module.advance(self.song)
        self.assertTrue(self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})['stopVerified'])

    def test_prepared_playhead_is_used_instead_of_insert_marker(self):
        def start_at_marker():
            self.song.current_song_time = self.song.start_time
            self.song.is_playing = True
        self.song.start_playing = start_at_marker
        result = self.start()
        self.assertEqual(self.song.current_song_time, 64)
        self.assertEqual(self.song.start_time, 64)
        self.assertTrue(result['recordingActiveObserved'])

    def test_unverified_marker_refuses_before_recording_or_registration(self):
        class MarkerSong(type(self.song)):
            @property
            def start_time(self):
                return 8
            @start_time.setter
            def start_time(self, value):
                pass
        self.song.__class__ = MarkerSong
        with self.assertRaisesRegex(ValueError, 'marker'):
            self.start()
        self.assertFalse(self.song.record_mode)
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.module._recordings, {})

    def test_marker_change_after_start_relinquishes_recording_scope(self):
        result = self.start()
        self.song.start_time = 16
        self.module.advance(self.song)
        state = self.call('get_session_arrangement_recording', {'recordingId': result['recordingId']})
        self.assertEqual(state['status'], 'ownership_lost')
        self.assertTrue(self.song.record_mode)

    def test_native_bar_and_multibar_launch_grid_are_required_before_recording(self):
        for position, quantization in [(dict(bars=18, beats=2, sub_division=1, ticks=1), 4),
                                       (dict(bars=18, beats=1, sub_division=1, ticks=1), 1),
                                       (dict(bars=17, beats=1, sub_division=2, ticks=1), 4),
                                       (dict(bars=17, beats=1, sub_division=1, ticks=0), 4),
                                       (dict(bars=17, beats=1, sub_division=1, ticks=2), 4)]:
            self.setUp()
            self.song.get_current_beats_song_time = lambda: SimpleNamespace(**position)
            self.song.clip_trigger_quantization = quantization
            with self.assertRaisesRegex(ValueError, 'bar|grid'):
                self.start()
            self.assertFalse(self.song.record_mode)
            self.assertEqual(self.song.start_time, 8)
        self.setUp()
        self.song.clip_trigger_quantization = 1
        self.assertTrue(self.start()['recordingActiveObserved'])

    def test_multitrack_append_inspection_preserves_each_original_prefix(self):
        originals = []
        for track in self.song.tracks[:2]:
            clip = copy.deepcopy(self.song.tracks[0].clip_slots[0].clip)
            clip.start_time, clip.end_time = 0, 4
            track.arrangement_clips = [clip]
            originals.append(clip)
        result = self.start()
        for track, clip in zip(self.song.tracks[:2], originals):
            appended = copy.deepcopy(clip)
            appended.start_time, appended.end_time = 64, 65
            track.arrangement_clips.append(appended)
        state = self.call('get_session_arrangement_recording', {'recordingId': result['recordingId']})
        self.assertTrue(state['originalClipMetadataPreserved'])
        self.assertEqual([row['startBeats'] for row in state['capturedClips']], [64, 64])

    def test_replaced_reordered_or_removed_originals_make_capture_inspection_uncertain(self):
        for edit in ('replace', 'reorder', 'remove'):
            self.setUp()
            track = self.song.tracks[0]
            first = copy.deepcopy(track.clip_slots[0].clip)
            second = copy.deepcopy(first)
            first.start_time, first.end_time = 0, 4
            second.start_time, second.end_time = 4, 8
            track.arrangement_clips = [first, second]
            result = self.start()
            if edit == 'replace':
                track.arrangement_clips[0] = copy.deepcopy(first)
            elif edit == 'reorder':
                track.arrangement_clips.reverse()
            else:
                track.arrangement_clips.pop(0)
            before = self.call('get_session_arrangement_recording', {'recordingId': result['recordingId']})
            self.assertFalse(before['capturedClipsAvailable'])
            self.assertIsNone(before['originalClipMetadataPreserved'])
            self.assertEqual(before['capturedClips'], [])
            self.assertIn('prefix', before['inspectionError'])
            stopped = self.call('finish_session_arrangement_recording', {'recordingId': result['recordingId'], 'cancel': True, 'before': before})
            self.assertTrue(stopped['stopVerified'])
            self.assertTrue(stopped['released'])

    def test_record_mode_setter_callbacks_cannot_widen_following_transport_commands(self):
        class CallbackSong(type(self.song)):
            @property
            def record_mode(self):
                return self._record_mode

            @record_mode.setter
            def record_mode(self, value):
                self._record_mode = value
                callback = getattr(self, 'record_callback', None)
                if callback:
                    callback()
        self.song._record_mode = self.song.record_mode
        self.song.__class__ = CallbackSong
        self.song.record_callback = lambda: setattr(self.song.tracks[1], 'arm', True)
        result = self.start()
        self.assertEqual(result['status'], 'ownership_lost')
        self.assertTrue(self.song.record_mode)
        self.assertFalse(self.song.is_playing)
        self.setUp()
        state = self.start()
        self.song._record_mode = self.song.record_mode
        self.song.__class__ = CallbackSong
        self.song.record_callback = lambda: setattr(self.song.tracks[1], 'arm', True)
        self.song.current_song_time = 72
        self.module.advance(self.song)
        self.assertFalse(self.song.record_mode)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.call('get_session_arrangement_recording', {'recordingId': state['recordingId']})['status'], 'ownership_lost')


if __name__ == "__main__":
    unittest.main()
