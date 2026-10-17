import copy
import unittest
import test_track_grouping as grouping_tests
from test_dispatch import Track, Device
import track_grouping as grouping


class UngroupingTests(unittest.TestCase):
    def setUp(self):
        fixture = grouping_tests.GroupingTests()
        fixture.setUp()
        self.song = fixture.song
        for owner in [*self.song.return_tracks, self.song.master_track]:
            if not hasattr(owner, 'devices'):
                owner.devices = []
        self.group = fixture.group()
        self.group_id = 'track-0'

    def source(self):
        return grouping.ungroup_source(self.song, {'groupTrackId': self.group_id}, 3)

    def status(self, source):
        return grouping.ungroup_status(self.song, {'ungroupingId': source['ungroupingId']}, 4)

    def remove_group(self):
        parent = self.group.group_track if self.group.is_grouped else None
        for track in self.song.tracks:
            if track.is_grouped and track.group_track == self.group:
                track.is_grouped, track.group_track = parent is not None, parent
                if track.current_output_routing == 'Group':
                    track.current_output_routing = 'Group' if parent is not None else 'Main'
                    track.current_output_sub_routing = ''
        self.song.tracks.remove(self.group)

    def test_plan_is_inert_and_retained_handle_verifies_original_children(self):
        source = self.source()
        self.assertEqual(source, self.source())
        self.assertEqual(self.status(source)['status'], 'unchanged')
        self.remove_group()
        result = self.status(source)
        self.assertTrue(result['ungroupVerified'])
        self.assertTrue(result['groupRemoved'])
        self.assertEqual([m['sourceTrackId'] for m in result['members']], ['track-1', 'track-2'])
        self.assertEqual([m['trackId'] for m in result['members']], ['track-0', 'track-1'])
        self.assertEqual(self.song.undo_boundaries, [])

    def test_nested_children_are_promoted_to_the_same_retained_outer_group(self):
        outer = Track()
        outer.is_foldable, outer.is_grouped, outer.fold_state, outer.can_be_armed = True, False, 0, False
        self.song.tracks.insert(0, outer)
        self.group.is_grouped, self.group.group_track = True, outer
        self.group_id = 'track-1'
        source = self.source()
        self.remove_group()
        result = self.status(source)
        self.assertTrue(result['ungroupVerified'])
        self.assertTrue(all(m['groupTrackId'] == 'track-0' for m in result['members']))

    def test_removed_group_mix_is_bound_but_not_transferred_to_children(self):
        self.group.mixer_device.volume.value = 0.5
        self.group.current_output_routing = 'Ext. Out'
        self.song.tracks[1].current_output_routing = 'Main'
        source = self.source()
        self.assertEqual(source['removedGroup']['mixer']['volume'], 0.5)
        self.remove_group()
        self.assertTrue(self.status(source)['ungroupVerified'])

    def test_group_processing_or_child_material_edits_change_the_handle(self):
        source = self.source()
        self.group.devices = [Device()]
        changed = self.source()
        self.assertNotEqual(source['ungroupingId'], changed['ungroupingId'])
        self.assertTrue(changed['hasGroupDevices'])
        self.assertEqual(self.status(source)['status'], 'changed')
        self.song.tracks[1].clip_slots[0].clip.extended_notes[0].velocity = 31
        self.assertNotEqual(changed['ungroupingId'], self.source()['ungroupingId'])

    def test_replaced_reordered_or_edited_children_cannot_verify(self):
        for mode in ('replace', 'reorder', 'notes', 'route', 'mute'):
            self.setUp()
            source = self.source()
            self.remove_group()
            if mode == 'replace':
                self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            elif mode == 'reorder':
                self.song.tracks.reverse()
            elif mode == 'notes':
                self.song.tracks[0].clip_slots[0].clip.extended_notes[0].velocity = 1
            elif mode == 'route':
                self.song.tracks[0].current_output_routing = 'No Output'
            else:
                self.song.tracks[-1].mute = True
            result = self.status(source)
            self.assertFalse(result['ungroupVerified'])
            self.assertTrue(result['inspectionRequired'])

    def test_only_observed_index_label_transitions_are_accepted(self):
        for name, verified in (('1-Piano', True), ('Different', False)):
            self.setUp()
            self.song.tracks[1].name = '2-Piano'
            source = self.source()
            self.remove_group()
            self.song.tracks[0].name = name
            result = self.status(source)
            self.assertEqual(result['ungroupVerified'], verified)
            if verified:
                self.assertEqual(result['renumberedTrackNames'][0]['before'], '2-Piano')
                self.assertEqual(result['renumberedTrackNames'][0]['after'], '1-Piano')

    def test_stopped_saved_unarmed_unfrozen_context_and_real_group_are_required(self):
        for mode in ('ordinary', 'playing', 'recording', 'armed', 'frozen', 'unsaved'):
            self.setUp()
            if mode == 'ordinary':
                self.group.is_foldable = False
            elif mode == 'playing':
                self.song.is_playing = True
            elif mode == 'recording':
                self.song.tracks[1].clip_slots[0].clip.is_recording = True
            elif mode == 'armed':
                self.song.tracks[1].arm = True
            elif mode == 'frozen':
                self.song.tracks[1].is_frozen = True
            else:
                self.song.file_path = ''
            with self.assertRaises(ValueError):
                self.source()

    def test_external_routes_to_the_removed_bus_are_refused_before_ui(self):
        self.song.tracks[-1].current_input_routing = self.group.name
        self.song.tracks[-1].available_input_routing_types = [self.group.name]
        with self.assertRaisesRegex(ValueError, 'refer|depend'):
            self.source()

    def test_changed_saved_path_return_or_scene_context_never_verifies(self):
        for mode in ('path', 'return', 'scene'):
            self.setUp()
            source = self.source()
            self.remove_group()
            if mode == 'path':
                self.song.file_path = '/sets/Other.als'
            elif mode == 'return':
                self.song.return_tracks[0] = copy.deepcopy(self.song.return_tracks[0])
            else:
                self.song.scenes[0] = copy.deepcopy(self.song.scenes[0])
            self.assertFalse(self.status(source)['ungroupVerified'])

    def test_return_routing_and_sidechain_dependencies_are_refused(self):
        for mode in ('return', 'sidechain'):
            self.setUp()
            if mode == 'return':
                owner = self.song.return_tracks[0]
                owner.current_output_routing = self.group.name
                owner.available_output_routing_types = [self.group.name]
                owner.current_output_sub_routing = ''
                owner.available_output_routing_channels = ['']
            else:
                device = self.song.tracks[1].devices[0]
                device.input_routing_type, device.input_routing_channel = self.group.name, 'Post Mixer'
            with self.assertRaisesRegex(ValueError, 'refer|depend'):
                self.source()

    def test_unrelated_sidechain_changes_are_detected_after_removal(self):
        device = self.song.tracks[1].devices[0]
        device.input_routing_type, device.input_routing_channel = 'External source', 'Post Mixer'
        source = self.source()
        self.remove_group()
        device.input_routing_type = 'Other source'
        self.assertFalse(self.status(source)['ungroupVerified'])

    def test_hidden_nested_group_requires_explicit_ancestor_disclosure(self):
        outer = Track()
        outer.is_foldable, outer.is_grouped, outer.fold_state, outer.can_be_armed = True, False, 1, False
        self.song.tracks.insert(0, outer)
        self.group.is_grouped, self.group.group_track = True, outer
        self.group_id = 'track-1'
        with self.assertRaisesRegex(ValueError, 'unfold'):
            self.source()

    def test_group_arrangement_getters_are_not_supported_native_evidence(self):
        class NativeGroup(Track):
            @property
            def arrangement_clips(self):
                raise RuntimeError('Group Tracks do not expose Arrangement clips')
        for nested in (False, True):
            self.setUp()
            self.group.__class__ = NativeGroup
            if nested:
                inner = copy.deepcopy(self.group)
                inner.name, inner.is_grouped, inner.group_track = 'Inner', True, self.group
                for child in self.song.tracks[1:3]:
                    child.group_track = inner
                self.song.tracks.insert(1, inner)
            source = self.source()
            self.remove_group()
            self.assertTrue(self.status(source)['ungroupVerified'])


if __name__ == '__main__':
    unittest.main()
