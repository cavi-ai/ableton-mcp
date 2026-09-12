import hashlib
import os
import queue
import socket
import threading

try:
    from .protocol import decode_lines, encode_message
except ImportError:
    from protocol import decode_lines, encode_message

BRIDGE_VERSION = "0.1.0"
CAPABILITIES = (
    "get_live_state", "get_song_musical_context", "set_song_musical_context",
    "list_tracks", "list_scenes", "list_clips", "get_clip_timing", "set_clip_timing",
    "get_track_mixer", "get_midi_clip_notes",
    "get_midi_clip_notes_extended", "set_midi_note_properties",
    "get_clip_parameter_envelope", "set_clip_parameter_envelope", "list_devices", "get_device_hierarchy",
    "list_device_parameters", "set_device_parameters", "create_midi_clip", "transport_play", "transport_stop",
    "set_tempo", "set_track_mixer", "arm_track", "launch_scene", "launch_clip",
    "stop_clip", "panic",
)

NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
SONG_QUANTIZATION_NAMES = (
    "none", "8_bars", "4_bars", "2_bars", "1_bar", "1_2", "1_2_triplet",
    "1_4", "1_4_triplet", "1_8", "1_8_triplet", "1_16", "1_16_triplet", "1_32",
)
RECORD_QUANTIZATION_NAMES = (
    "none", "1_4", "1_8", "1_8_triplet", "1_8_and_triplet", "1_16",
    "1_16_triplet", "1_16_and_triplet", "1_32",
)
CLIP_QUANTIZATION_NAMES = (
    "global", "none", "8_bars", "4_bars", "2_bars", "1_bar", "1_2", "1_2_triplet",
    "1_4", "1_4_triplet", "1_8", "1_8_triplet", "1_16", "1_16_triplet", "1_32",
)


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


def _clip_slot(song, track_id, clip_id):
    track_index, track = _track(song, track_id)
    expected = f"track-{track_index}:clip-"
    if not clip_id.startswith(expected):
        raise ValueError("clipId does not belong to trackId")
    index = int(clip_id.removeprefix(expected))
    return track, index, track.clip_slots[index]


def _clamp(value, target):
    return max(target.min, min(target.max, float(value)))


def _change_value(change):
    return change.get("value") if isinstance(change, dict) else change


def _enum_record(value, names):
    number = int(value)
    return {
        "value": number,
        "name": names[number] if 0 <= number < len(names) else "unknown",
        "choices": [{"value": index, "name": name} for index, name in enumerate(names)],
    }


def _grooves(song):
    pool = getattr(song, "groove_pool", None)
    return list(getattr(pool, "grooves", ()))


def _groove_record(groove, index):
    return {
        "id": f"groove-{index}", "name": getattr(groove, "name", f"Groove {index + 1}"),
        "base": int(groove.base), "timingAmount": float(groove.timing_amount),
        "quantizationAmount": float(groove.quantization_amount),
        "randomAmount": float(groove.random_amount),
    }


def _song_musical_context(song, state_version):
    return {
        "stateVersion": state_version,
        "timeSignature": {"numerator": int(song.signature_numerator), "denominator": int(song.signature_denominator)},
        "key": {
            "rootNote": int(song.root_note), "rootName": NOTE_NAMES[int(song.root_note) % 12],
            "scaleName": song.scale_name, "scaleMode": bool(song.scale_mode),
            "scaleIntervals": [int(interval) for interval in song.scale_intervals],
        },
        "quantization": {
            "clipTrigger": _enum_record(song.clip_trigger_quantization, SONG_QUANTIZATION_NAMES),
            "midiRecording": _enum_record(song.midi_recording_quantization, RECORD_QUANTIZATION_NAMES),
        },
        "groove": {
            "amount": float(song.groove_amount), "swingAmount": float(song.swing_amount),
            "pool": [_groove_record(groove, index) for index, groove in enumerate(_grooves(song))],
        },
        "loop": {
            "enabled": bool(song.loop), "startBeats": float(song.loop_start),
            "lengthBeats": float(song.loop_length),
        },
    }


