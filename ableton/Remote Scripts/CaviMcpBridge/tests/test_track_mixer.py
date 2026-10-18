import copy
import json
import os
import sys
import unittest
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_dispatch import Track
from test_track_routing import ready_song


def prepare_mixers(song):
    class Activator:
        min,max,is_enabled,is_quantized,automation_state = 0,1,True,True,0
        def __init__(self,owner): self.owner = owner
        @property
        def value(self): return 0 if self.owner.mute else 1
    for track in [*song.tracks,*song.return_tracks]:
        if not hasattr(track,'devices'):track.devices = []
        track.mixer_device.track_activator = Activator(track)
        for parameter in [track.mixer_device.volume,track.mixer_device.panning,*getattr(track.mixer_device,'sends',())]:
            parameter.is_enabled = True;parameter.is_quantized = False;parameter.automation_state = 0
    return song


def mixer_plan(song,requests,version=4):
    fields = sorted({key for changes in requests.values() for key in changes})
    before = dispatch_request(song,{'method':'get_track_mixer_edit_context','params':{'trackIds':list(requests),'fields':fields}},version)
    tracks = []
    for row in before['tracks']:
        changes = {}
        for key,value in requests[row['trackId']].items():
            if key.startswith('send-'):
                source = next(item for item in row['sends'] if item['id'] == key)
                changes.setdefault('sends',[]).append({**{k:source[k] for k in ('id','returnTrackId','name')},'previousValue':source['value'],'value':value})
            else:
                source = row[key] if key in ('mute','solo') else row[key]['value']
                changes[key] = {'previousValue':source,'value':value}
        tracks.append({'trackId':row['trackId'],'changes':changes})
    if len(tracks) == 1:
        return {**tracks[0],'before':before,'expectedStateVersion':version}
    return {'trackIds':list(requests),'tracks':tracks,'before':before,'expectedStateVersion':version}


