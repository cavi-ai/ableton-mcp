import copy
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class ArrangementAudioImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = os.path.realpath(os.path.join(self.directory.name, "take.wav"))
        with open(self.path, "wb") as output:
            output.write(b"audio source")
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.has_audio_input, self.track.has_midi_input = True, False
        self.track.arrangement_clips = []
        self.calls = []
        def create(path, start):
            self.calls.append((path, start))
            clip = AudioClip()
            clip.file_path = path
            clip.start_time, clip.end_time = start, start + 4
            self.track.arrangement_clips.append(clip)
        self.track.create_audio_clip = create
        source = os.stat(self.path)
        self.args = {"trackId": "track-0", "startBeats": 16, "name": "Vocal — imported",
                     "sourcePath": self.path, "expectedStateVersion": 3,
                     "sourceFile": {"size": str(source.st_size), "mtimeNs": str(source.st_mtime_ns),
                                    "device": str(source.st_dev), "inode": str(source.st_ino)}}

    def context(self):
        return dispatch_request(self.song, {"method": "get_arrangement_audio_import_target", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": "create_arrangement_audio_clip",
                                "params": {**self.args, "before": before}}, 3)

    def change_file(self):
        with open(self.path, "ab") as output:
            output.write(b"changed")

    def test_inert_plan_and_named_import_report_actual_audio_and_interval(self):
        slots, devices, mixer = self.track.clip_slots, self.track.devices, self.track.mixer_device
        before = self.context()
        self.assertEqual(self.calls, [])
        result = self.execute(before)
        self.assertTrue(result["importVerified"])
        self.assertTrue(result["targetRetained"])
        self.assertTrue(result["sourceMetadataUnchanged"])
        self.assertTrue(result["sourceReferenceMatched"])
        self.assertEqual(result["createdClipId"], "track-0:arrangement-clip-0")
        self.assertEqual(result["observedClip"]["endBeats"], 20)
        self.assertEqual(result["audioState"]["source"]["path"], self.path)
        self.assertEqual(result["observedClip"]["name"], self.args["name"])
        self.assertIs(self.track.clip_slots, slots)
        self.assertIs(self.track.devices, devices)
        self.assertIs(self.track.mixer_device, mixer)

    def test_nonempty_midi_frozen_recording_and_invalid_positions_refuse(self):
        changes = [lambda: self.track.arrangement_clips.append(AudioClip()),
                   lambda: setattr(self.track, "has_audio_input", False),
                   lambda: setattr(self.track, "is_frozen", True),
                   lambda: setattr(self.song, "record_mode", True),
                   lambda: setattr(self.song, "session_record", True),
                   lambda: setattr(self.song, "is_counting_in", True),
                   lambda: self.args.update(startBeats=float("inf")),
                   lambda: self.args.update(startBeats=-1),
                   lambda: self.args.update(trackId="track-00")]
        for change in changes:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.context()
            self.assertEqual(self.calls, [])

    def test_same_version_track_replacement_and_file_changes_invalidate_plan(self):
        for change in (lambda: self.song.tracks.__setitem__(0, copy.deepcopy(self.track)),
                       self.change_file):
            self.setUp()
            before = self.context()
            change()
            with self.assertRaises(ValueError):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_undo_entry_rechecks_destination_and_file_before_import(self):
        for change in (lambda: self.track.arrangement_clips.append(AudioClip()),
                       self.change_file):
            self.setUp()
            before = self.context()
            self.song.begin_undo_step = change
            with self.assertRaises(ValueError):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def test_native_exception_after_insertion_retains_unconfirmed_clip(self):
        before, original = self.context(), self.track.create_audio_clip
        def broken(path, start):
            original(path, start)
            raise RuntimeError("import failed after insert")
        self.track.create_audio_clip = broken
        result = self.execute(before)
        self.assertFalse(result["nativeReturned"])
        self.assertFalse(result["importVerified"])
        self.assertIsNone(result["createdClipId"])
        self.assertEqual(len(self.track.arrangement_clips), 1)
        self.assertEqual(self.track.arrangement_clips[0].name, "Vocal")

    def test_file_change_during_import_stops_before_name_write(self):
        before, original = self.context(), self.track.create_audio_clip
        def broken(path, start):
            original(path, start)
            with open(path, "ab") as output:
                output.write(b"changed")
        self.track.create_audio_clip = broken
        result = self.execute(before)
        self.assertFalse(result["importVerified"])
        self.assertFalse(result["nameWriteReturned"])
        self.assertFalse(result["sourceMetadataUnchanged"])
        self.assertEqual(self.track.arrangement_clips[0].name, "Vocal")

    def test_finalization_failure_retains_actual_named_audio_readback(self):
        before = self.context()
        def broken():
            raise RuntimeError("finalization failed")
        self.song.end_undo_step = broken
        result = self.execute(before)
        self.assertFalse(result["importVerified"])
        self.assertEqual(result["observedClip"]["name"], self.args["name"])
        self.assertEqual(result["audioState"]["source"]["path"], self.path)
        self.assertIn("finalization failed", result["error"])

    def test_changed_source_reference_and_interval_are_unverified(self):
        for change in (lambda clip: setattr(clip, "file_path", "/another.wav"),
                       lambda clip: setattr(clip, "start_time", 17)):
            self.setUp()
            before, original = self.context(), self.track.create_audio_clip
            def altered(path, start):
                original(path, start)
                change(self.track.arrangement_clips[-1])
            self.track.create_audio_clip = altered
            result = self.execute(before)
            self.assertFalse(result["importVerified"])
            self.assertFalse(result["nameWriteReturned"])
            self.assertEqual(len(self.track.arrangement_clips), 1)

    def test_invalid_name_and_missing_confirmation_context_do_not_import(self):
        for name in ("", " ", "x" * 129, "bad\nname"):
            self.setUp()
            before = self.context()
            self.args["name"] = name
            with self.assertRaises(ValueError):
                self.execute(before)
            self.assertEqual(self.calls, [])
        self.setUp()
        with self.assertRaises(ValueError):
            self.execute(None)
