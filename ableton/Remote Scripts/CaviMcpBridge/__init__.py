import os

from _Framework.ControlSurface import ControlSurface
from .bridge import SocketBridge


class CaviMcpBridge(ControlSurface):
    def __init__(self, c_instance):
        super().__init__(c_instance)
        socket_path = os.environ.get("ABLETON_MCP_BRIDGE_SOCKET", "/tmp/cavi-ableton-mcp.sock")
        self._bridge = SocketBridge(self, socket_path)
        self._bridge.start()
        self.schedule_message(1, self._drain_requests)

    def _drain_requests(self):
        self._bridge.drain()
        self.schedule_message(1, self._drain_requests)

    def disconnect(self):
        self._bridge.stop()
        super().disconnect()


def create_instance(c_instance):
    return CaviMcpBridge(c_instance)
