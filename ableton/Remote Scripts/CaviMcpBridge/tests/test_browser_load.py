import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from test_dispatch import Song, Application
from bridge import dispatch_request
import browser_load


class BrowserLoadTests(unittest.TestCase):
    def setUp(self):
        self.song, self.app = Song(), Application()
        self.params = {'trackId': 'track-0', 'root': 'user_library', 'path': ['Drift']}

    def plan(self):
        return {**self.params, 'item': dispatch_request(self.song, {'method': 'get_browser_items', 'params': self.params}, 3, self.app)['item'],
                'before': dispatch_request(self.song, {'method': 'list_devices', 'params': self.params}, 3),
                'beforeLoadContext': browser_load.context(self.song, self.app, self.params, 3)}

    def load(self, params):
        return dispatch_request(self.song, {'method': 'load_browser_item', 'params': params}, 3, self.app)

    def test_context_is_inert_and_replacement_changes_native_identity(self):
        first = browser_load.context(self.song, self.app, self.params, 3)
        self.assertEqual(browser_load.context(self.song, self.app, self.params, 3), first)
        self.assertEqual(self.app.loaded, [])
        self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
        self.assertNotEqual(browser_load.context(self.song, self.app, self.params, 3)['identityToken'], first['identityToken'])

    def test_recreated_browser_wrappers_bind_stable_metadata(self):
        first = browser_load.context(self.song, self.app, self.params, 3)
        self.app.browser.user_library = copy.deepcopy(self.app.browser.user_library)
        self.assertEqual(browser_load.context(self.song, self.app, self.params, 3), first)

    def test_inserted_track_and_its_actual_clip_are_reported_with_rebased_owner(self):
        plan, selected = self.plan(), self.song.view.selected_track
        imported = copy.deepcopy(self.song.tracks[1])
        imported.name = self.song.tracks[0].name
        imported.clip_slots[0].create_clip(8)
        self.app.browser.load_item = lambda item: self.song.tracks.insert(0, imported)
        result = self.load(plan)
        self.assertEqual(result['trackId'], 'track-1')
        self.assertEqual(result['requestedTrackId'], 'track-0')
        self.assertEqual(result['trackEffect']['kind'], 'inserted')
        self.assertEqual(result['trackEffect']['addedTracks'][0]['id'], 'track-0')
        self.assertEqual(result['trackEffect']['addedTracks'][0]['sessionClips'][0]['id'], 'track-0:clip-0')
        self.assertEqual(result['trackEffect']['survivingTracks'][0], {'previousTrackId': 'track-0', 'trackId': 'track-1'})
        self.assertEqual(result['deviceChain']['trackId'], 'track-1')
        self.assertIs(self.song.view.selected_track, selected)

    def test_multi_track_insert_does_not_infer_identity_from_names(self):
        plan = self.plan()
        imported = [copy.deepcopy(self.song.tracks[1]) for _ in range(2)]
        self.app.browser.load_item = lambda item: self.song.tracks.extend(imported)
        result = self.load(plan)
        self.assertEqual([t['id'] for t in result['trackEffect']['addedTracks']], ['track-2', 'track-3'])
        self.assertEqual(result['trackEffect']['removedTrackIds'], [])
        self.assertTrue(result['trackEffect']['oldOrderPreserved'])

    def test_stale_topology_or_item_refuses_before_native_load(self):
        for change in ('topology', 'item'):
            self.setUp()
            plan = self.plan()
            if change == 'topology':
                self.song.tracks[1] = copy.deepcopy(self.song.tracks[1])
            else:
                plan['item'] = {**plan['item'], 'uri': 'different'}
            with self.assertRaisesRegex(ValueError, 'browser|context|topology'):
                self.load(plan)
            self.assertEqual(self.app.loaded, [])

    def test_partial_native_failure_retains_created_track_and_reports_error(self):
        plan = self.plan()
        def load(item):
            self.song.tracks.append(copy.deepcopy(self.song.tracks[1]))
            raise RuntimeError('import interrupted')
        self.app.browser.load_item = load
        result = self.load(plan)
        self.assertFalse(result['nativeLoadReturned'])
        self.assertEqual(result['loadError'], 'import interrupted')
        self.assertEqual(result['trackEffect']['addedTracks'][0]['id'], 'track-2')
        self.assertEqual(len(self.song.tracks), 3)

    def test_disposed_target_does_not_hide_the_track_receipt(self):
        plan, owner = self.plan(), self.song.tracks[0]
        class Disposed(type(owner)):
            @property
            def devices(self):
                raise RuntimeError('disposed target')
        def load(item):
            self.song.tracks.remove(owner)
            owner.__class__ = Disposed
        self.app.browser.load_item = load
        result = self.load(plan)
        self.assertIsNone(result['trackId'])
        self.assertTrue(result['nativeLoadReturned'])
        self.assertEqual(result['trackEffect']['removedTrackIds'], ['track-0'])
        self.assertEqual(result['deviceChainEffect']['kind'], 'unavailable')
        self.assertIsNone(result['deviceChain'])
        self.assertIn('removed', result['targetInspectionError'])


if __name__ == '__main__':
    unittest.main()
