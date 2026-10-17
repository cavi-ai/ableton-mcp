import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song, Application


class BrowserPreviewTests(unittest.TestCase):
    def setUp(self):
        self.song, self.app = Song(), Application()
        self.song.is_counting_in = False
        self.calls = []
        self.app.browser.preview_item = lambda item: self.calls.append(('start', item.name))
        self.app.browser.stop_preview = lambda: self.calls.append(('stop',))
        self.target = {'root': 'user_library', 'path': ['Drift']}

    def read(self, target=None):
        return dispatch_request(self.song, {'method': 'get_browser_preview_context', 'params': target or {}}, 3, self.app)

    def apply(self, action, before, target=None):
        return dispatch_request(self.song, {'method': 'set_browser_preview', 'params': {
            'action': action, 'before': before, **(target or {})}}, 3, self.app)

    def test_context_and_start_do_not_load_or_edit_the_document(self):
        before = self.read(self.target)
        self.assertEqual(self.calls, [])
        self.assertTrue(before['previewSupported'])
        self.assertFalse(before['previewStateObserved'])
        selected = self.song.view.selected_track
        result = self.apply('start', before, self.target)
        self.assertEqual(self.calls, [('start', 'Drift')])
        self.assertTrue(result['nativeReturned'])
        self.assertTrue(result['contextPreserved'])
        self.assertFalse(result['previewVerified'])
        self.assertFalse(result['audibleOutputVerified'])
        self.assertEqual(self.app.loaded, [])
        self.assertIs(self.song.view.selected_track, selected)
        self.assertEqual(self.song.undo_boundaries, [])

    def test_stop_is_explicitly_global_and_remains_available_while_recording(self):
        self.song.record_mode = True
        result = self.apply('stop', self.read())
        self.assertEqual(self.calls, [('stop',)])
        self.assertTrue(result['nativeReturned'])
        self.assertTrue(result['globalPreviewAffected'])
        self.assertFalse(result['previewVerified'])

    def test_manual_topology_selection_and_item_changes_refuse_at_same_version(self):
        for change in ('track', 'selection', 'item', 'recording'):
            self.setUp()
            before = self.read(self.target)
            if change == 'track': self.song.tracks[0] = copy.deepcopy(self.song.tracks[0])
            if change == 'selection': self.song.view.selected_track = self.song.tracks[1]
            if change == 'item': self.app.browser.user_library.children[0].uri = 'replacement'
            if change == 'recording': self.song.record_mode = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.apply('start', before, self.target)
            self.assertEqual(self.calls, [])

    def test_recreated_browser_wrappers_with_identical_metadata_remain_usable(self):
        before = self.read(self.target)
        self.app.browser.user_library = copy.deepcopy(self.app.browser.user_library)
        self.assertTrue(self.apply('start', before, self.target)['nativeReturned'])

    def test_browser_refresh_cannot_substitute_an_unconfirmed_item_at_dispatch(self):
        before = self.read(self.target)
        original = self.app.browser.user_library.children[0]
        replacement = copy.deepcopy(original)
        replacement.uri = 'replacement-uri'

        class RefreshingRoot:
            reads = 0

            @property
            def children(self):
                self.reads += 1
                return [original] if self.reads == 1 else [replacement]

        self.app.browser.user_library = RefreshingRoot()
        with self.assertRaisesRegex(ValueError, 'item changed'):
            self.apply('start', before, self.target)
        self.assertEqual(self.calls, [])

    def test_unsupported_api_folder_recording_and_invalid_scope_refuse_without_preview(self):
        for change in ('unsupported', 'stop unsupported', 'folder', 'record', 'count-in'):
            self.setUp()
            if change == 'unsupported': self.app.browser.preview_item = None
            if change == 'stop unsupported': self.app.browser.stop_preview = None
            if change == 'folder': self.app.browser.user_library.children[0].is_folder = True
            if change == 'record': self.song.record_mode = True
            if change == 'count-in': self.song.is_counting_in = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.apply('start', self.read(self.target), self.target)
            self.assertEqual(self.calls, [])
        for target in ({'root': 'user_library'}, {'path': ['Drift']}, {'root': 'user_library', 'path': []}):
            with self.subTest(target=target), self.assertRaises(ValueError): self.read(target)

    def test_native_error_is_retained_without_retry_or_false_audio_verification(self):
        def fail(item):
            self.calls.append(('attempt',))
            raise RuntimeError('native preview error')
        self.app.browser.preview_item = fail
        result = self.apply('start', self.read(self.target), self.target)
        self.assertEqual(self.calls, [('attempt',)])
        self.assertFalse(result['nativeReturned'])
        self.assertIn('native preview error', result['error'])
        self.assertFalse(result['previewVerified'])

    def test_playing_clock_is_not_bound_but_playback_state_is(self):
        self.song.is_playing = True
        before = self.read(self.target)
        self.song.current_song_time += 4
        self.assertTrue(self.apply('start', before, self.target)['nativeReturned'])
        before = self.read(self.target)
        self.song.is_playing = False
        with self.assertRaises(ValueError): self.apply('start', before, self.target)


if __name__ == '__main__': unittest.main()
