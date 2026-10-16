import json
import os
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from bridge import SocketBridge
from protocol import encode_message
from test_dispatch import Song


class Surface:
    def __init__(self):
        self.document = Song()
    def song(self):
        return self.document
    def application(self):
        return None
    def schedule_message(self, _, callback):
        self.callback = callback


class RequestLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.surface = Surface()
        self.bridge = SocketBridge(self.surface, "/unused")
        self.sender, receiver = socket.socketpair()
        self.sender.settimeout(1)
        self.reader = threading.Thread(target=self.bridge._read_client, args=(receiver,), daemon=True)
        self.reader.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.sender.close()
        self.reader.join(1)

    def send(self, *messages):
        self.sender.sendall(b"".join(encode_message(message) for message in messages))

    def response(self):
        data = b""
        while b"\n" not in data:
            data += self.sender.recv(65536)
        return json.loads(data.split(b"\n")[0])

    def queued(self):
        item = self.bridge.requests.get(timeout=1)
        self.bridge.requests.put(item)
        return item

    def mutation(self, **extra):
        return {"id": "tempo", "method": "set_tempo", "params": {"tempo": 130},
                "deadlineUnixMs": time.time() * 1000 + 5000, **extra}

    def test_protocol_handshake_does_not_wait_for_the_live_thread(self):
        self.send({"id": "hello", "method": "get_bridge_protocol"})
        result = self.response()["result"]
        self.assertEqual(result["version"], 2)
        self.assertTrue(result["requestDeadlines"])
        self.assertTrue(result["requestCancellation"])
        self.assertTrue(self.bridge.requests.empty())

    def test_expired_native_request_never_changes_tempo(self):
        self.send(self.mutation(deadlineUnixMs=time.time() * 1000 - 1))
        self.queued()
        self.bridge.drain()
        response = self.response()
        self.assertEqual(response["error"]["code"], "BRIDGE_EXPIRED")
        self.assertEqual(response["error"]["outcome"], "not_executed")
        self.assertEqual(self.surface.document.tempo, 120)

    def test_cancelled_queue_entry_cannot_write_and_a_later_read_works(self):
        self.send(self.mutation(), {"cancelRequestIds": ["tempo"]})
        self.queued()
        self.bridge.drain()
        self.assertEqual(self.response()["error"]["code"], "BRIDGE_CANCELLED")
        self.assertEqual(self.surface.document.tempo, 120)
        self.send({"id": "read", "method": "get_live_state"})
        self.queued()
        self.bridge.drain()
        self.assertEqual(self.response()["result"]["tempo"], 120)

    def test_disconnect_invalidates_queued_work(self):
        self.send(self.mutation())
        self.queued()
        self.sender.shutdown(socket.SHUT_WR)
        self.reader.join(1)
        self.assertFalse(self.reader.is_alive())
        self.bridge.drain()
        self.assertEqual(self.surface.document.tempo, 120)

    def test_cancellation_between_deferred_cue_stages_prevents_the_cue_write(self):
        self.send({"id": "cue", "method": "create_arrangement_cue_point",
                   "params": {"timeBeats": 32, "name": "Cancelled"},
                   "deadlineUnixMs": time.time() * 1000 + 5000})
        record = self.queued()
        original_time = self.surface.document.current_song_time
        self.bridge.drain()
        self.assertEqual(self.surface.document.current_song_time, 32)
        self.send({"cancelRequestIds": ["cue"]})
        self.assertTrue(record.cancelled.wait(1))
        self.surface.callback()
        self.assertEqual(self.response()["error"]["outcome"], "unknown")
        self.assertFalse(any(cue.name == "Cancelled" for cue in self.surface.document.cue_points))
        self.assertEqual(self.surface.document.current_song_time, original_time)
        self.assertFalse(self.bridge.deferred_request)

    def test_malformed_deadline_is_rejected_without_enqueueing(self):
        self.send(self.mutation(deadlineUnixMs="tomorrow"))
        self.assertEqual(self.response()["error"]["outcome"], "not_executed")
        self.assertTrue(self.bridge.requests.empty())

    def test_deadline_between_deferred_cue_stages_prevents_the_cue_write(self):
        self.send({"id": "cue", "method": "create_arrangement_cue_point",
                   "params": {"timeBeats": 32, "name": "Expired"},
                   "deadlineUnixMs": time.time() * 1000 + 5000})
        record = self.queued()
        self.bridge.drain()
        record.deadline = time.monotonic() - 1
        self.surface.callback()
        self.assertEqual(self.response()["error"]["code"], "BRIDGE_EXPIRED")
        self.assertFalse(any(cue.name == "Expired" for cue in self.surface.document.cue_points))
        self.assertFalse(self.bridge.deferred_request)

    def test_native_queue_capacity_is_bounded_and_overflow_never_enqueues(self):
        self.send(*(self.mutation(id=str(index)) for index in range(257)))
        result = self.response()
        self.assertEqual(result["id"], "256")
        self.assertEqual(result["error"]["code"], "BRIDGE_BUSY")
        self.assertEqual(result["error"]["outcome"], "not_executed")
        self.assertEqual(self.bridge.requests.qsize(), 256)

    def test_one_connection_cannot_cancel_another_connections_request(self):
        other_sender, other_receiver = socket.socketpair()
        other = threading.Thread(target=self.bridge._read_client, args=(other_receiver,), daemon=True)
        other.start()
        try:
            self.send(self.mutation())
            record = self.queued()
            other_sender.sendall(encode_message({"cancelRequestIds": ["tempo"]}))
            other_sender.shutdown(socket.SHUT_WR)
            other.join(1)
            self.assertFalse(record.cancelled.is_set())
            self.bridge.drain()
            self.assertEqual(self.response()["result"]["tempo"], 130)
        finally:
            other_sender.close()


if __name__ == "__main__":
    unittest.main()
