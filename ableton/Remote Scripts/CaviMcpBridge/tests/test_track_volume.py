import copy
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class Volume:
    min, max, value = 0.0, 1.0, 0.75
    is_enabled, is_quantized, automation_state = True, False, 0

    def str_for_value(self, value):
        return "-inf dB" if value == 0 else f"{-60 + 66 * math.sqrt(value):.1f} dB"


class TrackVolumeTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks[0].mixer_device.volume = Volume()
        self.args = {"trackId": "track-0", "volumeDb": -12.0}

    def source(self):
        return dispatch_request(self.song, {"method": "get_track_volume_edit_context", "params": self.args}, 3)

    def apply(self, before=None):
        return dispatch_request(self.song, {"method": "set_track_volume_db", "params": {
            **self.args, "expectedStateVersion": 3, "before": before or self.source()}}, 3)

    def test_native_nonlinear_display_drives_plan_and_readback(self):
        before = self.source()
        self.assertEqual(before["target"]["displayValue"], "-12.0 dB")
        self.assertAlmostEqual(before["target"]["value"], (48 / 66) ** 2, delta=0.002)
        original = self.song.tracks[0].mixer_device.volume.value
        self.assertEqual(original, 0.75)
        result = self.apply(before)
        self.assertEqual(result["stateVersion"], 4)
        self.assertTrue(result["verified"])
        self.assertEqual(result["volume"]["decibels"], -12)
        self.assertFalse(self.song.tracks[0].mute)
        self.assertEqual(self.song.tracks[0].mixer_device.panning.value, 0)
        self.assertEqual(self.song.tracks[1].mixer_device.volume.value, 0.75)

    def test_manual_value_or_native_track_replacement_invalidates_plan(self):
        before = self.source()
        self.song.tracks[0].mixer_device.volume.value = 0.6
        with self.assertRaisesRegex(ValueError, "changed"):
            self.apply(before)
        self.song.tracks[0].mixer_device.volume.value = 0.75
        self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
        with self.assertRaisesRegex(ValueError, "changed"):
            self.apply(before)

    def test_rejects_automation_disabled_frozen_recording_and_unrepresentable_targets(self):
        volume = self.song.tracks[0].mixer_device.volume
        for state in [1, 2, None]:
            volume.automation_state = state
            with self.assertRaisesRegex(ValueError, "automation"):
                self.source()
        volume.automation_state = 0
        volume.is_enabled = False
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.source()
        volume.is_enabled = True
        self.song.tracks[0].is_frozen = True
        with self.assertRaisesRegex(ValueError, "frozen"):
            self.source()
        self.song.tracks[0].is_frozen = False
        for flag in ["record_mode", "session_record"]:
            setattr(self.song, flag, True)
            with self.assertRaisesRegex(ValueError, "recording"):
                self.source()
            setattr(self.song, flag, False)
        for db in [7, -90, float("nan"), True]:
            self.args["volumeDb"] = db
            with self.assertRaises(ValueError):
                self.source()
        self.assertEqual(volume.value, 0.75)

    def test_rechecks_automation_at_the_native_write_boundary(self):
        before = self.source()
        self.song.tracks[0].mixer_device.volume.automation_state = 1
        with self.assertRaisesRegex(ValueError, "automation"):
            self.apply(before)
        self.assertEqual(self.song.tracks[0].mixer_device.volume.value, 0.75)

    def test_unknown_display_is_unavailable_in_read_and_refused_for_write(self):
        volume = self.song.tracks[0].mixer_device.volume
        volume.str_for_value = lambda value: f"{value:.2f} Hz"
        self.assertIsNone(dispatch_request(self.song, {"method": "get_track_mixer", "params": {"trackId": "track-0"}}, 3)["volume"]["decibels"])
        with self.assertRaisesRegex(ValueError, "dB display"):
            self.source()

    def test_failed_native_readback_restores_only_the_original_volume(self):
        volume = self.song.tracks[0].mixer_device.volume
        class RejectingVolume(Volume):
            _value = 0.75
            @property
            def value(self):
                return self._value
            @value.setter
            def value(self, value):
                self._value = value if value == 0.75 else 0.9
        volume = self.song.tracks[0].mixer_device.volume = RejectingVolume()
        with self.assertRaisesRegex(RuntimeError, "readback"):
            self.apply()
        self.assertEqual(volume.value, 0.75)

    def test_return_and_main_faders_use_native_db_and_independent_readback(self):
        for track_id, owner in [('return-0', self.song.return_tracks[0]), ('master', self.song.master_track)]:
            with self.subTest(track_id=track_id):
                owner.mixer_device.volume = Volume()
                self.args['trackId'] = track_id
                before = self.source()
                self.assertEqual(before['trackId'], track_id)
                self.assertEqual(before['ownerType'], 'master' if track_id == 'master' else 'return')
                self.assertTrue(self.apply(before)['verified'])
                mixer = dispatch_request(self.song, {'method': 'get_set_mixer'}, 4)
                observed = mixer['master'] if track_id == 'master' else mixer['returns'][0]
                self.assertEqual(observed['volume']['decibels'], -12)
                self.assertEqual(observed['volume']['automationState'], {'value': 0, 'name': 'none'})
                self.assertEqual(observed['pan']['value'], 0)
                self.assertEqual(self.song.tracks[0].mixer_device.volume.value, .75)

    def test_bus_plans_bind_native_owner_mixer_and_parameter(self):
        for track_id in ['return-0', 'master']:
            for replaced in ['owner', 'mixer', 'parameter']:
                with self.subTest(track_id=track_id, replaced=replaced):
                    self.setUp()
                    self.args['trackId'] = track_id
                    owner = self.song.master_track if track_id == 'master' else self.song.return_tracks[0]
                    owner.mixer_device.volume = Volume()
                    before = self.source()
                    if replaced == 'owner':
                        if track_id == 'master': self.song.master_track = copy.deepcopy(owner)
                        else: self.song.return_tracks[0] = copy.deepcopy(owner)
                    elif replaced == 'mixer': owner.mixer_device = copy.deepcopy(owner.mixer_device)
                    else: owner.mixer_device.volume = Volume()
                    with self.assertRaisesRegex(ValueError, 'changed'):
                        self.apply(before)

    def test_bus_faders_refuse_recording_count_in_automation_and_invalid_ids(self):
        for track_id in ['return-0', 'master']:
            self.args['trackId'] = track_id
            owner = self.song.master_track if track_id == 'master' else self.song.return_tracks[0]
            owner.mixer_device.volume = Volume()
            for state in [1, 2, None]:
                owner.mixer_device.volume.automation_state = state
                with self.assertRaisesRegex(ValueError, 'automation'): self.source()
            owner.mixer_device.volume.automation_state = 0
            for flag in ['record_mode', 'session_record', 'is_counting_in']:
                setattr(self.song, flag, True)
                with self.assertRaisesRegex(ValueError, 'recording|count-in'): self.source()
                setattr(self.song, flag, False)
        for track_id in ['return-00', 'track-00', 'master-0', 'return--1', None]:
            self.args['trackId'] = track_id
            with self.assertRaises(ValueError): self.source()

    def test_native_undo_entry_rechecks_bus_ownership_before_any_write(self):
        for track_id in ['return-0', 'master']:
            self.setUp()
            self.args['trackId'] = track_id
            owner = self.song.master_track if track_id == 'master' else self.song.return_tracks[0]
            owner.mixer_device.volume = Volume()
            original = owner.mixer_device.volume
            before = self.source()
            self.song.begin_undo_step = lambda: setattr(owner, 'mixer_device', copy.deepcopy(owner.mixer_device))
            with self.assertRaisesRegex(ValueError, 'changed'): self.apply(before)
            self.assertEqual(original.value, .75)
            self.assertEqual(owner.mixer_device.volume.value, .75)

    def test_replaced_owner_during_failed_write_prevents_orphan_rollback(self):
        owner = self.song.return_tracks[0]
        song = self.song
        class ReplacingVolume(Volume):
            _value = .75
            writes = []
            @property
            def value(self): return self._value
            @value.setter
            def value(self, value):
                self.writes.append(value)
                self._value = value
                song.return_tracks[0] = copy.deepcopy(owner)
                raise RuntimeError('owner replaced')
        parameter = owner.mixer_device.volume = ReplacingVolume()
        self.args['trackId'] = 'return-0'
        with self.assertRaisesRegex(RuntimeError, 'rollback failed'): self.apply()
        self.assertEqual(len(parameter.writes), 1)

    def test_replaced_bus_mixer_at_undo_exit_cannot_report_verified(self):
        for track_id in ['return-0', 'master']:
            self.setUp()
            self.args['trackId'] = track_id
            owner = self.song.master_track if track_id == 'master' else self.song.return_tracks[0]
            owner.mixer_device.volume = Volume()
            self.song.end_undo_step = lambda: setattr(owner, 'mixer_device', copy.deepcopy(owner.mixer_device))
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.apply()

    def test_bus_readback_and_rollback_recheck_native_ownership(self):
        for replace_at in ['final_read', 'rollback']:
            self.setUp()
            self.args['trackId'] = 'return-0'
            owner = self.song.return_tracks[0]
            class ReplacingVolume(Volume):
                _value = .75
                replace_on_read = False
                @property
                def value(self): return self._value
                @value.setter
                def value(self, value):
                    self._value = value
                    if replace_at == 'rollback':
                        if value != .75: raise RuntimeError('write failed')
                        self.replace()
                def replace(self):
                    replacement = copy.copy(owner.mixer_device)
                    replacement.volume = Volume()
                    owner.mixer_device = replacement
                def str_for_value(self, value):
                    result = super().str_for_value(value)
                    if self.replace_on_read: self.replace()
                    return result
            parameter = owner.mixer_device.volume = ReplacingVolume()
            if replace_at == 'final_read':
                self.song.end_undo_step = lambda: setattr(parameter, 'replace_on_read', True)
            with self.subTest(replace_at=replace_at):
                with self.assertRaisesRegex((ValueError, RuntimeError), 'changed|rollback failed'):
                    self.apply()


if __name__ == "__main__":
    unittest.main()
