import copy
import json
from types import SimpleNamespace
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Clip, MidiNote, AudioClip

class LoopClip(Clip):
    def __setattr__(self, name, value):
        if name in ('loop_start', 'loop_end', 'looping', 'signature_numerator') and hasattr(self, 'writes'):
            if name == 'loop_start' and value >= self.loop_end: raise ValueError('inverted native loop')
            if name == 'loop_end' and value <= self.loop_start: raise ValueError('inverted native loop')
            self.writes.append((name, value))
            object.__setattr__(self, name, value)
            if self.on_write: self.on_write(name)
        else: object.__setattr__(self, name, value)

class ClipLoopEditTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.is_counting_in = False
        self.clip = LoopClip()
        self.clip.is_audio_clip = False
        self.clip.is_recording = self.clip.is_overdubbing = self.clip.is_triggered = False
        self.clip.start_marker, self.clip.end_marker = 0., 4.
        self.clip.extended_notes = [MidiNote(7)]
        self.clip.writes, self.clip.on_write = [], None
        self.song.tracks[0].clip_slots[0].clip = self.clip
        self.target = {'trackId': 'track-0', 'clipId': 'track-0:clip-0'}
    def read(self):
        return dispatch_request(self.song, {'method':'get_clip_loop_edit_context', 'params':self.target}, 3)
    def plan(self, **changes):
        before = self.read()
        return {**self.target, 'expectedStateVersion':3, 'before':before['clipTiming'], 'loopEditContext':before, 'changes':changes or {'loop':{'startBeats':1, 'endBeats':3}}}
    def apply(self, plan):
        return dispatch_request(self.song, {'method':'set_clip_timing', 'params':plan}, 3)
    def test_order_notes_playback_and_mixed_fields(self):
        self.song.is_playing = True
        result = self.apply(self.plan(loop={'startBeats':8,'endBeats':12}, timeSignature={'numerator':3}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['notesPreserved'])
        self.assertEqual(self.clip.writes, [('loop_end',12.),('loop_start',8.),('signature_numerator',3)])
        self.assertEqual(self.song.undo_boundaries, ['begin','end'])
        self.assertTrue(self.song.is_playing)
    def test_no_op_avoids_setters_and_undo(self):
        result = self.apply(self.plan(loop={'enabled':True,'startBeats':0,'endBeats':4}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(self.clip.writes, [])
        self.assertEqual(self.song.undo_boundaries, [])
    def test_native_replacement_and_undo_entry_changes_refuse(self):
        for kind in ('clip','notes','recording'):
            self.setUp();plan=self.plan()
            begin=self.song.begin_undo_step
            def entry():
                begin()
                if kind=='clip': self.song.tracks[0].clip_slots[0].clip=copy.deepcopy(self.clip)
                elif kind=='notes': self.clip.extended_notes[0].velocity=31
                else: self.song.record_mode=True
            self.song.begin_undo_step=entry
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.apply(plan)
            self.assertEqual(self.clip.writes, [])
    def test_manual_edits_stop_further_setters_without_rollback(self):
        self.clip.on_write=lambda name:setattr(self.clip.extended_notes[0],'velocity',31)
        result=self.apply(self.plan(loop={'startBeats':8,'endBeats':12}))
        self.assertFalse(result['requestedChangesVerified'])
        self.assertTrue(result['error'])
        self.assertFalse(result['notesPreserved'])
        self.assertEqual(self.clip.writes, [('loop_end',12.)])
        self.assertEqual(self.clip.loop_end,12.)
        self.assertEqual(self.clip.extended_notes[0].velocity,31)
    def test_recording_unknown_and_frozen_contexts_refuse(self):
        for owner,field in [(self.song,'record_mode'),(self.song,'session_record'),(self.song,'is_counting_in'),(self.clip,'is_recording'),(self.clip,'is_overdubbing'),(self.clip,'is_triggered'),(self.song.tracks[0],'is_frozen')]:
            for value in (True,None):
                old=getattr(owner,field);setattr(owner,field,value)
                with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.apply(self.plan())
                setattr(owner,field,old)
        self.assertEqual(self.clip.writes,[])
    def test_partial_setter_and_undo_close_failures_keep_actual_result(self):
        for kind in ('setter','undo'):
            self.setUp()
            if kind=='setter':self.clip.on_write=lambda name:(_ for _ in ()).throw(RuntimeError('setter interrupted'))
            else:self.song.end_undo_step=lambda:(_ for _ in ()).throw(RuntimeError('undo close failed'))
            result=self.apply(self.plan())
            self.assertFalse(result['requestedChangesVerified'])
            self.assertTrue(result['error'])
            self.assertTrue(result['writeRequested'])
            self.assertEqual(self.clip.loop_start,1.)
    def test_mode_switch_precedes_final_bounds_with_native_coupling(self):
        object.__setattr__(self.clip,'loop_start',2.)
        object.__setattr__(self.clip,'loop_end',6.)
        def switch(name):
            if name=='looping':
                object.__setattr__(self.clip,'loop_start',0.)
                object.__setattr__(self.clip,'loop_end',8.)
        self.clip.on_write=switch
        result=self.apply(self.plan(loop={'enabled':False,'startBeats':2,'endBeats':6}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['nativeReturned'])
        self.assertEqual(self.clip.writes,[('looping',False),('loop_start',2.),('loop_end',6.)])
        self.assertEqual(result['loop'],{'enabled':False,'startBeats':2.,'endBeats':6.})

    def test_mode_coupling_can_make_remaining_setters_unnecessary(self):
        object.__setattr__(self.clip,'looping',False)
        object.__setattr__(self.clip,'loop_start',1.)
        object.__setattr__(self.clip,'loop_end',5.)
        def switch(name):
            if name=='looping':
                object.__setattr__(self.clip,'loop_start',2.)
                object.__setattr__(self.clip,'loop_end',6.)
        self.clip.on_write=switch
        result=self.apply(self.plan(loop={'enabled':True,'startBeats':2,'endBeats':6}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['nativeReturned'])
        self.assertEqual(result['completedFields'],['loop.enabled'])
        self.assertEqual(self.clip.writes,[('looping',True)])

    def test_audio_material_preserved_with_beats_and_seconds(self):
        for warped in (True,False):
            self.setUp()
            self.clip.__dict__.update(AudioClip().__dict__)
            self.clip.warping=warped
            key='Beats' if warped else 'Seconds'
            result=self.apply(self.plan(loop={'start'+key:.5,'end'+key:2}))
            self.assertTrue(result['requestedChangesVerified'])
            self.assertTrue(result['audioSourcePreserved'])
            self.assertIsNone(result['notesPreserved'])
            self.assertFalse(result['sourceFileBytesVerified'])
    def test_omitted_loop_bound_changes_are_not_tolerated(self):
        self.clip.on_write=lambda name:object.__setattr__(self.clip,'loop_end',4.0000001)
        result=self.apply(self.plan(loop={'startBeats':1}))
        self.assertFalse(result['requestedChangesVerified'])
        self.assertEqual(self.clip.loop_end,4.0000001)
        self.assertEqual(self.clip.writes,[('loop_start',1.)])
    def test_native_rounding_only_applies_to_issued_bound(self):
        self.clip.on_write=lambda name:object.__setattr__(self.clip,'loop_start',1.0000001)
        result=self.apply(self.plan(loop={'startBeats':1}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertEqual(result['loop']['startBeats'],1.0000001)
    def test_native_coupled_markers_are_reported_without_claiming_preservation(self):
        self.clip.on_write=lambda name:object.__setattr__(self.clip,'start_marker',1.)
        result=self.apply(self.plan(loop={'startBeats':1}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['markersChanged'])
        self.assertFalse(result['unrequestedTimingPreserved'])
    def test_ignored_setter_and_unavailable_readback_remain_unverified(self):
        for kind in ('ignored','readback'):
            self.setUp()
            def changed(name):
                if kind=='ignored':object.__setattr__(self.clip,'loop_start',0.)
                else:self.clip.get_all_notes_extended=lambda:(_ for _ in ()).throw(RuntimeError('readback unavailable'))
            self.clip.on_write=changed
            result=self.apply(self.plan())
            self.assertFalse(result['requestedChangesVerified'])
            self.assertTrue(result['error'] or result['observationError'])
            self.assertEqual(self.clip.writes,[('loop_start',1.)])

    def arrangement(self, neighbor_start=None):
        self.clip.start_time,self.clip.end_time=32.,40.
        clips=[self.clip]
        if neighbor_start is not None:
            neighbor=copy.deepcopy(self.clip)
            neighbor.start_time,neighbor.end_time=neighbor_start,neighbor_start+8
            clips.append(neighbor)
        self.song.tracks[0].arrangement_clips=clips
        self.target['clipId']='track-0:arrangement-clip-0'
        return clips[-1]
    def test_nonloop_arrangement_resize_is_verified_and_reported(self):
        self.arrangement()
        def resized(name):
            if not self.clip.looping:self.clip.end_time=self.clip.start_time+self.clip.loop_end-self.clip.loop_start
        self.clip.on_write=resized
        result=self.apply(self.plan(loop={'enabled':False,'startBeats':1,'endBeats':3}))
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['arrangementSpanChanged'])
        self.assertFalse(result['unrequestedTimingPreserved'])
        self.assertEqual(result['timeline']['endBeats'],34.)
    def test_transient_arrangement_overlap_refuses_before_writing(self):
        self.arrangement(42.)
        with self.assertRaisesRegex(ValueError,'overlap'):
            self.apply(self.plan(loop={'enabled':False,'startBeats':10,'endBeats':14}))
        self.assertEqual(self.clip.writes,[])
        self.assertEqual(self.song.undo_boundaries,[])
    def test_long_arrangement_occurrence_bounds_transient_mode_coupling(self):
        self.arrangement(70.)
        self.clip.end_time=64.
        object.__setattr__(self.clip,'loop_start',10.)
        object.__setattr__(self.clip,'loop_end',14.)
        self.clip.start_marker,self.clip.end_marker=10.,14.
        with self.assertRaisesRegex(ValueError,'overlap'):
            self.apply(self.plan(loop={'enabled':False,'startBeats':.5,'endBeats':3}))
        self.assertEqual(self.clip.writes,[])
        self.assertEqual(self.song.undo_boundaries,[])
    def test_plan_context_refuses_unsafe_arrangement_before_confirmation(self):
        self.arrangement(42.)
        with self.assertRaisesRegex(ValueError,'overlap'):
            dispatch_request(self.song,{'method':'get_clip_loop_edit_context','params':{
                **self.target,'changes':{'loop':{'enabled':False,'startBeats':10,'endBeats':14}}}},3)
        self.assertEqual(self.clip.writes,[])
    def test_unknown_mode_coupling_refuses_when_following_clips_exist(self):
        self.arrangement(48.)
        del self.clip.end_marker
        with self.assertRaisesRegex(ValueError,'cannot bound'):
            self.apply(self.plan(loop={'enabled':False,'startBeats':1,'endBeats':3}))
        self.assertEqual(self.clip.writes,[])

    def test_exact_touch_is_allowed_but_positive_tiny_overlap_refuses(self):
        for boundary in (44.,43.9999999):
            self.setUp();self.arrangement(boundary)
            def resized(name):
                if not self.clip.looping:self.clip.end_time=32+self.clip.loop_end-self.clip.loop_start
            self.clip.on_write=resized
            plan=self.plan(loop={'enabled':False,'startBeats':0,'endBeats':12})
            if boundary==44.:
                self.assertTrue(self.apply(plan)['requestedChangesVerified'])
                self.assertEqual(self.clip.end_time,44.)
            else:
                with self.assertRaisesRegex(ValueError,'overlap'):self.apply(plan)
                self.assertEqual(self.clip.writes,[])
                self.assertEqual(self.song.undo_boundaries,[])
    def test_native_rounding_into_occupied_space_is_not_verified(self):
        self.arrangement(44.)
        def resized(name):
            if name=='loop_end':object.__setattr__(self.clip,'loop_end',12.0000001)
            if not self.clip.looping:self.clip.end_time=32+self.clip.loop_end-self.clip.loop_start
        self.clip.on_write=resized
        result=self.apply(self.plan(loop={'enabled':False,'startBeats':0,'endBeats':12}))
        self.assertFalse(result['requestedChangesVerified'])
        self.assertIn('overlap',result['error'])
        self.assertEqual(self.clip.end_time,44.0000001)

    def test_tiny_unwarped_expansion_with_following_material_refuses_before_write(self):
        self.clip.__dict__.update(AudioClip().__dict__)
        self.clip.warping=False
        object.__setattr__(self.clip,'looping',False)
        self.arrangement(64.)
        with self.assertRaisesRegex(ValueError,'unwarped.*expansion'):
            self.apply(self.plan(loop={'endSeconds':4.00000001}))
        self.assertEqual(self.clip.writes,[])
        self.assertEqual(self.song.undo_boundaries,[])
    def queued(self,plan,fail_schedule=False):
        callbacks,replies=[],[]
        def schedule(delay,callback):
            if fail_schedule:raise RuntimeError('scheduler unavailable')
            callbacks.append(callback)
        surface=SimpleNamespace(song=lambda:self.song,application=lambda:None,schedule_message=schedule)
        client=SimpleNamespace(sendall=lambda payload:replies.append(json.loads(payload)))
        bridge=SocketBridge(surface,'/unused');bridge.state_version=3
        bridge.requests.put((client,{'id':1,'method':'set_clip_timing','params':plan}))
        bridge.drain()
        return callbacks,replies,bridge
    def test_deferred_arrangement_audio_readback_observes_rebase_without_replay(self):
        self.clip.__dict__.update(AudioClip().__dict__)
        self.clip.warping=False
        object.__setattr__(self.clip,'looping',False)
        self.clip.warp_markers=[SimpleNamespace(sample_time=0.,beat_time=0.),SimpleNamespace(sample_time=.015625,beat_time=.03125)]
        self.arrangement()
        callbacks,replies,bridge=self.queued(self.plan(loop={'startSeconds':.5,'endSeconds':2.}))
        self.assertEqual(replies,[])
        self.assertTrue(bridge.deferred_request)
        self.clip.end_time=35.
        for marker in self.clip.warp_markers:marker.sample_time+=.5
        callbacks.pop(0)();self.assertEqual(replies,[])
        callbacks.pop(0)()
        result=replies[0]['result']
        self.assertTrue(result['requestedChangesVerified'])
        self.assertTrue(result['arrangementSpanChanged'])
        self.assertTrue(result['audioSourceIdentityPreserved'])
        self.assertFalse(result['audioSourcePreserved'])
        self.assertFalse(result['warpMarkersPreserved'])
        self.assertTrue(result['warpMarkersRebased'])
        self.assertEqual(result['observedContext']['stateVersion'],4)
        self.assertEqual(self.clip.writes,[('loop_start',.5),('loop_end',2.)])
        self.assertFalse(bridge.deferred_request)
    def test_deferred_manual_change_stays_unverified_without_replay(self):
        callbacks,replies,_=self.queued(self.plan())
        self.assertEqual(replies,[])
        self.clip.extended_notes[0].velocity=31
        for _ in range(3):
            if callbacks:callbacks.pop(0)()
        result=replies[0]['result']
        self.assertFalse(result['requestedChangesVerified'])
        self.assertFalse(result['notesPreserved'])
        self.assertEqual(self.clip.extended_notes[0].velocity,31)
        self.assertEqual(self.clip.writes,[('loop_start',1.),('loop_end',3.)])
    def test_deferred_lost_song_retains_native_partial_receipt(self):
        callbacks,replies,bridge=self.queued(self.plan())
        def unavailable():raise RuntimeError('Song unavailable')
        bridge.control_surface.song=unavailable
        callbacks.pop(0)()
        result=replies[0]['result']
        self.assertFalse(result['requestedChangesVerified'])
        self.assertTrue(result['writeRequested'])
        self.assertTrue(result['nativeReturned'])
        self.assertEqual(result['completedFields'],['loop.startBeats','loop.endBeats'])
        self.assertIsNone(result['observedContext'])
        self.assertIsNone(result['notesPreserved'])
        self.assertIn('Song unavailable',result['observationError'])
        self.assertEqual(self.clip.writes,[('loop_start',1.),('loop_end',3.)])
        self.assertFalse(bridge.deferred_request)
    def test_deferred_scheduler_failure_retains_native_partial_receipt(self):
        _,replies,_=self.queued(self.plan(),fail_schedule=True)
        result=replies[0]['result']
        self.assertFalse(result['requestedChangesVerified'])
        self.assertTrue(result['writeRequested'])
        self.assertTrue(result['nativeReturned'])
        self.assertIn('scheduler',result['error'])
        self.assertEqual(self.clip.writes,[('loop_start',1.),('loop_end',3.)])

    def test_neighbor_manual_edits_are_preserved_and_stop_further_setters(self):
        neighbor=self.arrangement(48.)
        self.clip.on_write=lambda name:setattr(neighbor,'end_time',57.)
        result=self.apply(self.plan(loop={'startBeats':1,'endBeats':3}))
        self.assertFalse(result['requestedChangesVerified'])
        self.assertTrue(result['error'])
        self.assertEqual(self.clip.writes,[('loop_start',1.)])
        self.assertEqual(neighbor.end_time,57.)
    def test_unwarped_arrangement_shrink_and_expansion_without_following_clips(self):
        self.clip.__dict__.update(AudioClip().__dict__)
        self.clip.warping=False
        object.__setattr__(self.clip,'looping',False)
        self.arrangement()
        self.clip.on_write=lambda name:setattr(self.clip,'end_time',32+2*(self.clip.loop_end-self.clip.loop_start))
        for start,end in ((.5,2.),(.5,6.)):
            result=self.apply(self.plan(loop={'startSeconds':start,'endSeconds':end}))
            self.assertTrue(result['requestedChangesVerified'])
            self.assertTrue(result['audioSourcePreserved'])
            self.assertTrue(result['arrangementSpanChanged'])
    def test_unwarped_arrangement_expansion_with_following_clips_refuses(self):
        self.clip.__dict__.update(AudioClip().__dict__)
        self.clip.warping=False
        object.__setattr__(self.clip,'looping',False)
        self.arrangement(64.)
        with self.assertRaisesRegex(ValueError,'unwarped.*expansion'):
            self.apply(self.plan(loop={'startSeconds':0,'endSeconds':8}))
        self.assertEqual(self.clip.writes,[])
        self.assertEqual(self.song.undo_boundaries,[])

    def test_missing_native_plan_refuses_before_writing(self):
        with self.assertRaises(ValueError):self.apply({**self.target,'changes':{'loop':{'startBeats':1}}})
        self.assertEqual(self.clip.writes,[])
    def test_arrangement_and_complete_note_limit(self):
        self.clip.start_time,self.clip.end_time=16.,20.
        self.song.tracks[0].arrangement_clips=[self.clip]
        self.target['clipId']='track-0:arrangement-clip-0'
        self.assertTrue(self.apply(self.plan())['requestedChangesVerified'])
        self.clip.extended_notes=[MidiNote(i) for i in range(4097)]
        with self.assertRaises(ValueError):self.read()
if __name__=='__main__':unittest.main()
