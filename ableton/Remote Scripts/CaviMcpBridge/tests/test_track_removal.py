import copy
import json
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_dispatch import Song,Track,ClipSlot,MidiNote,Device

class TrackRemovalTests(unittest.TestCase):
    def setUp(self):
        self.song=Song();self.song.is_counting_in=False;self.song.tracks.append(Track())
        self.calls=[];self.song.delete_track=self.native
        for scene in self.song.scenes:scene.is_triggered=False
        for i,track in enumerate(self.song.tracks):
            track.name='Part '+str(i);track.is_grouped=False;track.is_foldable=False;track.group_track=None;track.can_be_armed=True;track.implicit_arm=False
            track.clip_slots=[ClipSlot(False),ClipSlot(False)];track.arrangement_clips=[];track.fired_slot_index=-1;track.playing_slot_index=-1
            for slot in track.clip_slots:slot.is_triggered=False;slot.has_stop_button=True
        for owner in [*self.song.return_tracks,self.song.master_track]:owner.devices=[]
        clip=ClipSlot().clip;clip.is_audio_clip=False;clip.is_recording=clip.is_overdubbing=clip.is_triggered=clip.is_playing=False;clip.extended_notes=[MidiNote()]
        self.clip=clip;self.song.tracks[0].clip_slots[0].has_clip=True;self.song.tracks[0].clip_slots[0].clip=clip
    def group(self):
        group=self.song.tracks[0];group.is_foldable=True;group.can_be_armed=False;group.fold_state=0;group.clip_slots=[ClipSlot(False),ClipSlot(False)]
        for slot in group.clip_slots:slot.is_triggered=False;slot.has_stop_button=True
        child=self.song.tracks[1];child.is_grouped=True;child.group_track=group;child.current_output_routing='Group';child.available_output_routing_types=['Main','Group']
        return group,child
    def native(self,index):
        from track_grouping import _ancestors
        target=self.song.tracks[index];removed=[t for t in self.song.tracks if t==target or target in _ancestors(t,self.song.tracks)]
        self.calls.append(index);self.song.tracks[:]=[t for t in self.song.tracks if t not in removed]
    def context(self,track='track-0'):return dispatch_request(self.song,{'method':'get_track_removal_context','params':{'trackId':track}},3)
    def plan(self,track='track-0',allow=True):
        before=self.context(track);return {'target':{'targetType':'track','targetId':track,'name':before['removedTracks'][0]['name']},'expectedStateVersion':3,'trackRemovalContext':before,'allowContent':allow}
    def apply(self,plan):return dispatch_request(self.song,{'method':'delete_session_object','params':plan},3)
    def test_session_arrangement_and_devices_are_disclosed_and_erased_once(self):
        arr=copy.deepcopy(self.clip);arr.start_time=32.;arr.end_time=40.;self.song.tracks[0].arrangement_clips=[arr]
        before=self.plan();row=before['trackRemovalContext']['removedTracks'][0]
        self.assertEqual(row['sessionClipCount'],1);self.assertEqual(row['arrangementClipCount'],1);self.assertEqual(row['deviceCount'],len(self.song.tracks[0].devices))
        survivor=self.song.tracks[1];result=self.apply(before);self.assertTrue(result['deletionVerified']);self.assertTrue(result['targetsAbsent']);self.assertTrue(result['remainingMaterialPreserved']);self.assertIs(self.song.tracks[0],survivor);self.assertEqual(self.calls,[0]);self.assertEqual(self.song.undo_boundaries,['begin','end'])
    def test_group_subtree_including_nested_members_is_explicit(self):
        group,child=self.group();child.is_foldable=True;child.can_be_armed=False;child.fold_state=0
        member=Track();member.name='Nested member';member.is_foldable=False;member.is_grouped=True;member.group_track=child;member.arrangement_clips=[];member.fired_slot_index=-1;member.implicit_arm=False;member.clip_slots=[];member.current_output_routing='Group';member.available_output_routing_types=['Main','Group']
        self.song.tracks.insert(2,member)
        plan=self.plan();self.assertEqual([r['trackId'] for r in plan['trackRemovalContext']['removedTracks']],['track-0','track-1','track-2']);self.assertTrue(self.apply(plan)['deletionVerified']);self.assertEqual(len(self.song.tracks),1)
    def test_every_track_removal_requires_content_authority_for_unexposed_automation(self):
        self.song.tracks[0].clip_slots[0].has_clip=False;self.song.tracks[0].devices=[]
        with self.assertRaisesRegex(ValueError,'allowContent'):self.apply(self.plan(allow=False))
        self.assertEqual(self.calls,[])
    def test_same_version_material_device_and_owner_replacement_refuse(self):
        for change in [lambda:setattr(self.clip.extended_notes[0],'velocity',42),lambda:setattr(self.song.tracks[0].devices[0].parameters[0],'value',.8),lambda:self.song.tracks.__setitem__(0,copy.deepcopy(self.song.tracks[0]))]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_undo_entry_rechecks_before_native_call(self):
        plan=self.plan();self.song.begin_undo_step=lambda:setattr(self.clip,'name','Manual')
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def test_recording_playing_count_in_pending_and_frozen_targets_refuse(self):
        for owner,name,value in [('song','is_playing',True),('song','record_mode',True),('song','is_counting_in',None),('track','fired_slot_index',0),('track','is_frozen',True),('clip','is_recording',True)]:
            self.setUp();obj={'song':self.song,'track':self.song.tracks[0],'clip':self.clip}[owner];setattr(obj,name,value)
            with self.assertRaises(ValueError):self.context()
            self.assertEqual(self.calls,[])
    def test_last_track_or_last_group_subtree_refuses(self):
        self.song.tracks=self.song.tracks[:1]
        with self.assertRaises(ValueError):self.context()
        self.setUp();self.group();self.song.tracks.pop()
        with self.assertRaises(ValueError):self.context()
    def test_external_track_and_device_sidechain_dependencies_refuse(self):
        track=self.song.tracks[1];track.current_input_routing=self.song.tracks[0].name;track.available_input_routing_types=[self.song.tracks[0].name]
        with self.assertRaisesRegex(ValueError,'dependenc'):self.context()
        self.assertEqual(self.calls,[])
    def test_native_exception_after_removal_retains_actual_absence(self):
        plan=self.plan()
        def fail(index):self.native(index);raise RuntimeError('native reply lost')
        self.song.delete_track=fail;result=self.apply(plan);self.assertTrue(result['deleteRequested']);self.assertFalse(result['nativeReturned']);self.assertTrue(result['targetsAbsent']);self.assertFalse(result['deletionVerified']);self.assertEqual(self.calls,[0])
    def test_disposed_track_is_not_compared_after_deletion(self):
        class NativeTrack(Track):
            dead=False
            def __eq__(self,other):
                if self.dead:raise RuntimeError('Track object is invalid')
                return self is other
        target=NativeTrack();target.__dict__.update(self.song.tracks[0].__dict__);self.song.tracks[0]=target
        plan=self.plan()
        def dispose(index):self.calls.append(index);self.song.tracks.pop(index);target.dead=True
        self.song.delete_track=dispose;result=self.apply(plan);self.assertTrue(result['deletionVerified']);self.assertIsNone(result['observationError'])
    def test_survivor_manual_changes_are_retained_and_unverified(self):
        plan=self.plan()
        def change(index):self.native(index);self.song.tracks[0].devices[0].parameters[0].value=.9
        self.song.delete_track=change;result=self.apply(plan);self.assertFalse(result['deletionVerified']);self.assertEqual(self.song.tracks[0].devices[0].parameters[0].value,.9);self.assertEqual(self.calls,[0])
    def test_device_power_and_automation_state_changes_invalidate_plan(self):
        for change in (lambda:setattr(self.song.tracks[0].devices[0],'is_active',False),lambda:setattr(self.song.tracks[0].devices[0].parameters[0],'automation_state',1)):
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_return_and_main_sidechain_dependencies_refuse(self):
        for owner in (self.song.return_tracks[0],self.song.master_track):
            device=Device();device.input_routing_type=self.song.tracks[0].name;device.input_routing_channel='Post Mixer';owner.devices=[device]
            with self.assertRaisesRegex(ValueError,'dependenc'):self.context()
            owner.devices=[]
        self.assertEqual(self.calls,[])
    def test_only_exact_native_numbered_label_changes_are_accepted(self):
        self.song.tracks[1].name='2-Audio';self.song.tracks[2].name='3-Audio';plan=self.plan()
        def renumber(index):
            self.native(index);self.song.tracks[0].name='1-Audio';self.song.tracks[1].name='2-Audio'
        self.song.delete_track=renumber;result=self.apply(plan);self.assertTrue(result['deletionVerified']);self.assertEqual(len(result['renumberedTrackNames']),2)
    def queued(self,plan):
        callbacks,replies=[],[];surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=lambda delay,callback:callbacks.append(callback));client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)))
        bridge=SocketBridge(surface,'/unused');bridge.state_version=3;bridge.requests.put((client,{'id':1,'method':'delete_session_object','params':plan}));bridge.drain();return callbacks,replies,bridge
    def test_deferred_receipt_settles_without_replaying(self):
        callbacks,replies,bridge=self.queued(self.plan());self.assertEqual(replies,[]);callbacks.pop(0)();self.assertEqual(replies,[]);callbacks.pop(0)();self.assertTrue(replies[0]['result']['deletionVerified']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_deferred_lost_song_retains_dispatch_facts(self):
        callbacks,replies,bridge=self.queued(self.plan());self.assertEqual(replies,[])
        def unavailable():raise RuntimeError('Song unavailable')
        bridge.control_surface.song=unavailable;callbacks.pop(0)();result=replies[0]['result'];self.assertTrue(result['deleteRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['deletionVerified']);self.assertIsNone(result['targetsAbsent']);self.assertIn('Song unavailable',result['observationError'])
    def test_new_song_with_same_children_never_verifies(self):
        callbacks,replies,bridge=self.queued(self.plan());other=copy.copy(self.song);bridge.control_surface.song=lambda:other
        for _ in range(3):
            if callbacks:callbacks.pop(0)()
        self.assertFalse(replies[0]['result']['deletionVerified']);self.assertEqual(self.calls,[0])
if __name__=='__main__':unittest.main()
