import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request, SocketBridge
from test_dispatch import Song, Track, prepare_loop_target


class TrackArmingTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        prepare_loop_target(self.song)
        self.song.record_mode = self.song.session_record = False
        for track in self.song.tracks:
            track.can_be_armed = True
            track.implicit_arm = track.is_foldable = False
            track.arrangement_clips = []
            for slot in track.clip_slots:
                slot.is_triggered = False
                if slot.has_clip:
                    slot.clip.is_recording = slot.clip.is_overdubbing = slot.clip.is_triggered = False
        self.ids = {'trackId': 'track-0'}

    def read(self):
        return dispatch_request(self.song, {'method':'get_track_arm_context', 'params':self.ids}, 4)

    def plan(self, armed=True):
        return {**self.ids, 'expectedStateVersion':4, 'armed':armed, 'before':self.read()}

    def change(self, plan):
        return dispatch_request(self.song, {'method':'arm_track', 'params':plan}, 4)

    def test_read_reports_readiness_without_writes_and_arming_preserves_other_arms(self):
        self.song.tracks[1].arm = True
        before = self.read()
        self.assertTrue(before['readyToChange'])
        self.assertEqual(self.song.undo_boundaries, [])
        result = self.change(self.plan())
        self.assertTrue(result['verified'])
        self.assertTrue(result['otherArmsPreserved'])
        self.assertTrue(result['armed'])
        self.assertTrue(self.song.tracks[1].arm)
        self.assertTrue(self.change(self.plan(False))['verified'])
        self.assertFalse(self.song.tracks[0].arm)
        self.assertTrue(self.song.tracks[1].arm)

    def test_playing_clock_advances_without_invalidating_arming(self):
        self.song.is_playing = True
        plan = self.plan()
        self.song.current_song_time += 8
        self.assertTrue(self.change(plan)['verified'])
        self.assertTrue(self.song.is_playing)

    def test_equal_replacement_and_same_version_manual_changes_refuse(self):
        for field in ('replacement', 'routing', 'monitoring', 'otherArm', 'playback'):
            self.setUp(); plan = self.plan()
            if field == 'replacement': self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            elif field == 'routing': self.song.tracks[0].current_input_routing = 'No Input'
            elif field == 'monitoring': self.song.tracks[0].current_monitoring_state = 2
            elif field == 'otherArm': self.song.tracks[1].arm = True
            else: self.song.is_playing = not self.song.is_playing
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'changed|context'):
                self.change(plan)
            self.assertFalse(self.song.tracks[0].arm)
            self.assertEqual(self.song.undo_boundaries, [])

    def test_ineligible_targets_and_recording_are_explained_before_any_write(self):
        for owner, field, value in [('track','is_foldable',True), ('track','can_be_armed',False),
                ('track','is_frozen',True), ('track','implicit_arm',True), ('track','arm',None),
                ('song','record_mode',True), ('song','session_record',True), ('song','is_counting_in',True),
                ('song','record_mode',None), ('clip','is_recording',True), ('clip','is_overdubbing',True),
                ('track','fired_slot_index',0), ('slot','is_triggered',True)]:
            self.setUp()
            track = self.song.tracks[0]
            objects = {'song':self.song,'track':track,'slot':track.clip_slots[0],'clip':track.clip_slots[0].clip}
            setattr(objects[owner],field,value)
            before = self.read()
            self.assertFalse(before['readyToChange'], (field,value))
            self.assertTrue(before['reasons'])
            with self.assertRaises(ValueError): self.change(self.plan())
            self.assertEqual(self.song.undo_boundaries, [])

    def test_context_is_rechecked_inside_undo_and_noop_opens_no_undo(self):
        plan = self.plan()
        self.song.begin_undo_step = lambda: setattr(self.song.tracks[0], 'implicit_arm', True)
        with self.assertRaises(ValueError): self.change(plan)
        self.assertFalse(self.song.tracks[0].arm)
        self.setUp()
        result = self.change(self.plan(False))
        self.assertTrue(result['verified'])
        self.assertFalse(result['writeRequested'])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_setter_failure_after_applying_is_reported_without_replay(self):
        class Uncertain(Track):
            calls = 0
            @property
            def arm(track): return track.actual_arm
            @arm.setter
            def arm(track, value):
                track.calls += 1
                track.actual_arm = value
                raise RuntimeError('arm failed after applying')
        track = self.song.tracks[0]
        track.actual_arm = track.arm
        track.__class__ = Uncertain
        result = self.change(self.plan())
        self.assertTrue(result['writeRequested'])
        self.assertFalse(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertTrue(result['armed'])
        self.assertIn('after applying', result['error'])
        self.assertEqual(track.calls, 1)

    def test_ignored_setter_or_changed_other_arm_never_verifies(self):
        for side_effect in ('ignored', 'otherArm'):
            self.setUp(); song = self.song
            class Unexpected(Track):
                @property
                def arm(track): return track.actual_arm
                @arm.setter
                def arm(track, value):
                    if side_effect == 'otherArm':
                        track.actual_arm = value
                        song.tracks[1].arm = False
            track = self.song.tracks[0];track.actual_arm = False;track.__class__ = Unexpected
            self.song.tracks[1].arm = True
            result = self.change(self.plan())
            self.assertTrue(result['nativeReturned'])
            self.assertFalse(result['verified'])
            self.assertEqual(result['otherArmsPreserved'], side_effect != 'otherArm')

    def test_undo_close_failure_preserves_native_arm_fact(self):
        def fail(): raise RuntimeError('undo close failed')
        self.song.end_undo_step = fail
        result = self.change(self.plan())
        self.assertTrue(result['nativeReturned'])
        self.assertTrue(result['armed'])
        self.assertFalse(result['verified'])
        self.assertIn('undo close', result['error'])

    def test_scene_launch_pending_or_unknown_refuses_before_arming(self):
        for value in (True, None):
            self.setUp(); self.song.scenes[0].is_triggered = value
            self.assertFalse(self.read()['readyToChange'])
            with self.assertRaises(ValueError): self.change(self.plan())
            self.assertFalse(self.song.tracks[0].arm)

    def test_other_track_input_change_after_write_is_retained_and_unverified(self):
        self.song.end_undo_step = lambda: setattr(self.song.tracks[1], 'current_input_routing', 'No Input')
        result = self.change(self.plan())
        self.assertTrue(result['nativeReturned'])
        self.assertTrue(self.song.tracks[0].arm)
        self.assertFalse(result['verified'])
        self.assertFalse(result['contextPreserved'])
        self.assertEqual(self.song.tracks[1].current_input_routing, 'No Input')

    def test_deferred_completion_retains_write_facts_when_song_is_unavailable(self):
        song = self.song
        class Surface:
            available = True
            def song(surface):
                if not surface.available: raise RuntimeError('Song unavailable')
                return song
            def application(surface): return None
            def schedule_message(surface, _, callback): surface.callback = callback
        class Client:
            messages = None
            def sendall(client, data): client.messages = json.loads(data)
        surface,client = Surface(),Client();bridge = SocketBridge(surface,'/unused')
        before = dispatch_request(song,{'method':'get_track_arm_context','params':self.ids},bridge.state_version)
        bridge.requests.put((client,{'id':'arm','method':'arm_track','params':{
            **self.ids,'expectedStateVersion':bridge.state_version,'before':before,'armed':True}}))
        bridge.drain()
        self.assertIsNone(client.messages)
        self.assertTrue(song.tracks[0].arm)
        surface.available = False;surface.callback()
        result = client.messages['result']
        self.assertTrue(result['nativeReturned'])
        self.assertFalse(result['verified'])
        self.assertIsNone(result['observed'])
        self.assertIn('Song unavailable',result['observationError'])
        self.assertFalse(bridge.deferred_request)

    def test_canonical_ids_bounds_and_explicit_boolean_are_required(self):
        for track_id in ('track-00','return-0','master','track--1'):
            self.ids={'trackId':track_id}
            with self.assertRaises(ValueError): self.read()
        self.ids={'trackId':'track-0'}
        for value in (1,'false',None):
            with self.assertRaises(ValueError): self.change(self.plan(value))
        self.song.tracks *= 129
        with self.assertRaises(ValueError): self.read()


if __name__ == '__main__': unittest.main()
