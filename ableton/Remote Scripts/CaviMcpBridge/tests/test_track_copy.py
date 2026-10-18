import copy
import json
import unittest
from types import SimpleNamespace
from test_dispatch import Song, Track, ClipSlot, MidiNote
from bridge import dispatch_request, SocketBridge


class TrackCopyTests(unittest.TestCase):
    def setUp(self):
        self.song=Song();self.song.is_counting_in=False;self.song.tracks.append(Track());self.calls=[];self.song.duplicate_track=self.native
        for i,t in enumerate(self.song.tracks):
            t.name='Part '+str(i);t.is_grouped=False;t.is_foldable=False;t.group_track=None;t.can_be_armed=True;t.implicit_arm=False;t.current_monitoring_state=2
            t.clip_slots=[ClipSlot(False),ClipSlot(False)];t.arrangement_clips=[]
            for field in ('volume','panning','sends'):setattr(t.mixer_device,field,copy.deepcopy(getattr(t.mixer_device,field)))
            for slot in t.clip_slots:slot.is_triggered=False;slot.has_stop_button=True
        for owner in [*self.song.return_tracks,self.song.master_track]:owner.devices=[]
        clip=ClipSlot().clip;clip.is_audio_clip=False;clip.is_recording=clip.is_overdubbing=clip.is_triggered=clip.is_playing=False;clip.extended_notes=[MidiNote()]
        self.clip=clip;self.song.tracks[0].clip_slots[0].has_clip=True;self.song.tracks[0].clip_slots[0].clip=clip
    def members(self,index):
        from track_grouping import _ancestors
        root=self.song.tracks[index];return [i for i,t in enumerate(self.song.tracks) if i==index or root in _ancestors(t,self.song.tracks)]
    def native(self,index):
        members=self.members(index);original=[self.song.tracks[i] for i in members];clones=copy.deepcopy(original)
        for old,new in zip(original,clones):
            if old.group_track is not None and old.group_track not in original:new.group_track=old.group_track
            for clip in [s.clip for s in new.clip_slots if s.has_clip]+new.arrangement_clips:
                for note in clip.extended_notes:note.note_id+=100
        self.calls.append(index);at=members[-1]+1;self.song.tracks[at:at]=clones
    def group(self):
        group,child=self.song.tracks[:2];group.is_foldable=True;group.can_be_armed=False;group.fold_state=0;group.clip_slots=[];group.arrangement_clips=[]
        child.is_grouped=True;child.group_track=group;child.current_output_routing='Group';child.available_output_routing_types=['Main','Group']
        return group,child
    def context(self,key='track-0'):return dispatch_request(self.song,{'method':'get_track_copy_context','params':{'trackId':key}},3)
    def plan(self,key='track-0'):
        before=self.context(key);return {'expectedStateVersion':3,'trackCopyContext':before,'explicitCopyName':True,'target':{'targetType':'track','targetId':key,'sourceName':before['sourceTracks'][0]['name'],'name':'Alternative','destinationId':before['destinationId']}}
    def apply(self,plan):return dispatch_request(self.song,{'method':'duplicate_session_object','params':plan},3)
    def test_session_and_arrangement_notes_allow_new_copy_note_ids_only(self):
        arr=copy.deepcopy(self.clip);arr.start_time=32;arr.end_time=40;self.song.tracks[0].arrangement_clips=[arr]
        original=self.song.tracks[:];plan=self.plan();self.assertEqual(plan['trackCopyContext']['sourceTracks'][0]['arrangementClipCount'],1)
        result=self.apply(plan);self.assertTrue(result['copyVerified']);self.assertTrue(result['originalMaterialPreserved']);self.assertTrue(result['copyMaterialMatches']);self.assertEqual(self.calls,[0]);self.assertEqual(self.song.undo_boundaries,['begin','end']);self.assertIs(self.song.tracks[0],original[0]);self.assertIs(self.song.tracks[2],original[1]);self.assertEqual(self.song.tracks[1].name,'Alternative');self.assertNotEqual(self.song.tracks[1].clip_slots[0].clip.extended_notes[0].note_id,self.clip.extended_notes[0].note_id)
    def test_group_copy_is_after_the_entire_subtree_and_never_renames_original_child(self):
        group,child=self.group();name=child.name;plan=self.plan();self.assertEqual(plan['target']['destinationId'],'track-2');self.assertEqual(len(plan['trackCopyContext']['sourceTracks']),2)
        result=self.apply(plan);self.assertTrue(result['copyVerified']);self.assertEqual(child.name,name);self.assertEqual(self.song.tracks[2].name,'Alternative');self.assertIs(self.song.tracks[3].group_track,self.song.tracks[2]);self.assertIs(child.group_track,group);self.assertEqual(len(result['createdTracks']),2)
    def test_group_child_copy_remains_in_its_existing_parent(self):
        group,child=self.group();result=self.apply(self.plan('track-1'));self.assertTrue(result['copyVerified']);self.assertIs(self.song.tracks[2].group_track,group)
    def test_nested_group_subtree_and_exact_numbered_survivor_labels(self):
        group,child=self.group();child.is_foldable=True;child.can_be_armed=False;child.fold_state=0
        member=copy.deepcopy(self.song.tracks[2]);member.name='Nested member';member.is_grouped=True;member.group_track=child;member.current_output_routing='Group';member.available_output_routing_types=['Group','Main'];self.song.tracks.insert(2,member)
        self.song.tracks[3].name='4-Audio';plan=self.plan()
        def renumber(index):self.native(index);self.song.tracks[-1].name='7-Audio'
        self.song.duplicate_track=renumber;result=self.apply(plan);self.assertTrue(result['copyVerified']);self.assertEqual(len(result['createdTracks']),3);self.assertIs(self.song.tracks[5].group_track,self.song.tracks[4]);self.assertEqual(len(result['renumberedTrackNames']),1)
    def test_different_song_cannot_certify_copy(self):
        import track_copy
        operation=track_copy.begin(self.song,self.plan(),3);result=track_copy.complete(copy.copy(self.song),operation,4)
        self.assertFalse(result['copyVerified']);self.assertIn('Set changed',result['observationError']);self.assertEqual(self.calls,[0])
    def test_same_version_notes_parameters_and_owners_invalidate_plan(self):
        for change in [lambda:setattr(self.clip.extended_notes[0],'velocity',62),lambda:setattr(self.song.tracks[0].devices[0].parameters[0],'value',.8),lambda:self.song.tracks.__setitem__(0,copy.deepcopy(self.song.tracks[0]))]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_undo_entry_manual_edit_refuses_before_copy(self):
        plan=self.plan();self.song.begin_undo_step=lambda:setattr(self.clip,'name','Manual edit')
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def test_playback_recording_pending_armed_soloed_and_monitored_sources_refuse(self):
        for owner,key,value in [('song','is_playing',True),('song','record_mode',True),('song','is_counting_in',None),('track','fired_slot_index',0),('track','arm',True),('track','implicit_arm',True),('track','implicit_arm',None),('track','solo',True),('track','current_monitoring_state',0)]:
            self.setUp();setattr(self.song if owner=='song' else self.song.tracks[0],key,value)
            with self.assertRaises(ValueError):self.context()
            self.assertEqual(self.calls,[])
    def test_omitted_name_retains_a_long_existing_native_label(self):
        self.song.tracks[0].name='Long source '+('x'*190);plan=self.plan();plan['explicitCopyName']=False;plan['target']['name']=self.song.tracks[0].name
        self.assertTrue(self.apply(plan)['copyVerified']);self.assertEqual(self.song.tracks[1].name,self.song.tracks[0].name)
    def test_inherited_name_intent_cannot_supply_a_different_label(self):
        plan=self.plan();plan['explicitCopyName']=False
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def test_copied_notes_changed_beyond_ids_do_not_verify(self):
        plan=self.plan()
        def altered(index):self.native(index);self.song.tracks[1].clip_slots[0].clip.extended_notes[0].velocity=41
        self.song.duplicate_track=altered;result=self.apply(plan);self.assertFalse(result['copyVerified']);self.assertFalse(result['copyMaterialMatches']);self.assertTrue(result['originalMaterialPreserved']);self.assertEqual(self.calls,[0])
    def test_shared_source_clip_does_not_count_as_an_independent_copy(self):
        plan=self.plan()
        def shared(index):self.native(index);self.song.tracks[1].clip_slots[0].clip=self.clip
        self.song.duplicate_track=shared;result=self.apply(plan);self.assertFalse(result['copyVerified']);self.assertFalse(result['copyOwnersDistinct'])
    def test_partial_native_error_reports_located_copy_without_replay(self):
        plan=self.plan()
        def fail(index):self.native(index);raise RuntimeError('native response lost')
        self.song.duplicate_track=fail;result=self.apply(plan);self.assertTrue(result['duplicateRequested']);self.assertFalse(result['nativeReturned']);self.assertTrue(result['copiesLocated']);self.assertFalse(result['copyVerified']);self.assertEqual(self.calls,[0]);self.assertEqual(len(self.song.tracks),4)
    def test_original_manual_edit_after_dispatch_is_retained_and_unverified(self):
        plan=self.plan()
        def edited(index):self.native(index);self.song.tracks[0].devices[0].parameters[0].value=.9
        self.song.duplicate_track=edited;result=self.apply(plan);self.assertFalse(result['copyVerified']);self.assertFalse(result['originalMaterialPreserved']);self.assertEqual(self.song.tracks[0].devices[0].parameters[0].value,.9)
    def test_wrong_native_topology_never_renames_a_retained_track(self):
        group,child=self.group();name=child.name;plan=self.plan()
        def wrong(index):self.calls.append(index);self.song.tracks.append(Track())
        self.song.duplicate_track=wrong;result=self.apply(plan);self.assertFalse(result['copyVerified']);self.assertEqual(child.name,name);self.assertFalse(result['nameApplied'])
    def test_deferred_stable_readback_and_lost_song_keep_dispatch_facts(self):
        for lost in (False,True):
            self.setUp();callbacks,replies=[],[];surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=lambda delay,callback:callbacks.append(callback));client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)));bridge=SocketBridge(surface,'/unused');bridge.state_version=3;bridge.requests.put((client,{'id':1,'method':'duplicate_session_object','params':self.plan()}));bridge.drain();self.assertEqual(replies,[])
            if lost:
                def unavailable():raise RuntimeError('Song unavailable')
                surface.song=unavailable
            callbacks.pop(0)()
            if not lost:self.assertEqual(replies,[]);callbacks.pop(0)()
            result=replies[0]['result'];self.assertTrue(result['duplicateRequested']);self.assertEqual(result['copyVerified'],not lost);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_projected_capacity_refuses_before_copy(self):
        self.song.tracks=[self.song.tracks[0]]*256
        with self.assertRaises(ValueError):self.context()
        self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
