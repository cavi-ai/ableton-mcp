import copy
import importlib
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Parameter
from bridge import dispatch_request, SocketBridge


class Mixer:
    def __init__(self):
        self._side = 1
        self.writes = []
        self.callback = None
        self.defer = False
        self.fail = False

    @property
    def crossfade_assign(self):
        return self._side

    @crossfade_assign.setter
    def crossfade_assign(self, value):
        self.writes.append(value)
        if self.fail: raise RuntimeError('assignment refused')
        if not self.defer: self._side = value
        if self.callback: self.callback()


class CrossfaderTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        for track in [*self.song.tracks, *self.song.return_tracks]: track.mixer_device = Mixer()
        self.parameter = Parameter(); self.parameter.min = -1; self.parameter.max = 1
        self.parameter.value = .25; self.parameter.automation_state = 0
        self.song.master_track.mixer_device.crossfader = self.parameter
        self.assign = {'assignments': [{'trackId': 'track-0', 'side': 'A'}, {'trackId': 'return-0', 'side': 'B'}]}

    def call(self, name, args=None, version=4):
        return dispatch_request(self.song, {'method': name, 'params': args or {}}, version)

    def source(self):
        return self.call('get_crossfader_context')

    def start(self, args=None, before=None):
        return self.call('set_crossfader_state', {**(self.assign if args is None else args),
                         'expectedStateVersion': 4, 'before': before or self.source()})

    def test_read_is_inert_and_reports_all_bus_members_and_main_automation(self):
        view = self.source()
        self.assertEqual([r['trackId'] for r in view['tracks']], ['track-0', 'track-1', 'return-0'])
        self.assertEqual(view['position']['value'], .25)
        self.assertEqual(view['position']['automationState'], {'value': 0, 'name': 'none'})
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [])

    def test_assignment_batch_changes_exact_track_and_return_without_moving_main(self):
        self.song.is_playing = True
        before = self.source(); self.song.current_song_time += 1
        result = self.start(before=before)
        self.assertTrue(result['verified']); self.assertEqual(result['requestedAssignmentTrackIds'], ['track-0', 'return-0'])
        self.assertEqual(self.song.tracks[0].mixer_device.crossfade_assign, 0)
        self.assertEqual(self.song.return_tracks[0].mixer_device.crossfade_assign, 2)
        self.assertEqual(self.song.tracks[1].mixer_device.writes, [])
        self.assertEqual(self.parameter.value, .25); self.assertTrue(self.song.is_playing)

    def test_position_move_preserves_assignments_and_unchanged_value_is_no_op(self):
        before = self.source()
        result = self.start({'position': -.5}, before)
        self.assertTrue(result['verified']); self.assertTrue(result['positionWriteRequested'])
        self.assertEqual(self.parameter.value, -.5)
        self.assertTrue(all(not track.mixer_device.writes for track in [*self.song.tracks, *self.song.return_tracks]))
        result = self.start({'position': -.5})
        self.assertFalse(result['positionWriteRequested']); self.assertTrue(result['verified'])

    def test_same_valued_mixer_track_or_parameter_replacement_refuses_confirmation(self):
        for replace in ('mixer', 'track', 'parameter'):
            before = self.source()
            if replace == 'mixer': self.song.tracks[0].mixer_device = copy.deepcopy(self.song.tracks[0].mixer_device)
            elif replace == 'track': self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            else: self.song.master_track.mixer_device.crossfader = copy.deepcopy(self.parameter)
            with self.assertRaisesRegex(ValueError, 'changed'): self.start(before=before)
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [])

    def test_manual_assignment_or_main_value_change_invalidates_confirmation(self):
        before = self.source(); self.song.tracks[1].mixer_device._side = 2
        with self.assertRaisesRegex(ValueError, 'changed'): self.start(before=before)
        before = self.source(); self.parameter.value = -.25
        with self.assertRaisesRegex(ValueError, 'changed'): self.start(before=before)

    def test_recording_count_in_disabled_unknown_and_active_automation_refuse_writes(self):
        for owner, field, value in ((self.song, 'record_mode', True), (self.song, 'session_record', True),
                (self.song, 'is_counting_in', True), (self.parameter, 'is_enabled', False),
                (self.parameter, 'automation_state', 1), (self.parameter, 'automation_state', 2),
                (self.parameter, 'automation_state', 99)):
            previous = getattr(owner, field, False); setattr(owner, field, value)
            self.source()  # Inspection stays available during recording/automation.
            with self.assertRaises(ValueError): self.start()
            setattr(owner, field, previous)
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [])

    def test_invalid_scopes_targets_values_and_combined_operation_refuse_all_writes(self):
        for args in ({}, {'position': True}, {'position': float('nan')}, {'position': 2}, {'assignments': []},
                     {'assignments': [{'trackId': 'master', 'side': 'A'}]},
                     {'assignments': [{'trackId': 'track-0', 'side': 'C'}]},
                     {'assignments': self.assign['assignments'] * 2}, {**self.assign, 'position': 0}):
            with self.assertRaises(ValueError): self.start(args)
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [])

    def test_failed_second_assignment_preserves_partial_work_without_rollback(self):
        self.song.return_tracks[0].mixer_device.fail = True
        result = self.start()
        self.assertFalse(result['verified']); self.assertTrue(result['partial'])
        self.assertIn('assignment refused', result['error'])
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [0])
        self.assertEqual(self.parameter.value, .25)

    def test_replacement_during_setter_is_never_written_or_restored(self):
        old = self.song.return_tracks[0].mixer_device
        replacement = Mixer()
        self.song.tracks[0].mixer_device.callback = lambda: setattr(self.song.return_tracks[0], 'mixer_device', replacement)
        result = self.start()
        self.assertTrue(result['partial']); self.assertFalse(result['verified'])
        self.assertEqual(old.writes, []); self.assertEqual(replacement.writes, [])

    def test_position_write_rechecks_context_after_undo_step_entry(self):
        self.song.begin_undo_step = lambda: setattr(self.parameter, 'value', .75)
        result = self.start({'position': -.5})
        self.assertTrue(result['partial']); self.assertFalse(result['positionWriteRequested'])
        self.assertEqual(self.parameter.value, .75)

    def test_manual_main_move_during_assignment_stops_remaining_writes(self):
        self.song.tracks[0].mixer_device.callback = lambda: setattr(self.parameter, 'value', -.75)
        result = self.start()
        self.assertTrue(result['partial']); self.assertEqual(self.parameter.value, -.75)
        self.assertEqual(self.song.return_tracks[0].mixer_device.writes, [])

    def test_unavailable_assignment_or_main_support_is_explicit_and_not_writable(self):
        self.song.tracks[0].mixer_device = SimpleNamespace()
        self.assertFalse(self.source()['tracks'][0]['assignment']['supported'])
        with self.assertRaises(ValueError): self.start()
        del self.song.master_track.mixer_device.crossfader
        self.assertFalse(self.source()['position']['supported'])
        with self.assertRaises(ValueError): self.start({'position': 0})

    def test_socket_bridge_observes_deferred_assignment_without_reissuing_it(self):
        self.song.tracks[0].mixer_device.defer = True
        callbacks, replies = [], []
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
            schedule_message=lambda delay, callback: callbacks.append(callback))
        client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
        bridge = SocketBridge(surface, '/unused'); bridge.state_version = 4
        bridge.requests.put((client, {'id': 1, 'method': 'set_crossfader_state', 'params': {
            **self.assign, 'expectedStateVersion': 4, 'before': self.source()}}))
        bridge.drain(); self.assertEqual(replies, [])
        callbacks.pop(0)(); self.assertEqual(replies, [])
        self.song.tracks[0].mixer_device._side = 0
        callbacks.pop(0)()
        self.assertTrue(replies[0]['result']['verified']); self.assertFalse(bridge.deferred_request)
        self.assertEqual(self.song.tracks[0].mixer_device.writes, [0])


if __name__ == '__main__': unittest.main()
