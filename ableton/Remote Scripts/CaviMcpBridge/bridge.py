import hashlib
import json
import math
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
with open(os.path.join(os.path.dirname(__file__), "capabilities.json"), encoding="utf-8") as capability_file:
    CAPABILITIES = tuple(json.load(capability_file))

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
AUDIO_WARP_MODE_NAMES = ("beats", "tones", "texture", "re_pitch", "complex", "rex", "complex_pro")
COUNT_IN_DURATION_NAMES = ("none", "one_bar", "two_bars", "four_bars")


def _track(song, track_id):
    index = int(track_id.removeprefix("track-"))
    return index, song.tracks[index]


def _track_record(song, track, index):
    is_group = bool(getattr(track, "is_foldable", False))
    is_grouped = bool(getattr(track, "is_grouped", False))
    group_track_id = None
    if is_grouped:
        group_track = getattr(track, "group_track", None)
        group_index = next((i for i, candidate in enumerate(song.tracks) if candidate == group_track), None)
        if group_index is not None:
            group_track_id = f"track-{group_index}"
    return {
        "id": f"track-{index}", "name": track.name, "mute": bool(track.mute),
        "solo": bool(track.solo), "armed": bool(track.arm),
        "volume": track.mixer_device.volume.value, "pan": track.mixer_device.panning.value,
        "isGroup": is_group, "isGrouped": is_grouped, "groupTrackId": group_track_id,
        "foldState": int(track.fold_state) if is_group else None,
    }


def _device(song, track_id, device_id):
    track_index, track = _track(song, track_id)
    expected = f"track-{track_index}:device-"
    if not device_id.startswith(expected):
        raise ValueError("deviceId does not belong to trackId")
    parts = device_id.removeprefix(expected).split("/")
    if not parts[0].isdigit() or len(parts) % 2 != 1:
        raise ValueError("invalid device path")
    index = int(parts[0])
    owner = track
    try:
        device = owner.devices[index]
        for position in range(1, len(parts), 2):
            chain_part, device_part = parts[position:position + 2]
            if not chain_part.startswith("chain-") or not device_part.startswith("device-"):
                raise ValueError("invalid device path")
            chain_index = chain_part.removeprefix("chain-")
            child_index = device_part.removeprefix("device-")
            if not chain_index.isdigit() or not child_index.isdigit():
                raise ValueError("invalid device path")
            if not device.can_have_chains:
                raise ValueError("device has no chains")
            owner = device.chains[int(chain_index)]
            index = int(child_index)
            device = owner.devices[index]
    except (IndexError, AttributeError):
        raise ValueError("unknown device path") from None
    return owner, index, device


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


def _transport_context(song, state_version):
    return {
        "stateVersion": state_version, "isPlaying": bool(song.is_playing),
        "metronome": bool(song.metronome),
        "countInDuration": _enum_record(song.count_in_duration, COUNT_IN_DURATION_NAMES),
    }


def _clip_timing(song, track_id, clip_id, state_version):
    _, _, slot = _clip_slot(song, track_id, clip_id)
    if not slot.has_clip:
        raise ValueError("clip slot is empty")
    clip = slot.clip
    grooves = _grooves(song)
    groove_id = next((f"groove-{index}" for index, groove in enumerate(grooves) if groove == clip.groove), None)
    unwarped_audio = bool(getattr(clip, "is_audio_clip", False)) and not bool(clip.warping)
    loop = {"enabled": bool(clip.looping)}
    if unwarped_audio:
        loop.update(unit="seconds", startSeconds=float(clip.loop_start), endSeconds=float(clip.loop_end))
    else:
        loop.update(startBeats=float(clip.loop_start), endBeats=float(clip.loop_end))
    return {
        "stateVersion": state_version, "trackId": track_id, "clipId": clip_id,
        "loop": loop,
        "timeSignature": {"numerator": int(clip.signature_numerator), "denominator": int(clip.signature_denominator)},
        "launchQuantization": _enum_record(clip.launch_quantization, CLIP_QUANTIZATION_NAMES),
        "grooveId": groove_id,
        "availableGrooves": [_groove_record(groove, index) for index, groove in enumerate(grooves)],
    }


def _audio_clip(song, track_id, clip_id):
    timeline = None
    if ":arrangement-clip-" in clip_id:
        _, track = _track(song, track_id)
        prefix = f"{track_id}:arrangement-clip-"
        suffix = clip_id[len(prefix):] if clip_id.startswith(prefix) else ""
        if not suffix.isdigit() or int(suffix) >= len(track.arrangement_clips):
            raise ValueError("unknown Arrangement clip ID")
        index = int(suffix)
        clip = track.arrangement_clips[index]
        timeline = _arrangement_clip_record(clip, track_id, index)
    else:
        _, _, slot = _clip_slot(song, track_id, clip_id)
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
    if not getattr(clip, "is_audio_clip", False):
        raise ValueError("clip is not an audio clip")
    return clip, timeline


