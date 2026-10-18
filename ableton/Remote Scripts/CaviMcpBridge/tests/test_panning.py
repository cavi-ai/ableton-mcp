import copy
import json
import struct
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Parameter
from test_track_routing import ready_song
from test_track_mixer import prepare_mixers,mixer_plan
from test_return_mixer import return_plan
from bridge import dispatch_request, SocketBridge, _persisted_track_state, _persisted_device_chain


class Pan(Parameter):
    def __init__(self, value):
        super().__init__()
        self.min, self.max = -1, 1
        self._value = value
        self.automation_state = 0
        self.writes, self.callback, self.defer, self.fail = [], None, False, False

    @property
    def value(self): return self._value

    @value.setter
    def value(self, value):
        # Parameter.__init__ runs before the observation journal exists.
        if not hasattr(self, 'writes'):
            self._value = value
            return
        self.writes.append(value)
        if self.fail: raise RuntimeError('pan write refused')
        if not self.defer:
            self._value = struct.unpack('f', struct.pack('f', value))[0] if getattr(self, 'float32', False) else value
        if self.callback: self.callback()


def prepare(song):
    for track in [*song.tracks, *song.return_tracks, song.master_track]:
        mixer = track.mixer_device
        mixer.panning_mode = 0
        mixer.panning, mixer.left_split_stereo, mixer.right_split_stereo = Pan(0), Pan(-1), Pan(1)
    return song


class RefuseMute:
    def __init__(self, owner): self.owner = owner
    def __getattr__(self, key): return getattr(self.owner, key)
    @property
    def mute(self): return self.owner.mute
    @mute.setter
    def mute(self, value):
        if value: raise RuntimeError('mute refused')
        self.owner.mute = value


