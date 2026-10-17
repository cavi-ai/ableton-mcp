import copy
import os
import sys
import unittest
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, AudioClip


class AudioReverseTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.file_path = '/Projects/Test.als'
        self.song.is_counting_in = False
        for owner in self.song.tracks: owner.arrangement_clips = []
        self.track = self.song.tracks[0]
        self.clip = AudioClip()
        self.clip.name = 'Reverse test audio'
        self.clip.file_path = '/Samples/Source.wav'
        self.clip.is_recording = self.clip.is_triggered = False
        self.track.clip_slots[0].clip = self.clip
        self.track.clip_slots[0].has_clip = True
        self.ids = {'trackId':'track-0','clipId':'track-0:clip-0'}

    def read(self):
        return dispatch_request(self.song, {'method':'get_audio_clip_reverse_source','params':self.ids}, 4)

    def test_read_is_inert_and_binds_native_clip_audio_timing_and_identity(self):
        selected = self.song.view.selected_track
        before = self.read()
        self.assertEqual(before['audio']['source']['path'], '/Samples/Source.wav')
        self.assertEqual(before, self.read())
        self.assertIs(self.song.view.selected_track, selected)
        self.track.clip_slots[0].clip = copy.deepcopy(self.clip)
        after=self.read()
        self.assertNotEqual(before['identityToken'],after['identityToken'])
        self.assertEqual(before['ownerIdentityToken'],after['ownerIdentityToken'])
        self.song.tracks[0]=copy.deepcopy(self.track)
        self.assertNotEqual(before['ownerIdentityToken'],self.read()['ownerIdentityToken'])

    def test_source_requires_stopped_known_recording_and_unfrozen_unarmed_target(self):
        for obj, field in [(self.song,'is_playing'),(self.song,'record_mode'),(self.song,'session_record'),
                           (self.song,'is_counting_in'),(self.track,'arm'),(self.track,'is_frozen'),(self.clip,'is_recording')]:
            original = getattr(obj,field)
            for value in (True,None):
                setattr(obj,field,value)
                with self.assertRaises(ValueError): self.read()
            setattr(obj,field,original)

    def test_audio_identity_or_content_changes_refuse_before_selection(self):
        for field,value in [('gain',.8),('file_path','/Other.wav'),('loop_end',16)]:
            self.setUp()
            before=self.read()
            setattr(self.clip,field,value)
            with self.assertRaises(ValueError):
                dispatch_request(self.song,{'method':'select_audio_clip_reverse_source','params':{
                    **self.ids,'before':before,'expectedStateVersion':4}},4,application=SimpleNamespace())

    def test_native_selection_targets_one_session_or_arrangement_clip_without_reversing(self):
        for arrangement in (False,True):
            self.setUp()
            if arrangement:
                self.track.clip_slots[0].has_clip=False
                self.clip.start_time,self.clip.end_time=8.,16.
                self.track.arrangement_clips=[self.clip]
                self.ids['clipId']='track-0:arrangement-clip-0'
            calls=[]
            app=SimpleNamespace(view=SimpleNamespace(show_view=lambda view:calls.append(view),focus_view=lambda view:calls.append(view)))
            before=self.read()
            result=dispatch_request(self.song,{'method':'select_audio_clip_reverse_source','params':{
                **self.ids,'before':before,'expectedStateVersion':4}},4,application=app)
            self.assertIs(self.song.view.detail_clip,self.clip)
            self.assertEqual(result['source']['audio']['source']['path'],'/Samples/Source.wav')
            self.assertEqual(result['stateVersion'],5)
            self.assertIn('Detail/Clip',calls)

    def test_duplicate_names_and_pending_launches_refuse(self):
        self.track.clip_slots[1].clip=copy.deepcopy(self.clip)
        self.track.clip_slots[1].has_clip=True
        with self.assertRaises(ValueError):self.read()
        self.track.clip_slots[1].has_clip=False
        self.song.tracks[1].fired_slot_index=0
        with self.assertRaises(ValueError):self.read()

    def test_group_tracks_do_not_require_unsupported_arrangement_inventory(self):
        class Group:
            is_foldable=True
            fired_slot_index=-1
            clip_slots=[]
            @property
            def arrangement_clips(self):raise RuntimeError('Group has no arrangement clips')
        self.song.tracks.append(Group())
        self.assertEqual(self.read()['clipId'],'track-0:clip-0')

    def test_adaptive_editor_grid_is_not_audio_reversal_content(self):
        before=self.read()
        self.clip.view.grid_quantization=10
        self.assertEqual(self.read(),before)

    def test_arrangement_replacement_requires_stable_interval_and_neighbor_objects(self):
        self.track.clip_slots[0].has_clip=False
        self.clip.start_time,self.clip.end_time=0.,8.
        neighbor=copy.deepcopy(self.clip)
        neighbor.name='Other material'
        neighbor.start_time,neighbor.end_time=8.,16.
        self.track.arrangement_clips=[self.clip,neighbor]
        self.ids['clipId']='track-0:arrangement-clip-0'
        before=self.read()
        self.track.arrangement_clips[0]=copy.deepcopy(self.clip)
        after=self.read()
        self.assertNotEqual(after['identityToken'],before['identityToken'])
        self.assertEqual(after['ownerIdentityToken'],before['ownerIdentityToken'])
        self.track.arrangement_clips[1]=copy.deepcopy(neighbor)
        changed=self.read()
        self.assertNotEqual(changed['ownerIdentityToken'],after['ownerIdentityToken'])
        self.track.arrangement_clips[0].end_time=7.
        self.assertNotEqual(self.read()['ownerIdentityToken'],changed['ownerIdentityToken'])


if __name__=='__main__':unittest.main()
