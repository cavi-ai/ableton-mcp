import os

from _Framework.ControlSurface import ControlSurface
from .bridge import SocketBridge


class CaviMcpBridge(ControlSurface):
    def __init__(self, c_instance):
        super().__init__(c_instance)
        socket_path = os.environ.get("ABLETON_MCP_BRIDGE_SOCKET", "/tmp/cavi-ableton-mcp.sock")
        self._bridge = SocketBridge(self, socket_path)
        self._bridge.start()

    def update_display(self):
        super().update_display()
        # Live invokes this on its main thread. Drain each display tick without
        # an additional scheduled delay; socket threads only enqueue requests.
        bridge = getattr(self, "_bridge", None)
        if bridge is not None:
            bridge.drain()

    def disconnect(self):
        self._bridge.stop()
        self._bridge = None
        super().disconnect()


def create_instance(c_instance):
    return CaviMcpBridge(c_instance)
