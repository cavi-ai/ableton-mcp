import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Clip


class ArrangementCreationTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.arrangement_clips = []
        self.calls = []
        def create(start, length):
            self.calls.append((start, length))
            clip = Clip()
            clip.is_audio_clip = False
            clip.extended_notes = []
            clip.start_time, clip.end_time = start, start + length
            clip.loop_end = clip.end_marker = clip.length = length
            clip.start_marker = 0
            self.track.arrangement_clips.append(clip)
            return None
        self.track.create_midi_clip = create
        self.args = {"trackId": "track-0", "startBeats": 16, "lengthBeats": 4,
                     "name": "Verse — chords", "expectedStateVersion": 3,
                     "notes": [{"pitch": 60, "start": 0.5, "duration": 1, "velocity": 80, "mute": False}]}

    def context(self):
        return dispatch_request(self.song, {"method": "get_arrangement_creation_target", "params": self.args}, 3)

    def execute(self, before):
        return dispatch_request(self.song, {"method": "create_arrangement_midi_clip",
                                "params": {**self.args, "before": before}}, 3)

    def test_inert_plan_then_named_creation_preserves_processing_and_session(self):
        slots, devices, mixer = self.track.clip_slots, self.track.devices, self.track.mixer_device
        before = self.context()
        self.assertEqual(self.calls, [])
        result = self.execute(before)
        self.assertTrue(result["verified"])
        self.assertTrue(result["ownerRetained"])
        self.assertTrue(result["existingLayoutPreserved"])
        self.assertEqual(result["createdClipId"], "track-0:arrangement-clip-0")
        self.assertEqual(result["observedClip"]["name"], self.args["name"])
        self.assertEqual(result["observedNotes"][0]["pitch"], 60)
        self.assertEqual(result["observedNotes"][0]["releaseVelocity"], 0)
        self.assertIs(self.track.clip_slots, slots)
        self.assertIs(self.track.devices, devices)
        self.assertIs(self.track.mixer_device, mixer)
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_native_track_or_clip_layout_replacement_invalidates_plan(self):
        for replace in (lambda: self.song.tracks.__setitem__(0, copy.deepcopy(self.track)),
                        lambda: self.track.arrangement_clips.append(self.existing(32))):
            self.setUp()
            before = self.context()
            replace()
            with self.assertRaisesRegex(ValueError, "changed"):
                self.execute(before)
            self.assertEqual(self.calls, [])

    def existing(self, start):
        clip = Clip()
        clip.is_audio_clip = False
        clip.start_time, clip.end_time = start, start + 4
        return clip

    def test_overlap_frozen_type_recording_and_invalid_intervals_refuse(self):
        changes = [lambda: self.track.arrangement_clips.append(self.existing(16)),
                   lambda: setattr(self.track, "is_frozen", True),
                   lambda: setattr(self.track, "has_midi_input", False),
                   lambda: setattr(self.song, "session_record", True),
                   lambda: setattr(self.song, "record_mode", True),
                   lambda: setattr(self.song, "is_counting_in", True),
                   lambda: self.args.update(trackId="track-00"),
                   lambda: self.args.update(startBeats=-1),
                   lambda: self.args.update(lengthBeats=0),
                   lambda: self.args.update(startBeats=1576800, lengthBeats=1)]
        for change in changes:
            self.setUp()
            change()
            with self.assertRaises(ValueError):
                self.context()
            self.assertEqual(self.calls, [])

    def test_undo_entry_rechecks_destination_before_creation(self):
        before = self.context()
        self.song.begin_undo_step = lambda: self.track.arrangement_clips.append(self.existing(16))
        with self.assertRaises(ValueError):
            self.execute(before)
        self.assertEqual(self.calls, [])

    def test_invalid_notes_names_and_missing_context_never_create(self):
        invalid = [{"pitch": 128}, {"velocity": 0}, {"start": -1}, {"duration": 0},
                   {"start": 3, "duration": 2}, {"duration": float("nan")}, {"mute": "yes"}]
        for change in invalid:
            self.setUp()
            before = self.context()
            self.args["notes"][0].update(change)
            with self.assertRaises(ValueError):
                self.execute(before)
            self.assertEqual(self.calls, [])
        for name in ("", " ", "x" * 129, "line\nbreak"):
            self.setUp()
            before = self.context()
            self.args["name"] = name
            with self.assertRaises(ValueError):
                self.execute(before)
        self.setUp()
        with self.assertRaises(ValueError):
            self.execute(None)

    def test_note_failure_retains_owned_named_clip(self):
        before, original = self.context(), self.track.create_midi_clip
        def broken(start, length):
            original(start, length)
            def fail(notes):
                raise RuntimeError("notes failed")
            self.track.arrangement_clips[-1].add_new_notes = fail
        self.track.create_midi_clip = broken
        result = self.execute(before)
        self.assertFalse(result["verified"])
        self.assertTrue(result["nativeReturned"])
        self.assertEqual(result["observedClip"]["name"], self.args["name"])
        self.assertEqual(result["observedNotes"], [])
        self.assertEqual(len(self.track.arrangement_clips), 1)

    def test_name_callback_replacement_stops_before_note_insertion(self):
        for replacement in ("clip", "track"):
            self.setUp()
            before, original = self.context(), self.track.create_midi_clip
            orphan = []
            class CallbackClip(Clip):
                @property
                def name(current):
                    return current.__dict__["name"]

                @name.setter
                def name(current, value):
                    current.__dict__["name"] = value
                    if replacement == "clip":
                        self.track.arrangement_clips[-1] = copy.deepcopy(current)
                    else:
                        self.song.tracks[0] = copy.deepcopy(self.track)

            def create(start, length):
                original(start, length)
                created = self.track.arrangement_clips[-1]
                created.__class__ = CallbackClip
                orphan.append(created)
            self.track.create_midi_clip = create
            result = self.execute(before)
            self.assertFalse(result["verified"])
            self.assertFalse(result["notesWriteRequested"])
            self.assertEqual(orphan[0].extended_notes, [])
            self.assertEqual(self.song.tracks[0].arrangement_clips[-1].extended_notes, [])

    def test_exception_after_creation_retains_unconfirmed_clip_without_initialization(self):
        before, original = self.context(), self.track.create_midi_clip
        def broken(start, length):
            original(start, length)
            raise RuntimeError("creation failed after insert")
        self.track.create_midi_clip = broken
        result = self.execute(before)
        self.assertFalse(result["nativeReturned"])
        self.assertFalse(result["verified"])
        self.assertIsNone(result["createdClipId"])
        self.assertEqual(len(self.track.arrangement_clips), 1)
        self.assertEqual(self.track.arrangement_clips[0].name, "Loop")

    def test_empty_requested_part_skips_native_empty_note_write(self):
        self.args["notes"] = []
        result = self.execute(self.context())
        self.assertTrue(result["verified"])
        self.assertFalse(result["notesWriteRequested"])
        self.assertEqual(result["observedNotes"], [])

    def test_finalization_failure_retains_actual_readback(self):
        before = self.context()
        def broken():
            raise RuntimeError("finalization failed")
        self.song.end_undo_step = broken
        result = self.execute(before)
        self.assertFalse(result["verified"])
        self.assertEqual(result["observedNotes"][0]["pitch"], 60)
        self.assertIn("finalization failed", result["error"])

    def test_last_destination_capacity_returns_id_and_next_creation_refuses(self):
        self.track.arrangement_clips = [self.existing(32 + i * 4) for i in range(4095)]
        result = self.execute(self.context())
        self.assertTrue(result["verified"])
        self.assertEqual(result["createdClipId"], "track-0:arrangement-clip-4095")
        self.args["startBeats"] = 24
        with self.assertRaisesRegex(ValueError, "4096"):
            self.context()