def _audio_clip_state(song, track_id, clip_id, state_version):
    clip, timeline = _audio_clip(song, track_id, clip_id)
    return {
        "stateVersion": state_version, "trackId": track_id, "clipId": clip_id,
        "location": "arrangement" if timeline is not None else "session", "timeline": timeline,
        "source": {"path": getattr(clip, "file_path", None), "lengthSamples": getattr(clip, "sample_length", None)},
        "gain": {"value": float(clip.gain), "min": 0.0, "max": 1.0, "displayValue": clip.gain_display_string},
        "pitch": {"coarse": int(clip.pitch_coarse), "fine": int(clip.pitch_fine)},
        "warping": bool(clip.warping), "warpMode": _enum_record(clip.warp_mode, AUDIO_WARP_MODE_NAMES),
        "markers": {"unit": "beats" if clip.warping else "seconds",
                    "startBeats" if clip.warping else "startSeconds": float(clip.start_marker),
                    "endBeats" if clip.warping else "endSeconds": float(clip.end_marker)},
    }


def _clip_list(song, track_id, state_version):
    index, track = _track(song, track_id)
    return {
        "stateVersion": state_version, "trackId": track_id,
        "clips": [{
            "id": f"track-{index}:clip-{slot_index}",
            "name": slot.clip.name if slot.has_clip else None,
            "hasClip": bool(slot.has_clip),
            "durationUnit": ("seconds" if getattr(slot.clip, "is_audio_clip", False) and not slot.clip.warping else "beats") if slot.has_clip else None,
            "lengthBeats": float(slot.clip.length) if slot.has_clip and not (getattr(slot.clip, "is_audio_clip", False) and not slot.clip.warping) else None,
            "lengthSeconds": float(slot.clip.loop_end - slot.clip.loop_start) if slot.has_clip and getattr(slot.clip, "is_audio_clip", False) and not slot.clip.warping else None,
            "isPlaying": bool(slot.clip.is_playing) if slot.has_clip else False,
        } for slot_index, slot in enumerate(track.clip_slots)],
    }


def _arrangement_clip_record(clip, track_id, index):
    return {"id": f"{track_id}:arrangement-clip-{index}", "name": clip.name,
            "startBeats": float(clip.start_time), "endBeats": float(clip.end_time),
            "lengthBeats": float(clip.end_time - clip.start_time),
            "type": "audio" if clip.is_audio_clip else "midi"}


def _arrangement_clips(song, track_id, state_version):
    _, track = _track(song, track_id)
    return {"stateVersion": state_version, "trackId": track_id,
            "clips": [_arrangement_clip_record(clip, track_id, index)
                      for index, clip in enumerate(track.arrangement_clips)]}


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
        "valueItems": list(parameter.value_items) if parameter.is_quantized else [],
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


def _value_record(parameter):
    return {"value": parameter.value, "min": parameter.min, "max": parameter.max}


def _return_mixer_record(track, index):
    return {
        "id": f"return-{index}", "name": track.name,
        "volume": _value_record(track.mixer_device.volume),
        "pan": _value_record(track.mixer_device.panning),
        "mute": bool(track.mute), "solo": bool(track.solo),
    }


def _set_mixer(song, state_version):
    mixer = song.master_track.mixer_device
    master = song.master_track
    output_supported = hasattr(master, "current_output_sub_routing") and hasattr(master, "available_output_routing_channels")
    return {
        "stateVersion": state_version,
        "master": {
            "volume": _value_record(mixer.volume), "pan": _value_record(mixer.panning),
            "cueVolume": _value_record(mixer.cue_volume), "crossfader": _value_record(mixer.crossfader),
            "outputRouting": {
                "supported": output_supported,
                "channel": _routing_option(master.current_output_sub_routing) if output_supported else None,
                "availableChannels": [_routing_option(option) for option in master.available_output_routing_channels] if output_supported else [],
            },
        },
        "returns": [_return_mixer_record(track, index) for index, track in enumerate(song.return_tracks)],
    }


def _device_type(device):
    if Live is None:
        return "unknown"
    enum = Live.Device.DeviceType
    return {enum.audio_effect: "audio_effect", enum.instrument: "instrument",
            enum.midi_effect: "midi_effect"}.get(device.type, "unknown")


