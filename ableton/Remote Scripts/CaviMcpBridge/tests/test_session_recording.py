import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class SessionRecordingTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks[0].arm = True
        self.args = {"trackId": "track-0", "clipId": "track-0:clip-1", "recordLengthBeats": 4,
                     "expectedStateVersion": 3, "launchQuantization": 1}

    def source(self):
        return dispatch_request(self.song, {"method": "get_session_recording_source", "params": self.args}, 3)

    def fire(self, before):
        return dispatch_request(self.song, {"method": "launch_clip", "params": {**self.args, "beforeRecording": before}}, 3)

    def test_readiness_read_is_inert_and_recording_receipt_is_not_completion(self):
        before = self.source()
        slot = self.song.tracks[0].clip_slots[1]
        self.assertFalse(slot.has_clip)
        result = self.fire(before)
        self.assertTrue(result["recordingRequested"])
        self.assertFalse(result["recordingVerified"])
        self.assertEqual(slot.last_record_length, 4)
        self.assertFalse(self.song.tracks[1].arm)

    def test_input_monitoring_and_native_slot_replacement_invalidate_confirmation(self):
        for change in [lambda: setattr(self.song.tracks[0], "current_input_routing", "No Input"),
                       lambda: setattr(self.song.tracks[0], "current_monitoring_state", 2),
                       lambda: self.song.tracks[0].clip_slots.__setitem__(1, copy.deepcopy(self.song.tracks[0].clip_slots[1]))]:
            self.setUp()
            before = self.source()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.fire(before)
            self.assertFalse(self.song.tracks[0].clip_slots[1].has_clip)

    def test_refuses_other_arms_recording_pending_launches_and_missing_guard(self):
        for change in [lambda: setattr(self.song.tracks[1], "arm", True),
                       lambda: setattr(self.song, "record_mode", True),
                       lambda: setattr(self.song, "session_record", True),
                       lambda: setattr(self.song.tracks[1], "fired_slot_index", 0),
                       lambda: setattr(self.song.tracks[0].clip_slots[0].clip, "is_recording", True)]:
            self.setUp()
            before = self.source()
            change()
            with self.assertRaises(ValueError):
                self.fire(before)
            self.assertFalse(self.song.tracks[0].clip_slots[1].has_clip)
        self.setUp()
        with self.assertRaisesRegex(ValueError, "changed"):
            self.fire(None)

    def test_incoming_midi_capture_readiness_and_advancing_clock_do_not_invalidate_plan(self):
        before = self.source()
        self.song.can_capture_midi = not self.song.can_capture_midi
        self.song.current_song_time += 1
        self.fire(before)

    def test_clip_reads_expose_recording_and_pending_launch_evidence(self):
        clip = self.song.tracks[0].clip_slots[0].clip
        clip.is_recording, clip.is_triggered = True, True
        result = dispatch_request(self.song, {"method": "list_clips", "params": {"trackId": "track-0"}}, 3)
        self.assertTrue(result["clips"][0]["isRecording"])
        self.assertTrue(result["clips"][0]["isTriggered"])
        self.assertFalse(result["clips"][1]["isRecording"])

    def test_open_ended_recording_requires_the_same_native_guard(self):
        self.args.pop("recordLengthBeats")
        slot = self.song.tracks[0].clip_slots[1]
        fired = []
        slot.fire = lambda **kwargs: fired.append(kwargs)
        with self.assertRaisesRegex(ValueError, "changed"):
            self.fire(None)
        self.assertEqual(fired, [])
        before = self.source()
        self.assertIsNone(before["recordLengthBeats"])
        result = self.fire(before)
        self.assertTrue(result["recordingRequested"])
        self.assertEqual(fired, [{"launch_quantization": 0}])

    def test_empty_unarmable_group_slot_keeps_native_launch_behavior(self):
        track = self.song.tracks[0]

        class Group(type(track)):
            can_be_armed = False

            @property
            def arm(self):
                raise RuntimeError("Group tracks cannot be armed")

        track.__class__ = Group
        track.can_be_armed = False
        track.is_foldable = True
        fired = []
        track.clip_slots[1].fire = lambda **kwargs: fired.append(kwargs)
        result = dispatch_request(self.song, {"method": "launch_clip", "params": {
            "trackId": "track-0", "clipId": "track-0:clip-1"}}, 3)
        self.assertEqual(fired, [{}])
        self.assertNotIn("recordingRequested", result)
        self.song.tracks[1].arm = True
        listed = dispatch_request(self.song, {"method": "list_clips", "params": {"trackId": "track-0"}}, 3)
        self.assertTrue(listed["groupLaunchRecordingRisk"])
        with self.assertRaisesRegex(ValueError, "Group slot launch requires all tracks unarmed"):
            dispatch_request(self.song, {"method": "launch_clip", "params": {
                "trackId": "track-0", "clipId": "track-0:clip-1"}}, 3)
        self.assertEqual(fired, [{}])


if __name__ == "__main__":
    unittest.main()
