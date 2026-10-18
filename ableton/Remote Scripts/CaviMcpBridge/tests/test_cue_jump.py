import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, CuePoint


class CueJumpTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        for track in self.song.tracks:
            for slot in track.clip_slots:
                if slot.has_clip: slot.clip.is_recording = False
            track.arrangement_clips = []
        self.cue = self.song.cue_points[0]
        self.calls = 0
        def jump():
            self.calls += 1
            if not self.song.is_playing: self.song.current_song_time = self.cue.time
        self.cue.jump = jump

    def read(self):
        return dispatch_request(self.song, {"method":"get_arrangement_cue_jump_context", "params":{"cuePointId":"cue-0"}}, 4)

    def jump(self, before=None):
        return dispatch_request(self.song, {"method":"jump_to_arrangement_cue_point", "params":{
            "cuePointId":"cue-0", "expectedStateVersion":4, "before":self.read() if before is None else before}}, 4)

    def test_stopped_jump_verifies_position_without_starting_or_undo(self):
        selection = self.song.view.selected_track
        result = self.jump()
        self.assertTrue(result["jumpRequested"])
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["positionVerified"])
        self.assertTrue(result["targetRetained"])
        self.assertTrue(result["playbackStatePreserved"])
        self.assertEqual(result["observed"]["currentSongTime"], 16)
        self.assertFalse(self.song.is_playing)
        self.assertIs(self.song.view.selected_track, selection)
        self.assertEqual(self.calls, 1)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_playing_progress_is_not_stale_and_quantized_request_is_not_arrival(self):
        self.song.is_playing = True
        before = self.read()
        self.song.current_song_time += 2
        result = self.jump(before)
        self.assertTrue(result["nativeReturned"])
        self.assertFalse(result["positionVerified"])
        self.assertTrue(result["arrivalMayBeQuantized"])
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.calls, 1)

    def test_same_version_replacement_reorder_name_time_and_transport_changes_refuse(self):
        for change in ("replacement", "reorder", "name", "time", "playback", "position", "loop", "quantization"):
            self.setUp()
            before = self.read()
            if change == "replacement": self.song.cue_points[0] = copy.copy(self.cue)
            elif change == "reorder": self.song.cue_points.insert(0, CuePoint("Other", 2))
            elif change == "name": self.cue.name = "Manual"
            elif change == "time": self.cue.time += 1
            elif change == "playback": self.song.is_playing = True
            elif change == "position": self.song.current_song_time += 1
            elif change == "loop": self.song.loop = True
            else: self.song.clip_trigger_quantization += 1
            with self.assertRaises(ValueError): self.jump(before)
            self.assertEqual(self.calls, 0)

    def test_recording_count_in_unknown_and_active_clip_refuse(self):
        for flag in ("record_mode", "session_record", "is_counting_in"):
            self.setUp(); before = self.read(); setattr(self.song, flag, True)
            with self.assertRaises(ValueError): self.jump(before)
            self.assertEqual(self.calls, 0)
        self.setUp(); del self.song.is_counting_in
        with self.assertRaises(ValueError): self.jump()
        self.setUp(); self.song.tracks[0].clip_slots[0].clip.is_recording = True
        with self.assertRaises(ValueError): self.jump()
        self.assertEqual(self.calls, 0)

    def test_partial_native_failure_is_reported_once_without_replay(self):
        def fail():
            self.calls += 1
            self.song.current_song_time = self.cue.time
            raise RuntimeError("jump failed after applying")
        self.cue.jump = fail
        result = self.jump()
        self.assertTrue(result["jumpRequested"])
        self.assertFalse(result["nativeReturned"])
        self.assertFalse(result["positionVerified"])
        self.assertEqual(result["observed"]["currentSongTime"], 16)
        self.assertIn("failed after applying", result["error"])
        self.assertEqual(self.calls, 1)

    def test_lost_target_and_readback_failure_are_explicit(self):
        self.cue.jump = lambda: self.song.cue_points.clear()
        result = self.jump()
        self.assertFalse(result["targetRetained"])
        self.assertFalse(result["positionVerified"])
        self.assertIn("observationError", result)

    def test_unguarded_noncanonical_and_oversize_requests_refuse(self):
        with self.assertRaises(ValueError):
            dispatch_request(self.song, {"method":"jump_to_arrangement_cue_point", "params":{"cuePointId":"cue-0"}}, 4)
        for cue_id in ("cue-00", "cue--1", "cue-9999"):
            with self.assertRaises(ValueError):
                dispatch_request(self.song, {"method":"get_arrangement_cue_jump_context", "params":{"cuePointId":cue_id}}, 4)
        self.song.cue_points *= 4097
        with self.assertRaises(ValueError): self.read()

    def test_groups_do_not_expose_arrangement_clips_but_children_still_guard_recording(self):
        class Group:
            is_foldable = True
            @property
            def arrangement_clips(self): raise RuntimeError("Group track has no Arrangement clips")
        self.song.tracks.insert(0, Group())
        self.assertTrue(self.jump()["positionVerified"])
        self.song.tracks[1].clip_slots[0].clip.is_recording = True
        with self.assertRaises(ValueError): self.jump()
        self.assertEqual(self.calls, 1)

    def test_socket_observes_later_without_replaying_native_jump(self):
        import json
        from bridge import SocketBridge
        song = self.song
        calls = []
        self.cue.jump = lambda: calls.append("jump")
        class Surface:
            def song(self): return song
            def application(self): return None
            def schedule_message(self, _, callback): self.callback = callback
        class Client:
            def __init__(self): self.messages = []
            def sendall(self, payload): self.messages.append(json.loads(payload))
        surface, client = Surface(), Client()
        bridge = SocketBridge(surface, "/unused")
        before = dispatch_request(song, {"method":"get_arrangement_cue_jump_context", "params":{"cuePointId":"cue-0"}}, bridge.state_version)
        bridge.requests.put((client, {"id":"jump", "method":"jump_to_arrangement_cue_point", "params":{
            "cuePointId":"cue-0", "expectedStateVersion":bridge.state_version, "before":before}}))
        bridge.drain()
        self.assertEqual(client.messages, [])
        self.assertEqual(calls, ["jump"])
        song.current_song_time = self.cue.time
        surface.callback()
        self.assertTrue(client.messages[0]["result"]["positionVerified"])
        self.assertEqual(calls, ["jump"])
        self.assertFalse(bridge.deferred_request)

    def test_lost_song_after_accepted_jump_preserves_dispatch_facts(self):
        import json
        from bridge import SocketBridge
        song = self.song
        calls = []
        self.cue.jump = lambda: calls.append("jump")
        class Surface:
            available = True
            def song(self):
                if not self.available: raise RuntimeError("Song lookup failed")
                return song
            def application(self): return None
            def schedule_message(self, _, callback): self.callback = callback
        class Client:
            def __init__(self): self.messages = []
            def sendall(self, payload): self.messages.append(json.loads(payload))
        surface, client = Surface(), Client()
        bridge = SocketBridge(surface, "/unused")
        before = dispatch_request(song, {"method":"get_arrangement_cue_jump_context", "params":{"cuePointId":"cue-0"}}, bridge.state_version)
        bridge.requests.put((client, {"id":"jump", "method":"jump_to_arrangement_cue_point", "params":{
            "cuePointId":"cue-0", "expectedStateVersion":bridge.state_version, "before":before}}))
        bridge.drain()
        surface.available = False
        surface.callback()
        receipt = client.messages[0]["result"]
        self.assertTrue(receipt["jumpRequested"])
        self.assertTrue(receipt["nativeReturned"])
        self.assertFalse(receipt["positionVerified"])
        self.assertFalse(receipt["targetRetained"])
        self.assertIsNone(receipt["observed"])
        self.assertIn("Song lookup failed", receipt["observationError"])
        self.assertEqual(calls, ["jump"])
        self.assertFalse(bridge.deferred_request)