def _device_record(device, device_id):
    sample = getattr(device, "sample", None)
    return {
        "id": device_id, "name": device.name,
        "className": device.class_name, "classDisplayName": device.class_display_name,
        "type": _device_type(device), "active": bool(device.is_active),
        "canHaveChains": bool(device.can_have_chains),
        "canHaveDrumPads": bool(device.can_have_drum_pads),
        "sampleSource": {"path": sample.file_path} if sample is not None else None,
        "multiSampleMode": bool(device.multi_sample_mode) if hasattr(device, "multi_sample_mode") else None,
    }


def _browser_item_record(item):
    return {
        "name": item.name, "uri": getattr(item, "uri", None),
        "loadable": bool(item.is_loadable), "folder": bool(item.is_folder),
    }


def _browser_item(application, root, path):
    roots = {
        name: name for name in (
            "audio_effects", "clips", "current_project", "drums", "hotswap_target", "instruments",
            "legacy_libraries", "max_for_live", "midi_effects", "packs", "plugins", "samples", "sounds",
            "user_folders", "user_library",
        )
    }
    if root not in roots:
        raise ValueError("unknown Live browser root")
    item = getattr(application.browser, roots[root])
    for name in path:
        matches = [child for child in item.children if child.name == name]
        if len(matches) != 1:
            raise ValueError("Live browser path is missing or ambiguous")
        item = matches[0]
    return item


def _search_browser_items(application, root, path, query, max_depth, limit):
    item = _browser_item(application, root, path)
    needle = query.casefold()
    results = []

    def visit(parent, parent_path, depth):
        if depth >= max_depth or len(results) >= limit:
            return
        for child in parent.children:
            child_path = parent_path + [child.name]
            if needle in child.name.casefold():
                results.append({**_browser_item_record(child), "path": child_path})
                if len(results) >= limit:
                    return
            if child.is_folder:
                visit(child, child_path, depth + 1)
                if len(results) >= limit:
                    return

    visit(item, list(path), 0)
    return results


def _chain_mixer(chain):
    mixer = getattr(chain, "mixer_device", None)
    def parameter_state(name):
        parameter = getattr(mixer, name, None)
        return None if parameter is None else {
            "value": float(parameter.value), "min": float(parameter.min),
            "max": float(parameter.max), "enabled": bool(parameter.is_enabled),
        }
    return {"volume": parameter_state("volume"), "pan": parameter_state("panning"),
            "mute": bool(chain.mute) if hasattr(chain, "mute") else None,
            "solo": bool(chain.solo) if hasattr(chain, "solo") else None}


def _device_tree(device, device_id):
    record = _device_record(device, device_id)
    chains = []
    chain_ids = []
    if device.can_have_chains:
        for chain_index, chain in enumerate(device.chains):
            chain_id = f"{device_id}/chain-{chain_index}"
            chain_ids.append((chain, chain_id))
            chains.append({
                "id": chain_id, "name": chain.name,
                "apiSupport": {"deleteDevice": callable(getattr(chain, "delete_device", None))},
                "mixer": _chain_mixer(chain),
                "noteRouting": {"inputNote": getattr(chain, "in_note", None),
                                "outputNote": getattr(chain, "out_note", None)},
                "devices": [_device_tree(child, f"{chain_id}/device-{child_index}")
                            for child_index, child in enumerate(chain.devices)],
            })
    record["chains"] = chains
    record["returnChains"] = [{
        "id": f"{device_id}/return-chain-{index}", "name": chain.name,
        "apiSupport": {"deleteDevice": callable(getattr(chain, "delete_device", None))},
        "mixer": _chain_mixer(chain),
        "devices": [_device_tree(child, f"{device_id}/return-chain-{index}/device-{child_index}")
                    for child_index, child in enumerate(chain.devices)],
    } for index, chain in enumerate(getattr(device, "return_chains", ())) ] if device.can_have_chains else []
    record["drumPads"] = []
    if device.can_have_drum_pads:
        record["drumPads"] = [{
            "note": int(pad.note), "name": pad.name, "mute": bool(pad.mute), "solo": bool(pad.solo),
            "chainIds": [chain_id for chain in pad.chains for candidate, chain_id in chain_ids if chain == candidate],
        } for pad in device.drum_pads if pad.chains]
    return record


