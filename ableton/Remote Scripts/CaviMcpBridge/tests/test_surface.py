import importlib.util
import os
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch


class SurfaceSchedulingTests(unittest.TestCase):
    def setUp(self):
        events = self.events = []

        class ControlSurface:
            def __init__(self, c_instance):
                self._song = types.SimpleNamespace(tracks=[], scenes=[])
                self.guard_active = False
                self.update_display()

            def update_display(self):
                events.append("display")

            def schedule_message(self, ticks, callback):
                pass

            @contextmanager
            def component_guard(self):
                self.guard_active = True
                try:
                    yield
                finally:
                    self.guard_active = False

            def song(self):
                return self._song

            def application(self):
                return None

            def disconnect(self):
                events.append("disconnect")

        framework = types.ModuleType("_Framework")
        base = types.ModuleType("_Framework.ControlSurface")
        base.ControlSurface = ControlSurface
        directory = os.path.dirname(os.path.dirname(__file__))
        spec = importlib.util.spec_from_file_location("_cavi_surface_test",
            os.path.join(directory, "__init__.py"), submodule_search_locations=[directory])
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"_Framework": framework, "_Framework.ControlSurface": base,
                                    "_cavi_surface_test": module}):
            spec.loader.exec_module(module)
            self.bridge_module = sys.modules[module.SocketBridge.__module__]
        self.module = module
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        socket_path = os.path.join(directory.name, "bridge.sock")
        with patch.object(module.SocketBridge, "start"), patch.dict(os.environ,
                {"ABLETON_MCP_BRIDGE_SOCKET": socket_path}):
            self.surface = module.CaviMcpBridge(None)
        self.events.clear()

    def test_first_display_callback_drains_pending_reads_after_framework_update(self):
        responses = []
        client = types.SimpleNamespace(sendall=responses.append)
        for index, method in enumerate(["get_live_state", "get_transport_context"]):
            self.surface._bridge.requests.put((client, {"id": str(index), "method": method}))

        def dispatch(song, request, state_version, application):
            self.assertTrue(self.surface.guard_active)
            self.events.append(request["method"])
            return {"stateVersion": state_version}

        with patch.object(self.bridge_module, "dispatch_request", dispatch):
            self.surface.update_display()
            self.surface.update_display()
        self.assertEqual(self.events, ["display", "get_live_state", "get_transport_context", "display"])
        self.assertEqual(len(responses), 2)
        self.assertTrue(self.surface._bridge.requests.empty())
        self.assertFalse(self.surface.guard_active)

    def test_disconnect_stops_bridge_and_later_display_callbacks_do_not_drain(self):
        bridge = self.surface._bridge
        responses = []
        client = types.SimpleNamespace(sendall=responses.append)
        self.surface.disconnect()
        bridge.requests.put((client, {"id": "late", "method": "get_live_state"}))
        self.surface.update_display()
        self.assertTrue(bridge.stopped.is_set())
        self.assertEqual(responses, [])
        self.assertEqual(self.events, ["disconnect", "display"])


if __name__ == "__main__":
    unittest.main()
