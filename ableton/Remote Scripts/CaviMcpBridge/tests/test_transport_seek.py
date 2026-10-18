import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song


class TransportSeekTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        for track in self.song.tracks:
            track.arrangement_clips = []
            for slot in track.clip_slots:
                if slot.has_clip: slot.clip.is_recording = False

    def read(self):
        return dispatch_request(self.song, {"method":"get_transport_seek_context"}, 4)

    def seek(self, before=None, **extra):
        return dispatch_request(self.song, {"method":"set_transport_recording_context", "params":{
            "expectedStateVersion":4, "before":self.read() if before is None else before,
            "changes":{"currentSongTime":32, **extra}}}, 4)

    def test_stopped_absolute_seek_and_scoped_flags_are_verified(self):
        result = self.seek(automationArm=True, arrangement={"punchIn":False})
        self.assertTrue(result["verification"]["controlsConfirmed"])
        self.assertTrue(result["verification"]["positionVerified"])
        self.assertTrue(result["targetRetained"])
        self.assertEqual(result["observed"]["currentSongTime"], 32)
        self.assertFalse(self.song.is_playing)
        self.assertTrue(self.song.session_automation_record)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_playing_clock_progress_does_not_invalidate_absolute_seek(self):
        self.song.is_playing = True
        before = self.read()
        self.song.current_song_time += 3
        result = self.seek(before)
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["seek"]["nativeReturned"])
        self.assertFalse(result["verification"]["positionVerified"])
        self.assertTrue(result["verification"]["controlFieldsConfirmed"])
        self.assertEqual(result["verification"]["unverifiedFields"], ["currentSongTime"])
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.current_song_time, 32)

    def test_stopped_clock_modes_layout_and_set_replacement_refuse(self):
        for change in ("position", "playback", "automation", "tracks", "song"):
            self.setUp(); before = self.read()
            if change == "position": self.song.current_song_time += 1
            elif change == "playback": self.song.is_playing = True
            elif change == "automation": self.song.session_automation_record = True
            elif change == "tracks": self.song.tracks.reverse()
            else: self.song = copy.deepcopy(self.song)
            with self.assertRaises(ValueError): self.seek(before)
            self.assertNotEqual(self.song.current_song_time, 32)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_recording_count_in_and_unknown_clip_state_refuse_even_stop_and_seek(self):
        for flag in ("record_mode", "session_record", "is_counting_in"):
            self.setUp(); setattr(self.song, flag, True)
            with self.assertRaises(ValueError): self.seek(arrangement={"record":False})
            self.assertEqual(self.song.current_song_time, 4)
        self.setUp(); del self.song.is_counting_in
        with self.assertRaises(ValueError): self.seek()
        self.setUp(); self.song.tracks[0].clip_slots[0].clip.is_recording = True
        with self.assertRaises(ValueError): self.seek()

    def test_partial_seek_failure_is_retained_without_rollback(self):
        class Uncertain(Song):
            @property
            def current_song_time(item): return item.position
            @current_song_time.setter
            def current_song_time(item, value):
                item.position = value
                item.calls += 1
                raise RuntimeError("seek failed after applying")
        song = Uncertain.__new__(Uncertain); song.__dict__.update(self.song.__dict__)
        song.position, song.calls = 4, 0
        self.song = song
        result = self.seek()
        self.assertTrue(result["seek"]["writeRequested"])
        self.assertFalse(result["seek"]["nativeReturned"])
        self.assertFalse(result["verification"]["controlsConfirmed"])
        self.assertEqual(result["observed"]["currentSongTime"], 32)
        self.assertEqual(song.calls, 1)
        self.assertIn("after applying", result["error"])

    def test_later_control_failure_does_not_restore_old_playhead(self):
        class Rejecting(Song):
            @property
            def metronome(item): return item.click
            @metronome.setter
            def metronome(item, value): raise RuntimeError("click rejected")
        song = Rejecting.__new__(Rejecting); song.__dict__.update(self.song.__dict__); song.click = False
        self.song = song
        result = self.seek(metronome=True)
        self.assertEqual(song.current_song_time, 32)
        self.assertTrue(result["seek"]["nativeReturned"])
        self.assertFalse(result["nativeReturned"])
        self.assertIn("click rejected", result["error"])

    def test_undo_entry_change_prevents_seek_and_noop_creates_no_undo(self):
        before = self.read()
        self.song.begin_undo_step = lambda: setattr(self.song, "session_automation_record", True)
        with self.assertRaises(ValueError): self.seek(before)
        self.assertEqual(self.song.current_song_time, 4)
        self.setUp(); self.song.current_song_time = 32
        result = self.seek()
        self.assertFalse(result["seek"]["writeRequested"])
        self.assertFalse(result["nativeReturned"])
        self.assertTrue(result["verification"]["positionVerified"])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_groups_and_limits_and_malformed_changes(self):
        class Group:
            is_foldable = True
            @property
            def arrangement_clips(self): raise RuntimeError("Group clips unavailable")
        self.song.tracks.insert(0, Group())
        self.assertTrue(self.seek()["verification"]["positionVerified"])
        self.setUp()
        with self.assertRaises(ValueError): self.seek(arrangement={"record":1})
        with self.assertRaises(ValueError): self.seek(unknown=True)
        self.song.tracks *= 129
        with self.assertRaises(ValueError): self.read()

    def test_socket_observes_once_and_preserves_receipt_if_song_disappears(self):
        song = self.song
        class Surface:
            available = True
            def song(self):
                if not self.available: raise RuntimeError("Song unavailable")
                return song
            def application(self): return None
            def schedule_message(self, _, callback): self.callback = callback
        class Client:
            def __init__(self): self.messages = []
            def sendall(self, payload): self.messages.append(json.loads(payload))
        surface, client = Surface(), Client()
        bridge = SocketBridge(surface, "/unused")
        before = dispatch_request(song, {"method":"get_transport_seek_context"}, bridge.state_version)
        bridge.requests.put((client, {"id":"seek", "method":"set_transport_recording_context", "params":{
            "expectedStateVersion":bridge.state_version,"before":before,"changes":{"currentSongTime":32}}}))
        bridge.drain(); self.assertEqual(client.messages, [])
        surface.available = False; surface.callback()
        result = client.messages[0]["result"]
        self.assertTrue(result["seek"]["nativeReturned"])
        self.assertIsNone(result["observed"])
        self.assertFalse(result["targetRetained"])
        self.assertIn("Song unavailable", result["observationError"])
        self.assertFalse(bridge.deferred_request)

    def test_unapplied_position_does_not_fail_static_control_verification(self):
        class Ignored(Song):
            @property
            def current_song_time(item): return 4
            @current_song_time.setter
            def current_song_time(item, value): pass
        song = Ignored.__new__(Ignored); song.__dict__.update(self.song.__dict__); self.song = song
        result = self.seek(automationArm=True)
        self.assertFalse(result["verification"]["positionVerified"])
        self.assertTrue(result["verification"]["controlFieldsConfirmed"])
        self.assertEqual(result["verification"]["mismatches"], ["currentSongTime"])

    def test_intervening_record_start_stops_forward_writes_without_rollback(self):
        class Changed(Song):
            @property
            def current_song_time(item): return item.position
            @current_song_time.setter
            def current_song_time(item, value):
                item.position = value
                item.record_mode = True
        song = Changed.__new__(Changed); song.__dict__.update(self.song.__dict__); song.position = 4; self.song = song
        result = self.seek(metronome=True, arrangement={"record":False})
        self.assertTrue(song.record_mode)
        self.assertFalse(song.metronome)
        self.assertEqual(song.current_song_time, 32)
        self.assertEqual([r["field"] for r in result["writes"]], ["currentSongTime"])
        self.assertFalse(result["verification"]["controlsConfirmed"])
        self.assertIsNotNone(result["error"])
