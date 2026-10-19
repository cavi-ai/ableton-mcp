import copy
import json
import os
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_track_mixer import prepare_mixers
from test_track_routing import ready_song,RoutingOption


def prepare_main(song):
    prepare_mixers(song)
    song.master_track.name = 'Main';song.master_track.devices = []
    for owner in [*song.tracks,*song.return_tracks]:owner.mixer_device.crossfade_assign = 1
    for field in ('volume','panning','cue_volume','crossfader'):
        parameter = getattr(song.master_track.mixer_device,field)
        parameter.is_enabled = True;parameter.is_quantized = False;parameter.automation_state = 0
    return song


def main_plan(song,values,version=4):
    before = dispatch_request(song,{'method':'get_master_mixer_edit_context','params':{'fields':sorted(values)}},version)
    changes = {}
    for field,value in values.items():
        if field == 'outputChannelId':
            routing = before['master']['outputRouting']
            changes[field] = {'previous':routing['channel'],'value':next(row for row in routing['availableChannels'] if row['id'] == value)}
        else:changes[field] = {'previousValue':before['controls'][field]['value'],'value':value}
    return {'before':before,'expectedStateVersion':version,'changes':changes}


class MasterMixerTests(unittest.TestCase):
    def setUp(self):self.song = prepare_main(ready_song())

    def apply(self,values):return dispatch_request(self.song,{'method':'set_master_mixer','params':main_plan(self.song,values)},4)

    def test_combined_controls_and_output_have_one_verified_undo_and_preserve_paths(self):
        plan = main_plan(self.song,{'volume':.4,'pan':.2,'cueVolume':.3,'crossfader':-.25,'outputChannelId':'3/4'})
        result = dispatch_request(self.song,{'method':'set_master_mixer','params':plan},4)
        self.assertTrue(result['verified']);self.assertTrue(result['contextPreserved'])
        self.assertEqual(result['master']['outputRouting']['channel']['id'],'3/4')
        self.assertEqual(result['master']['volume']['value'],.4)
        self.assertEqual(result['observedContext']['audioPaths'][:-1],plan['before']['audioPaths'][:-1])
        self.assertEqual(result['observedContext']['switches'],plan['before']['switches'])
        self.assertEqual([row['field'] for row in result['writes']][:2],['volume','outputChannelId'])
        self.assertEqual(len(result['writes']),5);self.assertEqual(self.song.undo_boundaries,['begin','end'])

    def test_noop_during_playback_uses_no_setter_or_undo(self):
        self.song.is_playing = True
        result = self.apply({'volume':.8,'outputChannelId':'1/2'})
        self.assertTrue(result['verified']);self.assertFalse(result['writeRequested'])
        self.assertEqual(result['writes'],[]);self.assertEqual(self.song.undo_boundaries,[]);self.assertTrue(self.song.is_playing)

    def test_replaced_owners_parameters_choices_and_unrequested_controls_refuse(self):
        for field in ('owner','mixer','parameter','choices','pan','solo','assignment','route','version'):
            self.setUp();plan = main_plan(self.song,{'volume':.4})
            master = self.song.master_track
            if field == 'owner':self.song.master_track = copy.deepcopy(master)
            elif field == 'mixer':master.mixer_device = copy.deepcopy(master.mixer_device)
            elif field == 'parameter':master.mixer_device.volume = copy.deepcopy(master.mixer_device.volume)
            elif field == 'choices':master.available_output_routing_channels = ('1/2',)
            elif field == 'pan':master.mixer_device.panning.value = .3
            elif field == 'solo':self.song.tracks[0].solo = True
            elif field == 'assignment':self.song.tracks[0].mixer_device.crossfade_assign = 0
            elif field == 'route':self.song.tracks[0].current_output_routing = 'No Output'
            else:plan['expectedStateVersion'] = 3
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'changed'):
                dispatch_request(self.song,{'method':'set_master_mixer','params':plan},4)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_unsafe_recording_pending_launches_and_requested_controls_refuse(self):
        for field in ('record','session','countIn','pending','automation','disabled','split','unknownAssignment'):
            self.setUp();values = {'pan':.2} if field == 'split' else {'crossfader':.2} if field == 'unknownAssignment' else {'volume':.4}
            if field == 'record':self.song.record_mode = True
            elif field == 'session':self.song.session_record = None
            elif field == 'countIn':self.song.is_counting_in = True
            elif field == 'pending':self.song.scenes[0].is_triggered = True
            elif field == 'automation':self.song.master_track.mixer_device.volume.automation_state = 1
            elif field == 'disabled':self.song.master_track.mixer_device.volume.is_enabled = False
            elif field == 'split':self.song.master_track.mixer_device.panning_mode = 1
            else:self.song.tracks[0].mixer_device.crossfade_assign = 9
            with self.subTest(field=field),self.assertRaises(ValueError):self.apply(values)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_modern_hardware_choice_uses_the_exact_native_option(self):
        master = self.song.master_track
        options = (RoutingOption('out-a','Pair'),RoutingOption('out-b','Pair'))
        master.available_output_routing_channels = options;master.output_routing_channel = options[0]
        result = self.apply({'outputChannelId':'out-b'})
        self.assertTrue(result['verified']);self.assertIs(master.output_routing_channel,options[1])
        self.assertEqual(master.current_output_sub_routing,'1/2')

    def test_duplicate_legacy_output_choices_and_invalid_values_never_write(self):
        self.song.master_track.available_output_routing_channels = ('1/2','3/4','3/4')
        with self.assertRaises(ValueError):self.apply({'outputChannelId':'3/4'})
        self.setUp()
        for values in ({'volume':float('nan')},{'pan':True},{'cueVolume':2},{'unknown':.4}):
            with self.subTest(values=values),self.assertRaises(ValueError):self.apply(values)
        self.assertEqual(self.song.undo_boundaries,[])

    def test_throw_after_write_retains_partial_state_without_rollback(self):
        mixer = self.song.master_track.mixer_device
        class Uncertain(type(mixer.crossfader)):
            calls = 0
            @property
            def value(parameter):return getattr(parameter,'actual',0)
            @value.setter
            def value(parameter,value):parameter.calls += 1;parameter.actual = value;raise RuntimeError('failed after applying')
        mixer.crossfader.__class__ = Uncertain
        result = self.apply({'volume':.4,'crossfader':.2})
        self.assertFalse(result['verified']);self.assertFalse(result['nativeReturned'])
        self.assertEqual(mixer.volume.value,.4);self.assertEqual(mixer.crossfader.value,.2)
        self.assertEqual(mixer.crossfader.calls,1);self.assertEqual(len(result['writes']),2)

    def test_intervening_edit_or_undo_entry_recording_prevents_remaining_writes(self):
        self.song.begin_undo_step = lambda:setattr(self.song,'record_mode',True)
        with self.assertRaisesRegex(ValueError,'changed'):self.apply({'volume':.4})
        self.assertEqual(self.song.master_track.mixer_device.volume.value,.8)

    def test_ignored_write_and_intervening_assignment_stop_without_replay(self):
        for mode in ('ignored','manual'):
            self.setUp();song = self.song;parameter = song.master_track.mixer_device.volume
            class Uncertain(type(parameter)):
                calls = 0
                @property
                def value(control):return control.actual
                @value.setter
                def value(control,value):
                    control.calls += 1
                    if mode == 'manual':control.actual = value;song.tracks[0].mixer_device.crossfade_assign = 0
            parameter.actual = parameter.value;parameter.__class__ = Uncertain
            result = self.apply({'volume':.4,'pan':.2})
            self.assertFalse(result['verified']);self.assertEqual(parameter.calls,1)
            self.assertEqual(parameter.value,.4 if mode == 'manual' else .8)
            self.assertEqual(song.master_track.mixer_device.panning.value,0)
            self.assertEqual([row['field'] for row in result['writes']],['volume'])

    def test_late_compatibility_read_cannot_verify_an_earlier_main_snapshot(self):
        import master_mixer
        operation = master_mixer.begin(self.song,main_plan(self.song,{'volume':.4}),4)
        original = master_mixer._set_mixer
        calls = []
        def changed(song,version):
            result = original(song,version);calls.append(True)
            if len(calls) == 2:song.master_track.mixer_device.panning.value = .75
            return result
        with patch.object(master_mixer,'_set_mixer',side_effect=changed):
            result = master_mixer.complete(self.song,operation,5)
        self.assertFalse(result['verified']);self.assertTrue(result['writeRequested'])
        self.assertEqual(self.song.master_track.mixer_device.panning.value,.75)
        self.assertEqual(self.song.master_track.mixer_device.volume.value,.4)

    def test_deferred_lost_song_retains_main_dispatch_facts(self):
        song = self.song
        class Surface:
            available = True
            def song(surface):
                if not surface.available:raise RuntimeError('Song unavailable')
                return song
            def schedule_message(surface,_,callback):surface.callback = callback
        class Client:
            message = None
            def sendall(client,data):client.message = json.loads(data)
        surface,client = Surface(),Client();bridge = SocketBridge(surface,'/unused')
        bridge.requests.put((client,{'id':'main','method':'set_master_mixer','params':main_plan(song,{'volume':.4},bridge.state_version)}))
        bridge.drain();self.assertIsNone(client.message)
        surface.available = False;surface.callback();result = client.message['result']
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertIsNone(result['master']);self.assertIsNone(result['observedContext'])
        self.assertIn('Song unavailable',result['observationError'])
