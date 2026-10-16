import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Track, ClipSlot


class PlaybackTrack(Track):
    def __init__(self):
        super().__init__()
        self.clip_slots = [ClipSlot(False)]
        self.arrangement_clips = []
        self.playing_slot_index, self.fired_slot_index = 0, -1
        self._override, self.fail_return = True, False

    @property
    def back_to_arranger(self):
        return self._override

    @back_to_arranger.setter
    def back_to_arranger(self, value):
        if self.fail_return:
            raise RuntimeError("return failed")
        self._override = value
        if not value:
            self.playing_slot_index = -1


class ArrangementAuditionTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks = [PlaybackTrack(), PlaybackTrack()]
        self.song.view.selected_track = self.song.tracks[1]
        self.args = {"startBeats": 8, "endBeats": 16, "trackIds": ["track-0"]}

    def call(self, method, params):
        return dispatch_request(self.song, {"method": method, "params": params}, 4)

    def plan(self):
        return self.call("get_arrangement_audition_source", self.args)

    def start(self, before=None):
        return self.call("audition_arrangement_passage", {**self.args, "expectedStateVersion": 4,
                                                         "before": before or self.plan()})

    def test_plan_is_read_only_and_start_returns_only_requested_track(self):
        before = self.plan()
        self.assertFalse(self.song.is_playing)
        self.assertTrue(self.song.tracks[0].back_to_arranger)
        result = self.start(before)
        self.assertTrue(result["started"])
        self.assertEqual(result["stateVersion"], 5)
        self.assertEqual((self.song.loop_start, self.song.loop_length, self.song.loop), (8, 8, True))
        self.assertEqual(self.song.current_song_time, 8)
        self.assertFalse(self.song.tracks[0].back_to_arranger)
        self.assertTrue(self.song.tracks[1].back_to_arranger)
        self.assertIs(self.song.view.selected_track, self.song.tracks[1])

    def test_unsafe_recording_playback_pending_launches_groups_and_bad_ranges_refuse_before_writes(self):
        for attribute in ("record_mode", "session_record", "is_playing"):
            setattr(self.song, attribute, True)
            with self.assertRaises(ValueError):
                self.plan()
            setattr(self.song, attribute, False)
        self.song.tracks[1].fired_slot_index = 0
        with self.assertRaises(ValueError):
            self.plan()
        self.song.tracks[1].fired_slot_index = -1
        self.song.tracks[0].is_foldable = True
        with self.assertRaises(ValueError):
            self.plan()
        self.song.tracks[0].is_foldable = False
        for change in ({"trackIds": []}, {"trackIds": ["track-0", "track-0"]}, {"trackIds": ["master"]},
                       {"startBeats": -1}, {"endBeats": 8}, {"endBeats": 1000}):
            with self.assertRaises(ValueError):
                self.call("get_arrangement_audition_source", {**self.args, **change})
        self.assertFalse(self.song.is_playing)
        self.assertEqual(self.song.loop_start, 0)

    def test_changed_controls_or_document_refuse_stale_plan(self):
        before = self.plan()
        self.song.tracks[1].mute = True
        with self.assertRaises(ValueError):
            self.start(before)
        self.song.tracks[1].mute = False
        self.plan()
        other = Song()
        other.tracks = self.song.tracks
        dispatch_request(other, {"method": "get_arrangement_audition_source", "params": self.args}, 4)
        with self.assertRaises(ValueError):
            self.start(before)
        self.assertFalse(self.song.is_playing)

    def test_failure_after_a_track_return_reports_partial_controls_without_fake_restoration(self):
        self.args["trackIds"] = ["track-0", "track-1"]
        self.song.tracks[1].fail_return = True
        result = self.start()
        self.assertFalse(result["started"])
        self.assertTrue(result["partial"])
        self.assertIn("return failed", result["error"])
        self.assertFalse(self.song.tracks[0].back_to_arranger)
        self.assertTrue(self.song.tracks[1].back_to_arranger)
        self.assertFalse(self.song.is_playing)
        self.assertTrue(self.song.loop)

    def test_ignored_track_return_is_unverified_even_when_transport_started(self):
        class IgnoredTrack(PlaybackTrack):
            @PlaybackTrack.back_to_arranger.setter
            def back_to_arranger(self, value):
                pass
        self.song.tracks[0] = IgnoredTrack()
        result = self.start()
        self.assertTrue(self.song.is_playing)
        self.assertFalse(result["started"])
        self.assertFalse(result["verification"]["tracksReturned"])
        self.assertTrue(result["partial"])

    def test_track_topology_change_during_start_cannot_be_certified(self):
        def start_with_insertion():
            self.song.is_playing = True
            self.song.tracks.append(PlaybackTrack())
        self.song.start_playing = start_with_insertion
        result = self.start()
        self.assertFalse(result["started"])
        self.assertFalse(result["verification"]["topologyStable"])

    def test_socket_bridge_waits_for_applied_controls_and_never_reissues_playback(self):
        class DeferredSong(Song):
            def __setattr__(self, name, value):
                if self.__dict__.get("defer", False) and name in ("loop", "loop_start", "loop_length", "current_song_time", "is_playing"):
                    self.pending[name] = value
                else:
                    object.__setattr__(self, name, value)
            def start_playing(self):
                self.starts += 1
                self.is_playing = True
        self.song = DeferredSong()
        self.song.tracks = [PlaybackTrack(), PlaybackTrack()]
        self.song.pending, self.song.starts, self.song.defer = {}, 0, True
        song = self.song
        class Surface:
            def song(self):
                return song
            def application(self):
                return None
            def schedule_message(self, delay, callback):
                self.callback = callback
        class Client:
            def __init__(self):
                self.messages = []
            def sendall(self, payload):
                self.messages.append(json.loads(payload))
        surface, client = Surface(), Client()
        bridge = SocketBridge(surface, "/unused")
        bridge.state_version = 4
        bridge.requests.put((client, {"id": 1, "method": "audition_arrangement_passage", "params": {
            **self.args, "expectedStateVersion": 4, "before": self.plan()}}))
        bridge.drain()
        self.assertEqual(client.messages, [])
        self.assertFalse(song.is_playing)
        self.assertEqual(song.starts, 1)
        surface.callback()
        self.assertEqual(client.messages, [])
        self.assertEqual(song.starts, 1)
        for name, value in song.pending.items():
            object.__setattr__(song, name, value)
        surface.callback()
        self.assertTrue(client.messages[0]["result"]["started"])
        self.assertEqual(song.starts, 1)
        self.assertFalse(bridge.deferred_request)


if __name__ == "__main__":
    unittest.main()
