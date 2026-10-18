import copy
import json
import os
import sys
import unittest
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_dispatch import Track
from test_track_mixer import prepare_mixers
from test_track_routing import ready_song


def return_plan(song,changes,version=4,return_id='return-0'):
    before = dispatch_request(song,{'method':'get_return_mixer_edit_context','params':{'returnTrackId':return_id,'fields':sorted(changes)}},version)
    row = before['tracks'][0]
    return {'returnTrackId':return_id,'before':before,'expectedStateVersion':version,'changes':{
        field:{'previousValue':row[field] if field in ('mute','solo') else row[field]['value'],'value':value}
        for field,value in changes.items()}}


class ReturnMixerTests(unittest.TestCase):
    def setUp(self):
        self.song = ready_song()
        self.song.return_tracks.append(Track())
        prepare_mixers(self.song)

    def apply(self,changes):
        return dispatch_request(self.song,{'method':'set_return_mixer','params':return_plan(self.song,changes)},4)

    def test_combined_return_controls_keep_other_solos_and_routes(self):
        self.song.tracks[0].solo = self.song.return_tracks[1].solo = True
        plan = return_plan(self.song,{'volume':.4,'pan':.25,'mute':True,'solo':True})
        result = dispatch_request(self.song,{'method':'set_return_mixer','params':plan},4)
        self.assertTrue(result['verified']);self.assertTrue(result['contextPreserved'])
        self.assertEqual(result['returnTrackId'],'return-0');self.assertEqual(result['return']['id'],'return-0')
        self.assertEqual(result['return']['volume']['value'],.4)
        self.assertEqual([row['field'] for row in result['writes']],['mute','volume','pan','solo'])
        self.assertTrue(self.song.tracks[0].solo);self.assertTrue(self.song.return_tracks[1].solo)
        self.assertEqual(result['observedContext']['audioPaths'],plan['before']['audioPaths'])
        self.assertEqual(self.song.undo_boundaries,['begin','end'])

    def test_noop_during_playback_never_opens_undo_or_touches_transport(self):
        self.song.is_playing = True
        result = self.apply({'mute':False,'solo':False})
        self.assertTrue(result['verified']);self.assertFalse(result['writeRequested'])
        self.assertEqual(result['writes'],[]);self.assertEqual(self.song.undo_boundaries,[])
        self.assertTrue(self.song.is_playing)

    def test_native_replacements_and_manual_context_changes_invalidate_confirmation(self):
        for field in ('return','mixer','parameter','otherSolo','routing','state'):
            self.setUp();plan = return_plan(self.song,{'volume':.4,'mute':True})
            track = self.song.return_tracks[0]
            if field == 'return':self.song.return_tracks[0] = copy.deepcopy(track)
            elif field == 'mixer':track.mixer_device = copy.deepcopy(track.mixer_device)
            elif field == 'parameter':track.mixer_device.volume = copy.deepcopy(track.mixer_device.volume)
            elif field == 'otherSolo':self.song.tracks[0].solo = True
            elif field == 'routing':self.song.tracks[0].current_output_routing = 'No Output'
            else:plan['expectedStateVersion'] = 3
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'changed'):
                dispatch_request(self.song,{'method':'set_return_mixer','params':plan},4)
            self.assertFalse(track.mute);self.assertEqual(self.song.undo_boundaries,[])

    def test_recording_launches_automation_and_disabled_controls_refuse(self):
        for field in ('recording','sessionRecording','countIn','pending','automation','disabled','split'):
            self.setUp();track = self.song.return_tracks[0]
            changes = {'pan':.4} if field == 'split' else {'mute':True}
            if field == 'recording':self.song.record_mode = True
            elif field == 'sessionRecording':self.song.session_record = True
            elif field == 'countIn':self.song.is_counting_in = None
            elif field == 'pending':self.song.tracks[0].fired_slot_index = 0
            elif field == 'automation':track.mixer_device.track_activator.automation_state = 1
            elif field == 'disabled':track.mixer_device.track_activator.is_enabled = False
            else:track.mixer_device.panning_mode = 1
            with self.subTest(field=field),self.assertRaises(ValueError):self.apply(changes)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_uncertain_write_is_reported_once_without_replay_or_rollback(self):
        for mode in ('ignored','throws','manual'):
            self.setUp();song = self.song
            class Uncertain(type(song.return_tracks[0])):
                calls = 0
                @property
                def mute(track):return track.actual_mute
                @mute.setter
                def mute(track,value):
                    track.calls += 1
                    if mode != 'ignored':track.actual_mute = value
                    if mode == 'throws':raise RuntimeError('failed after applying')
                    if mode == 'manual':song.tracks[0].solo = True
            track = song.return_tracks[0];track.actual_mute = track.mute;track.__class__ = Uncertain
            result = self.apply({'mute':True,'solo':True})
            self.assertFalse(result['verified']);self.assertEqual(len(result['writes']),1)
            self.assertEqual(track.calls,1);self.assertEqual(result['return']['mute'],mode != 'ignored')
            self.assertFalse(track.solo);self.assertEqual(self.song.undo_boundaries,['begin','end'])

    def test_invalid_owner_fields_and_missing_native_context_refuse(self):
        for key in ('return-00','return--1','track-0','master'):
            with self.subTest(key=key),self.assertRaises(ValueError):return_plan(self.song,{'mute':True},return_id=key)
        for changes in ({'mute':1},{'volume':float('nan')},{'volume':2},{'send-0':.5}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.apply(changes)
        with self.assertRaises(ValueError):dispatch_request(self.song,{'method':'set_return_mixer','params':{'returnTrackId':'return-0','changes':{'mute':{'value':True}}}},4)

    def test_undo_entry_change_refuses_before_dispatch(self):
        self.song.begin_undo_step = lambda:setattr(self.song,'record_mode',True)
        with self.assertRaisesRegex(ValueError,'changed'):self.apply({'mute':True})
        self.assertFalse(self.song.return_tracks[0].mute)

    def test_pan_mode_and_owner_changes_retain_the_attempt_without_restoration(self):
        from test_panning import Pan
        for mode in ('split','replacement'):
            self.setUp();song = self.song;track = song.return_tracks[0]
            parameter = Pan(0);track.mixer_device.panning = parameter
            if mode == 'split':parameter.callback = lambda:setattr(track.mixer_device,'panning_mode',1)
            else:
                replacement = copy.deepcopy(track)
                parameter.callback = lambda:song.return_tracks.__setitem__(0,replacement)
            result = self.apply({'pan':.5,'solo':True})
            self.assertFalse(result['verified']);self.assertEqual(parameter.writes,[.5])
            self.assertEqual(parameter.value,.5);self.assertFalse(track.solo)
            self.assertEqual([row['field'] for row in result['writes']],['pan'])

    def test_deferred_lost_song_retains_return_dispatch_facts(self):
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
        bridge.requests.put((client,{'id':'return','method':'set_return_mixer','params':return_plan(song,{'mute':True},bridge.state_version)}))
        bridge.drain();self.assertIsNone(client.message)
        surface.available = False;surface.callback();result = client.message['result']
        self.assertTrue(result['nativeReturned']);self.assertFalse(result['verified'])
        self.assertEqual(result['returnTrackId'],'return-0');self.assertIsNone(result['return'])
        self.assertIn('Song unavailable',result['observationError'])
