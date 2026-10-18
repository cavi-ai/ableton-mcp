import copy
import os
import sys
import unittest
sys.path.insert(0,os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song,Clip,AudioClip


class ClipNamesTests(unittest.TestCase):
    def setUp(self):
        self.song=Song()
        self.track=self.song.tracks[0]
        self.clip=Clip()
        self.clip.name='Idea'
        self.clip.is_audio_clip=False
        self.clip.notes=[(60,0.,1.,100,False)]
        self.clip.start_time,self.clip.end_time=16.,24.
        self.track.arrangement_clips=[self.clip]
        self.ids={'trackId':'track-0','clipId':'track-0:arrangement-clip-0'}

    def read(self):
        return dispatch_request(self.song,{'method':'get_arrangement_clip_name_context','params':self.ids},4)

    def apply(self,before=None,name='Verse'):
        return dispatch_request(self.song,{'method':'rename_arrangement_clip','params':{
            **self.ids,'expectedStateVersion':4,'before':before or self.read(),'name':name}},4)

    def test_context_is_inert_and_rename_preserves_playback_selection_and_midi(self):
        selection=self.song.view.selected_track
        notes=copy.deepcopy(self.clip.notes)
        self.song.is_playing=True
        before=self.read()
        self.assertEqual(before,self.read())
        self.assertEqual(self.song.undo_boundaries,[])
        result=self.apply(before,'Verse — piano')
        self.assertTrue(result['verified'])
        self.assertTrue(result['targetRetained'])
        self.assertEqual(result['observed']['clip']['name'],'Verse — piano')
        self.assertEqual(self.clip.notes,notes)
        self.assertTrue(self.song.is_playing)
        self.assertIs(self.song.view.selected_track,selection)
        self.assertEqual((self.clip.start_time,self.clip.end_time),(16.,24.))

    def test_same_version_name_interval_or_object_replacement_refuses(self):
        for change in ('name','interval','clip','track'):
            self.setUp()
            before=self.read()
            if change=='name':self.clip.name='Manual choice'
            elif change=='interval':self.clip.start_time=17.
            elif change=='clip':self.track.arrangement_clips[0]=copy.deepcopy(self.clip)
            else:self.song.tracks[0]=copy.deepcopy(self.track)
            with self.assertRaises(ValueError):self.apply(before)
            self.assertEqual(self.song.undo_boundaries,[])

    def test_undo_entry_race_refuses_without_renaming_replacement(self):
        before=self.read()
        self.song.begin_undo_step=lambda:setattr(self.track,'arrangement_clips',[copy.deepcopy(self.clip)])
        with self.assertRaises(ValueError):self.apply(before)
        self.assertEqual(self.clip.name,'Idea')
        self.assertEqual(self.track.arrangement_clips[0].name,'Idea')

    def test_noop_requests_no_write_or_undo_step(self):
        result=self.apply(name='Idea')
        self.assertTrue(result['verified'])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(self.song.undo_boundaries,[])

    def test_finalization_failure_retains_actual_name_and_reports_unverified(self):
        self.song.end_undo_step=lambda:(_ for _ in ()).throw(RuntimeError('end failed'))
        result=self.apply()
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertEqual(result['observed']['clip']['name'],'Verse')
        self.assertIn('end failed',result['error'])

    def test_invalid_names_and_non_arrangement_targets_refuse(self):
        for name in ('','   ','line\nbreak','x'*129):
            with self.assertRaises(ValueError):self.apply(name=name)
        self.ids['clipId']='track-0:clip-0'
        with self.assertRaises(ValueError):self.read()

    def test_audio_source_and_duplicate_names_are_preserved(self):
        self.clip=AudioClip()
        self.clip.file_path='/Samples/Original.wav'
        self.clip.name='Same'
        self.clip.start_time,self.clip.end_time=16.,24.
        neighbor=copy.deepcopy(self.clip)
        neighbor.start_time,neighbor.end_time=32.,40.
        self.track.arrangement_clips=[self.clip,neighbor]
        result=self.apply(name='Reversed alternative')
        self.assertTrue(result['verified'])
        self.assertEqual(neighbor.name,'Same')
        self.assertEqual(self.clip.file_path,'/Samples/Original.wav')


if __name__=='__main__':unittest.main()
