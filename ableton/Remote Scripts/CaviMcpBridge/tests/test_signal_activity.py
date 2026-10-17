import copy
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class SignalActivityTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.track = self.song.tracks[0]
        self.track.input_meter_level = .25
        self.track.output_meter_level = .5
        self.track.has_audio_output = True
        self.track.has_midi_output = False
        self.track.muted_via_solo = False
        self.song.master_track.name = "Main"

    def read(self, track_id="track-0"):
        return dispatch_request(self.song, {"method": "get_track_signal_activity", "params": {"trackId": track_id}}, 7)

    def test_native_hold_peaks_and_controls_are_read_without_changing_the_song(self):
        before = copy.deepcopy(self.song.__dict__)
        result = self.read()
        self.assertEqual(result["stateVersion"], 7)
        self.assertEqual(result["trackId"], "track-0")
        self.assertEqual(result["meters"]["input"], {"status": "available", "value": .25})
        self.assertEqual(result["meters"]["output"], {"status": "available", "value": .5})
        self.assertEqual(result["meterSemantics"], {"unit": "native_0_to_1", "kind": "peak_hold", "holdSeconds": 1})
        self.assertTrue(result["hasAudioOutput"])
        self.assertFalse(result["hasMidiOutput"])
        self.assertFalse(result["controls"]["mutedViaSolo"])
        self.assertEqual(result["controls"]["monitoringState"], 1)
        self.assertTrue(result["snapshotOnly"])
        self.assertFalse(result["audibleOutputVerified"])
        self.assertEqual(result["transport"]["currentSongTimeBeats"], self.song.current_song_time)
        self.assertNotIn("currentSongTime", result["transport"])
        self.assertEqual(self.song.undo_boundaries, before["undo_boundaries"])
        self.assertEqual(self.track.input_meter_level, .25)
        self.assertEqual(self.track.output_meter_level, .5)
        self.assertFalse(self.song.is_playing)
        self.assertFalse(self.track.arm)

    def test_zero_is_available_and_missing_meter_is_unknown_not_zero(self):
        self.track.input_meter_level = 0
        del self.track.output_meter_level
        result = self.read()
        self.assertEqual(result["meters"]["input"], {"status": "available", "value": 0})
        self.assertEqual(result["meters"]["output"], {"status": "unavailable", "value": None})
        self.assertNotIn("silent", result)

    def test_invalid_native_values_are_explicit_and_never_clamped(self):
        for value in (True, None, "0.5", math.nan, math.inf, -.1, 1.1):
            with self.subTest(value=value):
                self.track.output_meter_level = value
                self.assertEqual(self.read()["meters"]["output"], {"status": "invalid", "value": None})

    def test_unavailable_properties_do_not_hide_the_other_meter(self):
        class MeterTrack(type(self.track)):
            @property
            def input_meter_level(self):
                raise RuntimeError("native property unavailable")

            @property
            def output_meter_left(self):
                raise AssertionError("stereo meters must not be read")

        track = MeterTrack()
        track.output_meter_level = .75
        self.song.tracks[0] = track
        result = self.read()
        self.assertEqual(result["meters"]["input"]["status"], "unavailable")
        self.assertEqual(result["meters"]["output"]["value"], .75)
        self.assertIsNone(result["hasAudioOutput"])
        self.assertIsNone(result["controls"]["mutedViaSolo"])

    def test_return_and_main_resolve_exact_owners_and_preserve_missing_controls(self):
        for track_id, owner in (("return-0", self.song.return_tracks[0]), ("master", self.song.master_track)):
            owner.output_meter_level = 1
            result = self.read(track_id)
            self.assertEqual(result["trackId"], track_id)
            self.assertEqual(result["name"], owner.name)
            self.assertEqual(result["meters"]["output"]["value"], 1)

    def test_invalid_and_unavailable_ids_fail_without_falling_back_to_selection(self):
        for track_id in ("track-00", "track--1", "track-99", "return-00", "return-99", "main", ""):
            with self.subTest(track_id=track_id), self.assertRaises(ValueError):
                self.read(track_id)


if __name__ == "__main__":
    unittest.main()
