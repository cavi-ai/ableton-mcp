import copy
import os
import sys
import unittest
import json
from types import SimpleNamespace
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_dispatch import Song,Scene,ClipSlot,AudioClip,MidiNote

class SceneDuplicationTests(unittest.TestCase):
    def setUp(self):
        self.song=Song();self.song.is_counting_in=False
        for track in self.song.tracks:
            track.clip_slots=[ClipSlot(),ClipSlot(False)]
            track.fired_slot_index=-1;track.playing_slot_index=-1;track.implicit_arm=False
            for slot in track.clip_slots:
                slot.is_triggered=False;slot.has_stop_button=True
                if slot.has_clip:
                    slot.clip.is_audio_clip=False;slot.clip.is_recording=False;slot.clip.is_overdubbing=False;slot.clip.is_triggered=False
                    slot.clip.extended_notes=[MidiNote()]
        self.song.tracks[1].clip_slots[0].clip=AudioClip()
        self.song.tracks[1].clip_slots[0].clip.is_recording=False
        self.song.tracks[1].clip_slots[0].clip.is_triggered=False
        self.song.tracks[1].clip_slots[0].clip.is_overdubbing=False
        for scene in self.song.scenes:scene.is_triggered=False
        self.calls=[];self.song.duplicate_scene=self.native
        self.target={'targetType':'scene','targetId':'scene-0','destinationId':'scene-1','name':'Verse'}
    def native(self,index):
        self.calls.append(index);self.song.scenes.insert(index+1,copy.deepcopy(self.song.scenes[index]))
        for track in self.song.tracks:
            slot=copy.deepcopy(track.clip_slots[index])
            if slot.has_clip:
                for note in getattr(slot.clip,'extended_notes',[]):note.note_id+=100
                slot.clip.is_playing=False
            track.clip_slots.insert(index+1,slot)
            if track.playing_slot_index>index:track.playing_slot_index+=1
    def context(self):return dispatch_request(self.song,{'method':'get_scene_duplication_context','params':{'sceneId':'scene-0'}},3)
    def plan(self):return {'target':self.target,'expectedStateVersion':3,'sceneCopyContext':self.context()}
    def apply(self,plan):return dispatch_request(self.song,{'method':'duplicate_session_object','params':plan},3)
    def test_mixed_row_copies_native_material_preserves_owners_and_remaps_ids(self):
        original=self.song.tracks[0].clip_slots[0].clip
        result=self.apply(self.plan())
        self.assertTrue(result['copyVerified']);self.assertTrue(result['existingLayoutPreserved']);self.assertTrue(result['existingMaterialPreserved']);self.assertTrue(result['playbackPreserved'])
        self.assertIs(self.song.tracks[0].clip_slots[0].clip,original)
        self.assertEqual(result['sceneId'],'scene-1');self.assertEqual(self.calls,[0]);self.assertEqual(self.song.undo_boundaries,['begin','end'])
        self.assertFalse(result['hiddenStateVerified']);self.assertFalse(result['sourceFileBytesVerified'])
    def test_stale_material_and_same_looking_native_replacements_refuse(self):
        for change in [lambda:setattr(self.song.tracks[0].clip_slots[0].clip.extended_notes[0],'velocity',22),lambda:self.song.scenes.__setitem__(0,copy.deepcopy(self.song.scenes[0])),lambda:setattr(self.song.tracks[1].clip_slots[0].clip,'pitch_coarse',7),lambda:setattr(self.song.tracks[0].clip_slots[1],'has_stop_button',False)]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_undo_entry_rechecks_before_copy(self):
        plan=self.plan()
        self.song.begin_undo_step=lambda:setattr(self.song.tracks[0].clip_slots[0].clip,'name','Manual')
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def test_partial_native_failure_keeps_inserted_row_without_replay(self):
        plan=self.plan()
        def fail(index):self.native(index);raise RuntimeError('native reply lost')
        self.song.duplicate_scene=fail;result=self.apply(plan)
        self.assertTrue(result['copyRequested']);self.assertFalse(result['nativeReturned']);self.assertFalse(result['copyVerified']);self.assertIsNone(result['sceneId']);self.assertEqual(len(self.song.scenes),3);self.assertEqual(self.calls,[0])
    def test_wrong_copied_content_or_old_material_never_verifies(self):
        for modify in [lambda:setattr(self.song.tracks[0].clip_slots[1].clip.extended_notes[0],'pitch',99),lambda:setattr(self.song.tracks[0].clip_slots[0].clip.extended_notes[0],'velocity',23),lambda:self.song.scenes.append(Scene())]:
            self.setUp();plan=self.plan()
            def wrong(index):self.native(index);modify()
            self.song.duplicate_scene=wrong;result=self.apply(plan)
            self.assertFalse(result['copyVerified']);self.assertEqual(len(self.calls),1)
    def test_recording_pending_count_in_unknown_and_frozen_source_refuse(self):
        for owner,name,value in [('song','record_mode',True),('song','session_record',True),('song','is_counting_in',None),('track','fired_slot_index',0),('track','is_frozen',True),('clip','is_recording',True),('clip','is_overdubbing',True),('clip','is_triggered',True),('slot','is_triggered',True)]:
            self.setUp();obj={'song':self.song,'track':self.song.tracks[0],'slot':self.song.tracks[0].clip_slots[0],'clip':self.song.tracks[0].clip_slots[0].clip}[owner];setattr(obj,name,value)
            with self.assertRaises(ValueError):self.context()
            self.assertEqual(self.calls,[])
    def test_playing_clip_after_insertion_keeps_native_owner(self):
        self.song.is_playing=True;track=self.song.tracks[0];track.clip_slots[1]=copy.deepcopy(track.clip_slots[0]);track.playing_slot_index=1;track.clip_slots[1].clip.is_playing=True
        self.assertTrue(self.apply(self.plan())['playbackPreserved']);self.assertEqual(track.playing_slot_index,2)
    def test_empty_and_group_rows_preserve_stop_buttons(self):
        track=self.song.tracks[0];track.is_foldable=True;track.can_be_armed=False;track.clip_slots[0]=ClipSlot(False);track.clip_slots[0].is_triggered=False;track.clip_slots[0].has_stop_button=False
        result=self.apply(self.plan());self.assertTrue(result['copyVerified']);self.assertFalse(track.clip_slots[1].has_stop_button)
    def test_unexpected_launch_of_copy_is_not_playback_preservation(self):
        self.song.is_playing=True;self.song.tracks[0].playing_slot_index=0
        plan=self.plan()
        def launch(index):self.native(index);self.song.tracks[0].playing_slot_index=index+1
        self.song.duplicate_scene=launch
        result=self.apply(plan)
        self.assertFalse(result['playbackPreserved']);self.assertFalse(result['copyVerified'])
    def test_missing_post_read_retains_inserted_row_dispatch_facts(self):
        plan=self.plan()
        def unavailable(index):
            self.native(index)
            self.song.tracks[0].clip_slots[0].clip.get_all_notes_extended=lambda:(_ for _ in ()).throw(RuntimeError('notes unavailable'))
        self.song.duplicate_scene=unavailable;result=self.apply(plan)
        self.assertTrue(result['copyRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['copyVerified']);self.assertIn('notes unavailable',result['observationError']);self.assertEqual(len(self.calls),1)
    def test_scene_tempo_enabled_is_bound_before_undo_and_after_copy(self):
        for phase in ('before','undo','copy'):
            self.setUp();scene=self.song.scenes[0];scene.tempo=123.;scene.tempo_enabled=False
            plan=self.plan()
            if phase=='before':
                scene.tempo_enabled=True
                with self.assertRaises(ValueError):self.apply(plan)
                self.assertEqual(self.calls,[])
            elif phase=='undo':
                self.song.begin_undo_step=lambda:setattr(scene,'tempo_enabled',True)
                with self.assertRaises(ValueError):self.apply(plan)
                self.assertEqual(self.calls,[])
            else:
                def change(index):self.native(index);self.song.scenes[index+1].tempo_enabled=True
                self.song.duplicate_scene=change
                self.assertFalse(self.apply(plan)['copyVerified'])
    def test_native_clip_playback_readback_detects_lagging_slot_index(self):
        self.song.is_playing=True;track=self.song.tracks[0];track.playing_slot_index=0;track.clip_slots[0].clip.is_playing=True
        plan=self.plan()
        def stop(index):self.native(index);track.clip_slots[0].clip.is_playing=False
        self.song.duplicate_scene=stop;result=self.apply(plan)
        self.assertFalse(result['playbackPreserved']);self.assertFalse(result['copyVerified'])
    def queued(self,plan):
        callbacks,replies=[],[]
        surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=lambda delay,callback:callbacks.append(callback))
        client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)))
        bridge=SocketBridge(surface,'/unused');bridge.state_version=3
        bridge.requests.put((client,{'id':1,'method':'duplicate_session_object','params':plan}));bridge.drain()
        return callbacks,replies,bridge
    def test_deferred_copy_observes_settled_material_without_replaying(self):
        plan=self.plan()
        def delayed(index):self.native(index);self.song.tracks[0].clip_slots[index+1].clip.extended_notes[0].velocity=12
        self.song.duplicate_scene=delayed
        callbacks,replies,bridge=self.queued(plan)
        self.assertEqual(replies,[])
        self.song.tracks[0].clip_slots[1].clip.extended_notes[0].velocity=100
        callbacks.pop(0)();self.assertEqual(replies,[])
        callbacks.pop(0)();self.assertTrue(replies[0]['result']['copyVerified']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_deferred_lost_song_retains_insertion_facts(self):
        callbacks,replies,bridge=self.queued(self.plan())
        self.assertEqual(replies,[])
        def unavailable():raise RuntimeError('Song unavailable')
        bridge.control_surface.song=unavailable;callbacks.pop(0)()
        result=replies[0]['result'];self.assertTrue(result['copyRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['copyVerified']);self.assertIsNone(result['existingMaterialPreserved']);self.assertIn('Song unavailable',result['observationError']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_deferred_different_song_with_same_children_cannot_verify(self):
        callbacks,replies,bridge=self.queued(self.plan())
        other=copy.copy(self.song)
        bridge.control_surface.song=lambda:other
        for _ in range(3):
            if callbacks:callbacks.pop(0)()
        result=replies[0]['result'];self.assertTrue(result['copyRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['copyVerified']);self.assertFalse(result['existingLayoutPreserved']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_missing_plan_and_noncanonical_id_refuse(self):
        with self.assertRaises(ValueError):self.apply({'target':self.target})
        with self.assertRaises(ValueError):dispatch_request(self.song,{'method':'get_scene_duplication_context','params':{'sceneId':'scene-00'}},3)
        self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
