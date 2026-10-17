import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import beat_repeat_fill as fill
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Device, Parameter, QuantizedParameter, Track


class ObservableRepeat(QuantizedParameter):
    @property
    def value(self):
        return getattr(self, "_value", 0)

    @value.setter
    def value(self, value):
        previous = getattr(self, "_value", 0)
        self._value = value
        if previous != value:
            for listener in list(getattr(self, "listeners", [])):
                listener()

    def add_value_listener(self, callback):
        self.listeners.append(callback)

    def remove_value_listener(self, callback):
        self.listeners.remove(callback)


class BeatRepeatFillTests(unittest.TestCase):
    def setUp(self):
        fill._fills.clear()
        fill._sources.clear()
        self.song = Song()
        self.song.is_playing = True
        device = Device()
        device.name, device.class_name, device.class_display_name = "Beat Repeat", "BeatRepeat", "Beat Repeat"
        grid = Parameter()
        grid.name = grid.original_name = "Grid"
        grid.value = 7
        repeat = ObservableRepeat()
        repeat.listeners = []
        repeat.name = repeat.original_name = "Repeat"
        repeat.value_items, repeat.min, repeat.max = ("Off", "On"), 0, 1
        repeat.automation_state = 0
        repeat.value = 0
        device.parameters = [grid, repeat]
        self.song.tracks[0].devices = [device]
        self.device, self.repeat = device, repeat
        self.target = {"trackId": "track-0", "deviceId": "track-0:device-0"}

    def tearDown(self):
        fill.shutdown(self.song)
        fill._fills.clear()
        fill._sources.clear()

    def source(self):
        return dispatch_request(self.song, {"method": "get_beat_repeat_fill_source", "params": self.target}, 3)

    def start(self, **extra):
        params = {**self.target, "expectedStateVersion": 3, "durationSeconds": 1, "before": self.source(), **extra}
        return dispatch_request(self.song, {"method": "perform_beat_repeat_fill", "params": params}, 3)

    def test_expiry_runs_on_native_display_tick_without_client_requests(self):
        with patch.object(fill.time, "monotonic", return_value=10):
            started = self.start()
        self.assertEqual(started["status"], "active")
        self.assertEqual(self.repeat.value, 1)
        bridge = SocketBridge(SimpleNamespace(song=lambda: self.song), "/unused-fill-test.sock")
        bridge.state_version = 4
        with patch.object(fill.time, "monotonic", return_value=11.1):
            bridge.drain()
        result = fill.read(self.song, {"fillId": started["fillId"]}, bridge.state_version)
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["repeatOffObserved"])
        self.assertGreaterEqual(result["elapsedSeconds"], 1)
        self.assertEqual(self.device.parameters[0].value, 7)
        self.assertEqual(self.repeat.listeners, [])

    def test_manual_off_then_on_relinquishes_ownership_without_overwriting(self):
        started = self.start()
        self.repeat.value = 0
        self.repeat.value = 1
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(result["status"], "superseded")
        self.assertFalse(result["repeatOffObserved"])
        self.assertEqual(self.repeat.value, 1)
        self.assertEqual(self.repeat.listeners, [])

    def test_deferred_notification_of_owned_on_does_not_relinquish_ownership(self):
        started = self.start()
        fill._fills[started["fillId"]]["listener"]()
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(self.repeat.value, 0)

    def test_replaced_device_is_not_turned_off(self):
        started = self.start()
        replacement = Device()
        replacement.parameters = self.device.parameters[:1] + [ObservableRepeat()]
        replacement.parameters[1].listeners = []
        replacement.parameters[1].value = 1
        self.song.tracks[0].devices = [replacement]
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(result["status"], "cleanup_failed")
        self.assertEqual(replacement.parameters[1].value, 1)
        self.assertTrue(result["cleanupErrors"])

    def test_inserted_track_ids_resolve_to_original_native_owner(self):
        started = self.start()
        self.song.tracks.insert(0, Track())
        current = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(current["trackId"], "track-1")
        self.assertEqual(current["deviceId"], "track-1:device-0")
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        self.assertEqual(self.repeat.value, 0)

    def test_cancel_requires_exact_current_handle_plan_and_releases_it(self):
        started = self.start()
        params = {"fillId": started["fillId"], "expectedStateVersion": 4, "before": started, "cancel": True}
        self.device.parameters[0].value = 9
        # Unrelated manual controls are retained; cancellation owns only Repeat.
        result = dispatch_request(self.song, {"method": "finish_beat_repeat_fill", "params": params}, 4)
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(result["repeatOffObserved"])
        self.assertEqual(self.device.parameters[0].value, 9)
        self.assertEqual(fill.read(self.song, {}, 5)["fills"], [])

    def test_recording_automation_and_active_repeat_are_refused_before_writes(self):
        for field in ("record_mode", "session_record"):
            setattr(self.song, field, True)
            with self.assertRaisesRegex(ValueError, "recording"):
                self.source()
            setattr(self.song, field, False)
        self.repeat.automation_state = 1
        with self.assertRaisesRegex(ValueError, "automation"):
            self.source()
        self.repeat.automation_state = 0
        self.repeat.value = 1
        with self.assertRaisesRegex(ValueError, "Off"):
            self.source()
        self.assertEqual(fill._fills, {})

    def test_confirmation_rejects_native_replacement_and_invalid_duration(self):
        before = self.source()
        self.song.tracks[0].devices[0] = Device()
        self.song.tracks[0].devices[0].__dict__.update(self.device.__dict__)
        with self.assertRaisesRegex(ValueError, "changed"):
            dispatch_request(self.song, {"method": "perform_beat_repeat_fill", "params": {
                **self.target, "expectedStateVersion": 3, "durationSeconds": 1, "before": before}}, 3)
        for duration in (True, .1, 9, float("nan")):
            with self.assertRaisesRegex(ValueError, "duration"):
                self.start(durationSeconds=duration)
        self.assertEqual(self.repeat.value, 0)

    def test_transport_stop_and_bridge_shutdown_release_only_owned_repeat(self):
        first = self.start()
        self.song.is_playing = False
        fill.advance(self.song)
        self.assertEqual(fill.read(self.song, {"fillId": first["fillId"]}, 4)["status"], "interrupted")
        self.assertEqual(self.repeat.value, 0)
        self.song.is_playing = True
        self.start()
        fill.shutdown(self.song)
        self.assertEqual(self.repeat.value, 0)
        self.assertEqual(self.repeat.listeners, [])

    def test_runtime_automation_prevents_release_and_failure_remains_inspectable(self):
        started = self.start()
        self.repeat.automation_state = 1
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(result["status"], "cleanup_failed")
        self.assertFalse(result["releaseVerified"])
        self.assertEqual(self.repeat.value, 1)
        self.assertTrue(result["cleanupErrors"])

    def test_completed_release_does_not_claim_a_later_manual_on_is_off(self):
        started = self.start()
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        self.repeat.value = 1
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertTrue(result["releaseVerified"])
        self.assertFalse(result["repeatOffObserved"])
        self.assertEqual(result["status"], "complete")

    def test_listener_cleanup_failure_is_not_reported_as_complete(self):
        started = self.start()
        self.repeat.remove_value_listener = lambda callback: (_ for _ in ()).throw(RuntimeError("listener busy"))
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        result = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        self.assertEqual(result["status"], "cleanup_failed")
        self.assertTrue(result["repeatOffObserved"])
        self.assertTrue(result["cleanupErrors"])

    def test_listener_detach_failure_retains_retry_handle_and_shutdown_retries(self):
        started = self.start()
        self.repeat.remove_value_listener = lambda callback: (_ for _ in ()).throw(RuntimeError("listener busy"))
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        before = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        with self.assertRaisesRegex(RuntimeError, "listener"):
            fill.finish(self.song, {"fillId": started["fillId"], "expectedStateVersion": 4, "before": before}, 4)
        self.assertIn(started["fillId"], fill._fills)
        self.assertEqual(len(self.repeat.listeners), 1)
        del self.repeat.remove_value_listener
        fill.shutdown(self.song)
        self.assertEqual(self.repeat.listeners, [])
        before = fill.read(self.song, {"fillId": started["fillId"]}, 4)
        result = fill.finish(self.song, {"fillId": started["fillId"], "expectedStateVersion": 4, "before": before}, 4)
        self.assertTrue(result["handleReleased"])

    def test_finishing_old_set_listener_cleanup_returns_receipt_before_removal(self):
        started = self.start()
        self.repeat.remove_value_listener = lambda callback: (_ for _ in ()).throw(RuntimeError("listener busy"))
        fill.advance(self.song, now=fill._fills[started["fillId"]]["deadline"] + 1)
        other_song = Song()
        before = fill.read(other_song, {"fillId": started["fillId"]}, 4)
        del self.repeat.remove_value_listener
        result = fill.finish(other_song, {"fillId": started["fillId"], "expectedStateVersion": 4, "before": before}, 4)
        self.assertTrue(result["handleReleased"])
        self.assertEqual(self.repeat.listeners, [])
        self.assertNotIn(started["fillId"], fill._fills)


if __name__ == "__main__":
    unittest.main()