def _clip_timing(song, track_id, clip_id, state_version):
    _, _, slot = _clip_slot(song, track_id, clip_id)
    if not slot.has_clip:
        raise ValueError("clip slot is empty")
    clip = slot.clip
    grooves = _grooves(song)
    groove_id = next((f"groove-{index}" for index, groove in enumerate(grooves) if groove == clip.groove), None)
    return {
        "stateVersion": state_version, "trackId": track_id, "clipId": clip_id,
        "loop": {"enabled": bool(clip.looping), "startBeats": float(clip.loop_start), "endBeats": float(clip.loop_end)},
        "timeSignature": {"numerator": int(clip.signature_numerator), "denominator": int(clip.signature_denominator)},
        "launchQuantization": _enum_record(clip.launch_quantization, CLIP_QUANTIZATION_NAMES),
        "grooveId": groove_id,
        "availableGrooves": [_groove_record(groove, index) for index, groove in enumerate(grooves)],
    }


def _parameter_record(parameter, index):
    return {
        "id": f"parameter-{index}",
        "name": parameter.name,
        "originalName": parameter.original_name,
        "min": parameter.min,
        "max": parameter.max,
        "value": parameter.value,
        "displayValue": parameter.str_for_value(parameter.value),
        "enabled": parameter.is_enabled,
        "quantized": parameter.is_quantized,
        "valueItems": list(parameter.value_items),
    }


def _midi_note_record(note):
    return {
        "noteId": int(note.note_id), "pitch": int(note.pitch), "start": float(note.start_time),
        "duration": float(note.duration), "velocity": int(note.velocity),
        "velocityDeviation": int(note.velocity_deviation), "releaseVelocity": int(note.release_velocity),
        "probability": float(note.probability), "mute": bool(note.mute),
    }


def _send_records(song, track):
    return [{
        "id": f"send-{i}", "returnTrackId": f"return-{i}", "name": song.return_tracks[i].name,
        "value": send.value, "min": send.min, "max": send.max,
    } for i, send in enumerate(track.mixer_device.sends)]


def _device_type(device):
    return {0: "audio_effect", 1: "instrument", 2: "midi_effect"}.get(device.type, "unknown")


def _device_record(device, device_id):
    return {
        "id": device_id, "name": device.name,
        "className": device.class_name, "classDisplayName": device.class_display_name,
        "type": _device_type(device), "canHaveChains": bool(device.can_have_chains),
        "canHaveDrumPads": bool(device.can_have_drum_pads),
    }


def _device_tree(device, device_id):
    record = _device_record(device, device_id)
    chains = []
    chain_ids = {}
    if device.can_have_chains:
        for chain_index, chain in enumerate(device.chains):
            chain_id = f"{device_id}/chain-{chain_index}"
            chain_ids[id(chain)] = chain_id
            chains.append({
                "id": chain_id, "name": chain.name,
                "devices": [_device_tree(child, f"{chain_id}/device-{child_index}")
                            for child_index, child in enumerate(chain.devices)],
            })
    record["chains"] = chains
    record["drumPads"] = []
    if device.can_have_drum_pads:
        record["drumPads"] = [{
            "note": int(pad.note), "name": pad.name, "mute": bool(pad.mute), "solo": bool(pad.solo),
            "chainIds": [chain_ids[id(chain)] for chain in pad.chains if id(chain) in chain_ids],
        } for pad in device.drum_pads if pad.chains]
    return record


