import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import dispatch_request
from test_dispatch import Song


class SessionNamesTests(unittest.TestCase):
    def configure(self, kind):
        self.song = Song()
        self.kind = kind
        self.collection = {"track":"tracks", "return":"return_tracks", "scene":"scenes"}[kind]
        self.owner = getattr(self.song, self.collection)[0]
        self.ids = {"targetType":kind, "targetId":kind+"-0"}

    def read(self):
        return dispatch_request(self.song, {"method":"get_session_object_name_context", "params":self.ids}, 4)

    def rename(self, before=None, name="Verse — layer"):
        before = self.read() if before is None else before
        return dispatch_request(self.song, {"method":"rename_session_object", "params":{
            "expectedStateVersion":4,"before":before,
            "target":{**self.ids,"previousName":before["object"]["name"],"name":name}}}, 4)

    def test_all_label_types_bind_native_identity_and_preserve_playback_and_focus(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            self.song.is_playing = True
            selection = self.song.view.selected_track
            before = self.read()
            self.assertEqual(before, self.read())
            self.assertEqual(self.song.undo_boundaries, [])
            result = self.rename(before)
            self.assertTrue(result["verified"], result)
            self.assertTrue(result["targetRetained"])
            self.assertEqual(result["target"]["name"], "Verse — layer")
            self.assertEqual(result["observed"]["object"]["name"], self.owner.name)
            self.assertTrue(self.song.is_playing)
            self.assertIs(self.song.view.selected_track, selection)
            self.assertEqual(self.song.undo_boundaries, ["begin", "end"])

    def test_same_version_rename_replacement_and_reorder_refuse_without_writes(self):
        for kind in ("track", "return", "scene"):
            for change in ("name", "object", "layout"):
                self.configure(kind)
                before = self.read()
                items = getattr(self.song, self.collection)
                if change == "name": self.owner.name = "Manual label"
                elif change == "object": items[0] = copy.deepcopy(self.owner)
                elif len(items)>1: items.reverse()
                else: items.append(copy.deepcopy(self.owner))
                with self.assertRaises(ValueError): self.rename(before)
                self.assertEqual(self.song.undo_boundaries, [])

    def test_undo_entry_replacement_prevents_name_write(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            before = self.read()
            def replace(): getattr(self.song, self.collection)[0] = copy.deepcopy(self.owner)
            self.song.begin_undo_step = replace
            with self.assertRaises(ValueError): self.rename(before)
            self.assertEqual(self.owner.name, before["object"]["name"])
            self.assertEqual(getattr(self.song, self.collection)[0].name, before["object"]["name"])

    def test_noop_has_no_write_or_undo_step(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            result = self.rename(name=self.owner.name)
            self.assertTrue(result["verified"])
            self.assertFalse(result["writeRequested"])
            self.assertFalse(result["nativeReturned"])
            self.assertEqual(self.song.undo_boundaries, [])

    def test_finalization_error_retains_actual_name_without_success_descriptor(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            def fail(): raise RuntimeError("undo end failed")
            self.song.end_undo_step = fail
            result = self.rename()
            self.assertTrue(result["nativeReturned"])
            self.assertFalse(result["verified"])
            self.assertEqual(result["observed"]["object"]["name"], "Verse — layer")
            self.assertIn("undo end failed", result["error"])
            self.assertNotIn("target", result)

    def test_recording_and_automation_progress_are_not_label_context(self):
        self.configure("track")
        self.owner.is_foldable = True
        before = self.read()
        self.song.record_mode = True
        self.song.is_playing = True
        self.song.tempo = 127
        self.owner.mixer_device.volume.value = .8
        self.owner.is_frozen = True
        self.assertTrue(self.rename(before)["verified"])
        self.assertTrue(self.song.record_mode)
        self.assertEqual(self.owner.mixer_device.volume.value, .8)

    def test_invalid_names_ids_bounds_and_unguarded_requests_refuse(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            for name in ("", "  ", "x"*256):
                with self.assertRaises(ValueError): self.rename(name=name)
            result = self.rename(name="x"*255)
            self.assertTrue(result["verified"])
            self.ids["targetId"] = kind+"-00"
            with self.assertRaises(ValueError): self.read()
            self.configure(kind)
            with self.assertRaises(ValueError):
                dispatch_request(self.song, {"method":"rename_session_object","params":{"target":{
                    **self.ids,"previousName":self.owner.name,"name":"Unbound"}}}, 4)
            getattr(self.song, self.collection).extend([self.owner]*(4097 if kind=="scene" else 257))
            with self.assertRaises(ValueError): self.read()

    def test_lost_owner_after_write_is_not_verified(self):
        for kind in ("track", "return", "scene"):
            self.configure(kind)
            def replace(): getattr(self.song, self.collection)[0] = copy.deepcopy(self.owner)
            self.song.end_undo_step = replace
            result = self.rename()
            self.assertFalse(result["verified"])
            self.assertFalse(result["targetRetained"])
            self.assertNotIn("target", result)

    def test_setter_failure_before_or_after_application_retains_actual_label_once(self):
        for kind in ("track", "return", "scene"):
            for after in (False, True):
                self.configure(kind)
                class Uncertain(type(self.owner)):
                    @property
                    def name(item): return item.label
                    @name.setter
                    def name(item, value):
                        item.calls += 1
                        if after: item.label = value
                        raise RuntimeError("setter failed")
                uncertain = Uncertain.__new__(Uncertain)
                uncertain.__dict__.update(self.owner.__dict__)
                uncertain.label, uncertain.calls = self.owner.name, 0
                getattr(self.song, self.collection)[0] = uncertain
                previous = uncertain.label
                result = self.rename()
                self.assertTrue(result["writeRequested"])
                self.assertFalse(result["nativeReturned"])
                self.assertFalse(result["verified"])
                self.assertEqual(result["observed"]["object"]["name"], "Verse — layer" if after else previous)
                self.assertEqual(uncertain.calls, 1)
                self.assertNotIn("target", result)

    def test_return_display_prefix_is_verified_and_raw_label_noop_is_inert(self):
        self.configure("return")
        class Prefixed(type(self.owner)):
            @property
            def name(item): return "A-"+item.raw
            @name.setter
            def name(item, value):
                item.calls += 1
                item.raw = value
        owner = Prefixed.__new__(Prefixed)
        owner.raw, owner.calls = "Reverb", 0
        self.song.return_tracks[0] = owner
        result = self.rename(name="Short Verb")
        self.assertTrue(result["verified"], result)
        self.assertEqual(result["target"]["name"], "A-Short Verb")
        self.assertEqual(result["observed"]["object"]["rawName"], "Short Verb")
        noop = self.rename(name="Short Verb")
        self.assertTrue(noop["verified"])
        self.assertFalse(noop["writeRequested"])
        self.assertEqual(owner.calls, 1)


if __name__ == "__main__": unittest.main()
