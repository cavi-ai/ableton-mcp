"""Exercise queued connections through the production Unix listener."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import SocketBridge
from protocol import encode_message
from test_dispatch import Song


class SocketListenerTests(unittest.TestCase):
    def test_context_reads_connect_during_a_brief_listener_delay(self):
        original_socket = socket.socket
        listening, accept_ready = threading.Event(), threading.Event()

        class DelayedListener(original_socket):
            def listen(self, backlog):
                super().listen(backlog)
                listening.set()

            def accept(self):
                if not accept_ready.wait(3):
                    raise socket.timeout()
                return super().accept()

        class Surface:
            def __init__(self):
                self.document = Song()

            def song(self):
                return self.document

            def application(self):
                return None

        def receive(client):
            data = b""
            while b"\n" not in data:
                chunk = client.recv(65536)
                self.assertTrue(chunk, "connection closed before its response")
                data += chunk
            return json.loads(data)

        with tempfile.TemporaryDirectory(prefix="ab-listen-") as directory:
            path = os.path.join(directory, "b.sock")
            bridge = SocketBridge(Surface(), path)
            clients = []
            try:
                with patch("bridge.socket.socket", DelayedListener):
                    bridge.start()
                    self.assertTrue(listening.wait(2))
                    # Concurrent MCP calls can arrive before the accept thread
                    # runs again. Keep this deterministic instead of racing it.
                    for _ in range(8):
                        client = original_socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        clients.append(client)
                        client.settimeout(1)
                        client.connect(path)
                    accept_ready.set()
                    for index, client in enumerate(clients):
                        client.sendall(encode_message({"id": "hello", "method": "get_bridge_protocol"}))
                        self.assertEqual(receive(client)["result"]["version"], 2)
                        client.sendall(encode_message({"id": index, "method": "get_live_state", "params": {},
                                                      "deadlineUnixMs": time.time() * 1000 + 5000}))
                    deadline = time.monotonic() + 2
                    while bridge.requests.qsize() < len(clients) and time.monotonic() < deadline:
                        time.sleep(.005)
                    self.assertEqual(bridge.requests.qsize(), len(clients))
                    bridge.drain()
                    for index, client in enumerate(clients):
                        response = receive(client)
                        self.assertEqual(response["id"], index)
                        self.assertEqual(response["result"]["tempo"], 120)
                        self.assertEqual(response["result"]["stateVersion"], 1)
            finally:
                accept_ready.set()
                for client in clients:
                    client.close()
                bridge.stop()
                bridge.thread.join(2)
                self.assertFalse(bridge.thread.is_alive())