class TrackMixerTests(unittest.TestCase):
    def setUp(self):self.song = prepare_mixers(ready_song())

    def apply(self,requests):
        params = mixer_plan(self.song,requests)
        return dispatch_request(self.song,{'method':'set_bulk_track_mixer' if 'tracks' in params else 'set_track_mixer','params':params},4)

    def test_combined_controls_and_sends_are_verified_in_one_undo(self):
        result = self.apply({'track-0':{'volume':.4,'pan':-.25,'mute':True,'solo':True,'send-0':.6}})
        self.assertTrue(result['verified']);self.assertTrue(result['contextPreserved'])
        self.assertEqual(result['volume'],.4);self.assertEqual(result['pan'],-.25)
        self.assertTrue(result['mute']);self.assertTrue(result['solo'])
        self.assertEqual(result['sends'][0]['value'],.6);self.assertEqual(len(result['writes']),5)
        self.assertEqual(self.song.undo_boundaries,['begin','end'])

    def test_bulk_mute_and_solo_preserve_other_track_and_return_solos(self):
        self.song.return_tracks[0].solo = True
        result = self.apply({'track-0':{'mute':True,'solo':True},'track-1':{'mute':True,'solo':True}})
        self.assertTrue(result['verified']);self.assertTrue(self.song.return_tracks[0].solo)
        self.assertTrue(all(t['mute'] and t['solo'] for t in result['tracks']))
        self.assertEqual(self.song.undo_boundaries,['begin','end'])

    def test_noop_does_not_write_and_playback_clock_can_advance(self):
        self.song.is_playing = True
        plan = mixer_plan(self.song,{'track-0':{'mute':False}})
        self.song.current_song_time += 8
        result = dispatch_request(self.song,{'method':'set_track_mixer','params':plan},4)
        self.assertTrue(result['verified']);self.assertEqual(result['writes'],[])
        self.assertEqual(self.song.undo_boundaries,[])

    def test_equal_owner_parameter_return_and_other_state_replacements_refuse(self):
        for field in ('owner','parameter','return','otherSolo','route'):
            self.setUp();plan = mixer_plan(self.song,{'track-0':{'volume':.4,'send-0':.5}})
            if field == 'owner':self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            elif field == 'parameter':self.song.tracks[0].mixer_device.volume = copy.deepcopy(self.song.tracks[0].mixer_device.volume)
            elif field == 'return':self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
            elif field == 'otherSolo':self.song.tracks[1].solo = True
            else:self.song.tracks[1].current_output_routing = 'No Output'
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'changed'):
                dispatch_request(self.song,{'method':'set_track_mixer','params':plan},4)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_recording_and_active_requested_automation_refuse_but_frozen_mute_is_supported(self):
        for field in ('recording','countIn','launch','muteAutomation','volumeAutomation','disabled'):
            self.setUp();track = self.song.tracks[0]
            request = {'volume':.2} if field == 'volumeAutomation' else {'mute':True}
            if field == 'recording':self.song.record_mode = True
            elif field == 'countIn':self.song.is_counting_in = None
            elif field == 'launch':self.song.scenes[0].is_triggered = True
            elif field == 'muteAutomation':track.mixer_device.track_activator.automation_state = 1
            elif field == 'volumeAutomation':track.mixer_device.volume.automation_state = 1
            else:track.mixer_device.track_activator.is_enabled = False
            with self.subTest(field=field),self.assertRaises(ValueError):self.apply({'track-0':request})
            self.assertEqual(self.song.undo_boundaries,[])
        self.setUp();self.song.tracks[0].is_frozen = True
        self.song.tracks[0].mixer_device.volume.automation_state = 1
        self.assertTrue(self.apply({'track-0':{'mute':True}})['verified'])

    def test_undo_entry_and_intervening_manual_edits_stop_remaining_setters(self):
        self.song.begin_undo_step = lambda:setattr(self.song.tracks[1],'solo',True)
        with self.assertRaisesRegex(ValueError,'changed'):self.apply({'track-0':{'mute':True}})
        self.setUp();song = self.song
        class Manual(Track):
            @property
            def mute(track):return track.actual_mute
            @mute.setter
            def mute(track,value):
                track.actual_mute = value;song.tracks[1].solo = True
        track = song.tracks[0];track.actual_mute = track.mute;track.__class__ = Manual
        result = self.apply({'track-0':{'mute':True,'solo':True}})
        self.assertFalse(result['verified']);self.assertEqual(len(result['writes']),1)
        self.assertTrue(track.mute);self.assertFalse(track.solo);self.assertTrue(song.tracks[1].solo)

    def test_ignored_or_throw_after_write_does_not_replay(self):
        for mode in ('ignored','throws'):
            self.setUp()
            class Uncertain(Track):
                calls = 0
                @property
                def mute(track):return track.actual_mute
                @mute.setter
                def mute(track,value):
                    track.calls += 1
                    if mode == 'throws':track.actual_mute = value;raise RuntimeError('failed after applying')
            track = self.song.tracks[0];track.actual_mute = track.mute;track.__class__ = Uncertain
            result = self.apply({'track-0':{'mute':True,'solo':True}})
            self.assertFalse(result['verified']);self.assertTrue(result['writeRequested'])
            self.assertEqual(result['nativeReturned'],mode == 'ignored');self.assertEqual(track.calls,1)
            self.assertEqual(len(result['writes']),1);self.assertEqual(result['mute'],mode == 'throws')

    def test_deferred_lost_song_retains_partial_dispatch_facts(self):
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
        bridge.requests.put((client,{'id':'mix','method':'set_track_mixer','params':mixer_plan(song,{'track-0':{'mute':True}},bridge.state_version)}))
        bridge.drain();self.assertIsNone(client.message)
        surface.available = False;surface.callback();result = client.message['result']
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertIsNone(result['observedContext']);self.assertIn('Song unavailable',result['observationError'])

    def test_final_control_lookup_cannot_start_recording_before_dispatch(self):
        song = self.song
        mixer = song.tracks[0].mixer_device
        class CallbackMixer(type(mixer)):
            reads = 0
            trigger_at = None
            @property
            def volume(mixer):
                mixer.reads += 1
                if mixer.reads == mixer.trigger_at:song.record_mode = True
                return mixer.actual_volume
        mixer.actual_volume = mixer.volume;mixer.__class__ = CallbackMixer
        plan = mixer_plan(song,{'track-0':{'volume':.4}})
        mixer.reads = 0;mixer.trigger_at = 5
        with self.assertRaisesRegex(ValueError,'changed'):
            dispatch_request(song,{'method':'set_track_mixer','params':plan},4)
        self.assertEqual(mixer.actual_volume.value,.75)

    def test_invalid_native_parameter_values_refuse_context_instead_of_serializing_nan(self):
        self.song.tracks[0].mixer_device.volume.value = float('nan')
        with self.assertRaises(ValueError):mixer_plan(self.song,{'track-0':{'volume':.4}})
