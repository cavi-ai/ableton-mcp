import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Track, prepare_loop_target
from types import SimpleNamespace


def RoutingOption(identifier, name):
    return SimpleNamespace(identifier=identifier, display_name=name)


def ready_song():
    song = Song()
    prepare_loop_target(song)
    song.record_mode = song.session_record = False
    for track in song.tracks:
        track.can_be_armed = True
        track.implicit_arm = track.is_foldable = False
        track.arrangement_clips = []
        for slot in track.clip_slots:
            slot.is_triggered = False
            if slot.has_clip:
                slot.clip.is_recording = slot.clip.is_overdubbing = slot.clip.is_triggered = False
    return song


class TrackRoutingTests(unittest.TestCase):
    def setUp(self):
        self.song = ready_song()

    def read(self):
        return dispatch_request(self.song, {'method':'get_track_routing_edit_context', 'params':{'trackId':'track-0'}}, 4)

    def plan(self, **changes):
        before = self.read()
        result = {}
        for key, value in changes.items():
            if key == 'monitoring':
                selected = next(row for row in before['monitoring']['choices'] if row['value'] == value)
                previous = {k:before['monitoring'][k] for k in ('name','value')}
            else:
                section = 'input' if key.startswith('input') else 'output'
                field = 'type' if 'Type' in key else 'channel'
                selected = next(row for row in before[section]['availableTypes' if field == 'type' else 'availableChannels'] if row['id'] == value)
                previous = before[section][field]
            result[key] = {'previous':previous, 'value':selected}
        return {'trackId':'track-0','expectedStateVersion':4,'before':before,'changes':result}

    def change(self, plan):
        return dispatch_request(self.song, {'method':'set_track_routing','params':plan}, 4)

    def test_multiple_exact_changes_have_a_verified_receipt_and_one_undo(self):
        result = self.change(self.plan(inputChannelId='channel-1',outputTypeId='no-output',monitoring=2))
        self.assertTrue(result['verified'])
        self.assertTrue(result['targetRetained'])
        self.assertTrue(result['contextPreserved'])
        self.assertEqual(result['input']['channel']['id'], 'channel-1')
        self.assertEqual(result['output']['type']['id'], 'no-output')
        self.assertEqual(result['monitoring']['name'], 'off')
        self.assertEqual(len(result['writes']), 3)
        self.assertEqual(self.song.undo_boundaries, ['begin','end'])

    def test_stale_owner_options_and_manual_context_changes_refuse_before_writing(self):
        for field in ('owner','options','monitoring','otherInput','otherArm','recording','scene'):
            self.setUp(); plan = self.plan(outputTypeId='no-output')
            if field == 'owner': self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            elif field == 'options': self.song.tracks[0].available_output_routing_types.pop()
            elif field == 'monitoring': self.song.tracks[0].current_monitoring_state = 2
            elif field == 'otherInput': self.song.tracks[1].current_input_routing = 'No Input'
            elif field == 'otherArm': self.song.tracks[1].arm = True
            elif field == 'recording': self.song.record_mode = True
            else: self.song.scenes[0].is_triggered = True
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'changed|context'):
                self.change(plan)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_input_requires_disarmed_target_but_output_preserves_existing_arms(self):
        self.song.tracks[0].arm = self.song.tracks[1].arm = True
        with self.assertRaisesRegex(ValueError, 'disarmed'): self.change(self.plan(monitoring=2))
        result = self.change(self.plan(outputTypeId='no-output'))
        self.assertTrue(result['verified'])
        self.assertTrue(all(track.arm for track in self.song.tracks))

    def test_no_input_can_be_routed_and_group_output_does_not_read_monitoring(self):
        self.song.tracks[0].can_be_armed = False
        self.song.tracks[0].current_input_routing = 'No Input'
        self.assertTrue(self.change(self.plan(inputTypeId='all-ins'))['verified'])
        self.setUp()
        group = self.song.tracks[0]
        group.is_foldable = True
        del group.current_monitoring_state
        self.assertTrue(self.change(self.plan(outputTypeId='no-output'))['verified'])
        with self.assertRaisesRegex(ValueError, 'Group'): self.change(self.plan(inputTypeId='no-input'))

    def test_noop_has_no_native_write_or_undo(self):
        result = self.change(self.plan(monitoring=1,outputTypeId='main'))
        self.assertTrue(result['verified'])
        self.assertEqual(result['writes'], [])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_undo_entry_rechecks_owner(self):
        plan = self.plan(outputTypeId='no-output')
        self.song.begin_undo_step = lambda: setattr(self.song.tracks[0], 'current_monitoring_state', 2)
        with self.assertRaisesRegex(ValueError, 'changed'): self.change(plan)
        self.assertEqual(self.song.tracks[0].current_output_routing.identifier, 'main')

    def test_duplicate_labels_use_exact_modern_native_objects(self):
        track = self.song.tracks[0]
        track.available_output_routing_types = [RoutingOption('first','Bus'),RoutingOption('second','Bus')]
        track.output_routing_type = track.available_output_routing_types[0]
        result = self.change(self.plan(outputTypeId='second'))
        self.assertTrue(result['verified'])
        self.assertIs(track.output_routing_type, track.available_output_routing_types[1])

    def test_recording_pending_and_unknown_readiness_refuse(self):
        for owner,field,value in [('song','record_mode',True),('song','is_counting_in',None),
                ('track','fired_slot_index',0),('scene','is_triggered',True),('clip','is_recording',True)]:
            self.setUp()
            targets = {'song':self.song,'track':self.song.tracks[0], 'scene':self.song.scenes[0], 'clip':self.song.tracks[0].clip_slots[0].clip}
            setattr(targets[owner],field,value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'recording|launch|readiness'):
                self.change(self.plan(outputTypeId='no-output'))
            self.assertEqual(self.song.undo_boundaries, [])

    def test_ignored_and_throw_after_write_setters_are_never_replayed(self):
        for failure in ('ignored','throws'):
            self.setUp()
            class Uncertain(Track):
                calls = 0
                @property
                def output_routing_type(track): return track.actual_output
                @output_routing_type.setter
                def output_routing_type(track, value):
                    track.calls += 1
                    if failure == 'throws':
                        track.actual_output = value
                        raise RuntimeError('failed after applying')
            track = self.song.tracks[0]
            track.actual_output = track.current_output_routing
            track.__class__ = Uncertain
            result = self.change(self.plan(outputTypeId='no-output',monitoring=2))
            self.assertFalse(result['verified'])
            self.assertEqual(track.calls, 1)
            self.assertEqual(len(result['writes']), 1)
            self.assertEqual(result['nativeReturned'], failure == 'ignored')
            self.assertEqual(track.current_monitoring_state, 1)
            self.assertEqual(result['output']['type']['id'], 'main' if failure == 'ignored' else 'no-output')

    def test_dependent_channel_is_disclosed_but_manual_monitoring_stops_remaining_writes(self):
        for manual in (False,True):
            self.setUp(); song = self.song
            class Dynamic(Track):
                @property
                def output_routing_type(track): return track.actual_output
                @output_routing_type.setter
                def output_routing_type(track,value):
                    track.actual_output = value
                    track.available_output_routing_channels = [RoutingOption('new','New Channel')]
                    track.current_output_sub_routing = track.available_output_routing_channels[0]
                    if manual: song.tracks[1].current_monitoring_state = 0
            track = self.song.tracks[0];track.actual_output = track.current_output_routing;track.__class__ = Dynamic
            result = self.change(self.plan(outputTypeId='no-output',monitoring=2))
            self.assertEqual(result['verified'], not manual)
            self.assertEqual(result['dependentChannelChanges'][0]['value']['id'], 'new')
            self.assertEqual(len(result['writes']), 1 if manual else 2)
            self.assertEqual(track.current_monitoring_state, 1 if manual else 2)

    def test_new_type_invalidates_old_channel_request_without_guessing_or_rollback(self):
        song = self.song
        class Dynamic(Track):
            @property
            def input_routing_type(track): return track.actual_input
            @input_routing_type.setter
            def input_routing_type(track,value):
                track.actual_input = value
                track.available_input_routing_channels = []
                track.current_input_sub_routing = RoutingOption('none','')
        track = song.tracks[0];track.actual_input = track.available_input_routing_types[0];track.__class__ = Dynamic
        result = self.change(self.plan(inputTypeId='no-input',inputChannelId='channel-1'))
        self.assertFalse(result['verified'])
        self.assertEqual(result['input']['type']['id'], 'no-input')
        self.assertEqual(len(result['writes']), 1)
        self.assertIn('choice changed', result['error'])

    def test_readback_retains_manual_changes_after_undo_closes(self):
        self.song.end_undo_step = lambda: setattr(self.song.tracks[1], 'arm', True)
        result = self.change(self.plan(monitoring=2))
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertFalse(result['contextPreserved'])
        self.assertTrue(self.song.tracks[1].arm)

    def test_deferred_lost_song_retains_per_setter_dispatch_facts(self):
        song = self.song
        class Surface:
            available = True
            def song(surface):
                if not surface.available: raise RuntimeError('Song unavailable')
                return song
            def schedule_message(surface, _, callback): surface.callback = callback
        class Client:
            messages = None
            def sendall(client,data): client.messages = json.loads(data)
        surface,client = Surface(),Client();bridge = SocketBridge(surface,'/unused')
        before = dispatch_request(song,{'method':'get_track_routing_edit_context','params':{'trackId':'track-0'}},bridge.state_version)
        params = self.plan(monitoring=2);params.update(before=before,expectedStateVersion=bridge.state_version)
        bridge.requests.put((client,{'id':'route','method':'set_track_routing','params':params}))
        bridge.drain();self.assertIsNone(client.messages)
        self.assertEqual(song.tracks[0].current_monitoring_state, 2)
        surface.available = False;surface.callback()
        result = client.messages['result']
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertIsNone(result['observedContext']);self.assertIn('Song unavailable',result['observationError'])
        self.assertFalse(bridge.deferred_request)

    def test_native_option_resolution_cannot_start_recording_before_the_setter(self):
        song = self.song
        class CallbackTrack(Track):
            reads = 0
            trigger_at = None
            @property
            def available_output_routing_types(track):
                track.reads += 1
                if track.reads == track.trigger_at: song.record_mode = True
                return track.options
        track = song.tracks[0]
        track.options = track.available_output_routing_types
        del track.available_output_routing_types
        track.__class__ = CallbackTrack
        plan = self.plan(outputTypeId='no-output')
        # begin context, undo-entry context, then exact native option resolution.
        track.trigger_at = track.reads + 3
        with self.assertRaisesRegex(ValueError, 'changed|recording'): self.change(plan)
        self.assertEqual(track.current_output_routing.identifier, 'main')


if __name__ == '__main__': unittest.main()
