"""Exercise the production socket bridge with a small document test double."""
import json
import os
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "ableton/Remote Scripts/CaviMcpBridge"))
from bridge import SocketBridge
from protocol import encode_message

document = SimpleNamespace(tracks=[], scenes=[], tempo=120.0, is_playing=False, file_path="fixture.als")
surface = SimpleNamespace(song=lambda: document, application=lambda: None)
bridge = SocketBridge(surface, sys.argv[1])
bridge.start()
deadline = time.monotonic() + 3
while not os.path.exists(sys.argv[1]):
    if time.monotonic() >= deadline:
        raise RuntimeError("bridge did not start")
    time.sleep(0.01)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
    probe.settimeout(3)
    probe.connect(sys.argv[1])
    probe.sendall(encode_message({"id": "ready", "method": "get_bridge_protocol"}))
    probe.recv(65536)
print(json.dumps({"ready": True}), flush=True)
record = None
try:
    for line in sys.stdin:
        command = line.strip()
        if command == "next":
            record = bridge.requests.get(timeout=3)
            bridge.requests.put(record)
            result = {"queuedMethod": record.request["method"]}
        elif command == "cancelled":
            result = {"cancelled": record.cancelled.wait(3)}
        elif command == "drain":
            bridge.drain()
            result = {"tempo": document.tempo, "stateVersion": bridge.state_version}
        elif command == "stop":
            break
        else:
            raise ValueError(command)
        print(json.dumps(result), flush=True)
finally:
    bridge.stop()
    bridge.thread.join(1)