def dispatch_request(song, request, state_version, application=None):
    method = request["method"]
    params = request.get("params", {})
    fingerprint = hashlib.sha256(f"{len(song.tracks)}:{song.tempo}".encode()).hexdigest()[:16]
    if method == "get_live_state":
        return {"stateVersion": state_version, "setFingerprint": fingerprint, "tempo": song.tempo, "isPlaying": song.is_playing, "bridgeVersion": BRIDGE_VERSION, "capabilities": list(CAPABILITIES)}
    if method == "get_transport_context":
        return _transport_context(song, state_version)
    if method == "set_transport_context":
        changes = params["changes"]
        if "metronome" in changes:
            song.metronome = bool(_change_value(changes["metronome"]))
        if "countInDuration" in changes:
            song.count_in_duration = int(_change_value(changes["countInDuration"]))
        return _transport_context(song, state_version + 1)
    if method == "get_history_state":
        return {"stateVersion": state_version, "canUndo": bool(song.can_undo), "canRedo": bool(song.can_redo)}
    if method in ("undo", "redo"):
        if method == "undo":
            if not song.can_undo:
                raise ValueError("undo is not available")
            song.undo()
        else:
            if not song.can_redo:
                raise ValueError("redo is not available")
            song.redo()
        return {"stateVersion": state_version + 1, "canUndo": bool(song.can_undo), "canRedo": bool(song.can_redo)}
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
    if method == "set_group_fold_state":
        track_index, track = _track(song, params["trackId"])
        if not bool(getattr(track, "is_foldable", False)):
            raise ValueError("track is not a group")
        track.fold_state = 1 if params["folded"] else 0
        return {"stateVersion": state_version + 1, "track": _track_record(song, track, track_index)}
    if method == "route_tracks_to_bus":
        _, bus = _track(song, params["busTrackId"])
        if not bool(getattr(bus, "is_foldable", False)):
            raise ValueError("bus track is not a group")
        routes = []
        for route_change in params["routes"]:
            _, track = _track(song, route_change["trackId"])
            selected = next(option for option in track.available_output_routing_types if _routing_id(option) == route_change["outputTypeId"])
            track.current_output_routing = selected
            routes.append(_track_routing(song, route_change["trackId"], state_version + 1))
        return {"stateVersion": state_version + 1, "busTrackId": params["busTrackId"], "routes": routes}
    if method in ("get_browser_items", "get_factory_browser_items"):
        item = _browser_item(application, params["root"], params.get("path", []))
        return {
            "stateVersion": state_version, "root": params["root"], "path": params.get("path", []),
            "item": _browser_item_record(item),
            "children": [_browser_item_record(child) for child in item.children],
        }
    if method == "search_browser_items":
        return {
            "stateVersion": state_version, "root": params["root"], "path": params.get("path", []),
            "query": params["query"],
            "results": _search_browser_items(
                application, params["root"], params.get("path", []), params["query"],
                params["maxDepth"], params["limit"],
            ),
        }
    if method in ("load_browser_item", "load_factory_browser_item"):
        item = _browser_item(application, params["root"], params["path"])
        if not item.is_loadable:
            raise ValueError("Live browser item is not loadable")
        _, track = _track(song, params["trackId"])
        current_devices = dispatch_request(song, {"method": "list_devices", "params": {"trackId": params["trackId"]}}, state_version)
        if current_devices != params["before"]:
            raise ValueError("target device chain changed")
        previous_track = song.view.selected_track
        try:
            song.view.selected_track = track
            application.browser.load_item(item)
        finally:
            song.view.selected_track = previous_track
        return {"stateVersion": state_version + 1, "trackId": params["trackId"], "loadedItem": _browser_item_record(item)}
    if method == "get_set_mixer":
        return _set_mixer(song, state_version)
    if method == "set_master_mixer":
        mixer = song.master_track.mixer_device
        if "outputChannelId" in params["changes"]:
            routing = _set_mixer(song, state_version)["master"]["outputRouting"]
            identifier = params["changes"]["outputChannelId"]["value"]["id"]
            selected = next((option for option in routing["availableChannels"] if option["id"] == identifier), None)
            if not routing["supported"] or selected is None:
                raise ValueError("master output channel is unavailable")
            song.master_track.current_output_sub_routing = selected["name"]
        properties = {"volume": "volume", "pan": "panning", "cueVolume": "cue_volume", "crossfader": "crossfader"}
        for key, attribute in properties.items():
            if key in params["changes"]:
                getattr(mixer, attribute).value = params["changes"][key]["value"]
        return _set_mixer(song, state_version + 1)
    if method == "set_return_mixer":
        index = int(params["returnTrackId"].removeprefix("return-"))
        track = song.return_tracks[index]
        if track.name != params["beforeReturn"]["name"]:
            raise ValueError("return track identity changed")
        changes = params["changes"]
        if "volume" in changes:
            track.mixer_device.volume.value = changes["volume"]["value"]
        if "pan" in changes:
            track.mixer_device.panning.value = changes["pan"]["value"]
        if "mute" in changes:
            track.mute = changes["mute"]["value"]
        if "solo" in changes:
            track.solo = changes["solo"]["value"]
        return {"stateVersion": state_version + 1, "return": _return_mixer_record(track, index)}
    if method == "get_audio_clip_state":
        return _audio_clip_state(song, params["trackId"], params["clipId"], state_version)
    if method == "set_audio_clip_state":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        if _audio_clip_state(song, track_id, clip_id, state_version) != params["before"]:
            raise ValueError("audio clip identity or state changed")
        changes = params["changes"]
        marker_keys = {"startMarkerBeats", "endMarkerBeats", "startMarkerSeconds", "endMarkerSeconds"}
        requested_markers = marker_keys.intersection(changes)
        suffix = "Beats" if clip.warping else "Seconds"
        if requested_markers:
            if "warping" in changes or not requested_markers.issubset({"startMarker" + suffix, "endMarker" + suffix}):
                raise ValueError("marker units must match current warping; change warping separately")
            start = _change_value(changes["startMarker" + suffix]) if "startMarker" + suffix in changes else clip.start_marker
            end = _change_value(changes["endMarker" + suffix]) if "endMarker" + suffix in changes else clip.end_marker
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                raise ValueError("invalid audio marker interval")
        for source, target in (("gain", "gain"), ("pitchCoarse", "pitch_coarse"),
                               ("pitchFine", "pitch_fine"), ("warping", "warping"),
                               ("warpMode", "warp_mode")):
            if source in changes:
                setattr(clip, target, _change_value(changes[source]))
        if requested_markers:
            if not clip.looping:
                if start >= clip.loop_end:
                    clip.loop_end = end
                    clip.loop_start = start
                else:
                    clip.loop_start = start
                    clip.loop_end = end
            if start >= clip.end_marker:
                clip.end_marker = end
                clip.start_marker = start
            else:
                clip.start_marker = start
                clip.end_marker = end
        return _audio_clip_state(song, track_id, clip_id, state_version + 1)
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
        return {"stateVersion": state_version, "tracks": [_track_record(song, track, i) for i, track in enumerate(song.tracks)]}
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
        if target["targetType"] == "track":
            source_index = int(target["targetId"].removeprefix("track-"))
            song.duplicate_track(source_index)
            item = song.tracks[source_index + 1]
            item.name = target["name"]
        elif target["targetType"] == "scene":
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
        return _clip_list(song, params["trackId"], state_version)
    if method == "list_arrangement_clips":
        return _arrangement_clips(song, params["trackId"], state_version)
    if method in ("delete_arrangement_clip", "move_arrangement_clip"):
        track_id = params["trackId"]
        _, track = _track(song, track_id)
        prefix = f"{track_id}:arrangement-clip-"
        clip_id = params["clipId"]
        suffix = clip_id[len(prefix):] if clip_id.startswith(prefix) else ""
        if not suffix.isdigit() or int(suffix) >= len(track.arrangement_clips):
            raise ValueError("unknown Arrangement clip ID")
        index = int(suffix)
        clip = track.arrangement_clips[index]
        before = _arrangement_clip_record(clip, track_id, index)
        if before != params["before"]:
            raise ValueError("Arrangement clip identity changed")
        if method == "move_arrangement_clip":
            start = float(params["startBeats"])
            end = start + before["lengthBeats"]
            if not math.isfinite(start) or start < 0 or not math.isfinite(end) or end <= start:
                raise ValueError("move must define a finite positive interval")
            if any(other != clip and start < other.end_time and end > other.start_time for other in track.arrangement_clips):
                raise ValueError("move would overlap another Arrangement clip")
            if start == before["startBeats"]:
                result = _arrangement_clips(song, track_id, state_version)
                result["movedClip"] = before
                return result
            staging_start = max(end, *(float(other.end_time) for other in track.arrangement_clips)) + 1.0
            staged = moved = None
            removed = False
            song.begin_undo_step()
            try:
                staged = track.duplicate_clip_to_arrangement(clip, staging_start)
                if not math.isclose(float(staged.end_time - staged.start_time), before["lengthBeats"], abs_tol=1e-8):
                    raise ValueError("Live changed the copied clip span; source was not moved")
                track.delete_clip(clip)
                removed = True
                moved = track.duplicate_clip_to_arrangement(staged, start)
                if not math.isclose(float(moved.end_time - moved.start_time), before["lengthBeats"], abs_tol=1e-8):
                    raise ValueError("Live changed the destination clip span")
                track.delete_clip(staged)
                staged = None
            except Exception as error:
                try:
                    if moved is not None:
                        track.delete_clip(moved)
                    if removed:
                        track.duplicate_clip_to_arrangement(staged, before["startBeats"])
                    if staged is not None:
                        track.delete_clip(staged)
                except Exception as rollback_error:
                    raise RuntimeError(f"move failed: {error}; rollback failed: {rollback_error}; use Live undo; staging starts at {staging_start}") from error
                raise
            finally:
                song.end_undo_step()
            result = _arrangement_clips(song, track_id, state_version + 1)
            moved_index = next(i for i, item in enumerate(track.arrangement_clips) if item == moved)
            result["movedClip"] = _arrangement_clip_record(moved, track_id, moved_index)
            result["previousClip"] = before
            return result
        song.begin_undo_step()
        try:
            track.delete_clip(clip)
        finally:
            song.end_undo_step()
        result = _arrangement_clips(song, track_id, state_version + 1)
        result["deletedClip"] = before
        return result
    if method == "place_session_clip_in_arrangement":
        track, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("source clip is empty")
        if getattr(slot.clip, "is_audio_clip", False) and not slot.clip.warping:
            raise ValueError("unwarped placement requires tempo-map duration conversion")
        start = float(params["startBeats"])
        end = start + float(slot.clip.length)
        if not math.isfinite(start) or start < 0 or not math.isfinite(end) or end <= start:
            raise ValueError("startBeats and source length must define a finite positive interval")
        if any(start < clip.end_time and end > clip.start_time for clip in track.arrangement_clips):
            raise ValueError("placement would overlap existing Arrangement clips")
        placed = track.duplicate_clip_to_arrangement(slot.clip, start)
        result = _arrangement_clips(song, params["trackId"], state_version + 1)
        index = next(index for index, clip in enumerate(track.arrangement_clips) if clip == placed)
        result["placedClip"] = _arrangement_clip_record(placed, params["trackId"], index)
        return result
    if method == "duplicate_clip":
        track_id = params["trackId"]
        _, _, source = _clip_slot(song, track_id, params["sourceClipId"])
        _, _, target = _clip_slot(song, track_id, params["targetClipId"])
        if not source.has_clip:
            raise ValueError("source clip is empty")
        if target.has_clip:
            raise ValueError("target clip must be empty")
        source.duplicate_clip_to(target)
        return _clip_list(song, track_id, state_version + 1)
    if method == "delete_clip":
        track_id = params["trackId"]
        _, _, slot = _clip_slot(song, track_id, params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip is empty")
        slot.delete_clip()
        return _clip_list(song, track_id, state_version + 1)
    if method == "get_clip_timing":
        return _clip_timing(song, params["trackId"], params["clipId"], state_version)
    if method == "set_clip_timing":
        if "before" in params and _clip_timing(song, params["trackId"], params["clipId"], state_version) != params["before"]:
            raise ValueError("clip timing changed since observation")
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        changes = params["changes"]
        loop = changes.get("loop", {})
        if getattr(clip, "is_audio_clip", False) and not clip.warping and any(key in loop for key in ("startBeats", "endBeats")):
            raise ValueError("beat-based loop positions cannot be applied to unwarped audio")
        seconds = bool(getattr(clip, "is_audio_clip", False)) and not clip.warping
        if not seconds and any(key in loop for key in ("startSeconds", "endSeconds")):
            raise ValueError("seconds-based loop positions require unwarped audio")
        start_key, end_key = ("startSeconds", "endSeconds") if seconds else ("startBeats", "endBeats")
        start, end = float(loop.get(start_key, clip.loop_start)), float(loop.get(end_key, clip.loop_end))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError("loop positions must define a finite positive interval")
        if start_key in loop or end_key in loop:
            if start >= clip.loop_end:
                clip.loop_end = end
                clip.loop_start = start
            else:
                clip.loop_start = start
                clip.loop_end = end
        for source, target in (("enabled", "looping"),):
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
    if method == "duplicate_clip_loop":
        track_id, clip_id = params["trackId"], params["clipId"]
        _, _, slot = _clip_slot(song, track_id, clip_id)
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        if not slot.clip.looping:
            raise ValueError("clip looping must be enabled")
        slot.clip.duplicate_loop()
        return _clip_timing(song, track_id, clip_id, state_version + 1)
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
        return {"stateVersion": state_version, "trackId": params["trackId"], "devices": [_device_tree(device, f"track-{index}:device-{i}") for i, device in enumerate(track.devices)]}
    if method in ("set_device_active", "delete_device", "move_device"):
        track, index, device = _device(song, params["trackId"], params["deviceId"])
        before = params["beforeDevice"]
        if device.name != before["name"] or device.class_name != before["className"]:
            raise ValueError("device identity changed")
        deleted = _device_record(device, params["deviceId"])
        if method == "move_device":
            position = params["targetPosition"]
            if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position <= len(track.devices):
                raise ValueError("targetPosition must be a valid device-chain insertion index")
            actual = song.move_device(device, track, position)
            if "/" in params["deviceId"]:
                new_id = params["deviceId"].rsplit("/device-", 1)[0] + f"/device-{actual}"
            else:
                new_id = f"{params['trackId']}:device-{actual}"
            return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                    "requestedPosition": position, "actualPosition": actual,
                    "device": _device_record(device, new_id)}
        if method == "set_device_active":
            on_parameter = next((parameter for parameter in device.parameters
                                 if getattr(parameter, "original_name", parameter.name) == "Device On"), None)
            if on_parameter is None or not on_parameter.is_enabled:
                raise ValueError("device has no writable Device On parameter")
            on_parameter.value = on_parameter.max if params["active"] else on_parameter.min
            return {
                "stateVersion": state_version + 1, "trackId": params["trackId"],
                "device": _device_record(device, params["deviceId"]),
            }
        if not callable(getattr(track, "delete_device", None)):
            raise ValueError("device owner has no native deletion API")
        track.delete_device(index)
        owner_path = params["deviceId"].rsplit("/device-", 1)[0] + "/device-" if "/" in params["deviceId"] else f"{params['trackId']}:device-"
        return {
            "stateVersion": state_version + 1, "trackId": params["trackId"],
            "deletedDevice": deleted,
            "devices": [_device_record(item, f"{owner_path}{i}") for i, item in enumerate(track.devices)],
        }
    if method == "move_device_to_chain":
        owner, _, device = _device(song, params["trackId"], params["deviceId"])
        chain_id = params["targetChainId"]
        rack_id, separator, suffix = chain_id.rpartition("/chain-")
        if not separator or not suffix.isdigit():
            raise ValueError("invalid target chain ID")
        _, _, rack = _device(song, params["targetTrackId"], rack_id)
        if not rack.can_have_chains or int(suffix) >= len(rack.chains):
            raise ValueError("unknown target chain")
        if _device_tree(device, params["deviceId"]) != params["beforeDevice"]:
            raise ValueError("source device state changed")
        if _device_tree(rack, rack_id) != params["beforeTargetRack"]:
            raise ValueError("target rack state changed")
        if chain_id.startswith(params["deviceId"] + "/"):
            raise ValueError("cannot move a rack into its own descendant")
        target = rack.chains[int(suffix)]
        position = params["targetPosition"]
        if type(position) is not int or not 0 <= position <= len(target.devices):
            raise ValueError("invalid target chain insertion index")
        song.begin_undo_step()
        try:
            actual = song.move_device(device, target, position)
        finally:
            song.end_undo_step()
        # Moving a sibling can change the rack's positional ID. Resolve its current
        # location from the target track rather than returning the pre-move path.
        _, target_track = _track(song, params["targetTrackId"])
        def find_rack(devices, prefix):
            for index, candidate in enumerate(devices):
                candidate_id = f"{prefix}{index}"
                if candidate == rack:
                    return candidate_id
                if candidate.can_have_chains:
                    for chain_index, chain in enumerate(candidate.chains):
                        found = find_rack(chain.devices, f"{candidate_id}/chain-{chain_index}/device-")
                        if found is not None:
                            return found
            return None
        current_rack_id = find_rack(target_track.devices, params["targetTrackId"] + ":device-")
        if current_rack_id is None:
            raise RuntimeError("moved device target rack could not be resolved; use Live undo")
        new_id = f"{current_rack_id}/chain-{int(suffix)}/device-{actual}"
        return {"stateVersion": state_version + 1, "trackId": params["targetTrackId"],
                "requestedPosition": position, "actualPosition": actual,
                "device": _device_tree(device, new_id),
                "targetRack": _device_tree(rack, current_rack_id)}
    if method == "set_drum_pad_state":
        _, _, rack = _device(song, params["trackId"], params["deviceId"])
        if not rack.can_have_drum_pads:
            raise ValueError("device has no drum pads")
        if _device_tree(rack, params["deviceId"]) != params["beforeDevice"]:
            raise ValueError("rack state changed")
        note = params["note"]
        if type(note) is not int or not 0 <= note <= 127:
            raise ValueError("pad note must be an integer from 0 to 127")
        pad = next((pad for pad in rack.drum_pads if pad.note == note and pad.chains), None)
        if pad is None:
            raise ValueError("unknown populated drum pad")
        changes = params["changes"]
        if not changes or set(changes) - {"mute", "solo"} or any(type(value) is not bool for value in changes.values()):
            raise ValueError("invalid drum pad changes")
        if changes.get("mute") is True and changes.get("solo") is True:
            raise ValueError("a drum pad cannot be requested muted and soloed simultaneously")
        # Solo transitions can restore native mute state. Apply explicit mute last.
        for key in ("solo", "mute"):
            if key in changes:
                setattr(pad, key, changes[key])
        device = _device_tree(rack, params["deviceId"])
        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                "pad": next(pad for pad in device["drumPads"] if pad["note"] == note), "device": device}
    if method in ("set_rack_chain_mixer", "rename_rack_chain", "set_rack_chain_note_routing"):
        _, _, rack = _device(song, params["trackId"], params["deviceId"])
        if _device_tree(rack, params["deviceId"]) != params["beforeDevice"]:
            raise ValueError("rack state changed")
        prefix = params["deviceId"] + "/chain-"
        chain_id = params["chainId"]
        suffix = chain_id.removeprefix(prefix)
        if not chain_id.startswith(prefix) or not suffix.isdigit() or int(suffix) >= len(rack.chains):
            raise ValueError("unknown rack chain")
        chain = rack.chains[int(suffix)]
        if method == "set_rack_chain_note_routing":
            if not rack.can_have_drum_pads:
                raise ValueError("note routing requires a Drum Rack")
            changes = params["changes"]
            attributes = {"inputNote": "in_note", "outputNote": "out_note"}
            if not changes or set(changes) - set(attributes):
                raise ValueError("invalid chain note routing changes")
            for key, value in changes.items():
                if type(value) is not int or not 0 <= value <= 127 or not hasattr(chain, attributes[key]):
                    raise ValueError("chain note routing requires available MIDI notes from 0 to 127")
            for key, value in changes.items():
                setattr(chain, attributes[key], value)
            return {"stateVersion": state_version + 1, "trackId": params["trackId"], "chainId": chain_id,
                    "noteRouting": {"inputNote": chain.in_note, "outputNote": chain.out_note},
                    "device": _device_tree(rack, params["deviceId"])}
        if method == "rename_rack_chain":
            name = params["name"]
            if not isinstance(name, str) or not name.strip():
                raise ValueError("chain name must not be empty")
            chain.name = name
            return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                    "chainId": chain_id, "name": chain.name, "device": _device_tree(rack, params["deviceId"])}
        changes = params["changes"]
        if not changes or set(changes) - {"volume", "pan", "mute", "solo"}:
            raise ValueError("invalid chain mixer changes")
        state = _chain_mixer(chain)
        for key, value in changes.items():
            if key in ("mute", "solo"):
                if type(value) is not bool or state[key] is None:
                    raise ValueError(f"{key} is not writable")
            elif type(value) not in (int, float) or not math.isfinite(value) or state[key] is None or not state[key]["enabled"] or not state[key]["min"] <= value <= state[key]["max"]:
                raise ValueError(f"{key} is outside the writable native range")
        song.begin_undo_step()
        try:
            for key, value in changes.items():
                if key in ("mute", "solo"):
                    setattr(chain, key, value)
                else:
                    getattr(chain.mixer_device, "panning" if key == "pan" else "volume").value = value
        finally:
            song.end_undo_step()
        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                "chainId": chain_id, "mixer": _chain_mixer(chain), "device": _device_tree(rack, params["deviceId"])}
    if method == "create_rack_chain":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        if not device.can_have_chains or not callable(getattr(device, "insert_chain", None)):
            raise ValueError("device does not support rack chain creation")
        if _device_tree(device, params["deviceId"]) != params["beforeDevice"]:
            raise ValueError("rack state changed")
        index, name = params["index"], params["name"]
        if type(index) is not int or index < 0 or index > len(device.chains):
            raise ValueError("invalid rack chain insertion index")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("rack chain name must not be empty")
        song.begin_undo_step()
        try:
            device.insert_chain(index)
            device.chains[index].name = name
        finally:
            song.end_undo_step()
        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                "device": _device_tree(device, params["deviceId"]),
                "createdChainId": f"{params['deviceId']}/chain-{index}"}
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
    if method == "create_audio_clip":
        track, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not track.has_audio_input or track.is_frozen:
            raise ValueError("track cannot host imported audio clips")
        if slot.has_clip:
            raise ValueError("clip slot already contains a clip")
        path = params["sourcePath"]
        if not os.path.isabs(path) or not os.path.isfile(path):
            raise ValueError("sourcePath must reference an absolute regular audio file")
        source = os.stat(path)
        descriptor = {"size": str(source.st_size), "mtimeNs": str(source.st_mtime_ns),
                      "device": str(source.st_dev), "inode": str(source.st_ino)}
        if descriptor != params["sourceFile"]:
            raise ValueError("source file changed after planning")
        song.begin_undo_step()
        try:
            slot.create_audio_clip(path)
            if "name" in params:
                slot.clip.name = params["name"]
        finally:
            song.end_undo_step()
        result = _clip_list(song, params["trackId"], state_version + 1)
        result["importedFile"] = {"path": path, **descriptor}
        return result
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
                result = dispatch_request(
                    self.control_surface.song(), request, self.state_version, self.control_surface.application()
                )
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
