import copy
import json
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Device, NestedDevice, Chain
from test_track_routing import ready_song, RoutingOption


def configure(device):
    device.available_input_routing_types = [RoutingOption('none','No Input'),RoutingOption('source','Trigger')]
    device.available_input_routing_channels = [RoutingOption('pre','Pre FX'),RoutingOption('post','Post FX')]
    device.input_routing_type = device.available_input_routing_types[0]
    device.input_routing_channel = device.available_input_routing_channels[0]
    return device


class SidechainRoutingTests(unittest.TestCase):
    def setUp(self):
        self.song = ready_song()
        self.device = configure(self.song.tracks[0].devices[0])
        self.ids = {'trackId':'track-0','deviceId':'track-0:device-0'}

    def read(self, version=4):
        return dispatch_request(self.song,{'method':'get_device_sidechain_edit_context','params':self.ids},version)

    def plan(self, key='sourceTypeId', value='source', version=4):
        before = self.read(version)
        field,available = ('type','availableTypes') if key == 'sourceTypeId' else ('channel','availableChannels')
        selected = next(row for row in before['sidechain'][available] if row['id'] == value)
        return {**self.ids,'expectedStateVersion':version,'before':before,
                'changes':{key:{'previous':before['sidechain'][field],'value':selected}}}

    def change(self, plan):
        return dispatch_request(self.song,{'method':'set_device_sidechain_routing','params':plan},4)

    def test_exact_native_object_write_and_noop_preserve_audio_paths(self):
        before = self.read()
        result = self.change(self.plan())
        self.assertTrue(result['verified'])
        self.assertTrue(result['targetRetained'])
        self.assertTrue(result['contextPreserved'])
        self.assertIs(self.device.input_routing_type,self.device.available_input_routing_types[1])
        self.assertEqual(result['observedContext']['audioPaths'],before['audioPaths'])
        self.assertEqual(self.song.undo_boundaries,['begin','end'])
        self.song.undo_boundaries = []
        noop = self.change(self.plan())
        self.assertTrue(noop['verified']);self.assertFalse(noop['writeRequested'])
        self.assertEqual(self.song.undo_boundaries,[])

    def test_replaced_native_owner_device_parameter_or_enclosing_rack_refuses(self):
        for replacement in ('track','device','parameter','rack'):
            self.setUp()
            if replacement == 'rack':
                rack = NestedDevice('Rack','AudioEffectGroupDevice');rack.can_have_chains = True
                rack.chains = [Chain('Lane',[self.device])];self.song.tracks[0].devices = [rack]
                self.ids['deviceId'] = 'track-0:device-0/chain-0/device-0'
            plan = self.plan()
            if replacement == 'track': self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            elif replacement == 'device': self.song.tracks[0].devices[0] = copy.deepcopy(self.device)
            elif replacement == 'parameter': self.device.parameters[0] = copy.deepcopy(self.device.parameters[0])
            else: self.song.tracks[0].devices[0].chains[0] = copy.deepcopy(rack.chains[0])
            with self.subTest(replacement=replacement),self.assertRaisesRegex(ValueError,'changed'):
                self.change(plan)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_recording_pending_unknown_and_frozen_refuse_but_armed_playback_is_allowed(self):
        for owner,key,value in [('song','record_mode',True),('song','session_record',None),('song','is_counting_in',True),
                ('track','is_frozen',True),('scene','is_triggered',True),('clip','is_overdubbing',True)]:
            self.setUp()
            targets = {'song':self.song,'track':self.song.tracks[0],'scene':self.song.scenes[0],'clip':self.song.tracks[0].clip_slots[0].clip}
            setattr(targets[owner],key,value)
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'recording|launch|frozen|readiness'):
                self.change(self.plan())
            self.assertEqual(self.song.undo_boundaries,[])
        self.setUp();self.song.is_playing = True;self.song.tracks[1].arm = True
        plan = self.plan();self.song.current_song_time += 8
        self.assertTrue(self.change(plan)['verified']);self.assertTrue(self.song.tracks[1].arm)

    def test_manual_routing_and_same_label_source_replacement_invalidate_confirmation(self):
        for change in ('route','source','options','arm'):
            self.setUp();plan = self.plan()
            if change == 'route': self.song.tracks[1].current_output_routing = 'No Output'
            elif change == 'source': self.song.tracks[1] = copy.deepcopy(self.song.tracks[1])
            elif change == 'options': self.device.available_input_routing_channels.pop()
            else: self.song.tracks[1].arm = True
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'changed'): self.change(plan)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_undo_entry_rechecks_and_channel_reset_is_disclosed(self):
        plan = self.plan();self.song.begin_undo_step = lambda:setattr(self.song,'record_mode',True)
        with self.assertRaisesRegex(ValueError,'changed'):self.change(plan)
        self.setUp()
        class Dynamic(Device):
            @property
            def input_routing_type(device):return device.actual_type
            @input_routing_type.setter
            def input_routing_type(device,value):
                device.actual_type = value
                device.available_input_routing_channels = [RoutingOption('new','New Tap')]
                device.input_routing_channel = device.available_input_routing_channels[0]
        self.device.actual_type = self.device.input_routing_type
        self.device.__class__ = Dynamic
        result = self.change(self.plan())
        self.assertTrue(result['verified']);self.assertTrue(result['channelChanged'])
        self.assertEqual(result['sidechain']['channel']['id'],'new')

    def test_ignored_and_throw_after_write_setters_keep_honest_partial_receipts(self):
        for failure in ('ignored','throws'):
            self.setUp()
            class Uncertain(Device):
                calls = 0
                @property
                def input_routing_type(device):return device.actual_type
                @input_routing_type.setter
                def input_routing_type(device,value):
                    device.calls += 1
                    if failure == 'throws':
                        device.actual_type = value
                        raise RuntimeError('failed after applying')
            self.device.actual_type = self.device.input_routing_type;self.device.__class__ = Uncertain
            result = self.change(self.plan())
            self.assertFalse(result['verified']);self.assertTrue(result['writeRequested'])
            self.assertEqual(result['nativeReturned'],failure == 'ignored');self.assertEqual(self.device.calls,1)
            self.assertEqual(result['sidechain']['type']['id'],'source' if failure == 'throws' else 'none')

    def test_manual_audio_route_after_write_is_retained_and_reported(self):
        self.song.end_undo_step = lambda:setattr(self.song.tracks[1],'current_output_routing','No Output')
        result = self.change(self.plan())
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertFalse(result['contextPreserved']);self.assertEqual(self.song.tracks[1].current_output_routing,'No Output')

    def test_noop_does_not_accept_a_later_manual_tap_change(self):
        import sidechain_routing
        operation = sidechain_routing.begin(self.song,self.plan(value='none'),4)
        self.assertFalse(operation['writeRequested'])
        self.device.input_routing_channel = self.device.available_input_routing_channels[1]
        result = sidechain_routing.complete(self.song,operation,5)
        self.assertFalse(result['verified']);self.assertFalse(result['contextPreserved'])
        self.assertTrue(result['channelChanged']);self.assertEqual(result['sidechain']['channel']['id'],'post')

    def test_group_return_master_and_nested_devices_keep_their_actual_owner(self):
        self.song.tracks[0].is_foldable = True
        del self.song.tracks[0].current_monitoring_state
        for owner_id,owner in [('track-0',self.song.tracks[0]),('return-0',self.song.return_tracks[0]),('master',self.song.master_track)]:
            owner.devices = [configure(Device())]
            self.ids = {'trackId':owner_id,'deviceId':owner_id+':device-0'}
            self.assertTrue(self.change(self.plan())['verified'])
        self.setUp()
        rack = NestedDevice('Rack','AudioEffectGroupDevice');rack.can_have_chains = True
        rack.chains = [Chain('Lane',[self.device])];self.song.tracks[0].devices = [rack]
        self.ids['deviceId'] = 'track-0:device-0/chain-0/device-0'
        self.assertTrue(self.change(self.plan())['verified'])

    def test_deferred_lost_song_retains_dispatch_facts(self):
        song = self.song
        class Surface:
            available = True
            def song(surface):
                if not surface.available: raise RuntimeError('Song unavailable')
                return song
            def schedule_message(surface,_,callback):surface.callback = callback
        class Client:
            message = None
            def sendall(client,data):client.message = json.loads(data)
        surface,client = Surface(),Client();bridge = SocketBridge(surface,'/unused')
        bridge.requests.put((client,{'id':'route','method':'set_device_sidechain_routing','params':self.plan(version=bridge.state_version)}))
        bridge.drain();self.assertIsNone(client.message)
        surface.available = False;surface.callback()
        result = client.message['result']
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertIsNone(result['observedContext']);self.assertIn('Song unavailable',result['observationError'])
        self.assertFalse(bridge.deferred_request)

    def test_option_resolution_cannot_start_recording_before_the_setter(self):
        song = self.song
        class CallbackDevice(Device):
            reads = 0
            trigger_at = None
            @property
            def available_input_routing_types(device):
                device.reads += 1
                if device.reads == device.trigger_at: song.record_mode = True
                return device.options
        self.device.options = self.device.available_input_routing_types
        del self.device.available_input_routing_types
        self.device.__class__ = CallbackDevice
        plan = self.plan()
        # Each read inspects support and then serializes choices.
        self.device.trigger_at = self.device.reads + 5
        with self.assertRaisesRegex(ValueError,'changed'):self.change(plan)
        self.assertEqual(self.device.input_routing_type.identifier,'none')
