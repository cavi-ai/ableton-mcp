import copy
import json
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request,SocketBridge
from test_dispatch import Song,Scene,ClipSlot,AudioClip,MidiNote

class SceneRemovalTests(unittest.TestCase):
    def setUp(self):
        self.song=Song();self.song.is_counting_in=False
        for track in self.song.tracks:
            track.clip_slots=[ClipSlot(),ClipSlot(False)];track.fired_slot_index=-1;track.playing_slot_index=-1;track.implicit_arm=False
            for slot in track.clip_slots:
                slot.is_triggered=False;slot.has_stop_button=True
                if slot.has_clip:
                    slot.clip.is_audio_clip=False;slot.clip.is_recording=slot.clip.is_overdubbing=slot.clip.is_triggered=False
                    slot.clip.is_playing=False;slot.clip.extended_notes=[MidiNote()]
        self.song.tracks[1].clip_slots[0].clip=AudioClip()
        clip=self.song.tracks[1].clip_slots[0].clip;clip.is_recording=clip.is_overdubbing=clip.is_triggered=clip.is_playing=False
        for scene in self.song.scenes:scene.is_triggered=False
        self.calls=[];self.song.delete_scene=self.native
    def native(self,index):
        self.calls.append(index);self.song.scenes.pop(index)
        for track in self.song.tracks:
            track.clip_slots.pop(index)
            if track.playing_slot_index>index:track.playing_slot_index-=1
    def context(self,scene='scene-0'):return dispatch_request(self.song,{'method':'get_scene_removal_context','params':{'sceneId':scene}},3)
    def plan(self,scene='scene-0',allow=True):
        before=self.context(scene);return {'target':{'targetType':'scene','targetId':scene,'name':before['scenes'][int(scene[6:])]['name']},'expectedStateVersion':3,'sceneRemovalContext':before,'allowContent':allow}
    def apply(self,plan):return dispatch_request(self.song,{'method':'delete_session_object','params':plan},3)
    def test_populated_row_removal_preserves_remaining_native_owners_and_material(self):
        survivor=self.song.scenes[1];slots=[t.clip_slots[1] for t in self.song.tracks]
        result=self.apply(self.plan());self.assertTrue(result['deletionVerified']);self.assertTrue(result['targetAbsent']);self.assertTrue(result['remainingMaterialPreserved']);self.assertTrue(result['playbackPreserved']);self.assertIs(self.song.scenes[0],survivor);self.assertEqual([t.clip_slots[0] for t in self.song.tracks],slots);self.assertEqual(self.calls,[0]);self.assertEqual(self.song.undo_boundaries,['begin','end'])
    def test_disposed_deleted_scene_proxy_is_never_compared(self):
        class NativeScene(Scene):
            dead=False
            def __eq__(self,other):
                if self.dead:raise RuntimeError('Scene object is invalid')
                return self is other
        target=NativeScene();target.is_triggered=False;self.song.scenes[0]=target
        plan=self.plan()
        def dispose(index):self.native(index);target.dead=True
        self.song.delete_scene=dispose;result=self.apply(plan)
        self.assertTrue(result['nativeReturned']);self.assertTrue(result['targetAbsent']);self.assertTrue(result['deletionVerified']);self.assertIsNone(result['observationError'])
    def test_empty_row_needs_no_content_override(self):self.assertTrue(self.apply(self.plan('scene-1',False))['deletionVerified'])
    def test_populated_row_needs_content_authority_at_native_boundary(self):
        with self.assertRaisesRegex(ValueError,'allowContent'):self.apply(self.plan(allow=False))
        self.assertEqual(self.calls,[])
    def test_same_version_edits_and_same_looking_replacements_refuse(self):
        for change in [lambda:setattr(self.song.tracks[0].clip_slots[0].clip.extended_notes[0],'velocity',22),lambda:self.song.scenes.__setitem__(0,copy.deepcopy(self.song.scenes[0])),lambda:self.song.tracks[0].clip_slots.__setitem__(0,copy.deepcopy(self.song.tracks[0].clip_slots[0])),lambda:setattr(self.song.tracks[1].clip_slots[0].clip,'pitch_coarse',4),lambda:setattr(self.song.tracks[0].clip_slots[1],'has_stop_button',False)]:
            self.setUp();plan=self.plan();change()
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_undo_entry_rechecks_material_and_recording(self):
        for change in [lambda:setattr(self.song.tracks[0].clip_slots[0].clip,'name','Manual'),lambda:setattr(self.song,'record_mode',True)]:
            self.setUp();plan=self.plan();self.song.begin_undo_step=change
            with self.assertRaises(ValueError):self.apply(plan)
            self.assertEqual(self.calls,[])
    def test_native_exception_retains_deleted_outcome_without_retry(self):
        plan=self.plan()
        def fail(index):self.native(index);raise RuntimeError('native reply lost')
        self.song.delete_scene=fail;result=self.apply(plan)
        self.assertTrue(result['deleteRequested']);self.assertFalse(result['nativeReturned']);self.assertTrue(result['targetAbsent']);self.assertFalse(result['deletionVerified']);self.assertEqual(self.calls,[0]);self.assertEqual(len(self.song.scenes),1)
    def test_last_scene_noncanonical_and_missing_plan_refuse(self):
        with self.assertRaises(ValueError):self.apply({'target':{'targetType':'scene','targetId':'scene-0'}})
        with self.assertRaises(ValueError):self.context('scene-00')
        self.song.scenes.pop();[t.clip_slots.pop() for t in self.song.tracks]
        with self.assertRaises(ValueError):self.context()
        self.assertEqual(self.calls,[])
    def test_recording_count_in_pending_and_unknown_refuse(self):
        for owner,name,value in [('song','record_mode',True),('song','session_record',True),('song','is_counting_in',None),('track','fired_slot_index',0),('track','is_frozen',True),('clip','is_recording',True),('clip','is_overdubbing',True),('clip','is_triggered',True),('slot','is_triggered',True)]:
            self.setUp();obj={'song':self.song,'track':self.song.tracks[0],'slot':self.song.tracks[0].clip_slots[0],'clip':self.song.tracks[0].clip_slots[0].clip}[owner];setattr(obj,name,value)
            with self.assertRaises(ValueError):self.context()
            self.assertEqual(self.calls,[])
    def test_playing_target_refuses_even_with_lagging_slot_index(self):
        for native_flag in (True,False):
            self.setUp();self.song.is_playing=True
            if native_flag:self.song.tracks[0].clip_slots[0].clip.is_playing=True
            else:self.song.tracks[0].playing_slot_index=0
            with self.assertRaisesRegex(ValueError,'playing'):self.context()
    def test_other_playing_row_survives_shift_with_native_playback(self):
        self.song.is_playing=True;track=self.song.tracks[0];track.clip_slots[1]=copy.deepcopy(track.clip_slots[0]);track.clip_slots[1].clip.is_playing=True;track.playing_slot_index=1
        result=self.apply(self.plan());self.assertTrue(result['deletionVerified']);self.assertTrue(result['playbackPreserved']);self.assertEqual(track.playing_slot_index,0);self.assertTrue(track.clip_slots[0].clip.is_playing)
    def test_manual_survivor_changes_or_wrong_scene_removal_are_not_verified(self):
        for wrong in (False,True):
            self.setUp();plan=self.plan()
            def mutate(index):
                self.native(1 if wrong else index)
                if not wrong:self.song.tracks[0].clip_slots[0].has_stop_button=False
            self.song.delete_scene=mutate;result=self.apply(plan);self.assertFalse(result['deletionVerified']);self.assertEqual(len(self.calls),1)
    def test_tempo_enable_change_invalidates_plan(self):
        scene=self.song.scenes[0];scene.tempo=123.;scene.tempo_enabled=False;plan=self.plan();scene.tempo_enabled=True
        with self.assertRaises(ValueError):self.apply(plan)
        self.assertEqual(self.calls,[])
    def queued(self,plan):
        callbacks,replies=[],[];surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=lambda delay,callback:callbacks.append(callback));client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)))
        bridge=SocketBridge(surface,'/unused');bridge.state_version=3;bridge.requests.put((client,{'id':1,'method':'delete_session_object','params':plan}));bridge.drain();return callbacks,replies,bridge
    def test_deferred_verification_is_stable_and_never_replays(self):
        callbacks,replies,bridge=self.queued(self.plan());self.assertEqual(replies,[]);callbacks.pop(0)();self.assertEqual(replies,[]);callbacks.pop(0)();self.assertTrue(replies[0]['result']['deletionVerified']);self.assertEqual(self.calls,[0]);self.assertFalse(bridge.deferred_request)
    def test_deferred_lost_song_retains_dispatch_facts(self):
        callbacks,replies,bridge=self.queued(self.plan());self.assertEqual(replies,[])
        def unavailable():raise RuntimeError('Song unavailable')
        bridge.control_surface.song=unavailable;callbacks.pop(0)();result=replies[0]['result'];self.assertTrue(result['deleteRequested']);self.assertTrue(result['nativeReturned']);self.assertFalse(result['deletionVerified']);self.assertIsNone(result['targetAbsent']);self.assertIn('Song unavailable',result['observationError']);self.assertEqual(self.calls,[0])
    def test_deferred_same_children_different_song_never_verifies(self):
        callbacks,replies,bridge=self.queued(self.plan());other=copy.copy(self.song);bridge.control_surface.song=lambda:other
        for _ in range(3):
            if callbacks:callbacks.pop(0)()
        self.assertFalse(replies[0]['result']['deletionVerified']);self.assertIsNone(replies[0]['result']['targetAbsent']);self.assertEqual(self.calls,[0])
if __name__=='__main__':unittest.main()
