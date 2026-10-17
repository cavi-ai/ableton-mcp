import copy
import os
import sys
import unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from test_dispatch import Song, Track, ClipSlot, MidiNote
import track_grouping


class GroupingTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.song.tracks.append(Track())
        self.song.tracks[-1].clip_slots = [ClipSlot(False), ClipSlot(False)]
        self.song.tracks[0].clip_slots[0].clip.extended_notes = [MidiNote()]
        for i, track in enumerate(self.song.tracks):
            track.has_audio_output = True
            track.is_grouped = False
            track.is_foldable = False
            track.current_output_sub_routing = ''
            track.available_output_routing_channels = ['']
            track.name = 'Part ' + str(i)
            track.group_track = self.song.tracks[2]
        self.ids = ['track-0', 'track-1']

    def source(self):
        return track_grouping.source(self.song, {'trackIds': self.ids}, 3)

    def status(self, source):
        return track_grouping.status(self.song, {'groupingId': source['groupingId']}, 3)

    def group(self, extra=False):
        group = Track()
        group.name, group.is_foldable, group.is_grouped = 'Group', True, False
        group.can_be_armed, group.fold_state = False, 0
        group.devices, group.clip_slots = [], [ClipSlot(False), ClipSlot(False)]
        group.has_midi_input, group.has_audio_input = False, True
        group.current_output_sub_routing, group.available_output_routing_channels = '', ['']
        members = self.song.tracks[:3 if extra else 2]
        self.song.tracks.insert(0, group)
        for t in members:
            t.is_grouped, t.group_track = True, group
            t.current_output_routing = 'Group'
            t.current_output_sub_routing = ''
            t.available_output_routing_types = ['Main', 'Group']
        return group

    def test_plan_is_inert_and_retained_handle_resolves_actual_group_and_shifted_members(self):
        before = self.source()
        self.assertEqual(before, self.source())
        self.assertEqual(self.status(before)['status'], 'unchanged')
        self.group()
        result = self.status(before)
        self.assertTrue(result['groupVerified'])
        self.assertTrue(result['materialPreserved'])
        self.assertEqual(result['group']['id'], 'track-0')
        self.assertEqual([t['trackId'] for t in result['members']], ['track-1', 'track-2'])
        self.assertEqual([t['sourceTrackId'] for t in result['members']], self.ids)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_same_version_material_edits_and_replaced_native_objects_change_the_plan_handle(self):
        before = self.source()
        self.song.tracks[0].clip_slots[0].clip.extended_notes[0].velocity = 80
        changed = self.source()
        self.assertNotEqual(before['groupingId'], changed['groupingId'])
        self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
        self.assertNotEqual(changed['groupingId'], self.source()['groupingId'])

    def test_exact_contiguous_unarmed_ungrouped_audio_producing_tracks_on_main_are_required(self):
        for ids in ([], ['track-0'], ['track-0', 'track-0'], ['track-00','track-1'], ['track-1','track-0'], ['track-0','track-2']):
            self.ids = ids
            with self.assertRaises(ValueError):
                self.source()
        for field, value in (('arm', True), ('is_frozen', True), ('is_grouped', True), ('is_foldable', True), ('has_audio_output', False), ('current_output_routing', 'No Output')):
            self.setUp()
            setattr(self.song.tracks[0], field, value)
            with self.assertRaises(ValueError):
                self.source()

    def test_active_transport_recording_pending_launches_and_unsaved_sets_are_refused(self):
        for obj, field, value in ((self.song,'is_playing',True),(self.song,'record_mode',True),(self.song,'session_record',True),(self.song,'file_path',''),(self.song.tracks[2],'fired_slot_index',0)):
            previous = getattr(obj, field)
            setattr(obj, field, value)
            with self.assertRaises(ValueError):
                self.source()
            setattr(obj, field, previous)

    def test_wrong_membership_reordering_or_replacement_never_verifies(self):
        for mode in ('extra', 'reordered', 'replacement'):
            self.setUp()
            before = self.source()
            self.group(extra=mode == 'extra')
            if mode == 'reordered':
                self.song.tracks[1:3] = reversed(self.song.tracks[1:3])
            if mode == 'replacement':
                self.song.tracks[1] = copy.deepcopy(self.song.tracks[1])
            result = self.status(before)
            self.assertFalse(result['groupVerified'])
            self.assertTrue(result['inspectionRequired'])

    def test_changed_notes_mixer_or_routing_are_reported_after_native_grouping(self):
        for mode in ('notes', 'mixer', 'routing'):
            self.setUp()
            before = self.source()
            self.group()
            if mode == 'notes':
                self.song.tracks[1].clip_slots[0].clip.extended_notes[0].velocity = 3
            elif mode == 'mixer':
                self.song.tracks[-1].mute = True
            else:
                self.song.tracks[1].current_output_routing = 'Main'
            result = self.status(before)
            self.assertFalse(result['groupVerified'])
            self.assertTrue(result['inspectionRequired'])

    def test_old_handle_does_not_describe_another_set_or_unknown_operation(self):
        before = self.source()
        with self.assertRaises(ValueError):
            track_grouping.status(Song(), {'groupingId': before['groupingId']}, 3)
        with self.assertRaises(ValueError):
            track_grouping.status(self.song, {'groupingId': 'missing'}, 3)

    def test_rerouting_without_grouping_cannot_be_reported_as_unchanged(self):
        before = self.source()
        self.song.tracks[0].current_output_routing = 'No Output'
        result = self.status(before)
        self.assertEqual(result['status'], 'changed')
        self.assertTrue(result['inspectionRequired'])
        self.assertFalse(result['sourceOutputsPreserved'])
        self.assertFalse(result['controlsPreserved'])

    def test_changed_saved_path_or_replaced_return_context_cannot_verify(self):
        for mode in ('path', 'return'):
            self.setUp()
            before = self.source()
            self.group()
            if mode == 'path':
                self.song.file_path = '/tmp/Another.als'
            else:
                self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
            result = self.status(before)
            self.assertFalse(result['groupVerified'])
            self.assertTrue(result['inspectionRequired'])

    def test_actual_target_recording_and_post_group_freeze_are_not_silently_accepted(self):
        self.song.tracks[0].clip_slots[0].clip.is_recording = True
        with self.assertRaises(ValueError):
            self.source()
        self.setUp()
        before = self.source()
        self.group()
        self.song.tracks[1].is_frozen = True
        self.assertFalse(self.status(before)['groupVerified'])

    def test_id_like_clip_names_are_not_normalized_as_owner_ids(self):
        self.song.tracks[0].clip_slots[0].clip.name = 'track-0:Part'
        before = self.source()
        self.group()
        self.song.tracks[1].clip_slots[0].clip.name = 'track-1:Part'
        result = self.status(before)
        self.assertFalse(result['groupVerified'])
        self.assertFalse(result['materialPreserved'])

    def test_only_exact_retained_numbered_group_name_transitions_are_accepted(self):
        for name, mute, verified in (('4-Group', False, True), ('5-Group', False, False), ('4-Group', True, False)):
            self.setUp()
            existing = self.song.tracks[2]
            existing.is_foldable, existing.name = True, '3-Group'
            existing.fold_state = 0
            before = self.source()
            self.group()
            existing.name, existing.mute = name, mute
            result = self.status(before)
            self.assertEqual(result['groupVerified'], verified)
            if verified:
                self.assertEqual(result['renumberedGroupNames'], [{'sourceTrackId': 'track-2', 'trackId': 'track-3',
                                                                 'before': '3-Group', 'after': '4-Group'}])

    def test_numbered_target_names_remain_literal(self):
        self.song.tracks[0].name = '1-Group'
        before = self.source()
        self.group()
        self.song.tracks[1].name = '2-Group'
        self.assertFalse(self.status(before)['groupVerified'])


if __name__ == '__main__':
    unittest.main()
