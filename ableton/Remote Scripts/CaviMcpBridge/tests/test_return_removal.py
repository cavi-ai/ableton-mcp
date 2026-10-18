import copy
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Track, Parameter, Device, ClipSlot, MidiNote
from bridge import dispatch_request, SocketBridge


class ReturnRemovalTests(unittest.TestCase):
    def setUp(self):
        self.song=Song();self.song.is_counting_in=False;self.song.send_pre=[0,1]
        self.song.return_tracks=[Track(),Track()];self.song.master_track.devices=[]
        for i,owner in enumerate([*self.song.tracks,*self.song.return_tracks]):
            owner.name=('Part ' if i<2 else 'Effect ')+str(i);owner.is_grouped=False;owner.is_foldable=False;owner.implicit_arm=False
            owner.clip_slots=[];owner.arrangement_clips=[];owner.mixer_device.sends=[Parameter(),Parameter()]
            for p in owner.mixer_device.sends:p.automation_state=0
        clip=ClipSlot().clip;clip.is_audio_clip=False;clip.is_recording=clip.is_overdubbing=clip.is_triggered=clip.is_playing=False;clip.extended_notes=[MidiNote()]
        self.clip=clip;self.song.tracks[0].clip_slots=[ClipSlot(False)];self.song.tracks[0].clip_slots[0].has_clip=True;self.song.tracks[0].clip_slots[0].clip=clip
        for t in self.song.tracks:
            for slot in t.clip_slots:slot.is_triggered=False;slot.has_stop_button=True
        self.calls=[];self.song.delete_return_track=self.native
    def native(self,index):
        self.calls.append(index);self.song.return_tracks.pop(index);self.song.send_pre.pop(index)
        for owner in [*self.song.tracks,*self.song.return_tracks]:owner.mixer_device.sends.pop(index)
    def context(self,key='return-0'):return dispatch_request(self.song,{'method':'get_return_removal_context','params':{'returnTrackId':key}},3)
    def plan(self):
        before=self.context();return {'target':{'targetType':'return','targetId':'return-0','name':before['target']['name']},'returnRemovalContext':before,'allowContent':True,'expectedStateVersion':3}
    def apply(self,plan):return dispatch_request(self.song,{'method':'delete_session_object','params':plan},3)
    def test_complete_devices_all_owner_sends_and_retained_destinations(self):
        plan=self.plan();before=plan['returnRemovalContext'];self.assertEqual(len(before['affectedSends']),4)
        self.assertIn('parameters',before['target']['devices'][0]);self.assertEqual(before['sendPre'],[0,1])
        survivor=self.song.return_tracks[1];result=self.apply(plan)
        self.assertTrue(result['deletionVerified']);self.assertTrue(result['targetAbsent']);self.assertTrue(result['remainingMaterialPreserved']);self.assertTrue(result['sendDestinationsPreserved']);self.assertIs(self.song.return_tracks[0],survivor)
        self.assertEqual(self.calls,[0]);self.assertEqual(self.song.undo_boundaries,['begin','end']);self.assertEqual(self.song.send_pre,[1])
    def test_main_only_mixer_properties_are_not_read_from_track_or_return(self):
        def invalid(owner):raise RuntimeError('Cue volume available on the main track only!')
        for owner in [*self.song.tracks,*self.song.return_tracks]:type(owner.mixer_device).cue_volume=property(invalid)
        self.assertTrue(self.apply(self.plan())['deletionVerified'])
    def test_same_version_device_send_clip_and_owner_changes_refuse(self):
        for change in [lambda:setattr(self.song.return_tracks[0].devices[0].parameters[0],'value',.7),lambda:setattr(self.song.return_tracks[1].mixer_device.sends[0],'value',.6),lambda:setattr(self.clip.extended_notes[0],'velocity',62),lambda:self.song.return_tracks.__setitem__(0,copy.deepcopy(self.song.return_tracks[0]))]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_authority_state_and_undo_entry_recheck(self):
        for key,value in [('allowContent',False),('expectedStateVersion',2)]:
            self.setUp();plan=self.plan();plan[key]=value
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
        self.setUp();plan=self.plan();self.song.begin_undo_step=lambda:setattr(self.song.tracks[0].mixer_device.sends[0],'value',.8)
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def test_recording_playback_pending_and_dependency_refuse(self):
        for key,value in [('record_mode',True),('session_record',True),('is_playing',True),('is_counting_in',None)]:
            self.setUp();setattr(self.song,key,value)
            with self.assertRaises(ValueError):self.context()
        self.setUp();self.song.tracks[0].fired_slot_index=0
        with self.assertRaises(ValueError):self.context()
        self.setUp();t=self.song.tracks[0];t.current_input_routing=self.song.return_tracks[0].name;t.available_input_routing_types=[t.current_input_routing]
        with self.assertRaisesRegex(ValueError,'dependenc'):self.context()
    def test_partial_native_failure_retains_actual_outcome_and_no_replay(self):
        plan=self.plan()
        def fail(index):self.native(index);raise RuntimeError('native response lost')
        self.song.delete_return_track=fail;result=self.apply(plan)
        self.assertTrue(result['deleteRequested']);self.assertFalse(result['nativeReturned']);self.assertTrue(result['targetAbsent']);self.assertFalse(result['deletionVerified']);self.assertEqual(self.calls,[0])
    def test_retained_send_or_material_edit_is_not_hidden(self):
        for change in [lambda:setattr(self.song.tracks[0].mixer_device.sends[0],'value',.9),lambda:setattr(self.clip.extended_notes[0],'velocity',55)]:
            self.setUp();plan=self.plan()
            def edited(index):self.native(index);change()
            self.song.delete_return_track=edited;result=self.apply(plan);self.assertFalse(result['deletionVerified']);self.assertTrue(result['targetAbsent']);self.assertEqual(self.calls,[0])
    def test_disposed_target_is_never_compared_after_deletion(self):
        class NativeTrack(Track):
            dead=False
            def __eq__(self,other):
                if self.dead:raise RuntimeError('invalid Return')
                return self is other
        target=NativeTrack();target.__dict__.update(self.song.return_tracks[0].__dict__);self.song.return_tracks[0]=target;plan=self.plan()
        def dispose(index):self.native(index);target.dead=True
        self.song.delete_return_track=dispose;self.assertTrue(self.apply(plan)['deletionVerified'])
    def test_only_return_can_be_removed(self):
        self.song.return_tracks.pop();self.song.send_pre.pop()
        for owner in [*self.song.tracks,*self.song.return_tracks]:owner.mixer_device.sends.pop()
        self.assertTrue(self.apply(self.plan())['deletionVerified']);self.assertEqual(self.song.return_tracks,[])
    def test_two_stable_observations_and_song_binding(self):
        import return_removal
        operation=return_removal.begin(self.song,self.plan(),3)
        self.assertTrue(return_removal.complete(self.song,operation,4)['readbackPending']);self.assertTrue(return_removal.complete(self.song,operation,4)['deletionVerified']);self.assertEqual(self.calls,[0])
        other=copy.copy(self.song);self.assertFalse(return_removal.complete(other,operation,4)['deletionVerified'])
    def test_same_value_send_parameter_replacement_and_automation_edits_refuse(self):
        for change in [lambda:self.song.tracks[0].mixer_device.sends.__setitem__(0,copy.deepcopy(self.song.tracks[0].mixer_device.sends[0])),lambda:setattr(self.song.tracks[0].mixer_device.sends[0],'automation_state',2),lambda:setattr(self.song.return_tracks[0].devices[0],'is_active',False)]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_return_and_main_sidechain_dependencies_refuse(self):
        for owner in [self.song.return_tracks[1],self.song.master_track]:
            device=Device();device.input_routing_type=self.song.return_tracks[0].name;device.input_routing_channel='Post Mixer';owner.devices=[device]
            with self.assertRaisesRegex(ValueError,'dependenc'):self.context()
            owner.devices=[]
    def test_exact_letter_transition_is_recognized(self):
        self.song.return_tracks[0].name='A-Delay';self.song.return_tracks[1].name='B-Reverb';plan=self.plan()
        def renumber(index):self.native(index);self.song.return_tracks[0].name='A-Reverb'
        self.song.delete_return_track=renumber;result=self.apply(plan);self.assertTrue(result['deletionVerified']);self.assertEqual(len(result['renumberedReturnNames']),1)
    def queued(self):
        callbacks,replies=[],[];surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=lambda delay,callback:callbacks.append(callback));client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)))
        bridge=SocketBridge(surface,'/unused');bridge.state_version=3;bridge.requests.put((client,{'id':1,'method':'delete_session_object','params':self.plan()}));bridge.drain();return callbacks,replies,bridge
    def test_deferred_receipt_settles_without_replay(self):
        callbacks,replies,bridge=self.queued();self.assertEqual(replies,[]);callbacks.pop(0)();self.assertEqual(replies,[]);callbacks.pop(0)();self.assertTrue(replies[0]['result']['deletionVerified']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_deferred_lost_song_retains_dispatch_facts(self):
        callbacks,replies,bridge=self.queued()
        def unavailable():raise RuntimeError('Song unavailable')
        bridge.control_surface.song=unavailable;callbacks.pop(0)();result=replies[0]['result'];self.assertTrue(result['deleteRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['deletionVerified']);self.assertIsNone(result['targetAbsent']);self.assertIn('Song unavailable',result['observationError'])


if __name__=='__main__':unittest.main()
