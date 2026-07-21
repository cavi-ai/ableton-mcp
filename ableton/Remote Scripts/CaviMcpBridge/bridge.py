import hashlib
import os
import queue
import socket
import threading

try:
    from .protocol import decode_lines, encode_message
except ImportError:
    from protocol import decode_lines, encode_message


def _track(song, track_id):
    index = int(track_id.removeprefix("track-"))
    return index, song.tracks[index]


def _device(song, track_id, device_id):
    track_index, track = _track(song, track_id)
    expected = f"track-{track_index}:device-"
    if not device_id.startswith(expected):
        raise ValueError("deviceId does not belong to trackId")
    index = int(device_id.removeprefix(expected))
    return track, index, track.devices[index]


def dispatch_request(song, request, state_version):
    method = request["method"]
    params = request.get("params", {})
    fingerprint = hashlib.sha256(f"{len(song.tracks)}:{song.tempo}".encode()).hexdigest()[:16]
    if method == "get_live_state":
        return {"stateVersion": state_version, "setFingerprint": fingerprint, "tempo": song.tempo, "isPlaying": song.is_playing}
    if method == "list_tracks":
        return {"stateVersion": state_version, "tracks": [{"id": f"track-{i}", "name": track.name} for i, track in enumerate(song.tracks)]}
    if method == "list_devices":
        index, track = _track(song, params["trackId"])
        return {"stateVersion": state_version, "trackId": params["trackId"], "devices": [{"id": f"track-{index}:device-{i}", "name": device.name} for i, device in enumerate(track.devices)]}
    if method == "list_device_parameters":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        return {"stateVersion": state_version, "trackId": params["trackId"], "deviceId": params["deviceId"], "parameters": [{"id": f"parameter-{i}", "name": parameter.name, "min": parameter.min, "max": parameter.max, "value": parameter.value, "enabled": parameter.is_enabled} for i, parameter in enumerate(device.parameters)]}
    if method == "set_device_parameters":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        observed = []
        for change in params["changes"]:
            parameter = device.parameters[int(change["id"].removeprefix("parameter-"))]
            if not parameter.is_enabled:
                raise ValueError("parameter is disabled")
            parameter.value = max(parameter.min, min(parameter.max, float(change["value"])))
            observed.append({"id": change["id"], "value": parameter.value})
        return {"stateVersion": state_version + 1, "trackId": params["trackId"], "deviceId": params["deviceId"], "observedChanges": observed}
    if method == "panic":
        song.stop_playing()
        return {"stateVersion": state_version + 1, "isPlaying": song.is_playing}
    raise ValueError(f"unsupported method {method}")


class SocketBridge:
    def __init__(self, control_surface, socket_path):
        self.control_surface = control_surface
        self.socket_path = socket_path
        self.requests = queue.Queue()
        self.stopped = threading.Event()
        self.state_version = 1
        self.thread = threading.Thread(target=self._serve, name="CaviMcpBridge", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stopped.set()
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass

    def _serve(self):
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        server.listen(1)
        server.settimeout(0.5)
        while not self.stopped.is_set():
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self._read_client, args=(client,), daemon=True).start()
        server.close()

    def _read_client(self, client):
        buffer = b""
        with client:
            while not self.stopped.is_set():
                chunk = client.recv(65536)
                if not chunk:
                    return
                messages, buffer = decode_lines(buffer + chunk)
                for message in messages:
                    self.requests.put((client, message))

    def drain(self):
        while True:
            try:
                client, request = self.requests.get_nowait()
            except queue.Empty:
                return
            try:
                result = dispatch_request(self.control_surface.song(), request, self.state_version)
                self.state_version = result.get("stateVersion", self.state_version)
                response = {"id": request.get("id"), "result": result}
            except Exception as error:
                response = {"id": request.get("id"), "error": {"message": str(error)}}
            client.sendall(encode_message(response))
