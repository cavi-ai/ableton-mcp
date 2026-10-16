import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import audio_capture
from bridge import SocketBridge, dispatch_request
from test_dispatch import Song, Track, AudioClip


class CaptureSlot:
    def __init__(self, path):
        self.path, self.has_clip, self.is_triggered, self.stops = path, False, False, 0

    def fire(self, record_length, launch_quantization):
        self.clip = AudioClip()
        self.clip.file_path = self.path
        self.clip.is_recording, self.clip.is_playing = True, True
        self.clip.stop = self.stop
        self.has_clip = True
        self.length, self.quantization = record_length, launch_quantization

    def stop(self):
        self.stops += 1
        self.is_triggered = False
        if self.has_clip:
            self.clip.is_recording, self.clip.is_playing = False, False


class AudioCaptureTests(unittest.TestCase):
    def setUp(self):
        audio_capture._captures.clear()
        self.file = tempfile.NamedTemporaryFile()
        self.file.write(b"audio" * 1024)
        self.file.flush()
        self.song = Song()
        self.song.is_playing = True
        self.original_tracks = list(self.song.tracks)

        def create(index):
            track = Track()
            track.has_midi_input, track.has_audio_input = False, True
            track.devices = []
            track.available_input_routing_types = [SimpleNamespace(identifier="resample", display_name="Resampling")]
            track.clip_slots = [CaptureSlot(self.file.name)]
            self.song.tracks.insert(index, track)
        self.song.create_audio_track = create
        self.song.delete_track = lambda index: self.song.tracks.pop(index)

    def tearDown(self):
        audio_capture._captures.clear()
        self.file.close()

    def read_source(self):
        return dispatch_request(self.song, {"method": "get_audio_capture_source", "params": {}}, 4)

    def start(self, **extra):
        return dispatch_request(self.song, {"method": "capture_live_audio", "params": {
            "expectedStateVersion": 4, "before": self.read_source(), "beats": 4, "name": "Listen", **extra}}, 4)

    def get(self, capture_id):
        return audio_capture.read(self.song, {"captureId": capture_id}, 5)

    def test_capture_is_quiet_and_source_playback_and_controls_are_preserved(self):
        original = [(t.arm, t.mute, t.solo, t.current_monitoring_state) for t in self.song.tracks]
        result = self.start()
        track = self.song.tracks[-1]
        self.assertTrue(track.mute)
        self.assertTrue(track.arm)
        self.assertFalse(track.solo)
        self.assertEqual(track.current_monitoring_state, 2)
        self.assertEqual(track.current_input_routing, "Resampling")
        self.assertEqual(track.clip_slots[0].length, 4)
        self.assertEqual(track.clip_slots[0].quantization, 0)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(original, [(t.arm, t.mute, t.solo, t.current_monitoring_state) for t in self.original_tracks])
        self.assertEqual(result["status"], "recording")

    def test_draining_without_client_requests_stops_disarms_and_waits_for_stable_file(self):
        result = self.start()
        track = self.song.tracks[-1]
        track.clip_slots[0].clip.is_recording = False
        bridge = SocketBridge(SimpleNamespace(song=lambda: self.song), "unused")
        for _ in range(3):
            bridge.drain()
        observed = self.get(result["captureId"])
        self.assertEqual(observed["status"], "file_ready")
        self.assertFalse(track.arm)
        self.assertFalse(track.clip_slots[0].clip.is_playing)
        self.assertTrue(observed["fileUnchanged"])
        self.assertEqual(observed["file"]["path"], os.path.realpath(self.file.name))
        self.assertTrue(self.song.is_playing)

    def test_plan_binds_controls_but_not_advancing_playhead(self):
        before = self.read_source()
        self.song.current_song_time += 4
        result = audio_capture.start(self.song, {"expectedStateVersion": 4, "before": before, "beats": 4, "name": "Listen"}, 4)
        self.assertEqual(result["status"], "recording")
        audio_capture._captures.clear()
        self.song.tracks.pop()
        before = self.read_source()
        self.song.tempo = 140
        with self.assertRaisesRegex(ValueError, "changed"):
            audio_capture.start(self.song, {"expectedStateVersion": 4, "before": before, "beats": 4, "name": "Listen"}, 4)

    def test_stopped_recording_and_armed_conflicts_refuse_before_creating_track(self):
        for target, attribute, value in [(self.song, "is_playing", False), (self.song, "record_mode", True),
                                         (self.song, "session_record", True), (self.song.tracks[0], "arm", True)]:
            old = getattr(target, attribute)
            setattr(target, attribute, value)
            with self.subTest(attribute=attribute), self.assertRaises(ValueError):
                self.start()
            self.assertEqual(self.song.tracks, self.original_tracks)
            setattr(target, attribute, old)

    def test_group_tracks_have_no_readable_arm_state(self):
        class GroupTrack(Track):
            can_be_armed = False

            @property
            def arm(self):
                raise RuntimeError("Main and Return Tracks have no 'Arm' state!")

            @arm.setter
            def arm(self, value):
                pass

        group = GroupTrack()
        group.is_foldable, group.clip_slots = True, []
        self.song.tracks.insert(0, group)
        self.assertEqual(self.start()["status"], "recording")

    def test_bounds_reject_without_creating_tracks(self):
        for beats in [0, 17, float("inf"), True, "4"]:
            with self.subTest(beats=beats), self.assertRaises(ValueError):
                self.start(beats=beats)
        self.song.tempo = 10
        with self.assertRaisesRegex(ValueError, "30"):
            self.start(beats=16)
        self.assertEqual(self.song.tracks, self.original_tracks)

    def test_cancel_stops_own_recording_and_releases_handle_without_deleting_audio(self):
        result = self.start()
        before = self.get(result["captureId"])
        ended = audio_capture.finish(self.song, {"captureId": result["captureId"], "cancel": True,
            "expectedStateVersion": 5, "before": before}, 5)
        self.assertEqual(ended["status"], "cancelled")
        self.assertFalse(self.song.tracks[-1].arm)
        self.assertTrue(self.song.tracks[-1].clip_slots[0].has_clip)
        self.assertEqual(len(self.song.tracks), 3)
        self.assertEqual(audio_capture.read(self.song, {}, 6)["captures"], [])

    def test_deadline_and_manual_input_changes_abort_and_leave_source_playing(self):
        for changed in ("deadline", "route", "mute"):
            result = self.start()
            record = audio_capture._captures[result["captureId"]]
            if changed == "route":
                record["track"].current_input_routing = "Ext. In"
            elif changed == "mute":
                record["track"].mute = False
            audio_capture.advance(self.song, now=record["deadline"] + 1 if changed == "deadline" else record["deadline"] - 1)
            self.assertIn(self.get(result["captureId"])["status"], ("timed_out", "interrupted"))
            self.assertFalse(record["track"].arm)
            self.assertTrue(self.song.is_playing)
            self.song.tracks.pop()

    def test_reordered_tracks_resolve_native_objects_and_wrong_document_is_rejected(self):
        result = self.start()
        self.song.tracks.insert(0, self.song.tracks.pop())
        self.assertEqual(self.get(result["captureId"])["trackId"], "track-0")
        with self.assertRaises(ValueError):
            audio_capture.read(Song(), {"captureId": result["captureId"]}, 5)

    def test_recorded_file_edit_is_reported_as_stale(self):
        result = self.start()
        self.song.tracks[-1].clip_slots[0].clip.is_recording = False
        for _ in range(3):
            audio_capture.advance(self.song)
        self.file.write(b"changed")
        self.file.flush()
        self.assertFalse(self.get(result["captureId"])["fileUnchanged"])

    def test_bridge_shutdown_stops_and_disarms_own_capture(self):
        self.start()
        audio_capture.shutdown(self.song)
        self.assertFalse(self.song.tracks[-1].arm)
        self.assertFalse(self.song.tracks[-1].clip_slots[0].clip.is_recording)
        self.assertTrue(self.song.is_playing)

    def test_own_session_recording_flag_is_not_a_conflicting_recording(self):
        result = self.start()
        self.song.session_record = True
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "recording")

    def test_arming_another_track_interrupts_capture_without_disarming_it(self):
        result = self.start()
        self.song.tracks[0].arm = True
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "interrupted")
        self.assertTrue(self.song.tracks[0].arm)
        self.assertFalse(self.song.tracks[-1].arm)

    def test_stop_waits_for_native_readback_on_a_later_tick(self):
        result = self.start()
        record = audio_capture._captures[result["captureId"]]
        clip = record["clip"]
        clip.stop = lambda: None
        ended = audio_capture.finish(self.song, {"captureId": result["captureId"], "cancel": True,
            "expectedStateVersion": 5, "before": self.get(result["captureId"])}, 5)
        self.assertEqual(ended["status"], "stopping")
        self.assertTrue(ended["captureActive"])
        self.assertFalse(record["track"].arm)
        clip.is_recording, clip.is_playing = False, False
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "cancelled")

    def test_transport_stop_ends_only_capture_and_does_not_restart_playback(self):
        result = self.start()
        self.song.is_playing = False
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "interrupted")
        self.assertFalse(self.song.tracks[-1].arm)
        self.assertFalse(self.song.is_playing)

    def test_preparation_failure_removes_only_new_capture_track(self):
        create = self.song.create_audio_track

        def wrong_routes(index):
            create(index)
            self.song.tracks[index].available_input_routing_types = []
        self.song.create_audio_track = wrong_routes
        with self.assertRaisesRegex(ValueError, "Resampling"):
            self.start()
        self.assertEqual(self.song.tracks, self.original_tracks)

    def test_insert_then_raise_cleans_up_exact_created_track(self):
        create = self.song.create_audio_track

        def broken(index):
            create(index)
            raise RuntimeError("insert failed")
        self.song.create_audio_track = broken
        with self.assertRaisesRegex(RuntimeError, "insert failed"):
            self.start()
        self.assertEqual(self.song.tracks, self.original_tracks)

    def test_finalization_does_not_claim_stability_when_recording_restarts(self):
        result = self.start()
        clip = self.song.tracks[-1].clip_slots[0].clip
        clip.is_recording = False
        audio_capture.advance(self.song)
        clip.is_recording = True
        for _ in range(3):
            audio_capture.advance(self.song)
        self.assertNotEqual(self.get(result["captureId"])["status"], "complete")

    def test_cleanup_failure_keeps_handle_and_explicit_cancel_can_retry_after_repair(self):
        result = self.start()
        track = self.song.tracks[-1]
        stop = track.clip_slots[0].clip.stop
        track.clip_slots[0].clip.stop = lambda: (_ for _ in ()).throw(RuntimeError("stop refused"))
        self.song.is_playing = False
        audio_capture.advance(self.song)
        before = self.get(result["captureId"])
        self.assertEqual(before["status"], "cleanup_failed")
        self.assertTrue(before["cleanupErrors"])
        self.assertFalse(track.arm)
        track.clip_slots[0].clip.stop = stop
        ended = audio_capture.finish(self.song, {"captureId": result["captureId"], "cancel": True,
            "expectedStateVersion": 5, "before": before}, 5)
        self.assertEqual(ended["status"], "cancelled")
        self.assertEqual(ended["cleanupErrors"], [])

    def test_replaced_slot_stops_bound_capture_without_stopping_replacement(self):
        result = self.start()
        slot = self.song.tracks[-1].clip_slots[0]
        owned = slot.clip
        replacement = AudioClip()
        replacement.is_recording, replacement.is_playing = False, True
        # The bound clip remains valid after moving; its stop must not act on slot.clip.
        owned.stop = lambda: (setattr(owned, "is_recording", False), setattr(owned, "is_playing", False))
        slot.clip = replacement
        audio_capture.advance(self.song)
        self.assertFalse(owned.is_recording)
        self.assertTrue(replacement.is_playing)
        self.assertEqual(self.get(result["captureId"])["cleanupErrors"], [])

    def test_invalid_native_file_reference_does_not_break_reads_or_listing(self):
        result = self.start()
        record = audio_capture._captures[result["captureId"]]

        class InvalidClip:
            @property
            def file_path(self):
                raise RuntimeError("native clip was deleted")
        record.update(clip=InvalidClip(), status="interrupted")
        self.assertIsNone(self.get(result["captureId"])["partialSourcePath"])
        self.assertEqual(len(audio_capture.read(self.song, {}, 5)["captures"]), 1)
        ended = audio_capture.finish(self.song, {"captureId": result["captureId"], "expectedStateVersion": 5,
            "before": self.get(result["captureId"])}, 5)
        self.assertFalse(ended["captureActive"])

    def test_pending_launch_cancellation_requires_readback(self):
        result = self.start()
        record = audio_capture._captures[result["captureId"]]
        slot = record["slot"]
        slot.has_clip, slot.is_triggered, record["clip"] = False, True, None
        slot.stop = lambda: None
        before = self.get(result["captureId"])
        ended = audio_capture.finish(self.song, {"captureId": result["captureId"], "cancel": True,
            "expectedStateVersion": 5, "before": before}, 5)
        self.assertEqual(ended["status"], "stopping")
        audio_capture.advance(self.song, now=record["stopDeadline"] + 1)
        self.assertEqual(self.get(result["captureId"])["status"], "cleanup_failed")

    def test_pending_launch_materializing_during_stop_is_still_recording(self):
        result = self.start()
        record = audio_capture._captures[result["captureId"]]
        slot = record["slot"]
        clip = slot.clip
        slot.has_clip, slot.is_triggered, record["clip"] = False, True, None
        slot.stop = lambda: None
        audio_capture.finish(self.song, {"captureId": result["captureId"], "cancel": True,
            "expectedStateVersion": 5, "before": self.get(result["captureId"])}, 5)
        slot.has_clip, slot.is_triggered = True, False
        clip.stop = lambda: None
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "stopping")
        self.assertIs(record["clip"], clip)
        clip.is_recording, clip.is_playing = False, False
        audio_capture.advance(self.song)
        self.assertEqual(self.get(result["captureId"])["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
