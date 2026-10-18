import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class SessionOverdubTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_playing = True
        self.song.is_counting_in = False
        for track in self.song.tracks:
            track.can_be_armed = True
            for slot in track.clip_slots:
                if slot.has_clip:
                    slot.clip.is_recording = False
                    slot.clip.is_overdubbing = False
                    slot.clip.is_triggered = False
        self.track = self.song.tracks[0]
        self.track.arm = True
        self.track.is_frozen = False
        self.track.playing_slot_index = 0
        self.clip = self.track.clip_slots[0].clip
        self.clip.is_midi_clip = True
        self.clip.is_playing = True
        self.clip.is_triggered = False
        self.clip.is_recording = False
        self.clip.is_overdubbing = False
        self.args = {"trackId": "track-0", "clipId": "track-0:clip-0"}

    def read(self):
        return dispatch_request(self.song, {"method": "get_session_midi_overdub_context", "params": self.args}, 3)

    def write(self, before, enabled=True):
        return dispatch_request(self.song, {"method": "set_session_midi_overdub", "params": {
            **self.args, "enabled": enabled, "expectedStateVersion": 3, "before": before}}, 3)

    def test_read_is_inert_and_start_changes_only_session_record(self):
        before = self.read()
        self.assertFalse(self.song.session_record)
        result = self.write(before)
        self.assertTrue(self.song.session_record)
        self.assertTrue(self.song.is_playing)
        self.assertTrue(self.track.arm)
        self.assertTrue(self.song.overdub)
        self.assertFalse(self.song.record_mode)
        self.assertTrue(result["nativeReturned"])
        self.assertTrue(result["sessionRecordVerified"])
        self.assertFalse(result["performanceVerified"])
        self.assertFalse(result["overdubActiveObserved"])

    def test_stop_keeps_playback_and_accepts_incoming_notes_and_clock_advance(self):
        self.song.session_record = True
        self.clip.is_recording = self.clip.is_overdubbing = True
        before = self.read()
        self.song.current_song_time += 2
        self.song.can_capture_midi = not self.song.can_capture_midi
        self.clip.get_all_notes_extended = lambda: (_ for _ in ()).throw(AssertionError("stop must not bind evolving notes"))
        result = self.write(before, False)
        self.assertFalse(self.song.session_record)
        self.assertTrue(self.song.is_playing)
        self.assertTrue(result["sessionRecordVerified"])
        self.assertFalse(result["recordingStoppedObserved"])

    def test_refuses_other_explicit_implicit_arms_and_recording_or_pending_work(self):
        changes = [lambda: setattr(self.song.tracks[1], "arm", True),
                   lambda: setattr(self.song.tracks[1], "implicit_arm", True),
                   lambda: setattr(self.song, "record_mode", True),
                   lambda: setattr(self.song, "is_counting_in", True),
                   lambda: setattr(self.song, "session_automation_record", True),
                   lambda: setattr(self.track, "fired_slot_index", 1),
                   lambda: setattr(self.clip, "is_triggered", True),
                   lambda: setattr(self.song.scenes[0], "is_triggered", True),
                   lambda: setattr(self.track, "arm", False),
                   lambda: setattr(self.track, "is_frozen", True),
                   lambda: setattr(self.clip, "looping", False),
                   lambda: setattr(self.clip, "is_midi_clip", False),
                   lambda: setattr(self.clip, "is_playing", False)]
        for change in changes:
            self.setUp()
            before = self.read()
            change()
            with self.assertRaises(ValueError):
                self.write(before)
            self.assertFalse(self.song.session_record)

    def test_identical_replacement_routing_timing_and_source_note_changes_refuse(self):
        for change in [lambda: self.track.clip_slots.__setitem__(0, copy.deepcopy(self.track.clip_slots[0])),
                       lambda: setattr(self.track, "current_input_routing", "No Input"),
                       lambda: setattr(self.clip, "loop_end", self.clip.loop_end + 1),
                       lambda: setattr(self.clip, "get_all_notes_extended", lambda: [type("Note", (), {
                           "note_id": 7, "pitch": 60, "start_time": 0, "duration": 1, "velocity": 80,
                           "mute": False, "probability": 1, "velocity_deviation": 0, "release_velocity": 64})()])]:
            self.setUp()
            before = self.read()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.write(before)
            self.assertFalse(self.song.session_record)

    def test_guard_is_rechecked_at_undo_entry_without_rollback(self):
        before = self.read()
        self.song.begin_undo_step = lambda: setattr(self.song.tracks[1], "arm", True)
        with self.assertRaises(ValueError):
            self.write(before)
        self.assertFalse(self.song.session_record)
        self.assertTrue(self.song.tracks[1].arm)

    def test_replay_missing_guard_and_nonboolean_refuse(self):
        before = self.read()
        for enabled in [1, "true", None]:
            with self.assertRaises(ValueError):
                self.write(before, enabled)
        with self.assertRaises(ValueError):
            self.write(None)
        with self.assertRaises(ValueError):
            self.write(before, False)
        self.write(before)
        with self.assertRaises(ValueError):
            self.write(before)

    def test_group_arm_is_never_read_even_if_can_be_armed_is_true(self):
        group = self.song.tracks[1]
        class Group(type(group)):
            @property
            def arm(self):
                raise RuntimeError("Main and Return Tracks have no Arm state")
        group.__class__ = Group
        group.is_foldable = True
        group.can_be_armed = True
        self.write(self.read())
        self.assertTrue(self.song.session_record)

    def test_undo_finalizer_failure_reports_observed_partial_start_and_stop(self):
        for enabled in [True, False]:
            self.setUp()
            self.song.session_record = not enabled
            before = self.read()
            def fail():
                raise RuntimeError("undo finalization failed")
            self.song.end_undo_step = fail
            result = self.write(before, enabled)
            self.assertTrue(result["nativeReturned"])
            self.assertTrue(result["sessionRecordVerified"])
            self.assertTrue(result["requiresInspection"])
            self.assertIn("undo finalization failed", result["error"])
            self.assertEqual(self.song.session_record, enabled)
            self.assertTrue(self.song.is_playing)

    def test_changed_recording_scope_after_dispatch_needs_inspection_without_cleanup(self):
        for change in [lambda: setattr(self.song.tracks[1], "arm", True),
                       lambda: setattr(self.track, "current_input_routing", "No Input"),
                       lambda: setattr(self.song, "tempo", 98),
                       lambda: setattr(self.clip, "loop_end", self.clip.loop_end + 1)]:
            self.setUp()
            before = self.read()
            self.song.end_undo_step = change
            result = self.write(before)
            self.assertTrue(result["nativeReturned"])
            self.assertTrue(result["sessionRecordVerified"])
            self.assertFalse(result["scopeVerified"])
            self.assertTrue(result["requiresInspection"])
            self.assertTrue(self.song.session_record)

    def test_native_legacy_overdub_alias_transition_is_expected(self):
        class AliasedSong(type(self.song)):
            @property
            def overdub(self):
                return self.session_record
        self.song.__class__ = AliasedSong
        for enabled in [True, False]:
            result = self.write(self.read(), enabled)
            self.assertTrue(result["scopeVerified"])
            self.assertFalse(result["requiresInspection"])
            self.assertEqual(self.song.overdub, enabled)


if __name__ == "__main__":
    unittest.main()
