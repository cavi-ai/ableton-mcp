import json
import math
import threading
import time

BRIDGE_PROTOCOL = {"version": 2, "requestDeadlines": True, "requestCancellation": True}


class ClientSession:
    def __init__(self, client):
        self.client = client
        self.lock = threading.RLock()
        self.send_lock = threading.Lock()
        self.pending = {}
        self.requires_deadline = False

    def send(self, response):
        with self.send_lock:
            self.client.sendall(encode_message(response))

    def cancel(self, request_ids, code="BRIDGE_CANCELLED"):
        with self.lock:
            for request_id in request_ids:
                if type(request_id) not in (str, int):
                    continue
                record = self.pending.get(request_id)
                if record is not None:
                    record.cancel_code = code
                    record.cancelled.set()


class QueuedRequest:
    def __init__(self, session, request):
        request_id = request.get("id")
        if type(request_id) not in (str, int):
            raise ValueError("bridge request ID must be a string or integer")
        if request_id in session.pending:
            raise ValueError("bridge request ID is already pending")
        if session.requires_deadline and "deadlineUnixMs" not in request:
            raise ValueError("bridge request deadline is required")
        deadline = request.get("deadlineUnixMs")
        if "deadlineUnixMs" in request and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
            raise ValueError("bridge request deadline must be finite milliseconds since the Unix epoch")
        self.deadline = None if deadline is None else time.monotonic() + max(0, deadline / 1000 - time.time())
        self.session, self.request = session, request
        self.client = session.client
        self.started = False
        self.cancelled = threading.Event()
        self.cancel_code = "BRIDGE_CANCELLED"
        session.pending[request_id] = self

    def unavailable(self):
        with self.session.lock:
            if self.cancelled.is_set():
                code, message = self.cancel_code, "bridge request cancelled or disconnected before completion"
            elif self.deadline is not None and time.monotonic() >= self.deadline:
                code, message = "BRIDGE_EXPIRED", "bridge request expired before execution"
            else:
                return None
            return {"code": code, "message": message, "outcome": "unknown" if self.started else "not_executed"}

    def claim(self):
        with self.session.lock:
            error = self.unavailable()
            if error is None:
                self.started = True
            return error

    def finish(self):
        with self.session.lock:
            self.session.pending.pop(self.request["id"], None)


def encode_message(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")


def decode_lines(buffer):
    messages = []
    while b"\n" in buffer:
        line, buffer = buffer.split(b"\n", 1)
        if line.strip():
            messages.append(json.loads(line.decode("utf-8")))
    return messages, buffer
