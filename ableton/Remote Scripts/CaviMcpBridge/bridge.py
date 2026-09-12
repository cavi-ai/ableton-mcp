import hashlib
import os
import queue
import socket
import threading

try:
    import Live
except ImportError:
    Live = None

try:
    from .protocol import decode_lines, encode_message
except ImportError:
    from protocol import decode_lines, encode_message

BRIDGE_VERSION = "0.1.0"
CAPABILITIES = (
    "get_live_state", "get_song_musical_context", "set_song_musical_context",
    "get_transport_recording_context", "set_transport_recording_context",
    "list_arrangement_cue_points", "create_arrangement_cue_point", "rename_arrangement_cue_point",
    "delete_arrangement_cue_point", "jump_to_arrangement_cue_point",
    "list_tracks", "list_scenes", "list_clips", "get_clip_timing", "set_clip_timing",
    "get_track_mixer", "get_track_routing", "set_track_routing", "get_midi_clip_notes",
    "create_track", "create_scene", "rename_session_object",
    "get_midi_clip_notes_extended", "set_midi_note_properties", "transform_midi_notes",
    "duplicate_session_object", "delete_session_object",
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


def _transport_recording_context(song, state_version):
    return {
        "stateVersion": state_version, "currentSongTime": float(song.current_song_time),
        "isPlaying": bool(song.is_playing), "metronome": bool(song.metronome),
        "arrangement": {
            "record": bool(song.record_mode), "overdub": bool(song.arrangement_overdub),
            "punchIn": bool(song.punch_in), "punchOut": bool(song.punch_out),
            "backToArranger": bool(song.back_to_arranger),
        },
        "session": {"record": bool(song.session_record), "overdub": bool(song.overdub)},
        "automationArm": bool(song.session_automation_record),
    }


def _arrangement_cue_points(song, state_version):
    return {
        "stateVersion": state_version,
        "cuePoints": [{"id": f"cue-{i}", "name": cue.name, "timeBeats": float(cue.time)} for i, cue in enumerate(song.cue_points)],
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


def _new_midi_note(spec):
    if Live is None:
        return spec
    return Live.Clip.MidiNoteSpecification(
        pitch=int(spec["pitch"]), start_time=float(spec["start"]), duration=float(spec["duration"]),
        velocity=int(spec["velocity"]), velocity_deviation=int(spec["velocityDeviation"]),
        release_velocity=int(spec["releaseVelocity"]), probability=float(spec["probability"]),
        mute=bool(spec["mute"]),
    )


def _send_records(song, track):
    return [{
        "id": f"send-{i}", "returnTrackId": f"return-{i}", "name": song.return_tracks[i].name,
        "value": send.value, "min": send.min, "max": send.max,
    } for i, send in enumerate(track.mixer_device.sends)]


def _routing_option(option):
    name = str(getattr(option, "display_name", option))
    identifier = getattr(option, "identifier", None)
    return {
        "id": str(identifier) if isinstance(identifier, (str, int, float)) else name,
        "name": name,
    }


def _routing_id(option):
    return _routing_option(option)["id"]


def _track_routing(song, track_id, state_version):
    _, track = _track(song, track_id)
    return {
        "stateVersion": state_version, "trackId": track_id,
        "input": {
            "type": _routing_option(track.current_input_routing),
            "channel": _routing_option(track.current_input_sub_routing),
            "availableTypes": [_routing_option(option) for option in track.available_input_routing_types],
            "availableChannels": [_routing_option(option) for option in track.available_input_routing_channels],
        },
        "output": {
            "type": _routing_option(track.current_output_routing),
            "channel": _routing_option(track.current_output_sub_routing),
            "availableTypes": [_routing_option(option) for option in track.available_output_routing_types],
            "availableChannels": [_routing_option(option) for option in track.available_output_routing_channels],
        },
        "monitoring": _enum_record(track.current_monitoring_state, ("in", "auto", "off")),
    }


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
    if method == "get_transport_recording_context":
        return _transport_recording_context(song, state_version)
    if method == "set_transport_recording_context":
        changes = params["changes"]
        for source, target in {"currentSongTime": "current_song_time", "metronome": "metronome", "automationArm": "session_automation_record"}.items():
            if source in changes:
                setattr(song, target, changes[source])
        for source, target in {"record": "record_mode", "overdub": "arrangement_overdub", "punchIn": "punch_in", "punchOut": "punch_out", "backToArranger": "back_to_arranger"}.items():
            if source in changes.get("arrangement", {}):
                setattr(song, target, changes["arrangement"][source])
        for source, target in {"record": "session_record", "overdub": "overdub"}.items():
            if source in changes.get("session", {}):
                setattr(song, target, changes["session"][source])
        return _transport_recording_context(song, state_version + 1)
    if method == "list_arrangement_cue_points":
        return _arrangement_cue_points(song, state_version)
    if method == "create_arrangement_cue_point":
        time_beats = float(params["timeBeats"])
        if any(float(cue.time) == time_beats for cue in song.cue_points):
            raise ValueError("cue point already exists at requested time")
        previous_time = song.current_song_time
        try:
            song.current_song_time = time_beats
            song.set_or_delete_cue()
        finally:
            song.current_song_time = previous_time
        cue = next(cue for cue in song.cue_points if float(cue.time) == time_beats)
        cue.name = params["name"]
        result = _arrangement_cue_points(song, state_version + 1)
        result["cuePoint"] = next(record for record in result["cuePoints"] if record["timeBeats"] == time_beats)
        return result
    if method in ("rename_arrangement_cue_point", "delete_arrangement_cue_point", "jump_to_arrangement_cue_point"):
        prefix, raw_index = params["cuePointId"].split("-", 1)
        if prefix != "cue" or not raw_index.isdigit():
            raise ValueError("unknown cue point")
        index = int(raw_index)
        if index >= len(song.cue_points):
            raise ValueError("unknown cue point")
        cue = song.cue_points[index]
        if method == "rename_arrangement_cue_point":
            cue.name = params["name"]
        elif method == "delete_arrangement_cue_point":
            previous_time = song.current_song_time
            try:
                song.current_song_time = float(cue.time)
                song.set_or_delete_cue()
            finally:
                song.current_song_time = previous_time
        else:
            cue.jump()
        return _arrangement_cue_points(song, state_version + 1)
    if method == "get_track_routing":
        return _track_routing(song, params["trackId"], state_version)
    if method == "set_track_routing":
        _, track = _track(song, params["trackId"])
        changes = params["changes"]
        properties = {
            "inputTypeId": ("current_input_routing", track.available_input_routing_types),
            "inputChannelId": ("current_input_sub_routing", track.available_input_routing_channels),
            "outputTypeId": ("current_output_routing", track.available_output_routing_types),
            "outputChannelId": ("current_output_sub_routing", track.available_output_routing_channels),
        }
        for key, (attribute, choices) in properties.items():
            if key in changes:
                identifier = changes[key]["value"]["id"]
                selected = next(
                    option for option in choices if _routing_id(option) == identifier
                )
                setattr(track, attribute, _routing_option(selected)["name"])
        if "monitoring" in changes:
            track.current_monitoring_state = int(changes["monitoring"]["value"]["value"])
        return _track_routing(song, params["trackId"], state_version + 1)
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
    if method == "create_track":
        index = int(params["index"])
        if params["type"] == "midi":
            song.create_midi_track(index)
        else:
            song.create_audio_track(index)
        song.tracks[index].name = params["name"]
        return {"stateVersion": state_version + 1, "track": {
            "id": f"track-{index}", "name": song.tracks[index].name, "type": params["type"],
        }}
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
    if method == "create_scene":
        index = int(params["index"])
        song.create_scene(index)
        song.scenes[index].name = params["name"]
        return {"stateVersion": state_version + 1, "scene": {
            "id": f"scene-{index}", "name": song.scenes[index].name,
        }}
    if method == "rename_session_object":
        target = params["target"]
        if target["targetType"] == "track":
            _, item = _track(song, target["targetId"])
        elif target["targetType"] == "scene":
            item = song.scenes[int(target["targetId"].removeprefix("scene-"))]
        else:
            _, _, slot = _clip_slot(song, target["trackId"], target["targetId"])
            if not slot.has_clip:
                raise ValueError("clip slot is empty")
            item = slot.clip
        item.name = target["name"]
        return {"stateVersion": state_version + 1, "target": {
            **target, "name": item.name,
        }}
    if method == "duplicate_session_object":
        target = params["target"]
        if target["targetType"] == "scene":
            source_index = int(target["targetId"].removeprefix("scene-"))
            song.duplicate_scene(source_index)
            item = song.scenes[source_index + 1]
        else:
            track, source_index, _ = _clip_slot(song, target["trackId"], target["targetId"])
            track.duplicate_clip_slot(source_index)
            item = track.clip_slots[source_index + 1].clip
        return {"stateVersion": state_version + 1, "target": {
            **target, "name": item.name,
        }}
    if method == "delete_session_object":
        target = params["target"]
        if target["targetType"] == "track":
            song.delete_track(int(target["targetId"].removeprefix("track-")))
        elif target["targetType"] == "scene":
            song.delete_scene(int(target["targetId"].removeprefix("scene-")))
        else:
            _, _, slot = _clip_slot(song, target["trackId"], target["targetId"])
            if not slot.has_clip:
                raise ValueError("clip slot is empty")
            slot.delete_clip()
        return {"stateVersion": state_version + 1, "deleted": target}
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
    if method in ("get_midi_clip_notes_extended", "set_midi_note_properties", "transform_midi_notes"):
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        if hasattr(clip, "is_midi_clip") and not clip.is_midi_clip:
            raise ValueError("clip is not a MIDI clip")
        if method in ("set_midi_note_properties", "transform_midi_notes"):
            note_ids = [int(change["noteId"]) for change in params["changes"]]
            notes = clip.get_notes_by_id(note_ids) if note_ids else []
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
            if notes:
                clip.apply_note_modifications(notes)
            added_note_ids = []
            if method == "transform_midi_notes" and params.get("newNotes"):
                added_note_ids = list(clip.add_new_notes(tuple(
                    _new_midi_note(note) for note in params["newNotes"]
                )))
            notes = (list(clip.get_all_notes_extended()) if method == "transform_midi_notes"
                     else list(clip.get_notes_by_id(note_ids)))
        else:
            notes = list(clip.get_all_notes_extended())
            added_note_ids = []
        result = {
            "stateVersion": state_version + (1 if method != "get_midi_clip_notes_extended" else 0),
            "trackId": params["trackId"], "clipId": params["clipId"],
            "lengthBeats": float(clip.length), "notes": [_midi_note_record(note) for note in notes],
        }
        if method == "transform_midi_notes":
            result["addedNoteIds"] = added_note_ids
        return result
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
        self.deferred_request = False
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
        if self.deferred_request:
            return
        while True:
            try:
                client, request = self.requests.get_nowait()
            except queue.Empty:
                return
            if request.get("method") in ("create_arrangement_cue_point", "delete_arrangement_cue_point"):
                self._defer_cue_mutation(client, request)
                return
            try:
                result = dispatch_request(self.control_surface.song(), request, self.state_version)
                self.state_version = result.get("stateVersion", self.state_version)
                response = {"id": request.get("id"), "result": result}
            except Exception as error:
                response = {"id": request.get("id"), "error": {"message": str(error) or error.__class__.__name__}}
            client.sendall(encode_message(response))

    def _defer_cue_mutation(self, client, request):
        song = self.control_surface.song()
        params = request.get("params", {})
        method = request["method"]
        try:
            if method == "create_arrangement_cue_point":
                time_beats = float(params["timeBeats"])
                if any(float(cue.time) == time_beats for cue in song.cue_points):
                    raise ValueError("cue point already exists at requested time")
            else:
                prefix, raw_index = params["cuePointId"].split("-", 1)
                if prefix != "cue" or not raw_index.isdigit() or int(raw_index) >= len(song.cue_points):
                    raise ValueError("unknown cue point")
                time_beats = float(song.cue_points[int(raw_index)].time)
            previous_time = float(song.current_song_time)
            song.current_song_time = time_beats
            self.deferred_request = True
            self.control_surface.schedule_message(
                1, lambda: self._complete_cue_mutation(client, request, previous_time, time_beats)
            )
        except Exception as error:
            client.sendall(encode_message({"id": request.get("id"), "error": {"message": str(error) or error.__class__.__name__}}))

    def _complete_cue_mutation(self, client, request, previous_time, time_beats):
        song = self.control_surface.song()
        try:
            song.set_or_delete_cue()
            if request["method"] == "create_arrangement_cue_point":
                cue = next(cue for cue in song.cue_points if float(cue.time) == time_beats)
                cue.name = request["params"]["name"]
            self.state_version += 1
            result = _arrangement_cue_points(song, self.state_version)
            if request["method"] == "create_arrangement_cue_point":
                result["cuePoint"] = next(record for record in result["cuePoints"] if record["timeBeats"] == time_beats)
            response = {"id": request.get("id"), "result": result}
        except Exception as error:
            response = {"id": request.get("id"), "error": {"message": str(error) or error.__class__.__name__}}
        finally:
            song.current_song_time = previous_time
            self.deferred_request = False
        client.sendall(encode_message(response))