class PanningTests(unittest.TestCase):
    def setUp(self): self.song = prepare(Song())

    def call(self, name, args=None):
        return dispatch_request(self.song, {'method': name, 'params': args or {}}, 4)

    def source(self, owner='track-0'):
        return self.call('get_mixer_panning_context', {'trackId': owner})

    def write(self, change, owner='track-0', before=None):
        return self.call('set_mixer_panning', {'trackId': owner, **change, 'expectedStateVersion': 4,
                        'before': before or self.source(owner)})

    def test_reads_track_group_return_and_main_without_writes(self):
        self.song.tracks[1].is_foldable = True
        for owner, kind in [('track-0', 'midi'), ('track-1', 'group'), ('return-0', 'return'), ('master', 'master')]:
            view = self.source(owner)
            self.assertEqual(view['type'], kind)
            self.assertEqual(view['mode'], {'supported': True, 'value': 0, 'name': 'stereo'})
            self.assertEqual(view['parameters']['left']['value'], -1)
            self.assertEqual(view, self.source(owner))
        self.assertEqual(self.song.undo_boundaries, [])

    def test_stereo_and_split_edits_are_separate_from_mode_changes(self):
        for owner in ['track-0', 'return-0', 'master']:
            self.assertTrue(self.write({'pan': -.25}, owner)['verified'])
            self.assertTrue(self.write({'mode': 'splitStereo'}, owner)['verified'])
            result = self.write({'left': -.5, 'right': .5}, owner)
            self.assertTrue(result['verified'])
            self.assertEqual(result['requestedControls'], ['left', 'right'])
            self.assertEqual(result['observed']['parameters']['pan']['value'], -.25)
            self.assertEqual(self.write({'left': -.5}, owner)['requestedControls'], [])

    def test_running_clock_advances_without_invalidating_the_pan_plan(self):
        self.song.is_playing = True
        before = self.source(); self.song.current_song_time += 1
        self.assertTrue(self.write({'pan': .5}, before=before)['verified'])
        self.assertTrue(self.song.is_playing)

    def test_wrong_mode_mixed_operations_bad_targets_and_values_refuse_before_writes(self):
        for change in [{}, {'pan': True}, {'pan': 2}, {'pan': float('nan')}, {'left': .5},
                       {'mode': 'unknown'}, {'mode': 'splitStereo', 'pan': 0}, {'pan': 0, 'left': 0}]:
            with self.assertRaises(ValueError): self.write(change)
        for owner in ['track-00', 'return-00', 'master-0', 'track--1']:
            with self.assertRaises(ValueError): self.source(owner)
        self.assertEqual(self.song.tracks[0].mixer_device.panning.writes, [])

    def test_recording_count_in_frozen_automation_unknown_disabled_and_quantized_refuse(self):
        mixer = self.song.tracks[0].mixer_device
        for owner, field, value in [(self.song, 'record_mode', True), (self.song, 'session_record', True),
                (self.song, 'is_counting_in', True), (self.song.tracks[0], 'is_frozen', True),
                (mixer.panning, 'automation_state', 1), (mixer.panning, 'automation_state', 99),
                (mixer.panning, 'is_enabled', False), (mixer.panning, 'is_quantized', True),
                (mixer, 'panning_mode', 99)]:
            old = getattr(owner, field, False); setattr(owner, field, value)
            self.source()
            with self.assertRaises(ValueError): self.write({'pan': .5})
            setattr(owner, field, old)
        mixer.left_split_stereo.automation_state = 1
        with self.assertRaises(ValueError): self.write({'mode': 'splitStereo'})
        self.assertEqual(mixer.panning.writes, [])

    def test_native_replacements_manual_values_and_modes_invalidate_same_version_context(self):
        for change in [lambda: setattr(self.song.tracks[0].mixer_device.panning, '_value', .75),
                       lambda: setattr(self.song.tracks[0].mixer_device, 'panning_mode', 1),
                       lambda: setattr(self.song.tracks[0].mixer_device, 'panning', Pan(0)),
                       lambda: setattr(self.song.tracks[0], 'mixer_device', copy.deepcopy(self.song.tracks[0].mixer_device)),
                       lambda: self.song.tracks.__setitem__(0, copy.deepcopy(self.song.tracks[0]))]:
            before = self.source(); change()
            with self.assertRaises(ValueError): self.write({'mode': 'stereo'}, before=before)

    def test_context_is_rechecked_after_undo_entry_and_between_split_writes(self):
        mixer = self.song.tracks[0].mixer_device; mixer.panning_mode = 1
        self.song.begin_undo_step = lambda: setattr(mixer.right_split_stereo, '_value', .75)
        result = self.write({'left': -.5, 'right': .5})
        self.assertTrue(result['partial']); self.assertEqual(result['requestedControls'], [])
        self.song.begin_undo_step = lambda: None
        mixer.left_split_stereo.callback = lambda: setattr(mixer.right_split_stereo, '_value', .25)
        result = self.write({'left': -.5, 'right': .5})
        self.assertTrue(result['partial']); self.assertEqual(result['requestedControls'], ['left'])
        self.assertEqual(mixer.right_split_stereo.writes, [])

    def test_failed_second_parameter_retains_partial_work_without_rollback(self):
        mixer = self.song.tracks[0].mixer_device; mixer.panning_mode = 1
        mixer.right_split_stereo.fail = True
        result = self.write({'left': -.5, 'right': .5})
        self.assertTrue(result['partial']); self.assertFalse(result['verified'])
        self.assertEqual(mixer.left_split_stereo.writes, [-.5])
        self.assertEqual(mixer.left_split_stereo.value, -.5)
        self.assertIn('refused', result['error'])

    def test_parameter_bounds_changed_during_setter_do_not_verify_even_when_value_matches(self):
        pan = self.song.tracks[0].mixer_device.panning
        pan.callback = lambda: setattr(pan, 'max', .75)
        result = self.write({'pan': .5})
        self.assertFalse(result['verified']); self.assertTrue(result['partial'])
        self.assertFalse(result['verification']['parameterContextPreserved'])
        self.assertEqual(pan.writes, [.5])

    def test_fractional_split_batch_accepts_only_native_rounding_of_issued_targets(self):
        mixer = self.song.tracks[0].mixer_device; mixer.panning_mode = 1
        mixer.left_split_stereo.float32 = mixer.right_split_stereo.float32 = True
        result = self.write({'left': -.3, 'right': .3})
        self.assertTrue(result['verified'])
        self.assertEqual(result['requestedControls'], ['left', 'right'])
        self.assertEqual(mixer.right_split_stereo.writes, [.3])

    def test_legacy_pan_guards_recheck_after_earlier_setters_switch_mode(self):
        self.song = prepare(prepare_mixers(ready_song()))
        for owner_id, owner in [('track-0', self.song.tracks[0]), ('return-0', self.song.return_tracks[0]), ('master', self.song.master_track)]:
            mixer = owner.mixer_device
            mixer.volume = Pan(.75)
            mixer.volume.callback = lambda m=mixer: setattr(m, 'panning_mode', 1)
            changes = {'volume': {'previousValue': .75, 'requestedValue': .5, 'value': .5},
                       'pan': {'previousValue': 0, 'requestedValue': .5, 'value': .5}}
            source = self.call('get_set_mixer')
            params = {'trackId': owner_id, 'changes': changes}
            if owner_id == 'master': params['beforeMaster'] = source['master']
            if owner_id == 'return-0': params.update(returnTrackId=owner_id, beforeReturn=source['returns'][0])
            if owner_id != 'master':
                result = self.call('set_track_mixer',mixer_plan(self.song,{owner_id:{'volume':.5,'pan':.5}})) if owner_id == 'track-0' else self.call('set_return_mixer',return_plan(self.song,{'volume':.5,'pan':.5}))
                self.assertFalse(result['verified'])
                self.assertEqual([row['field'] for row in result['writes']],['volume'])
                self.assertEqual(result['observedContext']['tracks'][0]['pan']['panningMode']['name'],'splitStereo')
            else:
                with self.assertRaisesRegex(ValueError, 'Stereo'):
                    self.call('set_master_mixer' if owner_id == 'master' else 'set_return_mixer', params)
            self.assertEqual(mixer.panning.writes, [])

    def test_bulk_rechecks_later_owner_before_any_of_its_writes(self):
        self.song = prepare(prepare_mixers(ready_song()))
        first, second = [track.mixer_device for track in self.song.tracks]
        first.volume = Pan(.75)
        first.volume.callback = lambda: setattr(second, 'panning_mode', 1)
        second_volume = second.volume.value
        result = self.call('set_bulk_track_mixer',mixer_plan(self.song,{key:{'volume':.5,'pan':.5} for key in ['track-0','track-1']}))
        self.assertFalse(result['verified'])
        self.assertEqual([(row['trackId'],row['field']) for row in result['writes']],[('track-0','volume')])
        self.assertEqual(second.volume.value, second_volume)
        self.assertEqual(second.panning.writes, [])

    def test_return_pan_refuses_replaced_mixer_after_an_earlier_setter(self):
        self.song = prepare(prepare_mixers(ready_song()))
        track = self.song.return_tracks[0]
        original = track.mixer_device
        original.volume = Pan(.75)
        replacement = copy.deepcopy(original)
        original.volume.callback = lambda: setattr(track, 'mixer_device', replacement)
        result = self.call('set_return_mixer',return_plan(self.song,{'volume':.5,'pan':.5}))
        self.assertFalse(result['verified']);self.assertFalse(result['targetRetained'])
        self.assertEqual([row['field'] for row in result['writes']],['volume'])
        self.assertEqual(original.panning.writes, [])
        self.assertEqual(replacement.panning.writes, [])

    def test_snapshot_pan_previously_unchanged_is_rechecked_if_an_earlier_setter_changes_it(self):
        for owner_id in ['track-0', 'return-0', 'master']:
            owner = self.song.tracks[0] if owner_id == 'track-0' else self.song.return_tracks[0] if owner_id == 'return-0' else self.song.master_track
            owner.devices = []
            mixer = owner.mixer_device
            mixer.volume = Pan(.75)
            def changed(m=mixer):
                m.panning_mode = 1
                m.panning._value = .25
            mixer.volume.callback = changed
            method = 'get_track_state_snapshot' if owner_id == 'track-0' else 'get_device_chain_snapshot'
            current = self.call(method, {'trackId': owner_id})
            target = _persisted_track_state(current) if owner_id == 'track-0' else _persisted_device_chain(current,
                'cavi-device-chain-v5' if owner_id == 'return-0' else 'cavi-device-chain-v6')
            target['mixer' if owner_id == 'track-0' else 'ownerMixer']['volume'] = .5
            with self.assertRaisesRegex(ValueError, 'Stereo'):
                self.call('set_track_state_snapshot' if owner_id == 'track-0' else 'set_device_chain_snapshot',
                    {'trackId': owner_id, 'before': current, 'target': target})
            self.assertEqual(mixer.panning.writes, [])

    def test_pan_rollback_preserves_partial_state_after_mode_or_owner_changes(self):
        for operation in ['master', 'trackSnapshot', 'returnSnapshot']:
            self.song = prepare(Song())
            native = self.song.tracks[0] if operation == 'trackSnapshot' else self.song.return_tracks[0]
            if operation == 'master': native = self.song.master_track
            native.devices = []
            native.mute = False
            owner = RefuseMute(native)
            owner_id = 'track-0' if operation == 'trackSnapshot' else 'master' if operation == 'master' else 'return-0'
            if owner_id == 'track-0': self.song.tracks[0] = owner
            elif owner_id == 'master': self.song.master_track = owner
            else: self.song.return_tracks[0] = owner
            mixer = owner.mixer_device
            mixer.panning.callback = lambda m=mixer: setattr(m, 'panning_mode', 1)
            if operation == 'master':
                mixer.cue_volume = Pan(.7); mixer.cue_volume.fail = True
                before = self.call('get_set_mixer')['master']
                args = {'beforeMaster': before, 'changes': {
                    'pan': {'previousValue': 0, 'requestedValue': .5, 'value': .5},
                    'cueVolume': {'previousValue': .7, 'requestedValue': .5, 'value': .5}}}
                method = 'set_master_mixer'
            else:
                before = self.call('get_track_state_snapshot' if owner_id == 'track-0' else 'get_device_chain_snapshot', {'trackId': owner_id})
                target = _persisted_track_state(before) if owner_id == 'track-0' else _persisted_device_chain(before, 'cavi-device-chain-v5')
                target['mixer' if owner_id == 'track-0' else 'ownerMixer'].update(pan=.5, mute=True)
                args = {'trackId': owner_id, 'before': before, 'target': target}
                method = 'set_track_state_snapshot' if owner_id == 'track-0' else 'set_device_chain_snapshot'
            with self.assertRaises(RuntimeError): self.call(method, args)
            self.assertEqual(mixer.panning.writes, [.5], operation)
            self.assertEqual(mixer.panning.value, .5, operation)

    def test_legacy_stereo_pan_setters_refuse_split_mode_before_other_changes(self):
        self.song = prepare(prepare_mixers(ready_song()))
        self.song.tracks[1].mixer_device.panning_mode = 1
        before = self.song.tracks[1].mixer_device.volume.value
        with self.assertRaisesRegex(ValueError, 'Stereo'):
            self.call('set_track_mixer',mixer_plan(self.song,{'track-1':{'volume':.1,'pan':.5}}))
        self.assertEqual(self.song.tracks[1].mixer_device.volume.value, before)
        with self.assertRaisesRegex(ValueError, 'Stereo'):
            self.call('set_bulk_track_mixer',mixer_plan(self.song,{key:{'pan':.5} for key in ['track-0','track-1']}))
        self.assertEqual(self.song.tracks[0].mixer_device.panning.writes, [])

    def test_bus_pan_setters_and_snapshot_recalls_refuse_inactive_pan_before_other_writes(self):
        self.song = prepare(prepare_mixers(ready_song()))
        for owner in ['master', 'return-0']:
            native = self.song.master_track if owner == 'master' else self.song.return_tracks[0]
            native.mixer_device.panning_mode = 1
            native.devices = []
            source = self.call('get_set_mixer')
            row = source['master'] if owner == 'master' else source['returns'][0]
            changes = {key: {'previousValue': row[key]['value'], 'requestedValue': .5, 'value': .5} for key in ['volume', 'pan']}
            params = {'beforeMaster': row} if owner == 'master' else {'beforeReturn': row, 'returnTrackId': owner}
            with self.assertRaisesRegex(ValueError, 'Stereo'):
                self.call('set_master_mixer', {**params,'changes':changes}) if owner == 'master' else self.call('set_return_mixer',return_plan(self.song,{'volume':.5,'pan':.5}))
            self.assertEqual(native.mixer_device.volume.value, row['volume']['value'])
            current = self.call('get_device_chain_snapshot', {'trackId': owner})
            target = _persisted_device_chain(current, 'cavi-device-chain-v6' if owner == 'master' else 'cavi-device-chain-v5')
            target['ownerMixer']['pan'] = .5
            with self.assertRaisesRegex(ValueError, 'Stereo'):
                self.call('set_device_chain_snapshot', {'trackId': owner, 'before': current, 'target': target})
        self.song.tracks[0].mixer_device.panning_mode = 1
        current = self.call('get_track_state_snapshot', {'trackId': 'track-0'})
        target = _persisted_track_state(current)
        target['mixer']['pan'] = .5
        with self.assertRaisesRegex(ValueError, 'Stereo'):
            self.call('set_track_state_snapshot', {'trackId': 'track-0', 'before': current, 'target': target})

    def test_export_snapshot_binds_mode_split_values_and_native_parameter_identity(self):
        before = self.call('get_audio_export_source')
        self.song.return_tracks[0].mixer_device.left_split_stereo._value = -.25
        after = self.call('get_audio_export_source')
        self.assertNotEqual(before, after)
        self.assertEqual(before['stateVersion'], after['stateVersion'])
        self.song.return_tracks[0].mixer_device.left_split_stereo = Pan(-.25)
        self.assertNotEqual(after, self.call('get_audio_export_source'))

    def test_deferred_readback_observes_without_replaying_a_parameter_request(self):
        parameter = self.song.tracks[0].mixer_device.panning; parameter.defer = True
        callbacks, replies = [], []
        surface = SimpleNamespace(song=lambda: self.song, application=lambda: None,
            schedule_message=lambda delay, callback: callbacks.append(callback))
        client = SimpleNamespace(sendall=lambda payload: replies.append(json.loads(payload)))
        bridge = SocketBridge(surface, '/unused'); bridge.state_version = 4
        bridge.requests.put((client, {'id': 1, 'method': 'set_mixer_panning', 'params': {
            'trackId': 'track-0', 'pan': .5, 'expectedStateVersion': 4, 'before': self.source()}}))
        bridge.drain(); callbacks.pop(0)(); self.assertEqual(replies, [])
        parameter._value = .5; callbacks.pop(0)()
        self.assertTrue(replies[0]['result']['verified']); self.assertEqual(parameter.writes, [.5])


if __name__ == '__main__': unittest.main()