def dispatch_request(song, request, state_version):
    method = request["method"]
    params = request.get("params", {})
    fingerprint = hashlib.sha256(f"{len(song.tracks)}:{song.tempo}".encode()).hexdigest()[:16]
    if method == "get_live_state":
        return {"stateVersion": state_version, "setFingerprint": fingerprint, "tempo": song.tempo, "isPlaying": song.is_playing, "bridgeVersion": BRIDGE_VERSION, "capabilities": list(CAPABILITIES)}
    if method == "get_song_musical_context":
        return _song_musical_context(song, state_version)
    if method == "set_song_musical_context":
        changes = params["changes"]
        signature = changes.get("timeSignature", {})
        if "numerator" in signature:
            song.signature_numerator = int(signature["numerator"])
        if "denominator" in signature:
            song.signature_denominator = int(signature["denominator"])
        key = changes.get("key", {})
        for source, target in (("rootNote", "root_note"), ("scaleName", "scale_name"), ("scaleMode", "scale_mode")):
            if source in key:
                setattr(song, target, key[source])
        quantization = changes.get("quantization", {})
        if "clipTrigger" in quantization:
            song.clip_trigger_quantization = int(quantization["clipTrigger"])
        if "midiRecording" in quantization:
            song.midi_recording_quantization = int(quantization["midiRecording"])
        groove = changes.get("groove", {})
        if "amount" in groove:
            song.groove_amount = float(groove["amount"])
        if "swingAmount" in groove:
            song.swing_amount = float(groove["swingAmount"])
        loop = changes.get("loop", {})
        for source, target in (("enabled", "loop"), ("startBeats", "loop_start"), ("lengthBeats", "loop_length")):
            if source in loop:
                setattr(song, target, loop[source])
        return _song_musical_context(song, state_version + 1)
    if method == "list_tracks":
        return {"stateVersion": state_version, "tracks": [{"id": f"track-{i}", "name": track.name, "mute": track.mute, "solo": track.solo, "armed": track.arm, "volume": track.mixer_device.volume.value, "pan": track.mixer_device.panning.value} for i, track in enumerate(song.tracks)]}
    if method == "get_track_mixer":
        _, track = _track(song, params["trackId"])
        return {
            "stateVersion": state_version, "trackId": params["trackId"],
            "volume": {"value": track.mixer_device.volume.value, "min": track.mixer_device.volume.min, "max": track.mixer_device.volume.max},
            "pan": {"value": track.mixer_device.panning.value, "min": track.mixer_device.panning.min, "max": track.mixer_device.panning.max},
            "mute": track.mute, "solo": track.solo, "sends": _send_records(song, track),
        }
    if method == "list_scenes":
        return {"stateVersion": state_version, "scenes": [{"id": f"scene-{i}", "name": scene.name} for i, scene in enumerate(song.scenes)]}
    if method == "list_clips":
        index, track = _track(song, params["trackId"])
        clips = []
        for i, slot in enumerate(track.clip_slots):
            clips.append({"id": f"track-{index}:clip-{i}", "name": slot.clip.name if slot.has_clip else None, "hasClip": slot.has_clip, "isPlaying": slot.clip.is_playing if slot.has_clip else False})
        return {"stateVersion": state_version, "trackId": params["trackId"], "clips": clips}
    if method == "get_clip_timing":
        return _clip_timing(song, params["trackId"], params["clipId"], state_version)
    if method == "set_clip_timing":
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        changes = params["changes"]
        loop = changes.get("loop", {})
        for source, target in (("enabled", "looping"), ("startBeats", "loop_start"), ("endBeats", "loop_end")):
            if source in loop:
                setattr(clip, target, loop[source])
        signature = changes.get("timeSignature", {})
        if "numerator" in signature:
            clip.signature_numerator = int(signature["numerator"])
        if "denominator" in signature:
            clip.signature_denominator = int(signature["denominator"])
        if "launchQuantization" in changes:
            clip.launch_quantization = int(changes["launchQuantization"])
        if "grooveId" in changes:
            clip.groove = _grooves(song)[int(changes["grooveId"].removeprefix("groove-"))]
        return _clip_timing(song, params["trackId"], params["clipId"], state_version + 1)
    if method == "get_midi_clip_notes":
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        if hasattr(clip, "is_midi_clip") and not clip.is_midi_clip:
            raise ValueError("clip is not a MIDI clip")
        notes = clip.get_notes(0.0, 0, clip.length, 128)
        return {
            "stateVersion": state_version,
            "trackId": params["trackId"],
            "clipId": params["clipId"],
            "lengthBeats": clip.length,
            "notes": [{
                "pitch": int(note[0]), "start": float(note[1]), "duration": float(note[2]),
                "velocity": int(note[3]), "mute": bool(note[4]),
            } for note in notes],
        }
    if method in ("get_midi_clip_notes_extended", "set_midi_note_properties"):
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        if hasattr(clip, "is_midi_clip") and not clip.is_midi_clip:
            raise ValueError("clip is not a MIDI clip")
        if method == "set_midi_note_properties":
            note_ids = [int(change["noteId"]) for change in params["changes"]]
            notes = clip.get_notes_by_id(note_ids)
            by_id = {int(note.note_id): note for note in notes}
            if len(by_id) != len(set(note_ids)):
                raise ValueError("one or more note IDs no longer exist")
            fields = {
                "pitch": "pitch", "start": "start_time", "duration": "duration", "velocity": "velocity",
                "velocityDeviation": "velocity_deviation", "releaseVelocity": "release_velocity",
                "probability": "probability", "mute": "mute",
            }
            for change in params["changes"]:
                note = by_id[int(change["noteId"])]
                for source, target in fields.items():
                    if source in change:
                        setattr(note, target, change[source])
            clip.apply_note_modifications(notes)
            notes = clip.get_notes_by_id(note_ids)
        else:
            notes = list(clip.get_all_notes_extended())
        return {
            "stateVersion": state_version + (1 if method == "set_midi_note_properties" else 0),
            "trackId": params["trackId"], "clipId": params["clipId"],
            "lengthBeats": float(clip.length), "notes": [_midi_note_record(note) for note in notes],
        }
    if method in ("get_clip_parameter_envelope", "set_clip_parameter_envelope"):
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        if hasattr(clip, "is_midi_clip") and not clip.is_midi_clip:
            raise ValueError("clip is not a MIDI clip")
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        parameter_index = int(params["parameterId"].removeprefix("parameter-"))
        parameter = device.parameters[parameter_index]
        if method == "set_clip_parameter_envelope":
            if not parameter.is_enabled:
                raise ValueError("parameter is disabled")
            clip.clear_envelope(parameter)
            envelope = clip.create_automation_envelope(parameter)
            for point in params["points"]:
                envelope.insert_step(float(point["time"]), float(point["duration"]), _clamp(point["value"], parameter))
            sample_times = [float(point["time"]) for point in params["points"]]
        else:
            envelope = clip.automation_envelope(parameter)
            sample_times = [float(time) for time in params.get("sampleTimes", [])]
        return {
            "stateVersion": state_version + (1 if method == "set_clip_parameter_envelope" else 0),
            "trackId": params["trackId"], "clipId": params["clipId"],
            "deviceId": params["deviceId"], "parameterId": params["parameterId"],
            "clipLengthBeats": float(clip.length), "parameter": _parameter_record(parameter, parameter_index),
            "exists": envelope is not None, "replaced": method == "set_clip_parameter_envelope",
            "samples": [] if envelope is None else [
                {"time": time, "value": float(envelope.value_at_time(time))} for time in sample_times
            ],
        }
    if method == "list_devices":
        index, track = _track(song, params["trackId"])
        return {"stateVersion": state_version, "trackId": params["trackId"], "devices": [_device_record(device, f"track-{index}:device-{i}") for i, device in enumerate(track.devices)]}
    if method == "get_device_hierarchy":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        return {
            "stateVersion": state_version, "trackId": params["trackId"],
            "device": _device_tree(device, params["deviceId"]),
        }
    if method == "list_device_parameters":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        return {"stateVersion": state_version, "trackId": params["trackId"], "deviceId": params["deviceId"], "parameters": [_parameter_record(parameter, i) for i, parameter in enumerate(device.parameters)]}
    if method == "set_device_parameters":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        observed = []
        for change in params["changes"]:
            index = int(change["id"].removeprefix("parameter-"))
            parameter = device.parameters[index]
            if not parameter.is_enabled:
                raise ValueError("parameter is disabled")
            parameter.value = max(parameter.min, min(parameter.max, float(change["value"])))
            observed.append(_parameter_record(parameter, index))
        return {"stateVersion": state_version + 1, "trackId": params["trackId"], "deviceId": params["deviceId"], "observedChanges": observed}
    if method == "create_midi_clip":
        track, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not getattr(track, "has_midi_input", True):
            raise ValueError("track cannot host MIDI clips")
        if slot.has_clip:
            raise ValueError("clip slot already contains a clip")
        slot.create_clip(float(params["lengthBeats"]))
        clip = slot.clip
        notes = tuple((
            int(note["pitch"]), float(note["start"]), float(note["duration"]),
            int(note["velocity"]), bool(note.get("mute", False))
        ) for note in params["notes"])
        clip.set_notes(notes)
        if "name" in params:
            clip.name = params["name"]
        return {
            "stateVersion": state_version + 1,
            "trackId": params["trackId"],
            "clip": {
                "id": params["clipId"], "name": clip.name, "hasClip": True,
                "lengthBeats": clip.length, "noteCount": len(notes), "isPlaying": clip.is_playing,
            },
        }
    if method == "transport_play":
        song.start_playing()
        return {"stateVersion": state_version + 1, "isPlaying": song.is_playing}
    if method == "transport_stop":
        song.stop_playing()
        return {"stateVersion": state_version + 1, "isPlaying": song.is_playing}
    if method == "set_tempo":
        song.tempo = max(20.0, min(999.0, float(params["tempo"])))
        return {"stateVersion": state_version + 1, "tempo": song.tempo}
    if method == "set_track_mixer":
        _, track = _track(song, params["trackId"])
        changes = params.get("changes", params)
        if "volume" in changes:
            track.mixer_device.volume.value = _clamp(_change_value(changes["volume"]), track.mixer_device.volume)
        if "pan" in changes:
            track.mixer_device.panning.value = _clamp(_change_value(changes["pan"]), track.mixer_device.panning)
        for key in ("mute", "solo"):
            if key in changes:
                setattr(track, key, bool(_change_value(changes[key])))
        for change in changes.get("sends", []):
            index = int(change["id"].removeprefix("send-"))
            track.mixer_device.sends[index].value = _clamp(change["value"], track.mixer_device.sends[index])
        return {
            "stateVersion": state_version + 1, "trackId": params["trackId"],
            "volume": track.mixer_device.volume.value, "pan": track.mixer_device.panning.value,
            "mute": track.mute, "solo": track.solo, "sends": _send_records(song, track),
        }
    if method == "arm_track":
        _, track = _track(song, params["trackId"])
        track.arm = bool(params["armed"])
        return {"stateVersion": state_version + 1, "trackId": params["trackId"], "armed": track.arm}
    if method == "launch_scene":
        index = int(params["sceneId"].removeprefix("scene-"))
        song.scenes[index].fire()
        return {"stateVersion": state_version + 1, "sceneId": params["sceneId"]}
    if method in ("launch_clip", "stop_clip"):
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if method == "launch_clip":
            slot.fire()
        else:
            slot.stop()
        return {"stateVersion": state_version + 1, "trackId": params["trackId"], "clipId": params["clipId"], "isPlaying": slot.clip.is_playing if slot.has_clip else False}
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
