import copy
import json
from types import SimpleNamespace
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, MidiNote


class InstrumentComparisonTests(unittest.TestCase):
    def setUp(self):
        from instrument_comparison import _comparisons
        _comparisons.clear()
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.clip_slots = self.track.clip_slots[:2]
        self.clip = self.track.clip_slots[0].clip
        self.clip.extended_notes = [MidiNote(7), MidiNote(9)]
        self.track.arrangement_clips = []
        self.song.tracks[1].arrangement_clips = []
        self.song.record_mode = False
        self.song.session_record = False

    def call(self, method, params=None, version=4):
        return dispatch_request(self.song, {"method": method, "params": params or {}}, version)

    def prepare(self):
        before = self.call("get_instrument_comparison_source", {"trackId": "track-0", "clipId": "track-0:clip-0"})
        return self.call("prepare_instrument_comparison", {"expectedStateVersion": 4,
            "trackId": "track-0", "clipId": "track-0:clip-0", "name": "Warm alternative", "before": before})

    def test_socket_copy_waits_for_native_values_and_still_rejects_changed_content(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt):
                self.setUp()
                self.track.mixer_device = copy.copy(self.track.mixer_device)
                self.track.mixer_device.volume = copy.copy(self.track.mixer_device.volume)
                self.track.mixer_device.volume.value = 0.5
                callbacks, replies = [], []
                duplicate = self.song.duplicate_track
                def pending(index):
                    duplicate(index)
                    self.song.tracks[index + 1].mixer_device.volume.value = 0.85
                self.song.duplicate_track = pending
                surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
                    schedule_message=lambda delay, callback: callbacks.append(callback))
                client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
                bridge = SocketBridge(surface, "/unused")
                bridge.state_version = 4
                before = self.call("get_instrument_comparison_source", {"trackId": "track-0", "clipId": "track-0:clip-0"})
                bridge.requests.put((client, {"id": 1, "method": "prepare_instrument_comparison", "params": {
                    "expectedStateVersion": 4, "trackId": "track-0", "clipId": "track-0:clip-0",
                    "name": "Alternative", "before": before}}))
                bridge.drain()
                self.assertEqual(replies, [])
                self.assertEqual(len(self.song.tracks), 3)
                self.assertTrue(self.song.tracks[1].mute)
                self.assertEqual(self.song.undo_boundaries, ["begin", "end"])
                bridge.drain()
                self.assertEqual(len(self.song.tracks), 3)
                self.song.tracks[1].mixer_device.volume.value = self.track.mixer_device.volume.value
                if corrupt:
                    self.song.tracks[1].devices[0].parameters[0].value = 0.99
                callbacks.pop(0)()
                self.assertFalse(bridge.deferred_request)
                self.assertEqual(bridge.state_version, 5)
                if corrupt:
                    self.assertIn("content readback mismatch", replies[0]["error"]["message"])
                    self.assertEqual(len(self.song.tracks), 2)
                else:
                    self.assertIn("result", replies[0])
                    self.assertEqual(replies[0]["result"]["variation"]["trackId"], "track-1")
                    self.assertEqual(replies[0]["result"]["stateVersion"], 5)

    def test_deferred_copy_reports_and_cleans_scheduler_or_document_lookup_failure(self):
        for failure in ("schedule", "song"):
            with self.subTest(failure=failure):
                self.setUp()
                callbacks, replies = [], []
                def schedule(delay, callback):
                    if failure == "schedule":
                        raise RuntimeError("scheduler unavailable")
                    callbacks.append(callback)
                surface = SimpleNamespace(song=lambda: self.song, application=lambda: None, schedule_message=schedule)
                client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
                bridge = SocketBridge(surface, "/unused")
                bridge.state_version = 4
                before = self.call("get_instrument_comparison_source", {"trackId": "track-0", "clipId": "track-0:clip-0"})
                bridge.requests.put((client, {"id": 1, "method": "prepare_instrument_comparison", "params": {
                    "expectedStateVersion": 4, "trackId": "track-0", "clipId": "track-0:clip-0",
                    "name": "Alternative", "before": before}}))
                bridge.drain()
                if failure == "song":
                    def unavailable():
                        raise RuntimeError("document unavailable")
                    surface.song = unavailable
                    callbacks.pop(0)()
                self.assertEqual(len(replies), 1)
                self.assertIn("unavailable", replies[0]["error"]["message"])
                self.assertFalse(bridge.deferred_request)
                self.assertEqual(len(self.song.tracks), 2)
                self.assertFalse(self.track.mute)

    def test_native_copy_preserves_original_and_exposed_content_and_starts_silent(self):
        original_notes = copy.deepcopy([vars(note) for note in self.clip.extended_notes])
        follower = self.song.tracks[1]
        result = self.prepare()
        self.assertEqual(len(self.song.tracks), 3)
        variation = self.song.tracks[1]
        self.assertTrue(variation.mute)
        self.assertFalse(variation.arm)
        self.assertFalse(variation.solo)
        self.assertEqual(variation.current_monitoring_state, 2)
        self.assertEqual(variation.name, "Warm alternative")
        self.assertFalse(self.track.mute)
        self.assertIs(self.song.tracks[2], follower)
        self.assertEqual([vars(note) for note in self.clip.extended_notes], original_notes)
        self.assertEqual([vars(note) for note in variation.clip_slots[0].clip.extended_notes], original_notes)
        self.assertEqual(result["original"]["trackId"], "track-0")
        self.assertEqual(result["variation"]["trackId"], "track-1")
        self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_manual_note_or_parameter_change_invalidates_preparation_without_version_increment(self):
        for field in ("note", "parameter"):
            with self.subTest(field=field):
                self.setUp()
                before = self.call("get_instrument_comparison_source", {"trackId": "track-0", "clipId": "track-0:clip-0"})
                if field == "note":
                    self.clip.extended_notes[0].velocity = 41
                else:
                    self.track.devices[0].parameters[0].value = 0.93
                with self.assertRaisesRegex(ValueError, "changed"):
                    self.call("prepare_instrument_comparison", {"expectedStateVersion": 4, "trackId": "track-0",
                        "clipId": "track-0:clip-0", "name": "Alternative", "before": before})
                self.assertEqual(len(self.song.tracks), 2)

    def test_corrupt_copy_is_removed_without_deleting_following_track_or_muting_original(self):
        duplicate = self.song.duplicate_track
        follower = self.song.tracks[1]
        def corrupt(index):
            duplicate(index)
            self.song.tracks[index + 1].clip_slots[0].clip.extended_notes[0].velocity = 1
        self.song.duplicate_track = corrupt
        with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 2)
        self.assertIs(self.song.tracks[1], follower)
        self.assertFalse(self.track.mute)

    def test_insert_then_raise_still_cleans_only_the_created_track(self):
        duplicate = self.song.duplicate_track
        def fail(index):
            duplicate(index)
            raise RuntimeError("native insertion failed")
        self.song.duplicate_track = fail
        with self.assertRaisesRegex(RuntimeError, "native insertion failed"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 2)
        self.assertFalse(self.track.mute)

    def test_comparison_resolves_reordered_tracks_by_native_object_and_rejects_other_document(self):
        result = self.prepare()
        variation = self.song.tracks.pop(1)
        self.song.tracks.append(variation)
        read = self.call("get_instrument_comparison", {"comparisonId": result["comparisonId"]})
        self.assertEqual(read["variation"]["trackId"], "track-2")
        self.assertEqual(read["variation"]["clipId"], "track-2:clip-0")
        with self.assertRaisesRegex(ValueError, "unavailable|document"):
            dispatch_request(Song(), {"method": "get_instrument_comparison", "params": {
                "comparisonId": result["comparisonId"]}}, 4)

    def test_selection_only_changes_pair_mutes_and_preserves_manual_edits(self):
        result = self.prepare()
        variation = self.song.tracks[1]
        variation.clip_slots[0].clip.extended_notes[0].velocity = 55
        variation.devices[0].parameters[0].value = 0.3
        self.song.tracks[2].mute = True
        before = self.call("get_instrument_comparison", {"comparisonId": result["comparisonId"]}, 5)
        selected = self.call("select_instrument_comparison", {"comparisonId": result["comparisonId"],
            "choice": "variation", "expectedStateVersion": 5, "before": before}, 5)
        self.assertTrue(self.track.mute)
        self.assertFalse(variation.mute)
        self.assertTrue(self.song.tracks[2].mute)
        self.assertFalse(self.song.is_playing)
        self.assertEqual(variation.clip_slots[0].clip.extended_notes[0].velocity, 55)
        self.assertEqual(variation.devices[0].parameters[0].value, 0.3)
        self.assertEqual(selected["selected"], "variation")

    def test_restore_uses_original_mute_state_and_keeps_alternative_muted(self):
        self.track.mute = True
        result = self.prepare()
        args = {"comparisonId": result["comparisonId"]}
        before = self.call("get_instrument_comparison", args, 5)
        self.call("select_instrument_comparison", {**args, "choice": "original", "expectedStateVersion": 5, "before": before}, 5)
        self.assertFalse(self.track.mute)
        before = self.call("get_instrument_comparison", args, 6)
        self.call("select_instrument_comparison", {**args, "choice": "restore", "expectedStateVersion": 6, "before": before}, 6)
        self.assertTrue(self.track.mute)
        self.assertTrue(self.song.tracks[1].mute)

    def test_recording_frozen_and_solo_conflicts_refuse_selection(self):
        for conflict in ("recording", "frozen", "solo", "armed"):
            with self.subTest(conflict=conflict):
                self.setUp()
                result = self.prepare()
                if conflict == "recording": self.song.session_record = True
                if conflict == "frozen": self.song.tracks[1].is_frozen = True
                if conflict == "solo": self.song.tracks[2].solo = True
                if conflict == "armed": self.song.tracks[1].arm = True
                before = self.call("get_instrument_comparison", {"comparisonId": result["comparisonId"]}, 5)
                with self.assertRaisesRegex(ValueError, "recording|frozen|solo|armed"):
                    self.call("select_instrument_comparison", {"comparisonId": result["comparisonId"],
                        "choice": "variation", "expectedStateVersion": 5, "before": before}, 5)
                self.assertFalse(self.track.mute)
                self.assertTrue(self.song.tracks[1].mute)

    def test_running_transport_refuses_creation_without_mutation(self):
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, "transport"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 2)

    def test_listing_recovers_a_created_comparison_without_the_preparation_reply(self):
        created = self.prepare()
        listed = self.call("get_instrument_comparison")
        self.assertEqual([pair["comparisonId"] for pair in listed["comparisons"]], [created["comparisonId"]])

    def test_finish_preserves_both_tracks_and_releases_the_comparison_handle(self):
        created = self.prepare()
        args = {"comparisonId": created["comparisonId"]}
        before = self.call("get_instrument_comparison", args, 5)
        result = self.call("select_instrument_comparison", {**args, "choice": "variation", "finish": True,
            "expectedStateVersion": 5, "before": before}, 5)
        self.assertFalse(result["comparisonActive"])
        self.assertEqual(len(self.song.tracks), 3)
        self.assertTrue(self.track.mute)
        self.assertFalse(self.song.tracks[1].mute)
        self.assertEqual(self.call("get_instrument_comparison")["comparisons"], [])

    def test_failed_switch_restores_both_previous_mutes(self):
        created = self.prepare()
        variation = self.song.tracks[1]
        states = []
        def observe_original(track, key, value):
            object.__setattr__(track, key, value)
            if key == "mute": states.append((self.track.mute, variation.mute))
        self.track.__class__ = type("ObservedTrack", (type(self.track),), {"__setattr__": observe_original})
        def refuse_unmute(track, key, value):
            object.__setattr__(track, key, value)
            if key == "mute": states.append((self.track.mute, variation.mute))
            if key == "mute" and value is False:
                raise RuntimeError("native mute write failed")
        variation.__class__ = type("FailingTrack", (type(variation),), {"__setattr__": refuse_unmute})
        args = {"comparisonId": created["comparisonId"]}
        before = self.call("get_instrument_comparison", args, 5)
        with self.assertRaisesRegex(RuntimeError, "native mute write failed"):
            self.call("select_instrument_comparison", {**args, "choice": "variation",
                "expectedStateVersion": 5, "before": before}, 5)
        self.assertFalse(self.track.mute)
        self.assertTrue(variation.mute)
        self.assertNotIn((False, False), states)

    def test_an_active_comparison_cannot_share_a_track_with_another_pair(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, "active comparison"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 3)

    def test_ignored_copy_safety_flags_are_detected_and_the_copy_is_removed(self):
        duplicate = self.song.duplicate_track
        def fail(index):
            duplicate(index)
            variation = self.song.tracks[index + 1]
            variation.arm = True
            def ignore_disarm(track, key, value):
                if key != "arm": object.__setattr__(track, key, value)
            variation.__class__ = type("CannotDisarm", (type(variation),), {"__setattr__": ignore_disarm})
        self.song.duplicate_track = fail
        with self.assertRaisesRegex(RuntimeError, "safety.*readback mismatch"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 2)
        self.assertFalse(self.track.mute)

    def test_armed_soloed_and_input_monitored_sources_are_refused_before_native_duplication(self):
        for key, value in (("arm", True), ("solo", True), ("current_monitoring_state", 0)):
            with self.subTest(key=key):
                self.setUp()
                setattr(self.track, key, value)
                with self.assertRaisesRegex(ValueError, "armed|solo|monitor"):
                    self.prepare()
                self.assertEqual(len(self.song.tracks), 2)
                self.assertEqual(getattr(self.track, key), value)
                self.assertFalse(self.track.mute)

    def test_distinct_routing_ids_with_the_same_name_fail_copy_verification(self):
        duplicate = self.song.duplicate_track
        def corrupt(index):
            duplicate(index)
            copy_track = self.song.tracks[index + 1]
            route = type("OtherRoute", (), {"identifier": "other-main", "display_name": "Main"})()
            copy_track.available_output_routing_types = [route]
            copy_track.current_output_routing = route
        self.song.duplicate_track = corrupt
        with self.assertRaisesRegex(RuntimeError, "content readback mismatch"):
            self.prepare()
        self.assertEqual(len(self.song.tracks), 2)

    def test_failed_rollback_mute_never_enables_the_other_track(self):
        created = self.prepare()
        variation = self.song.tracks[1]
        def fail(track, key, value):
            if key != "mute": return object.__setattr__(track, key, value)
            if value is False: object.__setattr__(track, key, False)
            raise RuntimeError("native mute failed")
        variation.__class__ = type("MuteBroken", (type(variation),), {"__setattr__": fail})
        args = {"comparisonId": created["comparisonId"]}
        before = self.call("get_instrument_comparison", args, 5)
        with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
            self.call("select_instrument_comparison", {**args, "choice": "variation",
                "expectedStateVersion": 5, "before": before}, 5)
        self.assertTrue(self.track.mute)

    def adoption_pair(self):
        self.song.duplicate_track(0)
        variation = self.song.tracks[1]
        variation.name, variation.mute = "Existing alternative", False
        self.track.mute = True
        variation.devices[0].parameters[0].value = 0.37
        variation.clip_slots[0].clip.extended_notes[0].velocity = 53
        return {"original": {"trackId": "track-0", "clipId": "track-0:clip-0"},
                "variation": {"trackId": "track-1", "clipId": "track-1:clip-0"}}

    def test_adoption_binds_existing_parts_without_creating_or_editing_tracks(self):
        args = self.adoption_pair()
        tracks = list(self.song.tracks)
        notes = copy.deepcopy([vars(n) for n in tracks[1].clip_slots[0].clip.extended_notes])
        before = self.call("get_instrument_comparison_adoption_source", args)
        result = self.call("adopt_instrument_comparison", {**args, "expectedStateVersion": 4, "before": before})
        self.assertEqual(self.song.tracks, tracks)
        self.assertEqual(self.song.undo_boundaries, [])
        self.assertTrue(self.track.mute)
        self.assertFalse(tracks[1].mute)
        self.assertEqual([vars(n) for n in tracks[1].clip_slots[0].clip.extended_notes], notes)
        self.assertEqual(tracks[1].devices[0].parameters[0].value, 0.37)
        self.assertEqual(result["restorationBasis"], "adoption")
        self.assertEqual(result["restoreMutes"], {"original": True, "variation": False})
        self.assertEqual(result["original"]["clipId"], args["original"]["clipId"])
        self.assertFalse(self.song.is_playing)

        # A new handle retains native identities when the user reorders tracks.
        self.song.tracks.append(self.song.tracks.pop(1))
        pair = {"comparisonId": result["comparisonId"]}
        current = self.call("get_instrument_comparison", pair, 5)
        self.assertEqual(current["variation"]["trackId"], "track-2")
        self.call("select_instrument_comparison", {**pair, "choice": "original", "expectedStateVersion": 5, "before": current}, 5)
        current = self.call("get_instrument_comparison", pair, 6)
        self.call("select_instrument_comparison", {**pair, "choice": "restore", "finish": True,
            "expectedStateVersion": 6, "before": current}, 6)
        self.assertTrue(self.track.mute)
        self.assertFalse(tracks[1].mute)
        self.assertEqual(self.call("get_instrument_comparison")["comparisons"], [])

    def test_adoption_rejects_stale_content_topology_and_duplicate_handles(self):
        for change in ("notes", "parameter", "mute", "clip", "topology"):
            with self.subTest(change=change):
                self.setUp()
                args = self.adoption_pair()
                before = self.call("get_instrument_comparison_adoption_source", args)
                if change == "notes": self.clip.extended_notes[0].velocity = 17
                elif change == "parameter": self.song.tracks[1].devices[0].parameters[0].value = 0.5
                elif change == "mute": self.song.tracks[1].mute = True
                elif change == "clip": self.song.tracks[1].clip_slots[0].clip.name = "Changed"
                else: self.song.tracks.reverse()
                with self.assertRaisesRegex(ValueError, "changed|MIDI|clip"):
                    self.call("adopt_instrument_comparison", {**args, "expectedStateVersion": 4, "before": before})
                self.assertEqual(self.call("get_instrument_comparison")["comparisons"], [])
        self.setUp()
        args = self.adoption_pair()
        before = self.call("get_instrument_comparison_adoption_source", args)
        self.call("adopt_instrument_comparison", {**args, "expectedStateVersion": 4, "before": before})
        with self.assertRaisesRegex(ValueError, "active comparison"):
            self.call("get_instrument_comparison_adoption_source", args)

    def test_adoption_refuses_unsafe_or_ambiguous_pairs(self):
        for conflict in ("same_track", "both_unmuted", "recording", "solo", "frozen", "armed", "monitor", "audio", "group", "missing_clip"):
            with self.subTest(conflict=conflict):
                self.setUp()
                args = self.adoption_pair()
                variation = self.song.tracks[1]
                if conflict == "same_track": args["variation"] = args["original"]
                elif conflict == "both_unmuted": self.track.mute = False
                elif conflict == "recording": self.song.record_mode = True
                elif conflict == "solo": self.song.tracks[2].solo = True
                elif conflict == "frozen": variation.is_frozen = True
                elif conflict == "armed": variation.arm = True
                elif conflict == "monitor": variation.current_monitoring_state = 0
                elif conflict == "audio": variation.clip_slots[0].clip.is_audio_clip = True
                elif conflict == "group": variation.is_foldable = True
                else: args["variation"]["clipId"] = "track-1:clip-1"
                with self.assertRaises(ValueError):
                    self.call("get_instrument_comparison_adoption_source", args)
                self.assertEqual(len(self.song.tracks), 3)
                self.assertEqual(self.call("get_instrument_comparison")["comparisons"], [])

    def test_adoption_accepts_arrangement_parts_without_stopping_playback(self):
        args = self.adoption_pair()
        for index, side in enumerate(("original", "variation")):
            track = self.song.tracks[index]
            clip = track.clip_slots[0].clip
            clip.is_audio_clip = False
            clip.start_time, clip.end_time = 8.0, 12.0
            track.clip_slots = []
            track.arrangement_clips = [clip]
            args[side]["clipId"] = f"track-{index}:arrangement-clip-0"
        self.song.is_playing = True
        before = self.call("get_instrument_comparison_adoption_source", args)
        result = self.call("adopt_instrument_comparison", {**args, "expectedStateVersion": 4, "before": before})
        self.assertTrue(self.song.is_playing)
        self.assertEqual(result["original"]["location"], "arrangement")
        self.assertEqual(result["variation"]["clipId"], "track-1:arrangement-clip-0")
        self.assertTrue(self.track.mute)
        self.assertFalse(self.song.tracks[1].mute)


if __name__ == "__main__": unittest.main()
