import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Clip, AudioClip, MidiNote


class ArrangementCopyTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.source, self.target = self.song.tracks
        self.clip = Clip()
        self.clip.is_audio_clip = False
        self.clip.start_time, self.clip.end_time = 8, 12
        self.clip.extended_notes = [MidiNote()]
        self.source.arrangement_clips = [self.clip]
        self.target.arrangement_clips = []
        self.calls = []
        def duplicate(clip, start):
            self.calls.append((clip, start))
            result = copy.deepcopy(clip)
            result.start_time, result.end_time = start, start + clip.end_time - clip.start_time
            self.target.arrangement_clips.append(result)
            return result
        self.target.duplicate_clip_to_arrangement = duplicate
        self.args = {"trackId": "track-0", "clipId": "track-0:arrangement-clip-0",
                     "destinationTrackId": "track-1", "startBeats": 16, "name": "Layer — body",
                     "expectedStateVersion": 3}

    def context(self):
        return dispatch_request(self.song, {"method": "get_arrangement_copy_source", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": "copy_arrangement_clip_to_track",
                                "params": {**self.args, "before": before}}, 3)

    def test_inert_context_and_named_copy_preserve_source_and_destination_processing(self):
        devices, mixer = self.target.devices, self.target.mixer_device
        before = self.context()
        self.assertEqual(self.calls, [])
        result = self.execute(before)
        self.assertTrue(result["copyVerified"])
        self.assertTrue(result["sourcePreserved"])
        self.assertTrue(result["destinationRetained"])
        self.assertEqual(result["copiedClipId"], "track-1:arrangement-clip-0")
        self.assertEqual(self.target.arrangement_clips[0].name, "Layer — body")
        self.assertEqual(self.clip.name, "Loop")
        self.assertEqual(self.target.arrangement_clips[0].extended_notes[0].pitch, self.clip.extended_notes[0].pitch)
        self.assertIs(self.source.arrangement_clips[0], self.clip)
        self.assertIs(self.target.devices, devices)
        self.assertIs(self.target.mixer_device, mixer)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_same_version_source_and_destination_changes_refuse_before_copy(self):
        changes = [lambda: setattr(self.clip.extended_notes[0], "velocity", 42),
                   lambda: setattr(self.clip, "loop_end", 3),
                   lambda: self.source.arrangement_clips.__setitem__(0, copy.deepcopy(self.clip)),
                   lambda: self.song.tracks.__setitem__(1, copy.deepcopy(self.target)),
                   lambda: self.target.arrangement_clips.append(copy.deepcopy(self.clip))]
        for change in changes:
            self.setUp()
            before = self.context()
            change()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_overlap_type_frozen_recording_and_noncanonical_ids_refuse(self):
        changes = [lambda: self.args.update(destinationTrackId="track-0"),
                   lambda: self.args.update(clipId="track-0:clip-0"),
                   lambda: self.args.update(trackId="track-00"),
                   lambda: self.args.update(startBeats=float("inf")),
                   lambda: setattr(self.target, "has_midi_input", False),
                   lambda: setattr(self.target, "is_frozen", True),
                   lambda: setattr(self.song, "record_mode", True),
                   lambda: setattr(self.song, "session_record", True),
                   lambda: self.target.arrangement_clips.append(copy.deepcopy(self.clip))]
        for change in changes:
            self.setUp()
            if change is changes[-1]:
                self.args["startBeats"] = 8
            change()
            with self.assertRaises(ValueError):
                self.context()
            self.assertEqual(self.calls, [])

    def test_undo_entry_rechecks_content_before_native_copy(self):
        before = self.context()
        def begin():
            self.song.undo_boundaries.append("begin")
            self.clip.extended_notes[0].velocity = 42
        self.song.begin_undo_step = begin
        with self.assertRaisesRegex(ValueError, "changed"):
            self.execute(before)
        self.assertEqual(self.calls, [])

    def test_exception_after_native_creation_retains_unconfirmed_copy(self):
        before, original = self.context(), self.target.duplicate_clip_to_arrangement
        def broken(clip, start):
            original(clip, start)
            raise RuntimeError("copy failed after creation")
        self.target.duplicate_clip_to_arrangement = broken
        result = self.execute(before)
        self.assertFalse(result["nativeReturned"])
        self.assertFalse(result["copyVerified"])
        self.assertIsNone(result["copiedClipId"])
        self.assertEqual(len(self.target.arrangement_clips), 1)
        self.assertIn("copy failed after creation", result["error"])

    def test_incomplete_copy_is_reported_and_retained_without_rollback(self):
        before, original = self.context(), self.target.duplicate_clip_to_arrangement
        def broken(clip, start):
            result = original(clip, start)
            result.extended_notes[0].pitch = 12
            return result
        self.target.duplicate_clip_to_arrangement = broken
        result = self.execute(before)
        self.assertFalse(result["copyVerified"])
        self.assertTrue(result["sourcePreserved"])
        self.assertEqual(len(self.target.arrangement_clips), 1)
        self.assertNotEqual(self.clip.extended_notes[0].pitch, 12)

    def test_undo_finalization_failure_preserves_actual_named_copy(self):
        before = self.context()
        def broken():
            raise RuntimeError("undo finalization failed")
        self.song.end_undo_step = broken
        result = self.execute(before)
        self.assertFalse(result["copyVerified"])
        self.assertTrue(result["nativeReturned"])
        self.assertEqual(result["observedCopy"]["name"], self.args["name"])
        self.assertIn("undo finalization failed", result["error"])

    def test_audio_copy_preserves_exposed_settings_and_source_reference(self):
        self.clip = AudioClip()
        self.clip.file_path = "/samples/voice.wav"
        self.clip.start_time, self.clip.end_time = 8, 12
        self.source.arrangement_clips = [self.clip]
        self.target.has_midi_input, self.target.has_audio_input = False, True
        result = self.execute(self.context())
        self.assertTrue(result["copyVerified"])
        self.assertEqual(self.target.arrangement_clips[0].file_path, self.clip.file_path)
        self.assertEqual(self.target.arrangement_clips[0].pitch_coarse, self.clip.pitch_coarse)

    def test_invalid_names_and_missing_confirmation_context_refuse(self):
        for name in ("", " ", "x" * 129, "bad\nname"):
            self.setUp()
            before = self.context()
            self.args["name"] = name
            with self.assertRaises(ValueError):
                self.execute(before)
        self.setUp()
        with self.assertRaises(ValueError):
            self.execute(None)

    def test_last_destination_capacity_returns_the_verified_copy(self):
        for index in range(4095):
            clip = copy.deepcopy(self.clip)
            clip.start_time, clip.end_time = 100 + index * 4, 104 + index * 4
            self.target.arrangement_clips.append(clip)
        result = self.execute(self.context())
        self.assertTrue(result["copyVerified"])
        self.assertEqual(result["copiedClipId"], "track-1:arrangement-clip-4095")
        self.assertEqual(len(self.target.arrangement_clips), 4096)
        self.args["startBeats"] = 24
        with self.assertRaisesRegex(ValueError, "4096"):
            self.context()
        self.assertEqual(len(self.calls), 1)
