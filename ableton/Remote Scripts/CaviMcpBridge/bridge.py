import hashlib
import json
import math
import os
import queue
import socket
import threading
from contextlib import contextmanager

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


@contextmanager
def _undo_step(song):
    song.begin_undo_step()
    try:
        yield
    finally:
        song.end_undo_step()


def _track(song, track_id):
    if not isinstance(track_id, str) or not track_id.startswith("track-"):
        raise ValueError("invalid track ID")
    suffix = track_id.removeprefix("track-")
    if not suffix.isascii() or not suffix.isdigit():
        raise ValueError("invalid track ID")
    index = int(suffix)
    if str(index) != suffix or index >= len(song.tracks):
        raise ValueError("track ID is noncanonical or unavailable")
    return index, song.tracks[index]


def _device_owner(song, owner_id):
    if owner_id == "master":
        return "master", song.master_track
    if isinstance(owner_id, str) and owner_id.startswith("return-"):
        suffix = owner_id.removeprefix("return-")
        if not suffix.isascii() or not suffix.isdigit():
            raise ValueError("invalid device owner ID")
        index = int(suffix)
        if str(index) != suffix or index >= len(song.return_tracks):
            raise ValueError("device owner ID is noncanonical or unavailable")
        return owner_id, song.return_tracks[index]
    index, track = _track(song, owner_id)
    return f"track-{index}", track


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
        "solo": bool(track.solo), "armed": bool(track.arm) if getattr(track, "can_be_armed", True) else False,
        "volume": track.mixer_device.volume.value, "pan": track.mixer_device.panning.value,
        "isGroup": is_group, "isGrouped": is_grouped, "groupTrackId": group_track_id,
        "foldState": int(track.fold_state) if is_group else None,
    }


def _track_type(track):
    if bool(getattr(track, "is_foldable", False)):
        return "group"
    if bool(getattr(track, "has_midi_input", False)):
        return "midi"
    if bool(getattr(track, "has_audio_input", False)):
        return "audio"
    return "unknown"


def _device(song, track_id, device_id):
    owner_id, track = _device_owner(song, track_id)
    expected = f"{owner_id}:device-"
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
            chain_prefix = "return-chain-" if chain_part.startswith("return-chain-") else "chain-"
            if not chain_part.startswith(chain_prefix) or not device_part.startswith("device-"):
                raise ValueError("invalid device path")
            chain_index = chain_part.removeprefix(chain_prefix)
            child_index = device_part.removeprefix("device-")
            if not chain_index.isdigit() or not child_index.isdigit():
                raise ValueError("invalid device path")
            if not device.can_have_chains:
                raise ValueError("device has no chains")
            chains = device.return_chains if chain_prefix == "return-chain-" else device.chains
            owner = chains[int(chain_index)]
            index = int(child_index)
            device = owner.devices[index]
    except (IndexError, AttributeError):
        raise ValueError("unknown device path") from None
    return owner, index, device


def _clip_slot(song, track_id, clip_id):
    track_index, track = _track(song, track_id)
    expected = f"track-{track_index}:clip-"
    if not isinstance(clip_id, str) or not clip_id.startswith(expected):
        raise ValueError("clipId does not belong to trackId")
    suffix = clip_id.removeprefix(expected)
    if not suffix.isascii() or not suffix.isdigit():
        raise ValueError("invalid clip slot ID")
    index = int(suffix)
    if str(index) != suffix or index >= len(track.clip_slots):
        raise ValueError("clip slot ID is noncanonical or unavailable")
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


def _groove_base_options(groove):
    enum = type(groove.base)
    names = (("1_4", "gb_four"), ("1_8", "gb_eight"), ("1_8_triplet", "gb_eight_triplet"),
        ("1_16", "gb_sixteen"), ("1_16_triplet", "gb_sixteen_triplet"), ("1_32", "gb_thirtytwo"))
    return [(name, getattr(enum, attribute)) for name, attribute in names if hasattr(enum, attribute)]


def _groove_record(groove, index):
    choices = [{"value": int(value), "name": name} for name, value in _groove_base_options(groove)]
    return {
        "id": f"groove-{index}", "name": getattr(groove, "name", f"Groove {index + 1}"),
        "base": int(groove.base), "timingAmount": float(groove.timing_amount),
        "quantizationAmount": float(groove.quantization_amount),
        "randomAmount": float(groove.random_amount),
        "velocityAmount": float(groove.velocity_amount),
        "baseGrid": {"value": int(groove.base), "name": next((choice["name"] for choice in choices if choice["value"] == int(groove.base)), "unknown"), "choices": choices},
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


def _looper_performance_context(song, track_id, device_id, state_version):
    _, _, device = _device(song, track_id, device_id)
    if device.class_name != "Looper":
        raise ValueError("device is not a native Looper")
    parameters = [_parameter_record(parameter, index) for index, parameter in enumerate(device.parameters)]
    controls = {}
    for name in ("State", "Quantization", "Monitor", "Song Control", "Tempo Control"):
        matches = [parameter for parameter in parameters if parameter["originalName"] == name]
        if len(matches) != 1:
            raise ValueError(f"native Looper {name} control is unavailable or ambiguous")
        controls[name] = matches[0]
    return {
        "stateVersion": state_version, "trackId": track_id, "deviceId": device_id,
        "device": _device_record(device, device_id), "parameters": parameters,
        "controls": controls, "routing": _track_routing(song, track_id, state_version),
        "transport": _transport_context(song, state_version),
        "globalLaunchQuantization": _enum_record(song.clip_trigger_quantization, CLIP_QUANTIZATION_NAMES),
    }


def _beat_repeat_performance_context(song, track_id, device_id, state_version):
    _, _, device = _device(song, track_id, device_id)
    if device.class_name != "BeatRepeat":
        raise ValueError("device is not a native Beat Repeat")
    parameters = [_parameter_record(parameter, index) for index, parameter in enumerate(device.parameters)]
    controls = {}
    for name in ("Repeat", "Grid", "Interval", "Block Triplets", "Mix Type"):
        matches = [parameter for parameter in parameters if parameter["originalName"] == name]
        if len(matches) == 1:
            controls[name] = matches[0]
        elif name in ("Repeat", "Grid"):
            raise ValueError(f"native Beat Repeat {name} control is unavailable or ambiguous")
    grid = controls["Grid"]
    low, high = grid["min"], grid["max"]
    if (not grid["enabled"] or not math.isfinite(low) or not math.isfinite(high) or
            not float(low).is_integer() or not float(high).is_integer() or
            low < 0 or high < low or high - low > 31):
        raise ValueError("native Beat Repeat Grid cannot be enumerated safely")
    grid_parameter = device.parameters[int(grid["id"].removeprefix("parameter-"))]
    try:
        grid_choices = [{"value": value, "displayValue": grid_parameter.str_for_value(value)}
                        for value in range(int(low), int(high) + 1)]
    except Exception as error:
        raise ValueError("native Beat Repeat Grid display mapping failed") from error
    interval_choices = []
    interval = controls.get("Interval")
    if interval is not None:
        low, high = interval["min"], interval["max"]
        if (not interval["enabled"] or not math.isfinite(low) or not math.isfinite(high) or
                not float(low).is_integer() or not float(high).is_integer() or
                low < 0 or high < low or high - low > 31):
            raise ValueError("native Beat Repeat Interval cannot be enumerated safely")
        interval_parameter = device.parameters[int(interval["id"].removeprefix("parameter-"))]
        try:
            interval_choices = [{"value": value, "displayValue": interval_parameter.str_for_value(value)}
                                for value in range(int(low), int(high) + 1)]
        except Exception as error:
            raise ValueError("native Beat Repeat Interval display mapping failed") from error
    return {
        "stateVersion": state_version, "trackId": track_id, "deviceId": device_id,
        "device": _device_record(device, device_id), "parameters": parameters,
        "controls": controls, "gridChoices": grid_choices, "intervalChoices": interval_choices,
        "routing": _track_routing(song, track_id, state_version),
        "transport": _transport_context(song, state_version),
        "globalLaunchQuantization": _enum_record(song.clip_trigger_quantization, CLIP_QUANTIZATION_NAMES),
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
    if not isinstance(clip_id, str):
        raise ValueError("invalid audio clip ID")
    timeline = None
    if ":arrangement-clip-" in clip_id:
        _, track = _track(song, track_id)
        prefix = f"{track_id}:arrangement-clip-"
        suffix = clip_id[len(prefix):] if clip_id.startswith(prefix) else ""
        if not suffix.isascii() or not suffix.isdigit() or str(int(suffix)) != suffix or int(suffix) >= len(track.arrangement_clips):
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
        "warpMarkers": {"supported": hasattr(clip, "warp_markers"), "markers": [
            {"sampleTime": float(marker.sample_time), "beatTime": float(marker.beat_time)}
            for marker in getattr(clip, "warp_markers", ())
        ]},
        "markers": {"unit": "beats" if clip.warping else "seconds",
                    "startBeats" if clip.warping else "startSeconds": float(clip.start_marker),
                    "endBeats" if clip.warping else "endSeconds": float(clip.end_marker)},
        "loop": {"enabled": bool(clip.looping), "unit": "beats" if clip.warping else "seconds",
                 "startBeats" if clip.warping else "startSeconds": float(clip.loop_start),
                 "endBeats" if clip.warping else "endSeconds": float(clip.loop_end)},
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


def _parameter_record(parameter, index, include_native_choice_labels=False):
    record = {
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
    low, high = parameter.min, parameter.max
    if (include_native_choice_labels and parameter.is_quantized and not record["valueItems"] and
            math.isfinite(low) and math.isfinite(high) and
            float(low).is_integer() and float(high).is_integer() and
            0 <= high - low <= 31):
        try:
            record["nativeChoiceLabels"] = [
                {"value": value, "displayValue": parameter.str_for_value(value)}
                for value in range(int(low), int(high) + 1)]
        except Exception:
            pass
    return record


def _midi_note_record(note):
    return {
        "noteId": int(note.note_id), "pitch": int(note.pitch), "start": float(note.start_time),
        "duration": float(note.duration), "velocity": int(note.velocity),
        "velocityDeviation": int(note.velocity_deviation), "releaseVelocity": int(note.release_velocity),
        "probability": float(note.probability), "mute": bool(note.mute),
    }


def _new_midi_note(spec):
    spec = {"velocityDeviation": 0, "releaseVelocity": 0, "probability": 1.0,
            "mute": False, **spec}
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


def _current_routing_option(current, available):
    current_record = _routing_option(current)
    identifier_matches = [option for option in available if _routing_option(option)["id"] == current_record["id"]]
    if len(identifier_matches) == 1:
        return _routing_option(identifier_matches[0])
    aliases = {current_record["name"]}
    if current_record["name"].startswith("Ext: "):
        aliases.add(current_record["name"].removeprefix("Ext: "))
    if current_record["name"] == "Master":
        aliases.add("Main")
    if current_record["name"] == "":
        aliases.add("All Channels")
    label_matches = [option for option in available if _routing_option(option)["name"] in aliases]
    if len(label_matches) > 1:
        raise ValueError("ambiguous current routing label")
    return _routing_option(label_matches[0] if label_matches else current)


def _device_sidechain_routing(song, track_id, device_id, state_version):
    _, _, device = _device(song, track_id, device_id)
    supported = all(hasattr(device, attribute) for attribute in (
        "available_input_routing_types", "available_input_routing_channels", "input_routing_type", "input_routing_channel"))
    return {
        "stateVersion": state_version, "trackId": track_id, "deviceId": device_id,
        "device": _device_record(device, device_id),
        "sidechain": {
            "supported": supported,
            "type": _routing_option(device.input_routing_type) if supported else None,
            "channel": _routing_option(device.input_routing_channel) if supported else None,
            "availableTypes": [_routing_option(option) for option in device.available_input_routing_types] if supported else [],
            "availableChannels": [_routing_option(option) for option in device.available_input_routing_channels] if supported else [],
        },
    }


def _track_routing(song, track_id, state_version):
    _, track = _track(song, track_id)
    input_types = list(track.available_input_routing_types)
    input_channels = list(track.available_input_routing_channels)
    output_types = list(track.available_output_routing_types)
    output_channels = list(track.available_output_routing_channels)
    return {
        "stateVersion": state_version, "trackId": track_id,
        "input": {
            "type": _current_routing_option(track.current_input_routing, input_types),
            "channel": _current_routing_option(track.current_input_sub_routing, input_channels),
            "availableTypes": [_routing_option(option) for option in input_types],
            "availableChannels": [_routing_option(option) for option in input_channels],
        },
        "output": {
            "type": _current_routing_option(track.current_output_routing, output_types),
            "channel": _current_routing_option(track.current_output_sub_routing, output_channels),
            "availableTypes": [_routing_option(option) for option in output_types],
            "availableChannels": [_routing_option(option) for option in output_channels],
        },
        "monitoring": None if bool(getattr(track, "is_foldable", False)) else _enum_record(track.current_monitoring_state, ("in", "auto", "off")),
    }


def _value_record(parameter):
    return {"value": parameter.value, "min": parameter.min, "max": parameter.max}


def _return_mixer_record(track, index):
    return {
        "id": f"return-{index}", "name": track.name,
        "volume": _value_record(track.mixer_device.volume),
        "pan": _value_record(track.mixer_device.panning),
        "mute": bool(track.mute), "solo": bool(track.solo),
        "devices": [_device_tree(device, f"return-{index}:device-{device_index}")
                    for device_index, device in enumerate(getattr(track, "devices", ()))],
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


def _track_state_snapshot(song, track_id, state_version):
    track_index, track = _track(song, track_id)
    routing = _track_routing(song, track_id, state_version)
    return {
        "stateVersion": state_version, "trackId": track_id,
        "track": {**_track_record(song, track, track_index), "type": _track_type(track)},
        "mixer": {"volume": _value_record(track.mixer_device.volume), "pan": _value_record(track.mixer_device.panning),
                  "mute": bool(track.mute), "solo": bool(track.solo), "sends": _send_records(song, track)},
        "routing": {"input": routing["input"], "output": routing["output"], "monitoring": routing["monitoring"]},
        "devices": [{**_device_record(device, f"{track_id}:device-{index}"),
                     "parameters": [_parameter_record(parameter, parameter_index)
                                    for parameter_index, parameter in enumerate(device.parameters)]}
                    for index, device in enumerate(track.devices)],
    }


def _persisted_track_state(record):
    return {
        "format": "cavi-track-state-v1",
        "track": {"name": record["track"]["name"], "type": record["track"]["type"], "isGroup": record["track"]["isGroup"]},
        "mixer": {"volume": record["mixer"]["volume"]["value"], "pan": record["mixer"]["pan"]["value"],
                  "mute": record["mixer"]["mute"], "solo": record["mixer"]["solo"],
                  "sends": [{"id": item["id"], "name": item["name"], "value": item["value"]} for item in record["mixer"]["sends"]]},
        "routing": {"inputTypeId": record["routing"]["input"]["type"]["id"],
                    "inputChannelId": record["routing"]["input"]["channel"]["id"],
                    "outputTypeId": record["routing"]["output"]["type"]["id"],
                    "outputChannelId": record["routing"]["output"]["channel"]["id"],
                    "monitoring": record["routing"]["monitoring"]["value"] if record["routing"]["monitoring"] else None},
        "devices": [{"name": device["name"], "className": device["className"], "type": device["type"],
                     "parameters": [{"originalName": parameter["originalName"], "min": parameter["min"], "max": parameter["max"],
                                     "quantized": parameter["quantized"], "valueItems": parameter["valueItems"], "value": parameter["value"]}
                                    for parameter in device["parameters"]]}
                    for device in record["devices"]],
    }


def _device_chain_snapshot(song, owner_id, state_version):
    owner_id, owner = _device_owner(song, owner_id)
    return {
        "stateVersion": state_version, "trackId": owner_id,
        "devices": [{**_device_record(device, f"{owner_id}:device-{index}"),
                     "parameters": [_parameter_record(parameter, parameter_index)
                                    for parameter_index, parameter in enumerate(device.parameters)]}
                    for index, device in enumerate(owner.devices)],
    }


def _persisted_device_chain(record):
    return {
        "format": "cavi-device-chain-v1",
        "devices": [{"name": device["name"], "className": device["className"], "type": device["type"],
                     "parameters": [{"originalName": parameter["originalName"], "min": parameter["min"],
                                     "max": parameter["max"], "quantized": parameter["quantized"],
                                     "valueItems": parameter["valueItems"], "value": parameter["value"]}
                                    for parameter in device["parameters"]]}
                    for device in record["devices"]],
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


class _BrowserRootCollection:
    def __init__(self, name, items):
        self.name = name
        self.uri = None
        self.is_loadable = False
        self.is_folder = True
        self.children = items


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
    if root == "user_folders" and not hasattr(item, "children"):
        item = _BrowserRootCollection("User Folders", item)
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


def _chain_mixer(chain, audio=True):
    mixer = getattr(chain, "mixer_device", None) if audio else None
    def parameter_state(name):
        parameter = getattr(mixer, name, None)
        return None if parameter is None else {
            "value": float(parameter.value), "min": float(parameter.min),
            "max": float(parameter.max), "enabled": bool(parameter.is_enabled),
        }
    return {"volume": parameter_state("volume"), "pan": parameter_state("panning"),
            "sends": [{"index": index, "value": float(send.value), "min": float(send.min),
                       "max": float(send.max), "enabled": bool(send.is_enabled)}
                      for index, send in enumerate(getattr(mixer, "sends", ()))],
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
                "mixer": _chain_mixer(chain, audio=record["className"] != "MidiEffectGroupDevice"),
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


def _set_fingerprint(song):
    identity = (getattr(song, "file_path", ""), len(song.tracks),
                tuple(getattr(track, "name", "") for track in song.tracks),
                tuple(getattr(scene, "name", "") for scene in song.scenes),
                float(song.tempo))
    return hashlib.sha256(repr(identity).encode()).hexdigest()[:16]


def _drum_random(seed):
    state = seed & 0xffffffff
    while True:
        state = (state + 0x6D2B79F5) & 0xffffffff
        value = ((state ^ (state >> 15)) * (1 | state)) & 0xffffffff
        value = (value + (((value ^ (value >> 7)) * (61 | value)) & 0xffffffff)) ^ value
        yield ((value ^ (value >> 14)) & 0xffffffff) / 4294967296.0


def _validate_drum_variation_payload(clip, params):
    variation = params.get("variation")
    if not isinstance(variation, dict) or params.get("changes") != variation.get("changes") or \
            params.get("newNotes", []) != variation.get("newNotes"):
        raise ValueError("drum variation payload does not match its signed plan")
    note_range = variation.get("range", {})
    start_beat, end_beat = note_range.get("startBeat"), note_range.get("endBeat")
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start_beat, end_beat)) or \
            start_beat < 0 or end_beat <= start_beat or end_beat > float(clip.length):
        raise ValueError("drum variation range is invalid")
    lane_notes = variation.get("laneNotes")
    threshold = variation.get("preserveAccentsAbove")
    if not isinstance(lane_notes, list) or not lane_notes or any(type(pitch) is not int or pitch < 0 or pitch > 127 for pitch in lane_notes) or \
            len(lane_notes) != len(set(lane_notes)) or type(threshold) is not int or threshold < 1 or threshold > 127:
        raise ValueError("drum variation lanes or accent threshold are invalid")
    grid_steps = {"straight16": 4, "eighthTriplet": 3, "sixteenthTriplet": 6}
    grid = variation.get("grid")
    start_bar, bars, seed = variation.get("startBar"), variation.get("bars"), variation.get("seed")
    timing_amount, velocity_amount = variation.get("timingAmount"), variation.get("velocityAmount")
    if grid not in grid_steps or type(start_bar) is not int or start_bar < 0 or start_bar > 4095 or \
            type(bars) is not int or bars < 1 or bars > 16 or \
            type(seed) is not int or seed < 0 or seed > 0xffffffff or \
            not isinstance(timing_amount, (int, float)) or not math.isfinite(timing_amount) or timing_amount < 0 or timing_amount > .49 or \
            type(velocity_amount) is not int or velocity_amount < 0 or velocity_amount > 32:
        raise ValueError("drum variation deterministic options are invalid")
    signature = params["clipTiming"]["timeSignature"]
    bar_length = signature["numerator"] * 4 / signature["denominator"]
    step_beats = 1 / grid_steps[grid]
    if not float(bar_length * grid_steps[grid]).is_integer():
        raise ValueError("drum variation grid must be bar-aligned for the current time signature")
    if start_beat != start_bar * bar_length or end_beat != start_beat + bars * bar_length or \
            variation.get("stepBeats") != step_beats:
        raise ValueError("drum variation range or grid does not match its deterministic options")
    before_notes = params["before"]["notes"]
    before_by_id = {note["noteId"]: note for note in before_notes}
    changed_before = variation.get("changedBefore")
    preserved = variation.get("preservedNotes")
    if not isinstance(changed_before, list) or not isinstance(preserved, list) or \
            sorted(changed_before + preserved, key=lambda note: note["noteId"]) != sorted(before_notes, key=lambda note: note["noteId"]):
        raise ValueError("drum variation note partition does not match the observed clip")
    changed_ids = set()
    final_notes = [dict(note) for note in before_notes]
    final_by_id = {note["noteId"]: note for note in final_notes}
    allowed = {"noteId", "start", "velocity"}
    random_values = _drum_random(seed)
    expected_changes = []
    expected_changed_before = []
    for note in before_notes:
        if note["pitch"] in lane_notes and ((note["start"] < start_beat < note["start"] + note["duration"]) or
                                             (note["start"] < end_beat < note["start"] + note["duration"])):
            raise ValueError("target-lane note crosses the variation boundary")
    expected_preserved = [note for note in before_notes if note["pitch"] not in lane_notes or
                          not (start_beat <= note["start"] < end_beat)]
    selected = [note for note in before_notes if note["pitch"] in lane_notes and
                start_beat <= note["start"] < end_beat]
    for note in selected:
        if note["start"] + note["duration"] > end_beat:
            raise ValueError("target-lane note crosses the variation boundary")
        expected = {"noteId": note["noteId"]}
        if timing_amount > 0:
            magnitude = (next(random_values) * 2 - 1) * step_beats * timing_amount
            moved = note["start"] + magnitude
            if moved < start_beat:
                moved = note["start"] + abs(magnitude)
            if moved + note["duration"] > end_beat:
                moved = note["start"] - abs(magnitude)
            moved = max(start_beat, min(end_beat - note["duration"], moved))
            if moved != note["start"]:
                expected["start"] = moved
        if velocity_amount > 0 and note["velocity"] < threshold:
            delta = math.floor((next(random_values) * 2 - 1) * velocity_amount + .5)
            velocity = max(1, min(127, note["velocity"] + delta))
            if velocity != note["velocity"]:
                expected["velocity"] = velocity
        if len(expected) > 1:
            expected_changes.append(expected)
            expected_changed_before.append(note)
        else:
            expected_preserved.append(note)
    if params["changes"] != expected_changes or changed_before != expected_changed_before or \
            sorted(preserved, key=lambda note: note["noteId"]) != sorted(expected_preserved, key=lambda note: note["noteId"]):
        raise ValueError("drum variation changes do not match its deterministic plan")
    for change in params["changes"]:
        if set(change) - allowed:
            raise ValueError("drum variation contains unsupported change fields")
        note_id = change.get("noteId")
        before = before_by_id.get(note_id)
        if before is None or before not in changed_before or before["pitch"] not in lane_notes or note_id in changed_ids:
            raise ValueError("drum variation change target is invalid")
        changed_ids.add(note_id)
        if "velocity" in change and before["velocity"] >= threshold:
            raise ValueError("drum variation cannot alter a protected accent")
        if "velocity" in change and (type(change["velocity"]) is not int or change["velocity"] < 1 or change["velocity"] > 127):
            raise ValueError("drum variation velocity is outside its supported range")
        start = change.get("start", before["start"])
        if not isinstance(start, (int, float)) or not math.isfinite(start) or start < start_beat or start + before["duration"] > end_beat:
            raise ValueError("drum variation start is outside its selected range")
        final_by_id[note_id].update(change)
    if changed_ids != {note["noteId"] for note in changed_before}:
        raise ValueError("drum variation changed-note partition is incomplete")
    final_bar_start = end_beat - signature["numerator"] * 4 / signature["denominator"]
    fill = variation.get("fill")
    expected_new_notes = []
    if fill is not None:
        fill_grid = fill.get("grid") if isinstance(fill, dict) else None
        fill_steps = grid_steps.get(fill_grid)
        active_steps = fill.get("activeSteps") if isinstance(fill, dict) else None
        fill_note, fill_velocity, gate = fill.get("note"), fill.get("velocity"), fill.get("gate")
        steps_per_bar = bar_length * fill_steps if fill_steps else None
        if fill_steps is None or not float(steps_per_bar).is_integer() or type(fill_note) is not int or not 0 <= fill_note <= 127 or \
                type(fill_velocity) is not int or not 1 <= fill_velocity <= 127 or \
                not isinstance(gate, (int, float)) or not math.isfinite(gate) or not 0 < gate <= 1 or \
                not isinstance(active_steps, list) or not active_steps or len(active_steps) != len(set(active_steps)) or \
                any(type(step) is not int or step < 1 or step > steps_per_bar for step in active_steps):
            raise ValueError("drum variation fill options are invalid")
        fill_step_beats = 1 / fill_steps
        expected_new_notes = [{"pitch": fill_note, "start": final_bar_start + (step - 1) * fill_step_beats,
                               "duration": fill_step_beats * gate, "velocity": fill_velocity,
                               "velocityDeviation": 0, "releaseVelocity": 0, "probability": 1, "mute": False}
                              for step in sorted(active_steps)]
    if params.get("newNotes", []) != expected_new_notes:
        raise ValueError("drum variation fill notes do not match its deterministic plan")
    if not params["changes"] and not expected_new_notes:
        raise ValueError("drum variation would not change any notes")
    for note in params.get("newNotes", []):
        required = {"pitch", "start", "duration", "velocity", "velocityDeviation",
                    "releaseVelocity", "probability", "mute"}
        if set(note) != required or not isinstance(fill, dict) or note["pitch"] != fill.get("note"):
            raise ValueError("drum variation fill contains unsupported fields")
        if not all(isinstance(note[field], (int, float)) and math.isfinite(note[field])
                   for field in ("start", "duration")) or note["duration"] <= 0 or \
                note["start"] < final_bar_start or note["start"] + note["duration"] > end_beat:
            raise ValueError("drum variation fill is outside the final selected bar")
        final_notes.append(dict(note))
    for left_index, left in enumerate(final_notes):
        for right_index in range(left_index + 1, len(final_notes)):
            right = final_notes[right_index]
            involves_change = left.get("noteId") in changed_ids or right.get("noteId") in changed_ids or \
                "noteId" not in left or "noteId" not in right
            if involves_change and left["pitch"] == right["pitch"] and \
                    left["start"] < right["start"] + right["duration"] and \
                    right["start"] < left["start"] + left["duration"]:
                raise ValueError("drum variation would create a same-lane note collision")


def _basic_midi_note_records(clip):
    return [{"pitch": int(note[0]), "start": float(note[1]), "duration": float(note[2]),
             "velocity": int(note[3]), "mute": bool(note[4])}
            for note in clip.get_notes(0.0, 0, float(clip.length), 128)]


def _validate_midi_humanization_payload(clip, params):
    humanization = params.get("humanization")
    if not isinstance(humanization, dict) or params.get("changes") != humanization.get("changes") or \
            params.get("newNotes") != []:
        raise ValueError("MIDI humanization payload does not match its signed plan")
    options = humanization.get("options")
    note_ids = humanization.get("noteIds")
    if not isinstance(options, dict) or set(options) != {"seed", "gridBeats", "maxTimingOffsetBeats", "maxVelocityOffset"} or \
            not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)):
        raise ValueError("MIDI humanization options or note IDs are invalid")
    seed, grid = options["seed"], options["gridBeats"]
    timing, velocity_amount = options["maxTimingOffsetBeats"], options["maxVelocityOffset"]
    if type(seed) is not int or seed < 0 or seed > 0xffffffff or \
            not isinstance(grid, (int, float)) or not math.isfinite(grid) or grid <= 0 or grid > 128 or \
            not isinstance(timing, (int, float)) or not math.isfinite(timing) or timing < 0 or timing > grid / 2 or \
            type(velocity_amount) is not int or velocity_amount < 0 or velocity_amount > 126 or \
            (timing == 0 and velocity_amount == 0):
        raise ValueError("MIDI humanization deterministic options are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI humanization note IDs no longer exist")
    state = seed & 0xffffffff
    def random_value():
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xffffffff
        return state / 4294967296.0
    expected = []
    for note_id in note_ids:
        previous = by_id[note_id]
        offset = (random_value() * 2 - 1) * timing
        velocity_offset = math.floor(((random_value() * 2 - 1) * velocity_amount) + .5)
        start = max(0.0, min(float(clip.length) - previous["duration"], previous["start"] + offset))
        velocity = max(1, min(127, previous["velocity"] + velocity_offset))
        if start != previous["start"] or velocity != previous["velocity"]:
            expected.append({"noteId": note_id, "previous": previous, "start": start, "velocity": velocity})
    if not expected:
        raise ValueError("MIDI humanization would not change any selected notes")
    if params.get("changes") != expected:
        raise ValueError("MIDI humanization changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["start"] = change["start"]
        final[change["noteId"]]["velocity"] = change["velocity"]
    changed_ids = {change["noteId"] for change in expected}
    final_notes = list(final.values())
    for left_index, left in enumerate(final_notes):
        for right in final_notes[left_index + 1:]:
            if left["noteId"] not in changed_ids and right["noteId"] not in changed_ids:
                continue
            before_left, before_right = by_id[left["noteId"]], by_id[right["noteId"]]
            before_overlap = before_left["pitch"] == before_right["pitch"] and \
                before_left["start"] < before_right["start"] + before_right["duration"] and \
                before_right["start"] < before_left["start"] + before_left["duration"]
            after_overlap = left["pitch"] == right["pitch"] and \
                left["start"] < right["start"] + right["duration"] and \
                right["start"] < left["start"] + left["duration"]
            if after_overlap and not before_overlap:
                raise ValueError("MIDI humanization would create a same-pitch note collision")
    return final


def _validate_midi_velocity_curve_payload(clip, params):
    velocity_plan = params.get("velocityCurve")
    if not isinstance(velocity_plan, dict) or set(velocity_plan) != {"noteIds", "curve", "changes"} or \
            params.get("changes") != velocity_plan.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI velocity curve payload does not match its signed plan")
    note_ids = velocity_plan.get("noteIds")
    curve = velocity_plan.get("curve")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or not isinstance(curve, dict):
        raise ValueError("MIDI velocity curve options or note IDs are invalid")
    curve_type = curve.get("type")
    if curve_type == "fixed":
        if set(curve) != {"type", "velocity"} or type(curve["velocity"]) is not int or not 1 <= curve["velocity"] <= 127:
            raise ValueError("MIDI fixed velocity curve is invalid")
    elif curve_type == "accent":
        velocities = curve.get("velocities")
        if set(curve) != {"type", "velocities"} or not isinstance(velocities, list) or \
                not velocities or len(velocities) > 128 or \
                any(type(value) is not int or not 1 <= value <= 127 for value in velocities):
            raise ValueError("MIDI accent velocity curve is invalid")
    elif curve_type in ("crescendo", "decrescendo"):
        if set(curve) != {"type", "startVelocity", "endVelocity"} or \
                any(type(curve.get(field)) is not int or not 1 <= curve[field] <= 127
                    for field in ("startVelocity", "endVelocity")) or \
                (curve_type == "crescendo" and curve["endVelocity"] <= curve["startVelocity"]) or \
                (curve_type == "decrescendo" and curve["endVelocity"] >= curve["startVelocity"]):
            raise ValueError("MIDI linear velocity curve is invalid")
    else:
        raise ValueError("MIDI velocity curve type is invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI velocity curve note IDs no longer exist")
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    selected_ids = set(note_ids)
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI velocity curves require every note at each selected complete onset")
    onsets = sorted(selected_starts)
    velocity_by_start = {}
    for index, start in enumerate(onsets):
        if curve_type == "fixed":
            target = curve["velocity"]
        elif curve_type == "accent":
            target = curve["velocities"][index % len(curve["velocities"])]
        else:
            progress = 0 if len(onsets) == 1 else index / (len(onsets) - 1)
            target = math.floor(curve["startVelocity"] +
                                (curve["endVelocity"] - curve["startVelocity"]) * progress + .5)
        velocity_by_start[start] = target
    expected = []
    for note_id in note_ids:
        previous = by_id[note_id]
        target = velocity_by_start[previous["start"]]
        if target != previous["velocity"]:
            expected.append({"noteId": note_id, "previous": previous, "velocity": target})
    if not expected:
        raise ValueError("MIDI velocity curve would not change any selected notes")
    if params.get("changes") != expected:
        raise ValueError("MIDI velocity curve changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["velocity"] = change["velocity"]
    return final


def _validate_midi_gate_pattern_payload(clip, params):
    gate_plan = params.get("gatePattern")
    if not isinstance(gate_plan, dict) or set(gate_plan) != {"noteIds", "gridBeats", "gateRatios", "changes"} or \
            params.get("changes") != gate_plan.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI gate pattern payload does not match its signed plan")
    note_ids = gate_plan.get("noteIds")
    grid = gate_plan.get("gridBeats")
    ratios = gate_plan.get("gateRatios")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or \
            not isinstance(grid, (int, float)) or not math.isfinite(grid) or not 0 < grid <= 128 or \
            not isinstance(ratios, list) or not ratios or len(ratios) > 128 or \
            any(not isinstance(ratio, (int, float)) or not math.isfinite(ratio) or not 0 < ratio <= 1
                for ratio in ratios):
        raise ValueError("MIDI gate pattern options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI gate pattern note IDs no longer exist")
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    selected_ids = set(note_ids)
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI gate patterns require every note at each selected complete onset")
    duration_by_start = {start: grid * ratios[index % len(ratios)]
                         for index, start in enumerate(sorted(selected_starts))}
    expected = []
    for note_id in note_ids:
        previous = by_id[note_id]
        duration = duration_by_start[previous["start"]]
        if abs(duration - previous["duration"]) > 2e-7:
            expected.append({"noteId": note_id, "previous": previous, "duration": duration})
    if not expected:
        raise ValueError("MIDI gate pattern would not change any selected notes")
    if params.get("changes") != expected:
        raise ValueError("MIDI gate pattern changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        target = final[change["noteId"]]
        if target["start"] + change["duration"] > float(clip.length) + 2e-7:
            raise ValueError("MIDI gate pattern would extend a selected note beyond the clip")
        target["duration"] = change["duration"]
    changed_ids = {change["noteId"] for change in expected}
    final_notes = list(final.values())
    for left_index, left in enumerate(final_notes):
        for right in final_notes[left_index + 1:]:
            if left["noteId"] not in changed_ids and right["noteId"] not in changed_ids:
                continue
            before_left, before_right = by_id[left["noteId"]], by_id[right["noteId"]]
            before_overlap = before_left["pitch"] == before_right["pitch"] and \
                before_left["start"] < before_right["start"] + before_right["duration"] and \
                before_right["start"] < before_left["start"] + before_left["duration"]
            after_overlap = left["pitch"] == right["pitch"] and \
                left["start"] < right["start"] + right["duration"] and \
                right["start"] < left["start"] + left["duration"]
            if after_overlap and not before_overlap:
                raise ValueError("MIDI gate pattern would create a same-pitch note collision")
    return final


def _validate_midi_probability_pattern_payload(clip, params):
    probability_plan = params.get("probabilityPattern")
    if not isinstance(probability_plan, dict) or set(probability_plan) != {"noteIds", "probabilities", "changes"} or \
            params.get("changes") != probability_plan.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI probability pattern payload does not match its signed plan")
    note_ids = probability_plan.get("noteIds")
    probabilities = probability_plan.get("probabilities")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or \
            not isinstance(probabilities, list) or not probabilities or len(probabilities) > 128 or \
            any(not isinstance(probability, (int, float)) or not math.isfinite(probability) or
                not 0 <= probability <= 1 for probability in probabilities):
        raise ValueError("MIDI probability pattern options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI probability pattern note IDs no longer exist")
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    selected_ids = set(note_ids)
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI probability patterns require every note at each selected complete onset")
    probability_by_start = {start: probabilities[index % len(probabilities)]
                            for index, start in enumerate(sorted(selected_starts))}
    expected = []
    for note_id in note_ids:
        previous = by_id[note_id]
        probability = probability_by_start[previous["start"]]
        if abs(probability - previous["probability"]) > 2e-7:
            expected.append({"noteId": note_id, "previous": previous, "probability": probability})
    if not expected:
        raise ValueError("MIDI probability pattern would not change any selected notes")
    if params.get("changes") != expected:
        raise ValueError("MIDI probability pattern changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["probability"] = change["probability"]
    return final


def _validate_midi_ratchet_pattern_payload(clip, params):
    ratchet = params.get("ratchet")
    required = {"noteIds", "spanBeats", "repeatCounts", "gate", "removeNoteIds", "newNotes", "preservedNotes"}
    if not isinstance(ratchet, dict) or set(ratchet) != required or \
            params.get("removeNoteIds") != ratchet.get("removeNoteIds") or \
            params.get("newNotes") != ratchet.get("newNotes"):
        raise ValueError("MIDI ratchet payload does not match its signed plan")
    note_ids = ratchet.get("noteIds")
    span = ratchet.get("spanBeats")
    counts = ratchet.get("repeatCounts")
    gate = ratchet.get("gate")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or ratchet.get("removeNoteIds") != note_ids or \
            type(span) not in (int, float) or not math.isfinite(span) or not 0 < span <= 128 or \
            not isinstance(counts, list) or not counts or len(counts) > 128 or \
            any(type(count) is not int or not 1 <= count <= 64 for count in counts) or \
            type(gate) not in (int, float) or not math.isfinite(gate) or not 0 < gate <= 1:
        raise ValueError("MIDI ratchet options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI ratchet note IDs no longer exist")
    selected_ids = set(note_ids)
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI ratchets require every note at each selected complete onset")
    preserved = [note for note in current if note["noteId"] not in selected_ids]
    if ratchet.get("preservedNotes") != preserved:
        raise ValueError("MIDI ratchet preserved notes do not match the signed plan")
    count_by_start = {start: counts[index % len(counts)]
                      for index, start in enumerate(sorted(selected_starts))}
    expected = []
    for note_id in note_ids:
        source = by_id[note_id]
        count = count_by_start[source["start"]]
        step = span / count
        for repeat in range(count):
            expected.append({"sourceNoteId": note_id, "pitch": source["pitch"],
                             "start": source["start"] + step * repeat,
                             "duration": step * gate, "velocity": source["velocity"],
                             "velocityDeviation": source["velocityDeviation"],
                             "releaseVelocity": source["releaseVelocity"],
                             "probability": source["probability"], "mute": source["mute"]})
    supplied = ratchet.get("newNotes")
    if not isinstance(supplied, list) or len(supplied) != len(expected):
        raise ValueError("MIDI ratchet new notes do not match the signed plan")
    exact = ("sourceNoteId", "pitch", "velocity", "velocityDeviation",
             "releaseVelocity", "probability", "mute")
    if any(any(actual.get(field) != wanted[field] for field in exact) or
           abs(actual.get("start", math.inf) - wanted["start"]) > 2e-7 or
           abs(actual.get("duration", math.inf) - wanted["duration"]) > 2e-7
           for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI ratchet new notes do not match the signed plan")
    return preserved, expected


def _validate_midi_chord_doubling_payload(clip, params):
    doubling = params.get("chordDoubling")
    required = {"noteIds", "mode", "newNotes", "preservedNotes"}
    if not isinstance(doubling, dict) or set(doubling) != required or \
            params.get("removeNoteIds") != [] or params.get("newNotes") != doubling.get("newNotes"):
        raise ValueError("MIDI chord-doubling payload does not match its signed plan")
    note_ids, mode = doubling.get("noteIds"), doubling.get("mode")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or \
            mode not in ("bass_octave_down", "top_octave_up", "outer_octaves"):
        raise ValueError("MIDI chord-doubling options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI chord-doubling note IDs no longer exist")
    if doubling.get("preservedNotes") != current:
        raise ValueError("MIDI chord-doubling preserved notes do not match the signed plan")
    selected, starts = set(note_ids), {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in starts and note["noteId"] not in selected for note in current):
        raise ValueError("MIDI chord doubling requires every note at each selected complete onset")
    expected = []
    for start in sorted(starts):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        if len(chord) < 2:
            raise ValueError("each doubled MIDI chord onset must contain at least two notes")
        sources = ([(chord[0], -12)] if mode == "bass_octave_down" else
                   [(chord[-1], 12)] if mode == "top_octave_up" else
                   [(chord[0], -12), (chord[-1], 12)])
        for source, offset in sources:
            pitch = source["pitch"] + offset
            if not 0 <= pitch <= 127:
                raise ValueError("MIDI chord doubling would exceed the pitch range")
            generated = {"sourceNoteId": source["noteId"], "pitch": pitch,
                         "start": source["start"], "duration": source["duration"],
                         "velocity": source["velocity"], "velocityDeviation": source["velocityDeviation"],
                         "releaseVelocity": source["releaseVelocity"], "probability": source["probability"],
                         "mute": source["mute"]}
            if any(note["pitch"] == pitch and
                   note["start"] < generated["start"] + generated["duration"] - 2e-7 and
                   generated["start"] < note["start"] + note["duration"] - 2e-7
                   for note in current + expected):
                raise ValueError("MIDI chord doubling would create a same-pitch collision")
            expected.append(generated)
    if len(current) + len(expected) > 4096:
        raise ValueError("MIDI chord doubling supports at most 4096 final notes")
    supplied = doubling.get("newNotes")
    exact = ("sourceNoteId", "pitch", "velocity", "velocityDeviation",
             "releaseVelocity", "probability", "mute")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            any(actual.get(field) != wanted[field] for field in exact) or
            abs(actual.get("start", math.inf) - wanted["start"]) > 2e-7 or
            abs(actual.get("duration", math.inf) - wanted["duration"]) > 2e-7
            for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI chord-doubling new notes do not match the signed plan")
    return current, expected


def _validate_midi_diatonic_harmony_payload(clip, params):
    harmony = params.get("midiDiatonicHarmony")
    required = {"noteIds", "degreeOffsets", "scale", "newNotes", "preservedNotes"}
    if not isinstance(harmony, dict) or set(harmony) != required or \
            params.get("removeNoteIds") != [] or params.get("newNotes") != harmony.get("newNotes"):
        raise ValueError("MIDI diatonic-harmony payload does not match its signed plan")
    note_ids, offsets, scale = harmony.get("noteIds"), harmony.get("degreeOffsets"), harmony.get("scale")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or not isinstance(offsets, list) or not offsets or \
            len(offsets) > 16 or len(offsets) != len(set(offsets)) or \
            any(type(offset) is not int or offset == 0 or not -127 <= offset <= 127 for offset in offsets) or \
            not isinstance(scale, dict) or set(scale) != {"rootNote", "scaleName", "scaleIntervals"}:
        raise ValueError("MIDI diatonic-harmony options are invalid")
    musical = params.get("musicalContext", {}).get("key", {})
    expected_scale = {"rootNote": musical.get("rootNote"), "scaleName": musical.get("scaleName"),
                      "scaleIntervals": musical.get("scaleIntervals")}
    if scale != expected_scale:
        raise ValueError("MIDI diatonic-harmony scale does not match Live's current scale")
    root, intervals = scale.get("rootNote"), scale.get("scaleIntervals")
    if type(root) is not int or not 0 <= root <= 11 or not isinstance(intervals, list) or not intervals or \
            any(type(interval) is not int or not 0 <= interval <= 11 for interval in intervals) or \
            intervals != sorted(set(intervals)) or intervals[0] != 0:
        raise ValueError("MIDI diatonic-harmony scale is invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI diatonic-harmony note IDs no longer exist")
    if harmony.get("preservedNotes") != current:
        raise ValueError("MIDI diatonic-harmony preserved notes do not match the signed plan")
    expected, degree_count = [], len(intervals)
    for note_id in note_ids:
        source = by_id[note_id]
        delta = source["pitch"] - root
        octave, interval = delta // 12, delta % 12
        if interval not in intervals:
            raise ValueError("MIDI diatonic-harmony source note is not in the current scale")
        degree_index = intervals.index(interval)
        for offset in offsets:
            target_index = octave * degree_count + degree_index + offset
            pitch = root + (target_index // degree_count) * 12 + intervals[target_index % degree_count]
            if not 0 <= pitch <= 127:
                raise ValueError("MIDI diatonic harmony would exceed the pitch range")
            generated = {"sourceNoteId": note_id, "degreeOffset": offset, "pitch": pitch,
                         "start": source["start"], "duration": source["duration"],
                         "velocity": source["velocity"], "velocityDeviation": source["velocityDeviation"],
                         "releaseVelocity": source["releaseVelocity"], "probability": source["probability"],
                         "mute": source["mute"]}
            if any(note["pitch"] == pitch and
                   note["start"] < generated["start"] + generated["duration"] - 2e-7 and
                   generated["start"] < note["start"] + note["duration"] - 2e-7
                   for note in current + expected):
                raise ValueError("MIDI diatonic harmony would create a same-pitch collision")
            expected.append(generated)
    if len(current) + len(expected) > 4096:
        raise ValueError("MIDI diatonic harmony supports at most 4096 final notes")
    supplied = harmony.get("newNotes")
    exact = ("sourceNoteId", "degreeOffset", "pitch", "velocity", "velocityDeviation",
             "releaseVelocity", "probability", "mute")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            any(actual.get(field) != wanted[field] for field in exact) or
            abs(actual.get("start", math.inf) - wanted["start"]) > 2e-7 or
            abs(actual.get("duration", math.inf) - wanted["duration"]) > 2e-7
            for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI diatonic-harmony new notes do not match the signed plan")
    return current, expected


def _validate_midi_diatonic_chord_quality_payload(clip, params):
    quality = params.get("midiDiatonicChordQuality")
    required = {"noteIds", "rootDegrees", "chordSize", "chordSizes", "inversions", "voicingModes", "mode", "scale", "onsets", "changes",
                "removeNoteIds", "newNotes", "beforeNotes"}
    if not isinstance(quality, dict) or set(quality) != required or \
            params.get("changes") != quality.get("changes") or \
            params.get("removeNoteIds") != quality.get("removeNoteIds") or \
            params.get("newNotes") != quality.get("newNotes"):
        raise ValueError("MIDI chord-quality payload does not match its signed plan")
    note_ids, degrees = quality.get("noteIds"), quality.get("rootDegrees")
    chord_size, chord_sizes = quality.get("chordSize"), quality.get("chordSizes")
    inversions = quality.get("inversions")
    voicing_modes = quality.get("voicingModes")
    mode, scale = quality.get("mode"), quality.get("scale")
    scale_voices = {"triad": 3, "seventh": 4, "ninth": 5}
    chromatic_intervals = {
        "sus2": (0, 2, 7), "sus4": (0, 5, 7), "add6": (0, 4, 7, 9),
        "add9": (0, 4, 7, 14), "dominant7": (0, 4, 7, 10),
        "dominant9": (0, 4, 7, 10, 14), "dominant7_b9": (0, 4, 7, 10, 13),
        "dominant7_sharp9": (0, 4, 7, 10, 15), "dominant7_sharp11": (0, 4, 7, 10, 18),
        "dominant7_b13": (0, 4, 7, 10, 20), "dominant13": (0, 4, 7, 10, 14, 21),
    }
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or not isinstance(degrees, list) or not degrees or \
            any(type(degree) is not int for degree in degrees) or not isinstance(chord_sizes, list) or \
            not chord_sizes or any(recipe not in scale_voices and recipe not in chromatic_intervals
                                   for recipe in chord_sizes) or \
            not isinstance(inversions, list) or any(type(inversion) is not int or inversion < 0
                                                    for inversion in inversions) or \
            not isinstance(voicing_modes, list) or any(voicing_mode not in ("close", "open", "drop2", "drop3")
                                                       for voicing_mode in voicing_modes) or \
            (chord_size is not None and chord_size not in scale_voices and chord_size not in chromatic_intervals) or \
            (chord_size is not None and any(recipe != chord_size for recipe in chord_sizes)) or \
            mode not in ("preserve_register", "voice_leading") or not isinstance(scale, dict) or \
            set(scale) != {"rootNote", "scaleName", "scaleIntervals"}:
        raise ValueError("MIDI chord-quality options are invalid")
    musical = params.get("musicalContext", {}).get("key", {})
    expected_scale = {"rootNote": musical.get("rootNote"), "scaleName": musical.get("scaleName"),
                      "scaleIntervals": musical.get("scaleIntervals")}
    if scale != expected_scale:
        raise ValueError("MIDI chord-quality scale does not match Live's current scale")
    root, intervals = scale.get("rootNote"), scale.get("scaleIntervals")
    if type(root) is not int or not 0 <= root <= 11 or not isinstance(intervals, list) or not intervals or \
            any(type(interval) is not int or not 0 <= interval <= 11 for interval in intervals) or \
            intervals != sorted(set(intervals)) or intervals[0] != 0 or \
            any(degree < 1 or degree > len(intervals) for degree in degrees):
        raise ValueError("MIDI chord-quality scale or root degrees are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI chord-quality note IDs no longer exist")
    if quality.get("beforeNotes") != current:
        raise ValueError("MIDI chord-quality notes do not match the signed plan")
    selected, starts = set(note_ids), sorted({by_id[note_id]["start"] for note_id in note_ids})
    if any(note["start"] in starts and note["noteId"] not in selected for note in current):
        raise ValueError("MIDI chord quality requires every note at each selected complete onset")
    if len(degrees) != len(starts) or len(chord_sizes) != len(starts) or \
            len(inversions) != len(starts) or len(voicing_modes) != len(starts):
        raise ValueError("MIDI chord quality requires one root degree, chord recipe, inversion, and voicing mode per onset")
    expected_changes, expected_removals, expected_new, expected_onsets = [], [], [], []
    previous_target_root = None
    for start, degree, onset_chord_size, inversion, voicing_mode in \
            zip(starts, degrees, chord_sizes, inversions, voicing_modes):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        if len(chord) < 2:
            raise ValueError("each rebuilt MIDI onset must contain at least two source notes")
        pitch_class = (root + intervals[degree - 1]) % 12
        anchor = previous_target_root if mode == "voice_leading" and previous_target_root is not None else chord[0]["pitch"]
        target_root = min(range(pitch_class, 128, 12), key=lambda pitch: (abs(pitch - anchor), pitch))
        voice_count = scale_voices.get(onset_chord_size, len(chromatic_intervals.get(onset_chord_size, ())))
        if inversion >= voice_count:
            raise ValueError("MIDI chord quality inversion exceeds its chord voice count")
        if onset_chord_size in chromatic_intervals:
            root_position_pitches = [target_root + interval for interval in chromatic_intervals[onset_chord_size]]
        else:
            root_scale_index = ((target_root - root) // 12) * len(intervals) + degree - 1
            root_position_pitches = []
            for voice in range(voice_count):
                octave, degree_index = divmod(root_scale_index + voice * 2, len(intervals))
                root_position_pitches.append(root + octave * 12 + intervals[degree_index])
        inverted_pitches = sorted(pitch + (12 if index < inversion else 0)
                                  for index, pitch in enumerate(root_position_pitches))
        if voicing_mode == "open":
            target_pitches = sorted(pitch + (12 if index % 2 == 1 else 0)
                                    for index, pitch in enumerate(inverted_pitches))
        elif voicing_mode in ("drop2", "drop3"):
            drop_index = len(inverted_pitches) - (2 if voicing_mode == "drop2" else 3)
            if drop_index < 0:
                raise ValueError("MIDI chord quality drop voicing requires enough chord voices")
            target_pitches = sorted(pitch - (12 if index == drop_index else 0)
                                    for index, pitch in enumerate(inverted_pitches))
        else:
            target_pitches = inverted_pitches
        if any(pitch < 0 or pitch > 127 for pitch in target_pitches):
            raise ValueError("MIDI chord quality would exceed the pitch range")
        retained_count = min(len(chord), voice_count)
        for voice in range(retained_count):
            expected_changes.append({"noteId": chord[voice]["noteId"], "previous": chord[voice],
                                     "pitch": target_pitches[voice], "chordToneIndex": voice})
        expected_removals.extend(note["noteId"] for note in chord[voice_count:])
        source = chord[retained_count - 1]
        for voice in range(len(chord), voice_count):
            expected_new.append({"sourceNoteId": source["noteId"], "chordToneIndex": voice,
                                 "pitch": target_pitches[voice], "start": source["start"],
                                 "duration": source["duration"], "velocity": source["velocity"],
                                 "velocityDeviation": source["velocityDeviation"],
                                 "releaseVelocity": source["releaseVelocity"],
                                 "probability": source["probability"], "mute": source["mute"]})
        expected_onsets.append({"start": start, "rootDegree": degree, "chordSize": onset_chord_size,
                                "inversion": inversion,
                                "voicingMode": voicing_mode,
                                "targetRootPitch": target_root,
                                "sourceNoteIds": [note["noteId"] for note in chord],
                                "targetPitches": target_pitches})
        previous_target_root = target_root
    if quality.get("onsets") != expected_onsets or quality.get("changes") != expected_changes:
        raise ValueError("MIDI chord-quality changes do not match the signed plan")
    if quality.get("removeNoteIds") != expected_removals:
        raise ValueError("MIDI chord-quality removals do not match the signed plan")
    if quality.get("newNotes") != expected_new:
        raise ValueError("MIDI chord-quality new notes do not match the signed plan")
    change_by_id, removed = {change["noteId"]: change for change in expected_changes}, set(expected_removals)
    projected = [dict(note, pitch=change_by_id.get(note["noteId"], {}).get("pitch", note["pitch"]))
                 for note in current if note["noteId"] not in removed] + expected_new
    for index, left in enumerate(projected):
        for right in projected[index + 1:]:
            if left["pitch"] == right["pitch"] and \
                    left["start"] < right["start"] + right["duration"] - 2e-7 and \
                    right["start"] < left["start"] + left["duration"] - 2e-7:
                raise ValueError("MIDI chord quality would create a same-pitch collision")
    if len(projected) > 4096:
        raise ValueError("MIDI chord quality supports at most 4096 final notes")
    expected_final = {note["noteId"]: dict(note) for note in current if note["noteId"] not in removed}
    for change in expected_changes:
        expected_final[change["noteId"]]["pitch"] = change["pitch"]
    return expected_final, expected_new


def _midi_arpeggiation_random_key(pitch, seed):
    value = (pitch ^ seed) & 0xffffffff
    value = ((value ^ (value >> 16)) * 0x45d9f3b) & 0xffffffff
    value = ((value ^ (value >> 16)) * 0x45d9f3b) & 0xffffffff
    return (value ^ (value >> 16)) & 0xffffffff


def _validate_midi_chord_arpeggiation_payload(clip, params):
    arpeggiation = params.get("chordArpeggiation")
    required = {"noteIds", "mode", "stepBeats", "gate", "seed", "changes", "newNotes"}
    if not isinstance(arpeggiation, dict) or set(arpeggiation) != required or \
            params.get("changes") != arpeggiation.get("changes") or \
            params.get("newNotes") != arpeggiation.get("newNotes"):
        raise ValueError("MIDI chord-arpeggiation payload does not match its signed plan")
    note_ids = arpeggiation.get("noteIds")
    mode = arpeggiation.get("mode")
    step = arpeggiation.get("stepBeats")
    gate = arpeggiation.get("gate")
    seed = arpeggiation.get("seed")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or \
            mode not in ("up", "down", "up_down", "random") or \
            type(step) not in (int, float) or not math.isfinite(step) or step <= 0 or \
            type(gate) not in (int, float) or not math.isfinite(gate) or not 0 < gate <= 1 or \
            type(seed) is not int or not 0 <= seed <= 2147483647:
        raise ValueError("MIDI chord-arpeggiation options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI chord-arpeggiation note IDs no longer exist")
    selected_ids = set(note_ids)
    starts = {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI chord arpeggiation requires every note at each selected complete onset")
    preserved = [note for note in current if note["noteId"] not in selected_ids]
    onset_counts = {}
    for note in current:
        onset_counts[note["start"]] = onset_counts.get(note["start"], 0) + 1
    chord_onsets = sorted(start for start, count in onset_counts.items() if count >= 2)
    expected_changes = []
    expected_new = []
    for start in sorted(starts):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        if len(chord) < 2:
            raise ValueError("each arpeggiated MIDI chord onset must contain at least two notes")
        if mode == "down":
            ordered = list(reversed(chord))
        elif mode == "up_down":
            ordered = chord + list(reversed(chord[1:-1]))
        elif mode == "random":
            ordered = sorted(chord, key=lambda note: (_midi_arpeggiation_random_key(note["pitch"], seed),
                                                      note["pitch"]))
        else:
            ordered = chord
        next_onset = next((onset for onset in chord_onsets if onset > start + 2e-7), float(clip.length))
        duration = step * gate
        generated_notes = []
        for index, source in enumerate(ordered):
            generated = {"sourceNoteId": source["noteId"], "pitch": source["pitch"],
                         "start": start + index * step, "duration": duration,
                         "velocity": source["velocity"], "velocityDeviation": source["velocityDeviation"],
                         "releaseVelocity": source["releaseVelocity"], "probability": source["probability"],
                         "mute": source["mute"]}
            if generated["start"] + generated["duration"] > next_onset + 2e-7:
                raise ValueError("MIDI chord arpeggiation would cross a chord or clip boundary")
            if any(note["pitch"] == generated["pitch"] and
                   note["start"] < generated["start"] + generated["duration"] - 2e-7 and
                   generated["start"] < note["start"] + note["duration"] - 2e-7
                   for note in preserved + generated_notes):
                raise ValueError("MIDI chord arpeggiation would create a same-pitch collision")
            generated_notes.append(generated)
            if index < len(chord):
                expected_changes.append({"noteId": source["noteId"], "previous": source,
                                         "start": generated["start"], "duration": generated["duration"]})
            else:
                expected_new.append(generated)
    if len(current) + len(expected_new) > 4096:
        raise ValueError("MIDI chord arpeggiation supports at most 4096 final notes")
    if arpeggiation.get("changes") != expected_changes:
        raise ValueError("MIDI chord-arpeggiation changes do not match the signed plan")
    supplied = arpeggiation.get("newNotes")
    exact = ("sourceNoteId", "pitch", "velocity", "velocityDeviation",
             "releaseVelocity", "probability", "mute")
    if not isinstance(supplied, list) or len(supplied) != len(expected_new) or any(
            any(actual.get(field) != wanted[field] for field in exact) or
            abs(actual.get("start", math.inf) - wanted["start"]) > 2e-7 or
            abs(actual.get("duration", math.inf) - wanted["duration"]) > 2e-7
            for actual, wanted in zip(supplied, expected_new)):
        raise ValueError("MIDI chord-arpeggiation new notes do not match the signed plan")
    expected_final = {note["noteId"]: dict(note) for note in current}
    for change in expected_changes:
        expected_final[change["noteId"]]["start"] = change["start"]
        expected_final[change["noteId"]]["duration"] = change["duration"]
    return expected_final, expected_new


def _validate_midi_transposition_payload(clip, params):
    transposition = params.get("midiTransposition")
    if not isinstance(transposition, dict) or set(transposition) != {"noteIds", "semitones", "changes"} or \
            params.get("changes") != transposition.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI transposition payload does not match its signed plan")
    note_ids = transposition.get("noteIds")
    semitones = transposition.get("semitones")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or type(semitones) is not int or \
            semitones == 0 or not -127 <= semitones <= 127:
        raise ValueError("MIDI transposition options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI transposition note IDs no longer exist")
    selected = set(note_ids)
    retained = [note for note in current if note["noteId"] not in selected]
    expected_changes = []
    for note_id in note_ids:
        previous = by_id[note_id]
        pitch = previous["pitch"] + semitones
        if not 0 <= pitch <= 127:
            raise ValueError("MIDI transposition would exceed the MIDI range")
        candidate = dict(previous)
        candidate["pitch"] = pitch
        if any(note["pitch"] == pitch and
               note["start"] < candidate["start"] + candidate["duration"] - 2e-7 and
               candidate["start"] < note["start"] + note["duration"] - 2e-7
               for note in retained):
            raise ValueError("MIDI transposition would create a same-pitch collision")
        expected_changes.append({"noteId": note_id, "previous": previous, "pitch": pitch})
    if transposition.get("changes") != expected_changes:
        raise ValueError("MIDI transposition changes do not match the signed plan")
    expected_final = {note["noteId"]: dict(note) for note in current}
    for change in expected_changes:
        expected_final[change["noteId"]]["pitch"] = change["pitch"]
    return expected_final


def _validate_midi_diatonic_transposition_payload(clip, params):
    transposition = params.get("midiDiatonicTransposition")
    required = {"noteIds", "scaleSteps", "scale", "changes"}
    if not isinstance(transposition, dict) or set(transposition) != required or \
            params.get("changes") != transposition.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI diatonic-transposition payload does not match its signed plan")
    note_ids = transposition.get("noteIds")
    scale_steps = transposition.get("scaleSteps")
    scale = transposition.get("scale")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or type(scale_steps) is not int or \
            scale_steps == 0 or not -127 <= scale_steps <= 127 or not isinstance(scale, dict) or \
            set(scale) != {"rootNote", "scaleName", "scaleIntervals"}:
        raise ValueError("MIDI diatonic-transposition options are invalid")
    musical = params.get("musicalContext", {}).get("key", {})
    expected_scale = {"rootNote": musical.get("rootNote"), "scaleName": musical.get("scaleName"),
                      "scaleIntervals": musical.get("scaleIntervals")}
    if scale != expected_scale:
        raise ValueError("MIDI diatonic-transposition scale does not match Live's current scale")
    root = scale.get("rootNote")
    intervals = scale.get("scaleIntervals")
    if type(root) is not int or not 0 <= root <= 11 or not isinstance(intervals, list) or not intervals or \
            any(type(interval) is not int or not 0 <= interval <= 11 for interval in intervals) or \
            intervals != sorted(set(intervals)) or intervals[0] != 0:
        raise ValueError("MIDI diatonic-transposition scale is invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI diatonic-transposition note IDs no longer exist")
    retained = [note for note in current if note["noteId"] not in set(note_ids)]
    expected_changes = []
    degree_count = len(intervals)
    for note_id in note_ids:
        previous = by_id[note_id]
        delta = previous["pitch"] - root
        octave = delta // 12
        interval = delta % 12
        if interval not in intervals:
            raise ValueError("MIDI diatonic-transposition note is not in the current scale")
        target_index = octave * degree_count + intervals.index(interval) + scale_steps
        target_octave = target_index // degree_count
        target_degree = target_index % degree_count
        pitch = root + target_octave * 12 + intervals[target_degree]
        if not 0 <= pitch <= 127:
            raise ValueError("MIDI diatonic transposition would exceed the MIDI range")
        candidate = dict(previous)
        candidate["pitch"] = pitch
        if any(note["pitch"] == pitch and
               note["start"] < candidate["start"] + candidate["duration"] - 2e-7 and
               candidate["start"] < note["start"] + note["duration"] - 2e-7
               for note in retained):
            raise ValueError("MIDI diatonic transposition would create a same-pitch collision")
        expected_changes.append({"noteId": note_id, "previous": previous,
                                 "pitch": pitch, "degree": target_degree + 1})
    if transposition.get("changes") != expected_changes:
        raise ValueError("MIDI diatonic-transposition changes do not match the signed plan")
    expected_final = {note["noteId"]: dict(note) for note in current}
    for change in expected_changes:
        expected_final[change["noteId"]]["pitch"] = change["pitch"]
    return expected_final


def _validate_midi_scale_chord_remapping_payload(clip, params):
    remapping = params.get("midiScaleChordRemapping")
    required = {"noteIds", "targetDegrees", "mode", "scale", "onsets", "changes"}
    if not isinstance(remapping, dict) or set(remapping) != required or \
            params.get("changes") != remapping.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI scale-chord-remapping payload does not match its signed plan")
    note_ids, degrees = remapping.get("noteIds"), remapping.get("targetDegrees")
    mode, scale = remapping.get("mode"), remapping.get("scale")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or not isinstance(degrees, list) or not degrees or \
            any(type(degree) is not int for degree in degrees) or mode not in ("preserve_register", "voice_leading") or \
            not isinstance(scale, dict) or set(scale) != {"rootNote", "scaleName", "scaleIntervals"}:
        raise ValueError("MIDI scale-chord-remapping options are invalid")
    musical = params.get("musicalContext", {}).get("key", {})
    expected_scale = {"rootNote": musical.get("rootNote"), "scaleName": musical.get("scaleName"),
                      "scaleIntervals": musical.get("scaleIntervals")}
    if scale != expected_scale:
        raise ValueError("MIDI scale-chord-remapping scale does not match Live's current scale")
    root, intervals = scale.get("rootNote"), scale.get("scaleIntervals")
    if type(root) is not int or not 0 <= root <= 11 or not isinstance(intervals, list) or not intervals or \
            any(type(interval) is not int or not 0 <= interval <= 11 for interval in intervals) or \
            intervals != sorted(set(intervals)) or intervals[0] != 0 or \
            any(degree < 1 or degree > len(intervals) for degree in degrees):
        raise ValueError("MIDI scale-chord-remapping scale or target degrees are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI scale-chord-remapping note IDs no longer exist")
    selected = set(note_ids)
    starts = sorted({by_id[note_id]["start"] for note_id in note_ids})
    if any(note["start"] in starts and note["noteId"] not in selected for note in current):
        raise ValueError("MIDI scale chord remapping requires every note at each selected complete onset")
    if len(degrees) != len(starts):
        raise ValueError("MIDI scale chord remapping requires one target degree per onset")
    expected_changes, expected_onsets, previous_target_bass = [], [], None
    for start, degree in zip(starts, degrees):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        if len(chord) < 2:
            raise ValueError("each remapped MIDI onset must contain at least two notes")
        source_bass = chord[0]["pitch"]
        pitch_class = (root + intervals[degree - 1]) % 12
        anchor = previous_target_bass if mode == "voice_leading" and previous_target_bass is not None else source_bass
        target_bass = min(range(pitch_class, 128, 12), key=lambda pitch: (abs(pitch - anchor), pitch))
        semitones = target_bass - source_bass
        onset_ids = []
        for previous in chord:
            pitch = previous["pitch"] + semitones
            if not 0 <= pitch <= 127:
                raise ValueError("MIDI scale chord remapping would exceed the pitch range")
            expected_changes.append({"noteId": previous["noteId"], "previous": previous, "pitch": pitch})
            onset_ids.append(previous["noteId"])
        expected_onsets.append({"start": start, "targetDegree": degree, "sourceBassPitch": source_bass,
                                "targetBassPitch": target_bass, "semitones": semitones, "noteIds": onset_ids})
        previous_target_bass = target_bass
    if remapping.get("onsets") != expected_onsets or remapping.get("changes") != expected_changes:
        raise ValueError("MIDI scale-chord-remapping changes do not match the signed plan")
    if all(change["pitch"] == change["previous"]["pitch"] for change in expected_changes):
        raise ValueError("MIDI scale chord remapping would not change any notes")
    change_by_id = {change["noteId"]: change for change in expected_changes}
    projected = [dict(note, pitch=change_by_id.get(note["noteId"], {}).get("pitch", note["pitch"])) for note in current]
    for index, left in enumerate(projected):
        for right in projected[index + 1:]:
            if left["noteId"] not in change_by_id and right["noteId"] not in change_by_id:
                continue
            if left["pitch"] == right["pitch"] and \
                    left["start"] < right["start"] + right["duration"] - 2e-7 and \
                    right["start"] < left["start"] + left["duration"] - 2e-7:
                raise ValueError("MIDI scale chord remapping would create a same-pitch collision")
    expected_final = {note["noteId"]: dict(note) for note in current}
    for change in expected_changes:
        expected_final[change["noteId"]]["pitch"] = change["pitch"]
    return expected_final


def _validate_midi_strum_pattern_payload(clip, params):
    strum = params.get("strumPattern")
    if not isinstance(strum, dict) or set(strum) != {"noteIds", "direction", "spreadBeats", "changes"} or \
            params.get("changes") != strum.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI strum payload does not match its signed plan")
    note_ids = strum.get("noteIds")
    direction = strum.get("direction")
    spread = strum.get("spreadBeats")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or direction not in ("up", "down", "alternating") or \
            type(spread) not in (int, float) or not math.isfinite(spread) or not 0 < spread <= 4:
        raise ValueError("MIDI strum options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI strum note IDs no longer exist")
    selected_ids = set(note_ids)
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI strums require every note at each selected complete onset")
    expected = []
    for onset_index, start in enumerate(sorted(selected_starts)):
        chord = [by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start]
        if len(chord) < 2:
            raise ValueError("each MIDI strum onset must contain at least two notes")
        ascending = direction == "up" or direction == "alternating" and onset_index % 2 == 0
        chord.sort(key=lambda note: (note["pitch"] if ascending else -note["pitch"], note["noteId"]))
        step = spread / (len(chord) - 1)
        for rank, previous in enumerate(chord):
            next_start = start + step * rank
            duration = previous["start"] + previous["duration"] - next_start
            if duration <= 2e-7:
                raise ValueError("MIDI strum spread must leave every selected note with positive duration")
            expected.append({"noteId": previous["noteId"], "previous": previous,
                             "start": next_start, "duration": duration})
    supplied = params.get("changes")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            actual.get("noteId") != wanted["noteId"] or actual.get("previous") != wanted["previous"] or
            abs(actual.get("start", math.inf) - wanted["start"]) > 2e-7 or
            abs(actual.get("duration", math.inf) - wanted["duration"]) > 2e-7
            for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI strum changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["start"] = change["start"]
        final[change["noteId"]]["duration"] = change["duration"]
    return final


def _validate_midi_chord_inversion_payload(clip, params):
    inversion = params.get("chordInversion")
    if not isinstance(inversion, dict) or set(inversion) != {"noteIds", "direction", "steps", "changes"} or \
            params.get("changes") != inversion.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI chord inversion payload does not match its signed plan")
    note_ids = inversion.get("noteIds")
    direction = inversion.get("direction")
    steps = inversion.get("steps")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or direction not in ("up", "down") or \
            type(steps) is not int or not 1 <= steps <= 127:
        raise ValueError("MIDI chord inversion options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI chord inversion note IDs no longer exist")
    selected_ids = set(note_ids)
    selected_starts = {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in selected_starts and note["noteId"] not in selected_ids for note in current):
        raise ValueError("MIDI chord inversions require every note at each selected complete onset")
    expected = []
    for start in sorted(selected_starts):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        if len(chord) < 2:
            raise ValueError("each MIDI chord inversion onset must contain at least two notes")
        for rank, previous in enumerate(chord):
            octaves = ((steps + len(chord) - 1 - rank) // len(chord) if direction == "up"
                       else (steps + rank) // len(chord))
            pitch = previous["pitch"] + octaves * (12 if direction == "up" else -12)
            if not 0 <= pitch <= 127:
                raise ValueError("MIDI chord inversion would exceed the pitch range")
            expected.append({"noteId": previous["noteId"], "previous": previous, "pitch": pitch})
    supplied = params.get("changes")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            actual.get("noteId") != wanted["noteId"] or actual.get("previous") != wanted["previous"] or
            actual.get("pitch") != wanted["pitch"] for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI chord inversion changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["pitch"] = change["pitch"]
    before_collisions = set()
    after_collisions = set()
    for left in range(len(current)):
        for right in range(left + 1, len(current)):
            pair = tuple(sorted((current[left]["noteId"], current[right]["noteId"])))
            before_overlap = current[left]["pitch"] == current[right]["pitch"] and \
                current[left]["start"] < current[right]["start"] + current[right]["duration"] - 2e-7 and \
                current[right]["start"] < current[left]["start"] + current[left]["duration"] - 2e-7
            after_left, after_right = final[current[left]["noteId"]], final[current[right]["noteId"]]
            after_overlap = after_left["pitch"] == after_right["pitch"] and \
                after_left["start"] < after_right["start"] + after_right["duration"] - 2e-7 and \
                after_right["start"] < after_left["start"] + after_left["duration"] - 2e-7
            if before_overlap:
                before_collisions.add(pair)
            if after_overlap:
                after_collisions.add(pair)
    if after_collisions - before_collisions:
        raise ValueError("MIDI chord inversion would create a same-pitch collision")
    return final


def _validate_midi_drop_voicing_payload(clip, params):
    voicing = params.get("dropVoicing")
    if not isinstance(voicing, dict) or set(voicing) != {"noteIds", "mode", "changes"} or \
            params.get("changes") != voicing.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI drop voicing payload does not match its signed plan")
    note_ids, mode = voicing.get("noteIds"), voicing.get("mode")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or mode not in ("drop_2", "drop_3", "drop_2_and_4"):
        raise ValueError("MIDI drop voicing options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI drop voicing note IDs no longer exist")
    selected, starts = set(note_ids), {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in starts and note["noteId"] not in selected for note in current):
        raise ValueError("MIDI drop voicings require every note at each selected complete onset")
    expected = []
    for start in sorted(starts):
        chord = sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                       key=lambda note: (note["pitch"], note["noteId"]))
        minimum = 3 if mode == "drop_2" else 4
        if len(chord) < minimum:
            raise ValueError("MIDI drop voicing onset does not contain enough notes")
        ranks = ([len(chord) - 2] if mode == "drop_2" else [len(chord) - 3] if mode == "drop_3"
                 else [len(chord) - 2, len(chord) - 4])
        for rank, previous in enumerate(chord):
            pitch = previous["pitch"] - (12 if rank in ranks else 0)
            if pitch < 0:
                raise ValueError("MIDI drop voicing would exceed the pitch range")
            expected.append({"noteId": previous["noteId"], "previous": previous, "pitch": pitch})
    supplied = params.get("changes")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            actual.get("noteId") != wanted["noteId"] or actual.get("previous") != wanted["previous"] or
            actual.get("pitch") != wanted["pitch"] for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI drop voicing changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["pitch"] = change["pitch"]
    for left in range(len(current)):
        for right in range(left + 1, len(current)):
            before_left, before_right = current[left], current[right]
            after_left, after_right = final[before_left["noteId"]], final[before_right["noteId"]]
            before_overlap = before_left["pitch"] == before_right["pitch"] and \
                before_left["start"] < before_right["start"] + before_right["duration"] - 2e-7 and \
                before_right["start"] < before_left["start"] + before_left["duration"] - 2e-7
            after_overlap = after_left["pitch"] == after_right["pitch"] and \
                after_left["start"] < after_right["start"] + after_right["duration"] - 2e-7 and \
                after_right["start"] < after_left["start"] + after_left["duration"] - 2e-7
            if after_overlap and not before_overlap:
                raise ValueError("MIDI drop voicing would create a same-pitch collision")
    return final


def _validate_midi_chord_voice_leading_payload(clip, params):
    leading = params.get("chordVoiceLeading")
    required = {"noteIds", "mode", "minPitch", "maxPitch", "totalMovementSemitones", "changes"}
    if not isinstance(leading, dict) or set(leading) != required or \
            params.get("changes") != leading.get("changes") or params.get("newNotes") != []:
        raise ValueError("MIDI chord voice-leading payload does not match its signed plan")
    note_ids, mode = leading.get("noteIds"), leading.get("mode")
    min_pitch, max_pitch = leading.get("minPitch"), leading.get("maxPitch")
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 4096 or \
            any(type(note_id) is not int or note_id < 0 for note_id in note_ids) or \
            len(note_ids) != len(set(note_ids)) or mode not in ("all_voices", "preserve_bass") or \
            type(min_pitch) is not int or type(max_pitch) is not int or \
            not 0 <= min_pitch <= max_pitch <= 127:
        raise ValueError("MIDI chord voice-leading options or note IDs are invalid")
    current = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
    by_id = {note["noteId"]: note for note in current}
    if len(by_id) != len(current) or any(note_id not in by_id for note_id in note_ids):
        raise ValueError("one or more MIDI chord voice-leading note IDs no longer exist")
    selected, starts = set(note_ids), {by_id[note_id]["start"] for note_id in note_ids}
    if any(note["start"] in starts and note["noteId"] not in selected for note in current):
        raise ValueError("MIDI chord voice leading requires every note at each selected complete onset")
    chords = [sorted((by_id[note_id] for note_id in note_ids if by_id[note_id]["start"] == start),
                     key=lambda note: (note["pitch"], note["noteId"])) for start in sorted(starts)]
    if len(chords) < 2 or len(chords[0]) < 2 or any(len(chord) != len(chords[0]) for chord in chords):
        raise ValueError("MIDI chord voice leading requires equal chord voice counts")
    if any(not min_pitch <= note["pitch"] <= max_pitch for note in chords[0]):
        raise ValueError("anchored MIDI chord does not fit the requested pitch range")

    expected = [{"noteId": note["noteId"], "previous": note, "pitch": note["pitch"]}
                for note in chords[0]]
    previous_pitches = [note["pitch"] for note in chords[0]]
    total_movement = 0
    for chord in chords[1:]:
        states = [(0, 0, [])]
        for index, note in enumerate(chord):
            pitch_class = note["pitch"] % 12
            candidates = ([note["pitch"]] if mode == "preserve_bass" and index == 0 else
                          [pitch for pitch in range(pitch_class, 128, 12) if min_pitch <= pitch <= max_pitch])
            next_states = []
            for candidate in candidates:
                proposals = [(movement + abs(candidate - previous_pitches[index]),
                              displacement + abs(candidate - note["pitch"]), pitches + [candidate])
                             for movement, displacement, pitches in states
                             if not pitches or candidate > pitches[-1]]
                if proposals:
                    next_states.append(min(proposals, key=lambda state: (state[0], state[1], state[2])))
            states = next_states
        if not states:
            raise ValueError("MIDI chord voice leading cannot preserve voice order in range")
        movement, _, pitches = min(states, key=lambda state: (state[0], state[1], state[2]))
        total_movement += movement
        expected.extend({"noteId": note["noteId"], "previous": note, "pitch": pitch}
                        for note, pitch in zip(chord, pitches))
        previous_pitches = pitches
    if leading.get("totalMovementSemitones") != total_movement:
        raise ValueError("MIDI chord voice-leading movement does not match the signed plan")
    supplied = params.get("changes")
    if not isinstance(supplied, list) or len(supplied) != len(expected) or any(
            actual.get("noteId") != wanted["noteId"] or actual.get("previous") != wanted["previous"] or
            actual.get("pitch") != wanted["pitch"] for actual, wanted in zip(supplied, expected)):
        raise ValueError("MIDI chord voice-leading changes do not match the signed plan")
    final = {note["noteId"]: dict(note) for note in current}
    for change in expected:
        final[change["noteId"]]["pitch"] = change["pitch"]
    for left in range(len(current)):
        for right in range(left + 1, len(current)):
            before_left, before_right = current[left], current[right]
            after_left, after_right = final[before_left["noteId"]], final[before_right["noteId"]]
            before_overlap = before_left["pitch"] == before_right["pitch"] and \
                before_left["start"] < before_right["start"] + before_right["duration"] - 2e-7 and \
                before_right["start"] < before_left["start"] + before_left["duration"] - 2e-7
            after_overlap = after_left["pitch"] == after_right["pitch"] and \
                after_left["start"] < after_right["start"] + after_right["duration"] - 2e-7 and \
                after_right["start"] < after_left["start"] + after_left["duration"] - 2e-7
            if after_overlap and not before_overlap:
                raise ValueError("MIDI chord voice leading would create a same-pitch collision")
    return final


def _validate_scale_melody_payload(song, params, state_version, fingerprint):
    if params.get("expectedStateVersion") != state_version:
        raise ValueError("melody state version changed")
    if params.get("musicalContext") != _song_musical_context(song, state_version):
        raise ValueError("melody musical context changed since observation")
    grid_reference = params.get("gridReference", {})
    current_grid = {"tempoBpm": float(song.tempo), "timeSignature": {
        "numerator": int(song.signature_numerator), "denominator": int(song.signature_denominator)}}
    if {"tempoBpm": grid_reference.get("tempoBpm"),
            "timeSignature": grid_reference.get("timeSignature")} != current_grid or \
            grid_reference.get("setFingerprint") != fingerprint:
        raise ValueError("melody song grid changed since observation")
    melody = params.get("melody")
    if not isinstance(melody, dict) or params.get("notes") != melody.get("notes") or \
            params.get("lengthBeats") != melody.get("lengthBeats"):
        raise ValueError("melody payload does not match its signed plan")
    steps = {"straight16": 4, "eighthTriplet": 3, "sixteenthTriplet": 6}
    grid = melody.get("grid")
    motif_bars, repeats = melody.get("motifBars"), melody.get("repeats")
    gate, velocity = melody.get("gate"), melody.get("velocity")
    base_pitch, min_pitch, max_pitch = melody.get("basePitch"), melody.get("minPitch"), melody.get("maxPitch")
    if grid not in steps or type(motif_bars) is not int or not 1 <= motif_bars <= 16 or \
            type(repeats) is not int or not 1 <= repeats <= 16 or \
            not isinstance(gate, (int, float)) or not math.isfinite(gate) or not 0 < gate <= 1 or \
            type(velocity) is not int or not 1 <= velocity <= 127 or \
            any(type(value) is not int or not 0 <= value <= 127 for value in (base_pitch, min_pitch, max_pitch)) or \
            min_pitch > max_pitch or not min_pitch <= base_pitch <= max_pitch or base_pitch % 12 != int(song.root_note):
        raise ValueError("melody deterministic options are invalid")
    bar_length = int(song.signature_numerator) * 4 / int(song.signature_denominator)
    steps_per_bar = bar_length * steps[grid]
    if not float(steps_per_bar).is_integer():
        raise ValueError("melody grid must land on every bar boundary")
    steps_per_motif = int(steps_per_bar) * motif_bars
    step_beats = 1 / steps[grid]
    motif_length = bar_length * motif_bars
    if melody.get("stepsPerMotif") != steps_per_motif or melody.get("stepBeats") != step_beats or \
            melody.get("motifLengthBeats") != motif_length or melody.get("lengthBeats") != motif_length * repeats:
        raise ValueError("melody timing does not match its deterministic grid")
    key = params["musicalContext"]["key"]
    intervals = key["scaleIntervals"]
    scale = melody.get("scale", {})
    if scale.get("rootNote") != key["rootNote"] or scale.get("intervals") != intervals:
        raise ValueError("melody scale does not match the observed Live key")
    motif = melody.get("motif")
    if not isinstance(motif, list) or not motif or len(motif) * repeats > 4096:
        raise ValueError("melody motif is empty or exceeds 4096 MIDI notes")
    expected_motif = []
    seen = set()
    for event in motif:
        step, degree = event.get("step"), event.get("degree")
        octave, event_velocity = event.get("octaveOffset"), event.get("velocity")
        if type(step) is not int or not 0 <= step < steps_per_motif or step in seen or \
                type(degree) is not int or not 1 <= degree <= 9 or \
                type(octave) is not int or not -4 <= octave <= 4 or \
                type(event_velocity) is not int or not 1 <= event_velocity <= 127:
            raise ValueError("melody event is invalid")
        seen.add(step)
        degree_index = degree - 1
        scale_index = degree_index % len(intervals)
        pitch = base_pitch + intervals[scale_index] + 12 * (degree_index // len(intervals) + octave)
        if pitch < min_pitch or pitch > max_pitch:
            raise ValueError("melody event pitch is outside the requested range")
        expected_motif.append({"step": step, "degree": degree, "octaveOffset": octave,
                               "velocity": event_velocity, "pitch": pitch, "pitchClass": pitch % 12,
                               "noteName": scale["noteNames"][scale_index]})
    expected_motif.sort(key=lambda event: event["step"])
    if motif != expected_motif:
        raise ValueError("melody motif does not match its deterministic scale plan")
    duration = step_beats * gate
    expected_notes = [{"pitch": event["pitch"], "start": repeat * motif_length + event["step"] * step_beats,
                       "duration": duration, "velocity": event["velocity"], "mute": False}
                      for repeat in range(repeats) for event in expected_motif]
    if params["notes"] != expected_notes:
        raise ValueError("melody notes do not match its deterministic motif")


def dispatch_request(song, request, state_version, application=None):
    method = request["method"]
    params = request.get("params", {})
    fingerprint = _set_fingerprint(song)
    if method == "get_live_state":
        return {"stateVersion": state_version, "setFingerprint": fingerprint, "tempo": song.tempo, "isPlaying": song.is_playing, "bridgeVersion": BRIDGE_VERSION, "capabilities": list(CAPABILITIES),
                "nativeApiSupport": {"groupTracks": callable(getattr(song, "group_tracks", None)),
                                     "ungroupTrack": callable(getattr(song, "ungroup_track", None))}}
    if method == "get_transport_context":
        return _transport_context(song, state_version)
    if method == "get_looper_performance_context":
        return _looper_performance_context(song, params["trackId"], params["deviceId"], state_version)
    if method == "get_beat_repeat_performance_context":
        return _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version)
    if method == "set_beat_repeat_grid":
        if params.get("expectedStateVersion") != state_version:
            raise ValueError("Beat Repeat state version changed")
        before = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version)
        if params.get("before") != before:
            raise ValueError("Beat Repeat performance context changed")
        grid_value = params.get("gridValue")
        grid_display = params.get("gridDisplayValue")
        matches = [choice for choice in before["gridChoices"]
                   if choice["value"] == grid_value and choice["displayValue"] == grid_display]
        label_matches = [choice for choice in before["gridChoices"]
                         if choice["displayValue"] == grid_display]
        if (type(grid_value) is not int or type(grid_display) is not str or
                len(matches) != 1 or len(label_matches) != 1):
            raise ValueError("exact native Beat Repeat grid choice is unavailable")
        grid = before["controls"]["Grid"]
        if grid_value == grid["value"]:
            raise ValueError("native Beat Repeat Grid is already selected")
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        device.parameters[int(grid["id"].removeprefix("parameter-"))].value = grid_value
        observed = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version + 1)
        observed["gridParameterMatchesTarget"] = (
            observed["controls"]["Grid"]["value"] == grid_value and
            observed["controls"]["Grid"]["displayValue"] == grid_display)
        observed["gridDisplayValue"] = grid_display
        return observed
    if method == "set_beat_repeat_interval":
        if params.get("expectedStateVersion") != state_version:
            raise ValueError("Beat Repeat state version changed")
        before = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version)
        if params.get("before") != before:
            raise ValueError("Beat Repeat performance context changed")
        interval_value = params.get("intervalValue")
        interval_display = params.get("intervalDisplayValue")
        matches = [choice for choice in before["intervalChoices"]
                   if choice["value"] == interval_value and choice["displayValue"] == interval_display]
        label_matches = [choice for choice in before["intervalChoices"]
                         if choice["displayValue"] == interval_display]
        if (type(interval_value) is not int or type(interval_display) is not str or
                len(matches) != 1 or len(label_matches) != 1):
            raise ValueError("exact native Beat Repeat interval choice is unavailable")
        interval = before["controls"].get("Interval")
        if interval is None or interval_value == interval["value"]:
            raise ValueError("native Beat Repeat Interval is unavailable or already selected")
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        device.parameters[int(interval["id"].removeprefix("parameter-"))].value = interval_value
        observed = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version + 1)
        observed["intervalParameterMatchesTarget"] = (
            observed["controls"]["Interval"]["value"] == interval_value and
            observed["controls"]["Interval"]["displayValue"] == interval_display)
        observed["intervalDisplayValue"] = interval_display
        return observed
    if method == "set_beat_repeat_enabled":
        if params.get("expectedStateVersion") != state_version:
            raise ValueError("Beat Repeat state version changed")
        before = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version)
        if params.get("before") != before:
            raise ValueError("Beat Repeat performance context changed")
        enabled = params.get("enabled")
        if type(enabled) is not bool:
            raise ValueError("Beat Repeat enabled must be boolean")
        repeat = before["controls"]["Repeat"]
        target = "On" if enabled else "Off"
        if not repeat["enabled"] or not repeat["quantized"] or repeat["valueItems"].count(target) != 1:
            raise ValueError("native Beat Repeat Repeat control is unavailable")
        target_value = repeat["min"] + repeat["valueItems"].index(target)
        if target_value > repeat["max"] or target_value == repeat["value"]:
            raise ValueError("native Beat Repeat Repeat control is unavailable or already selected")
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        device.parameters[int(repeat["id"].removeprefix("parameter-"))].value = target_value
        observed = _beat_repeat_performance_context(song, params["trackId"], params["deviceId"], state_version + 1)
        observed["enabled"] = enabled
        observed["repeatParameterMatchesTarget"] = observed["controls"]["Repeat"]["displayValue"] == target
        return observed
    if method == "set_looper_state":
        if params.get("expectedStateVersion") != state_version:
            raise ValueError("Looper state version changed")
        before = _looper_performance_context(song, params["trackId"], params["deviceId"], state_version)
        if params.get("before") != before:
            raise ValueError("Looper performance context changed")
        target_state = params["targetState"]
        if target_state not in ("Stop", "Record", "Play", "Overdub"):
            raise ValueError("unknown Looper target state")
        state_record = before["controls"]["State"]
        if not state_record["enabled"] or not state_record["quantized"]:
            raise ValueError("Looper State control is unavailable")
        choices = state_record["valueItems"]
        if choices.count(target_state) != 1:
            raise ValueError("Looper target state is not an exact native choice")
        target_value = state_record["min"] + choices.index(target_state)
        if target_value > state_record["max"] or target_value == state_record["value"]:
            raise ValueError("Looper target state is unavailable or already selected")
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        device.parameters[int(state_record["id"].removeprefix("parameter-"))].value = target_value
        observed = _looper_performance_context(song, params["trackId"], params["deviceId"], state_version + 1)
        observed["targetState"] = target_state
        observed["stateParameterMatchesTarget"] = observed["controls"]["State"]["displayValue"] == target_state
        return observed
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
    if method == "get_clip_groove_context":
        _, track = _track(song, params["trackId"])
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        audio = bool(getattr(clip, "is_audio_clip", False))
        source_method = "get_audio_clip_state" if audio else "get_midi_clip_notes_extended"
        return {"stateVersion": state_version, "trackId": params["trackId"], "clipId": params["clipId"],
            "trackName": track.name, "clipName": clip.name,
            "source": {"type": "audio" if audio else "midi", "content": dispatch_request(song, {"method": source_method, "params": params}, state_version)},
            "timing": _clip_timing(song, params["trackId"], params["clipId"], state_version),
            "musicalContext": _song_musical_context(song, state_version)}
    if method == "set_groove":
        if _song_musical_context(song, state_version) != params["before"]:
            raise ValueError("groove pool or musical context changed")
        grooves = _grooves(song)
        matches = [groove for index, groove in enumerate(grooves) if f"groove-{index}" == params["grooveId"]]
        if len(matches) != 1:
            raise ValueError("unknown groove")
        groove = matches[0]
        properties = {"baseGrid": "base", "name": "name", "timingAmount": "timing_amount", "quantizationAmount": "quantization_amount",
            "randomAmount": "random_amount", "velocityAmount": "velocity_amount"}
        changes = params["changes"]
        if not changes or not set(changes).issubset(properties):
            raise ValueError("invalid groove changes")
        values = {}
        for key, change in changes.items():
            value = change["value"]
            if key == "baseGrid":
                matches = [native for name, native in _groove_base_options(groove) if {"value": int(native), "name": name} == value]
                if len(matches) != 1:
                    raise ValueError("unknown or unavailable native groove base grid")
                value = matches[0]
            elif key == "name":
                if not isinstance(value, str) or not value.strip():
                    raise ValueError("invalid groove name")
            else:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not (-100 if key == "velocityAmount" else 0) <= value <= 100:
                    raise ValueError("invalid groove percentage")
                value = float(value)
            values[properties[key]] = value
        with _undo_step(song):
            for attribute, value in values.items():
                setattr(groove, attribute, value)
        return _song_musical_context(song, state_version + 1)
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
        if "monitoring" in changes and bool(getattr(track, "is_foldable", False)):
            raise ValueError("monitoring is not supported on Group Tracks")
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
        destinations = []
        for route_change in params["routes"]:
            _, track = _track(song, route_change["trackId"])
            matches = [option for option in track.available_output_routing_types
                       if _routing_id(option) == route_change["outputTypeId"]]
            if len(matches) != 1:
                raise ValueError("bus output routing is missing or ambiguous")
            destinations.append((route_change["trackId"], track, _routing_option(matches[0])["name"]))
        for track_id, track, name in destinations:
            track.current_output_routing = name
            routes.append(_track_routing(song, track_id, state_version + 1))
        return {"stateVersion": state_version + 1, "busTrackId": params["busTrackId"], "routes": routes}
    if method in ("get_browser_items", "get_factory_browser_items"):
        item = _browser_item(application, params["root"], params.get("path", []))
        children = item.children
        total_children = len(children)
        offset = params.get("offset", 0)
        limit = params.get("limit")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError("browser offset must be a non-negative integer")
        if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 200):
            raise ValueError("browser limit must be an integer from 1 to 200")
        end = total_children if limit is None else min(offset + limit, total_children)
        return {
            "stateVersion": state_version, "root": params["root"], "path": params.get("path", []),
            "item": _browser_item_record(item),
            "children": [_browser_item_record(child) for child in children[offset:end]],
            "totalChildren": total_children,
            "nextOffset": end if end < total_children else None,
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
        _, track = _device_owner(song, params["trackId"])
        current_devices = dispatch_request(song, {"method": "list_devices", "params": {"trackId": params["trackId"]}}, state_version)
        if current_devices != params["before"]:
            raise ValueError("target device chain changed")
        before_objects = tuple(getattr(track, "devices", ()))
        previous_track = song.view.selected_track
        try:
            song.view.selected_track = track
            application.browser.load_item(item)
        finally:
            song.view.selected_track = previous_track
        after_objects = tuple(getattr(track, "devices", ()))
        added = [index for index, device in enumerate(after_objects)
                 if not any(device == old for old in before_objects)]
        removed = [index for index, device in enumerate(before_objects)
                   if not any(device == new for new in after_objects)]
        survivors_before = [device for device in before_objects if any(device == new for new in after_objects)]
        survivors_after = [device for device in after_objects if any(device == old for old in before_objects)]
        old_order_preserved = len(survivors_before) == len(survivors_after) and all(
            old == new for old, new in zip(survivors_before, survivors_after))
        kind = "unconfirmed"
        if len(added) == 1 and not removed and old_order_preserved:
            kind = "inserted"
        elif len(added) == 1 and len(removed) == 1 and added[0] == removed[0] and old_order_preserved:
            kind = "replaced"
        elif added or removed or not old_order_preserved:
            kind = "complex_change"
        effect = {"kind": kind, "insertedIndex": added[0] if len(added) == 1 else None,
                  "deviceId": f"{params['trackId']}:device-{added[0]}" if len(added) == 1 else None,
                  "removedIndices": removed, "oldOrderPreserved": old_order_preserved}
        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                "loadedItem": _browser_item_record(item), "deviceChainEffect": effect,
                "deviceChain": dispatch_request(song, {"method": "list_devices", "params": {"trackId": params["trackId"]}}, state_version + 1)}
    if method == "get_set_mixer":
        return _set_mixer(song, state_version)
    if method == "create_return_track":
        before = _set_mixer(song, state_version)["returns"]
        if before != params["beforeReturns"]:
            raise ValueError("return tracks changed")
        name = params["name"]
        if not isinstance(name, str) or not name.strip():
            raise ValueError("return track name must not be empty")
        if not callable(getattr(song, "create_return_track", None)):
            raise ValueError("Live does not expose return track creation")
        index = len(song.return_tracks)
        song.begin_undo_step()
        try:
            song.create_return_track()
            if len(song.return_tracks) != index + 1:
                raise RuntimeError("Live did not append exactly one return track")
            song.return_tracks[index].name = name
        except Exception:
            if len(song.return_tracks) == index + 1 and callable(getattr(song, "delete_return_track", None)):
                song.delete_return_track(index)
            raise
        finally:
            song.end_undo_step()
        return {"stateVersion": state_version + 1,
                "return": {"id": f"return-{index}", "name": song.return_tracks[index].name}}
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
    if method == "get_device_sidechain_routing":
        return _device_sidechain_routing(song, params["trackId"], params["deviceId"], state_version)
    if method == "set_device_sidechain_routing":
        track_id, device_id = params["trackId"], params["deviceId"]
        current = _device_sidechain_routing(song, track_id, device_id, state_version)
        if current != params["before"]:
            raise ValueError("device sidechain identity or state changed")
        if not current["sidechain"]["supported"]:
            raise ValueError("device sidechain routing is unsupported")
        changes = params["changes"]
        if len(changes) != 1 or not set(changes).issubset({"sourceTypeId", "sourceChannelId"}):
            raise ValueError("exactly one sidechain routing change is required")
        _, _, device = _device(song, track_id, device_id)
        key = next(iter(changes))
        is_type = key == "sourceTypeId"
        choices = device.available_input_routing_types if is_type else device.available_input_routing_channels
        matches = [option for option in choices if _routing_option(option) == changes[key]["value"]]
        if len(matches) != 1:
            raise ValueError("unknown or ambiguous sidechain routing choice")
        with _undo_step(song):
            setattr(device, "input_routing_type" if is_type else "input_routing_channel", matches[0])
        return _device_sidechain_routing(song, track_id, device_id, state_version + 1)
    if method == "get_audio_clip_state":
        return _audio_clip_state(song, params["trackId"], params["clipId"], state_version)
    if method == "get_audio_source_beat_times":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        if not clip.warping:
            raise ValueError("warped audio clip required for source-time conversion")
        convert = getattr(clip, "sample_to_beat_time", None)
        rate = getattr(clip, "sample_rate", None)
        length = getattr(clip, "sample_length", None)
        if not callable(convert) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
            raise ValueError("native audio source-to-beat conversion unavailable")
        if not isinstance(length, (int, float)) or not math.isfinite(length) or length <= 0:
            raise ValueError("native audio source length unavailable")
        seconds = params.get("sourceSeconds")
        if not isinstance(seconds, list) or not 1 <= len(seconds) <= 256:
            raise ValueError("sourceSeconds must contain one to 256 positions")
        points = []
        for source in seconds:
            if isinstance(source, bool) or not isinstance(source, (int, float)) or not math.isfinite(source) or not 0 <= source * rate <= length:
                raise ValueError("sourceSeconds position is outside the audio source")
            beat = convert(source * rate)
            if isinstance(beat, bool) or not isinstance(beat, (int, float)) or not math.isfinite(beat):
                raise ValueError("native source-to-beat conversion returned an invalid position")
            points.append({"sourceSeconds": source, "beatTime": float(beat)})
        return {"stateVersion": state_version, "trackId": track_id, "clipId": clip_id,
                "sourcePath": getattr(clip, "file_path", None), "conversion": "native", "points": points}
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
        with _undo_step(song):
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
    if method == "crop_audio_clip":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        if _audio_clip_state(song, track_id, clip_id, state_version) != params["before"]:
            raise ValueError("audio clip identity or state changed")
        if not callable(getattr(clip, "crop", None)):
            raise ValueError("native audio crop API required")
        start, end = (clip.loop_start, clip.loop_end) if clip.looping else (clip.start_marker, clip.end_marker)
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            raise ValueError("invalid audio crop interval")
        with _undo_step(song):
            clip.crop()
        return _audio_clip_state(song, track_id, clip_id, state_version + 1)
    if method == "quantize_audio_clip":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        if _audio_clip_state(song, track_id, clip_id, state_version) != params["before"]:
            raise ValueError("audio clip identity or state changed")
        if float(song.swing_amount) != params["beforeSwingAmount"]:
            raise ValueError("song swing amount changed")
        if not clip.warping or not callable(getattr(clip, "quantize", None)):
            raise ValueError("warped audio quantization API required")
        grids = {
            "1_4": "rec_q_quarter", "1_8": "rec_q_eight", "1_8_triplet": "rec_q_eight_triplet",
            "1_8_and_triplet": "rec_q_eight_eight_triplet", "1_16": "rec_q_sixtenth",
            "1_16_triplet": "rec_q_sixtenth_triplet", "1_16_and_triplet": "rec_q_sixtenth_sixtenth_triplet",
            "1_32": "rec_q_thirtysecond",
        }
        if params["grid"] not in grids:
            raise ValueError("unsupported audio quantization grid")
        amount = params["amount"]
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or not 0 <= amount <= 1:
            raise ValueError("amount must be a finite number from zero to one")
        native_grid = getattr(getattr(getattr(Live, "Song", None), "RecordingQuantization", None), grids[params["grid"]], None)
        if native_grid is None:
            raise ValueError("native audio quantization grid unavailable")
        with _undo_step(song):
            clip.quantize(native_grid, amount)
        return _audio_clip_state(song, track_id, clip_id, state_version + 1)
    if method == "add_audio_warp_marker":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        before = _audio_clip_state(song, track_id, clip_id, state_version)
        if before != params["before"]:
            raise ValueError("audio clip identity or state changed")
        if not clip.warping or not callable(getattr(clip, "add_warp_marker", None)):
            raise ValueError("warped audio marker creation API required")
        beat = params["beatTime"]
        if isinstance(beat, bool) or not isinstance(beat, (int, float)) or not math.isfinite(beat):
            raise ValueError("marker beat time must be a finite number")
        if any(marker["beatTime"] == beat for marker in before["warpMarkers"]["markers"]):
            raise ValueError("warp marker already exists at beat time")
        marker = {"beat_time": beat}
        if "sampleTime" in params:
            sample = params["sampleTime"]
            if isinstance(sample, bool) or not isinstance(sample, (int, float)) or not math.isfinite(sample) or sample < 0:
                raise ValueError("sampleTime must be a finite nonnegative number")
            marker["sample_time"] = sample
        else:
            convert_time = getattr(clip, "beat_to_sample_time", None)
            if not callable(convert_time):
                raise ValueError("native beat-to-sample conversion API required")
            sample_rate = getattr(clip, "sample_rate", None)
            if not isinstance(sample_rate, (int, float)) or not math.isfinite(sample_rate) or sample_rate <= 0:
                raise ValueError("native source sample rate unavailable")
            marker["sample_time"] = convert_time(beat) / sample_rate
        native_markers = clip.warp_markers
        if not native_markers:
            raise ValueError("native warp marker specification type unavailable")
        specification = type(native_markers[0])(**marker)
        with _undo_step(song):
            clip.add_warp_marker(specification)
        return _audio_clip_state(song, track_id, clip_id, state_version + 1)
    if method == "remove_audio_warp_marker":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        before = _audio_clip_state(song, track_id, clip_id, state_version)
        if before != params["before"]:
            raise ValueError("audio clip identity or state changed")
        if not clip.warping or not callable(getattr(clip, "remove_warp_marker", None)):
            raise ValueError("warped audio marker removal API required")
        beat = params["beatTime"]
        if isinstance(beat, bool) or not isinstance(beat, (int, float)) or not math.isfinite(beat):
            raise ValueError("marker beat time must be a finite number")
        markers = before["warpMarkers"]["markers"]
        index = next((i for i, marker in enumerate(markers) if marker["beatTime"] == beat), -1)
        if index < 0 or index == len(markers) - 1:
            raise ValueError("unknown or hidden terminal warp marker")
        with _undo_step(song):
            clip.remove_warp_marker(beat)
        return _audio_clip_state(song, track_id, clip_id, state_version + 1)
    if method == "move_audio_warp_marker":
        track_id, clip_id = params["trackId"], params["clipId"]
        clip, _ = _audio_clip(song, track_id, clip_id)
        before = _audio_clip_state(song, track_id, clip_id, state_version)
        if before != params["before"]:
            raise ValueError("audio clip identity or state changed")
        if not clip.warping or not callable(getattr(clip, "move_warp_marker", None)):
            raise ValueError("warped audio marker movement API required")
        beat, target = params["beatTime"], params["targetBeatTime"]
        if isinstance(beat, bool) or isinstance(target, bool) or not isinstance(beat, (int, float)) or not isinstance(target, (int, float)) or not math.isfinite(beat) or not math.isfinite(target):
            raise ValueError("marker beat times must be finite numbers")
        markers = before["warpMarkers"]["markers"]
        index = next((i for i, marker in enumerate(markers) if marker["beatTime"] == beat), -1)
        if index < 0 or index == len(markers) - 1:
            raise ValueError("unknown or hidden terminal warp marker")
        if (index > 0 and target <= markers[index - 1]["beatTime"]) or (index < len(markers) - 2 and target >= markers[index + 1]["beatTime"]):
            raise ValueError("warp marker cannot cross or overlap a neighbor")
        if beat == target:
            raise ValueError("warp marker movement must change beat time")
        with _undo_step(song):
            clip.move_warp_marker(beat, target - beat)
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
    if method == "get_track_state_snapshot":
        return _track_state_snapshot(song, params["trackId"], state_version)
    if method == "get_device_chain_snapshot":
        return _device_chain_snapshot(song, params["trackId"], state_version)
    if method == "set_device_chain_snapshot":
        owner_id, owner = _device_owner(song, params["trackId"])
        current = _device_chain_snapshot(song, owner_id, state_version)
        if current != params["before"]:
            raise ValueError("device chain changed after planning")
        target = params["target"]
        if target.get("format") != "cavi-device-chain-v1" or len(target.get("devices", ())) != len(current["devices"]):
            raise ValueError("device chain topology mismatch")
        for saved_device, native_device in zip(target["devices"], current["devices"]):
            if (saved_device.get("className") != native_device["className"] or
                    saved_device.get("type") != native_device["type"] or
                    not isinstance(saved_device.get("name"), str) or not saved_device["name"].strip() or
                    len(saved_device.get("parameters", ())) != len(native_device["parameters"])):
                raise ValueError("device chain topology mismatch")
            for saved, native in zip(saved_device["parameters"], native_device["parameters"]):
                if any(saved.get(field) != native[field] for field in ("originalName", "min", "max", "quantized", "valueItems")):
                    raise ValueError("device parameter layout mismatch")
                value = saved.get("value")
                if (type(value) not in (int, float) or not math.isfinite(value) or not native["min"] <= value <= native["max"] or
                        (native["quantized"] and not float(value).is_integer())):
                    raise ValueError("device parameter value outside native range")
                if value != native["value"] and not native["enabled"]:
                    raise ValueError(f"parameter {native['id']} is disabled")
        writes = []
        def write(target_object, attribute, value):
            previous = getattr(target_object, attribute)
            if previous != value:
                writes.append((target_object, attribute, previous))
                setattr(target_object, attribute, value)
        song.begin_undo_step()
        try:
            for device, saved_device in zip(owner.devices, target["devices"]):
                write(device, "name", saved_device["name"])
                for parameter, saved in zip(device.parameters, saved_device["parameters"]):
                    write(parameter, "value", saved["value"])
            result = _device_chain_snapshot(song, owner_id, state_version + 1)
            if _persisted_device_chain(result) != target:
                raise ValueError("Live did not apply the complete device chain snapshot")
        except Exception as error:
            rollback_errors = []
            for target_object, attribute, previous in reversed(writes):
                try:
                    setattr(target_object, attribute, previous)
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)
            if rollback_errors:
                details = "; ".join(str(item) for item in rollback_errors)
                raise RuntimeError(f"device chain recall failed: {error}; rollback failed: {details}; use Live undo") from error
            raise
        finally:
            song.end_undo_step()
        return result
    if method == "set_track_state_snapshot":
        track_id, target = params["trackId"], params["target"]
        current = _track_state_snapshot(song, track_id, state_version)
        if current != params["before"]:
            raise ValueError("track state changed after planning")
        if target.get("format") != "cavi-track-state-v1":
            raise ValueError("invalid track snapshot format")
        persisted = _persisted_track_state(current)
        if target["track"]["type"] != persisted["track"]["type"] or target["track"]["isGroup"] != persisted["track"]["isGroup"]:
            raise ValueError("snapshot track type is incompatible")
        if len(target["mixer"]["sends"]) != len(current["mixer"]["sends"]):
            raise ValueError("snapshot send layout mismatch")
        for saved, native in zip(target["mixer"]["sends"], current["mixer"]["sends"]):
            if saved["id"] != native["id"] or saved["name"] != native["name"]:
                raise ValueError("snapshot send layout mismatch")
            if not math.isfinite(saved["value"]) or not native["min"] <= saved["value"] <= native["max"]:
                raise ValueError("snapshot send value outside native range")
        for key in ("volume", "pan"):
            value, native = target["mixer"][key], current["mixer"][key]
            if not math.isfinite(value) or not native["min"] <= value <= native["max"]:
                raise ValueError(f"snapshot mixer {key} outside native range")
        routing_specs = (
            ("inputTypeId", current["routing"]["input"]["availableTypes"]),
            ("outputTypeId", current["routing"]["output"]["availableTypes"]),
        )
        selected_routes = {}
        for key, choices in routing_specs:
            identifier = target["routing"][key]
            selected = next((choice for choice in choices if choice["id"] == identifier), None) if identifier is not None else None
            if identifier is not None and selected is None:
                raise ValueError(f"snapshot routing {key} is unavailable")
            if selected is not None and sum(choice["name"] == selected["name"] for choice in choices) > 1:
                raise ValueError(f"snapshot routing {key} has an ambiguous routing label")
            selected_routes[key] = selected
        monitoring = current["routing"]["monitoring"]
        if target["routing"]["monitoring"] is not None and (monitoring is None or not any(
                choice["value"] == target["routing"]["monitoring"] for choice in monitoring["choices"])):
            raise ValueError("snapshot routing monitoring is unavailable")
        if len(target["devices"]) != len(current["devices"]):
            raise ValueError("snapshot device topology mismatch")
        for saved_device, native_device in zip(target["devices"], current["devices"]):
            if saved_device["className"] != native_device["className"] or saved_device["type"] != native_device["type"] or len(saved_device["parameters"]) != len(native_device["parameters"]):
                raise ValueError("snapshot device topology mismatch")
            for saved, native in zip(saved_device["parameters"], native_device["parameters"]):
                if any(saved[field] != native[field] for field in ("originalName", "min", "max", "quantized", "valueItems")):
                    raise ValueError("snapshot parameter layout mismatch")
                if not math.isfinite(saved["value"]) or not native["min"] <= saved["value"] <= native["max"] or (native["quantized"] and not float(saved["value"]).is_integer()):
                    raise ValueError("snapshot parameter value outside native range")
                if saved["value"] != native["value"] and not native["enabled"]:
                    raise ValueError(f"parameter {native['id']} is disabled")
        _, track = _track(song, track_id)
        writes = []
        route_previous = {}
        def write(owner, attribute, value):
            previous = getattr(owner, attribute)
            if previous != value:
                writes.append((owner, attribute, previous))
                setattr(owner, attribute, value)
        def write_route(attribute, value):
            previous = getattr(track, attribute)
            if previous != value:
                route_previous.setdefault(attribute, previous)
                setattr(track, attribute, value)
        song.begin_undo_step()
        try:
            write(track, "name", target["track"]["name"])
            write(track.mixer_device.volume, "value", target["mixer"]["volume"])
            write(track.mixer_device.panning, "value", target["mixer"]["pan"])
            write(track, "mute", target["mixer"]["mute"])
            write(track, "solo", target["mixer"]["solo"])
            for send, saved in zip(track.mixer_device.sends, target["mixer"]["sends"]):
                write(send, "value", saved["value"])
            route_attributes = {"inputTypeId": "current_input_routing", "outputTypeId": "current_output_routing"}
            for key, attribute in route_attributes.items():
                selected = selected_routes[key]
                if selected is not None:
                    write_route(attribute, selected["name"])
            channel_specs = (
                ("inputChannelId", "current_input_sub_routing", track.available_input_routing_channels),
                ("outputChannelId", "current_output_sub_routing", track.available_output_routing_channels),
            )
            for key, attribute, native_choices in channel_specs:
                choices = [_routing_option(choice) for choice in native_choices]
                identifier = target["routing"][key]
                selected = next((choice for choice in choices if choice["id"] == identifier), None) if identifier is not None else None
                if identifier is not None and selected is None:
                    raise ValueError(f"snapshot routing {key} is unavailable after changing routing type")
                if selected is not None and sum(choice["name"] == selected["name"] for choice in choices) > 1:
                    raise ValueError(f"snapshot routing {key} has an ambiguous routing label")
                if selected is not None:
                    write_route(attribute, selected["name"])
            if target["routing"]["monitoring"] is not None:
                write(track, "current_monitoring_state", target["routing"]["monitoring"])
            for device, saved_device in zip(track.devices, target["devices"]):
                write(device, "name", saved_device["name"])
                for parameter, saved in zip(device.parameters, saved_device["parameters"]):
                    write(parameter, "value", saved["value"])
            result = _track_state_snapshot(song, track_id, state_version + 1)
            if _persisted_track_state(result) != target:
                raise ValueError("Live did not apply the complete track snapshot")
        except Exception as error:
            rollback_errors = []
            for owner, attribute, previous in reversed(writes):
                try:
                    setattr(owner, attribute, previous)
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)
            for attribute in ("current_input_routing", "current_output_routing",
                              "current_input_sub_routing", "current_output_sub_routing"):
                if attribute in route_previous:
                    try:
                        setattr(track, attribute, route_previous[attribute])
                    except Exception as rollback_error:
                        rollback_errors.append(rollback_error)
            if rollback_errors:
                details = "; ".join(str(item) for item in rollback_errors)
                raise RuntimeError(f"track recall failed: {error}; rollback failed: {details}; use Live undo") from error
            raise
        finally:
            song.end_undo_step()
        return result
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
        elif target["targetType"] == "return":
            suffix = target["targetId"].removeprefix("return-")
            if not suffix.isascii() or not suffix.isdigit() or str(int(suffix)) != suffix or int(suffix) >= len(song.return_tracks):
                raise ValueError("return track is unavailable")
            item = song.return_tracks[int(suffix)]
            if item.name != target["previousName"]:
                raise ValueError("return track identity changed")
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
        elif target["targetType"] == "return":
            suffix = target["targetId"].removeprefix("return-")
            if not suffix.isascii() or not suffix.isdigit() or str(int(suffix)) != suffix or int(suffix) >= len(song.return_tracks):
                raise ValueError("return track is unavailable")
            index = int(suffix)
            current = _return_mixer_record(song.return_tracks[index], index)
            expected = {key: target[key] for key in current}
            if current != expected:
                raise ValueError("return track state changed")
            if not callable(getattr(song, "delete_return_track", None)):
                raise ValueError("Live does not expose return track deletion")
            song.begin_undo_step()
            try:
                song.delete_return_track(index)
            finally:
                song.end_undo_step()
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
    if method in ("delete_arrangement_clip", "move_arrangement_clip", "duplicate_arrangement_clip"):
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
        if method == "duplicate_arrangement_clip":
            start = float(params["startBeats"])
            end = start + before["lengthBeats"]
            if not math.isfinite(start) or start < 0 or not math.isfinite(end) or end <= start:
                raise ValueError("duplication must define a finite positive interval")
            if any(start < other.end_time and end > other.start_time for other in track.arrangement_clips):
                raise ValueError("duplication would overlap another Arrangement clip")
            duplicate = None
            song.begin_undo_step()
            try:
                duplicate = track.duplicate_clip_to_arrangement(clip, start)
                if not (
                    math.isclose(float(duplicate.start_time), start, rel_tol=0.0, abs_tol=1e-8)
                    and math.isclose(float(duplicate.end_time), end, rel_tol=0.0, abs_tol=1e-8)
                ):
                    raise ValueError("Live changed the duplicated clip interval")
                if any(
                    other is not duplicate
                    and float(duplicate.start_time) < float(other.end_time)
                    and float(duplicate.end_time) > float(other.start_time)
                    for other in track.arrangement_clips
                ):
                    raise ValueError("duplicated clip overlaps another Arrangement clip after the native copy")
            except Exception as error:
                if duplicate is not None:
                    try:
                        track.delete_clip(duplicate)
                    except Exception as rollback_error:
                        raise RuntimeError(
                            f"duplication failed: {error}; rollback failed: {rollback_error}; use Live undo"
                        ) from error
                raise
            finally:
                song.end_undo_step()
            result = _arrangement_clips(song, track_id, state_version + 1)
            duplicate_index = next(i for i, item in enumerate(track.arrangement_clips) if item == duplicate)
            result["duplicatedClip"] = _arrangement_clip_record(duplicate, track_id, duplicate_index)
            result["sourceClip"] = before
            return result
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
            guarded_variation = method == "transform_midi_notes" and params.get("operation") == "apply_drum_variation"
            guarded_humanization = method == "transform_midi_notes" and params.get("operation") == "apply_midi_humanization"
            guarded_velocity = method == "transform_midi_notes" and params.get("operation") == "apply_midi_velocity_curve"
            guarded_gate = method == "transform_midi_notes" and params.get("operation") == "apply_midi_gate_pattern"
            guarded_probability = method == "transform_midi_notes" and params.get("operation") == "apply_midi_probability_pattern"
            guarded_strum = method == "transform_midi_notes" and params.get("operation") == "apply_midi_strum_pattern"
            guarded_inversion = method == "transform_midi_notes" and params.get("operation") == "apply_midi_chord_inversion"
            guarded_drop = method == "transform_midi_notes" and params.get("operation") == "apply_midi_drop_voicing"
            guarded_leading = method == "transform_midi_notes" and params.get("operation") == "apply_midi_chord_voice_leading"
            guarded_arpeggiation = method == "transform_midi_notes" and params.get("operation") == "apply_midi_chord_arpeggiation"
            guarded_transposition = method == "transform_midi_notes" and params.get("operation") == "apply_midi_transposition"
            guarded_diatonic = method == "transform_midi_notes" and params.get("operation") == "apply_midi_diatonic_transposition"
            guarded_remapping = method == "transform_midi_notes" and params.get("operation") == "apply_midi_scale_chord_remapping"
            guarded_transform = guarded_variation or guarded_humanization or guarded_velocity or guarded_gate or guarded_probability or guarded_strum or guarded_inversion or guarded_drop or guarded_leading or guarded_arpeggiation or guarded_transposition or guarded_diatonic or guarded_remapping
            if guarded_transform:
                if params.get("expectedStateVersion") != state_version:
                    raise ValueError("MIDI clip state version changed")
                if params.get("clipTiming") != _clip_timing(song, params["trackId"], params["clipId"], state_version):
                    raise ValueError("MIDI clip timing changed since observation")
                grid_reference = params.get("gridReference", {})
                current_grid = {"tempoBpm": float(song.tempo), "timeSignature": {
                    "numerator": int(song.signature_numerator), "denominator": int(song.signature_denominator)}}
                planned_grid = {"tempoBpm": grid_reference.get("tempoBpm"),
                                "timeSignature": grid_reference.get("timeSignature")}
                if planned_grid != current_grid:
                    raise ValueError("song grid changed since observation")
                if grid_reference.get("setFingerprint") != fingerprint:
                    raise ValueError("Live set fingerprint changed since observation")
                current = {"stateVersion": state_version, "trackId": params["trackId"],
                           "clipId": params["clipId"], "lengthBeats": float(clip.length),
                           "notes": [_midi_note_record(note) for note in clip.get_all_notes_extended()]}
                if params.get("before") != current:
                    raise ValueError("MIDI clip changed since observation")
                if (guarded_diatonic or guarded_remapping) and params.get("musicalContext") != _song_musical_context(song, state_version):
                    raise ValueError("song musical context changed since observation")
            note_ids = [int(change["noteId"]) for change in params["changes"]]
            if guarded_transform and (len(current["notes"]) > 4096 or len(note_ids) > 4096 or
                                      len(params.get("newNotes", [])) > 4096 or
                                      len(current["notes"]) + len(params.get("newNotes", [])) > 4096):
                raise ValueError("drum variation supports at most 4096 existing, changed, added, or final notes")
            if guarded_transform and len(note_ids) != len(set(note_ids)):
                raise ValueError("guarded MIDI transform note IDs must be unique")
            if guarded_variation:
                _validate_drum_variation_payload(clip, params)
            expected_humanized = _validate_midi_humanization_payload(clip, params) if guarded_humanization else None
            expected_velocity = _validate_midi_velocity_curve_payload(clip, params) if guarded_velocity else None
            expected_gate = _validate_midi_gate_pattern_payload(clip, params) if guarded_gate else None
            expected_probability = _validate_midi_probability_pattern_payload(clip, params) if guarded_probability else None
            expected_strum = _validate_midi_strum_pattern_payload(clip, params) if guarded_strum else None
            expected_inversion = _validate_midi_chord_inversion_payload(clip, params) if guarded_inversion else None
            expected_drop = _validate_midi_drop_voicing_payload(clip, params) if guarded_drop else None
            expected_leading = _validate_midi_chord_voice_leading_payload(clip, params) if guarded_leading else None
            expected_arpeggiation = _validate_midi_chord_arpeggiation_payload(clip, params) if guarded_arpeggiation else None
            expected_transposition = _validate_midi_transposition_payload(clip, params) if guarded_transposition else None
            expected_diatonic = _validate_midi_diatonic_transposition_payload(clip, params) if guarded_diatonic else None
            expected_remapping = _validate_midi_scale_chord_remapping_payload(clip, params) if guarded_remapping else None
            notes = clip.get_notes_by_id(note_ids) if note_ids else []
            by_id = {int(note.note_id): note for note in notes}
            if len(by_id) != len(set(note_ids)):
                raise ValueError("one or more note IDs no longer exist")
            fields = {
                "pitch": "pitch", "start": "start_time", "duration": "duration", "velocity": "velocity",
                "velocityDeviation": "velocity_deviation", "releaseVelocity": "release_velocity",
                "probability": "probability", "mute": "mute",
            }
            originals = []
            for change in params["changes"]:
                note = by_id[int(change["noteId"])]
                originals.append((note, {target: getattr(note, target) for source, target in fields.items()
                                         if source in change}))
            added_note_ids = []
            new_note_specs = tuple(_new_midi_note(note) for note in params.get("newNotes", []))
            if guarded_transposition or guarded_diatonic or guarded_remapping:
                expected_pitch_transform = expected_transposition if guarded_transposition else \
                    expected_diatonic if guarded_diatonic else expected_remapping
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            by_id[int(change["noteId"])].pitch = change["pitch"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_pitch_transform) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7 or
                                abs(observed[note_id]["duration"] - expected["duration"]) > 2e-7
                                for note_id, expected in expected_pitch_transform.items()):
                            raise ValueError("native MIDI pitch-transform readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications([note for note, _ in originals])
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI pitch transform failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_arpeggiation:
                existing_ids = {int(note.note_id) for note in clip.get_all_notes_extended()}
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            note = by_id[int(change["noteId"])]
                            note.start_time = change["start"]
                            note.duration = change["duration"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        added_note_ids = list(clip.add_new_notes(new_note_specs)) if new_note_specs else []
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        exact = ("pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute")
                        existing_match = set(expected_arpeggiation[0]) == existing_ids and all(
                            note_id in observed and
                            all(observed[note_id][field] == expected[field] for field in exact) and
                            abs(observed[note_id]["start"] - expected["start"]) <= 2e-7 and
                            abs(observed[note_id]["duration"] - expected["duration"]) <= 2e-7
                            for note_id, expected in expected_arpeggiation[0].items())
                        added = [observed.get(note_id) for note_id in added_note_ids]
                        additions_match = len(added_note_ids) == len(expected_arpeggiation[1]) and \
                            len(set(added_note_ids)) == len(added_note_ids) and not any(note is None for note in added) and all(
                                all(actual[field] == expected[field] for field in exact) and
                                abs(actual["start"] - expected["start"]) <= 2e-7 and
                                abs(actual["duration"] - expected["duration"]) <= 2e-7
                                for actual, expected in zip(added, expected_arpeggiation[1]))
                        if not existing_match or not additions_match or \
                                len(readback) != len(expected_arpeggiation[0]) + len(expected_arpeggiation[1]):
                            raise ValueError("native MIDI chord arpeggiation readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": added_note_ids}
                    except Exception as mutation_error:
                        rollback_errors = []
                        try:
                            cleanup_ids = tuple(added_note_ids)
                            if new_note_specs and not cleanup_ids:
                                current_ids = {int(note.note_id) for note in clip.get_all_notes_extended()}
                                cleanup_ids = tuple(sorted(current_ids - existing_ids))
                            if cleanup_ids:
                                clip.remove_notes_by_id(cleanup_ids)
                        except Exception as error:
                            rollback_errors.append("added-note cleanup failed: %s" % error)
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications([note for note, _ in originals])
                        except Exception as error:
                            rollback_errors.append("existing-note restore failed: %s" % error)
                        if rollback_errors:
                            raise RuntimeError("MIDI chord arpeggiation failed and rollback was incomplete (%s); original error: %s" %
                                               ("; ".join(rollback_errors), mutation_error))
                        raise mutation_error
            if guarded_inversion or guarded_drop or guarded_leading:
                expected_pitch_state = expected_inversion if guarded_inversion else expected_drop if guarded_drop else expected_leading
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            by_id[int(change["noteId"])].pitch = change["pitch"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_pitch_state) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7 or
                                abs(observed[note_id]["duration"] - expected["duration"]) > 2e-7
                                for note_id, expected in expected_pitch_state.items()):
                            raise ValueError("native MIDI chord voicing readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications(notes)
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI chord voicing failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_strum:
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            note = by_id[int(change["noteId"])]
                            note.start_time = change["start"]
                            note.duration = change["duration"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_strum) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7 or
                                abs(observed[note_id]["duration"] - expected["duration"]) > 2e-7
                                for note_id, expected in expected_strum.items()):
                            raise ValueError("native MIDI strum readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications(notes)
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI strum failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_probability:
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            by_id[int(change["noteId"])].probability = change["probability"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_probability) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7 or
                                abs(observed[note_id]["duration"] - expected["duration"]) > 2e-7 or
                                abs(observed[note_id]["probability"] - expected["probability"]) > 2e-7
                                for note_id, expected in expected_probability.items()):
                            raise ValueError("native MIDI probability readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications(notes)
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI probability pattern failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_gate:
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            by_id[int(change["noteId"])].duration = change["duration"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_gate) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7 or
                                abs(observed[note_id]["duration"] - expected["duration"]) > 2e-7
                                for note_id, expected in expected_gate.items()):
                            raise ValueError("native MIDI gate readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications(notes)
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI gate pattern failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_velocity:
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            by_id[int(change["noteId"])].velocity = change["velocity"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_velocity) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "duration", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7
                                for note_id, expected in expected_velocity.items()):
                            raise ValueError("native MIDI velocity readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications(notes)
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI velocity curve failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_humanization:
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            note = by_id[int(change["noteId"])]
                            note.start_time = change["start"]
                            note.velocity = change["velocity"]
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                        observed = {note["noteId"]: note for note in readback}
                        if set(observed) != set(expected_humanized) or any(
                                any(observed[note_id][field] != expected[field]
                                    for field in ("pitch", "duration", "velocity", "velocityDeviation",
                                                  "releaseVelocity", "probability", "mute")) or
                                abs(observed[note_id]["start"] - expected["start"]) > 2e-7
                                for note_id, expected in expected_humanized.items()):
                            raise ValueError("native MIDI humanization readback does not match the signed plan")
                        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                                "notes": readback, "addedNoteIds": []}
                    except Exception as mutation_error:
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications([note for note, _ in originals])
                        except Exception as rollback_error:
                            raise RuntimeError("MIDI humanization failed and rollback was incomplete (%s); original error: %s" %
                                               (rollback_error, mutation_error))
                        raise mutation_error
            if guarded_variation:
                existing_ids = {int(note.note_id) for note in clip.get_all_notes_extended()}
                with _undo_step(song):
                    try:
                        for change in params["changes"]:
                            note = by_id[int(change["noteId"])]
                            for source, target in fields.items():
                                if source in change:
                                    setattr(note, target, change[source])
                        added_note_ids = list(clip.add_new_notes(new_note_specs)) if new_note_specs else []
                        if notes:
                            clip.apply_note_modifications(notes)
                        readback = list(clip.get_all_notes_extended())
                        result = {
                            "stateVersion": state_version + 1, "trackId": params["trackId"],
                            "clipId": params["clipId"], "lengthBeats": float(clip.length),
                            "notes": [_midi_note_record(note) for note in readback],
                            "addedNoteIds": added_note_ids,
                        }
                    except Exception as mutation_error:
                        rollback_errors = []
                        try:
                            cleanup_ids = tuple(added_note_ids)
                            if new_note_specs and not cleanup_ids:
                                current_ids = {int(note.note_id) for note in clip.get_all_notes_extended()}
                                cleanup_ids = tuple(sorted(current_ids - existing_ids))
                            if cleanup_ids:
                                clip.remove_notes_by_id(cleanup_ids)
                        except Exception as error:
                            rollback_errors.append("added-note cleanup failed: %s" % error)
                        for note, values in originals:
                            for target, value in values.items():
                                setattr(note, target, value)
                        try:
                            if originals:
                                clip.apply_note_modifications([note for note, _ in originals])
                        except Exception as error:
                            rollback_errors.append("existing-note restore failed: %s" % error)
                        if rollback_errors:
                            raise RuntimeError("drum variation failed and rollback was incomplete (%s); original error: %s" %
                                               ("; ".join(rollback_errors), mutation_error))
                        raise mutation_error
                return result
            else:
                for change in params["changes"]:
                    note = by_id[int(change["noteId"])]
                    for source, target in fields.items():
                        if source in change:
                            setattr(note, target, change[source])
                if notes:
                    clip.apply_note_modifications(notes)
                if method == "transform_midi_notes" and new_note_specs:
                    added_note_ids = list(clip.add_new_notes(new_note_specs))
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
    if method == "replace_midi_notes":
        if params.get("expectedStateVersion") != state_version:
            raise ValueError("MIDI clip state version changed")
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
        if hasattr(clip, "is_midi_clip") and not clip.is_midi_clip:
            raise ValueError("clip is not a MIDI clip")
        if params.get("clipTiming") != _clip_timing(song, params["trackId"], params["clipId"], state_version):
            raise ValueError("MIDI clip timing changed since observation")
        grid_reference = params.get("gridReference", {})
        current_song_grid = {
            "tempoBpm": float(song.tempo),
            "timeSignature": {"numerator": int(song.signature_numerator),
                              "denominator": int(song.signature_denominator)},
        }
        planned_song_grid = {"tempoBpm": grid_reference.get("tempoBpm"),
                             "timeSignature": grid_reference.get("timeSignature")}
        if planned_song_grid != current_song_grid:
            raise ValueError("song grid changed since observation")
        current = {
            "stateVersion": state_version, "trackId": params["trackId"], "clipId": params["clipId"],
            "lengthBeats": float(clip.length),
            "notes": [_midi_note_record(note) for note in clip.get_all_notes_extended()],
        }
        if params.get("before") != current:
            raise ValueError("MIDI clip changed since observation")
        guarded_ratchet = params.get("operation") == "apply_midi_ratchet_pattern"
        guarded_doubling = params.get("operation") == "apply_midi_chord_doubling"
        guarded_harmony = params.get("operation") == "apply_midi_diatonic_harmony"
        guarded_quality = params.get("operation") == "apply_midi_diatonic_chord_quality"
        if (guarded_ratchet or guarded_doubling or guarded_harmony or guarded_quality) and grid_reference.get("setFingerprint") != fingerprint:
            raise ValueError("Live set fingerprint changed since observation")
        if (guarded_harmony or guarded_quality) and params.get("musicalContext") != _song_musical_context(song, state_version):
            raise ValueError("song musical context changed since observation")
        expected_ratchet = _validate_midi_ratchet_pattern_payload(clip, params) if guarded_ratchet else None
        expected_doubling = _validate_midi_chord_doubling_payload(clip, params) if guarded_doubling else None
        expected_harmony = _validate_midi_diatonic_harmony_payload(clip, params) if guarded_harmony else None
        expected_quality = _validate_midi_diatonic_chord_quality_payload(clip, params) if guarded_quality else None
        remove_note_ids = [int(note_id) for note_id in params.get("removeNoteIds", [])]
        new_notes = params.get("newNotes", [])
        if len(current["notes"]) > 4096 or len(remove_note_ids) > 4096 or len(new_notes) > 4096 or \
                len(current["notes"]) - len(remove_note_ids) + len(new_notes) > 4096:
            raise ValueError("replace_midi_notes supports at most 4096 existing, removed, added, or final notes")
        if len(remove_note_ids) != len(set(remove_note_ids)):
            raise ValueError("removeNoteIds must be unique")
        existing_ids = {int(note.note_id) for note in clip.get_notes_by_id(remove_note_ids)}
        if existing_ids != set(remove_note_ids):
            raise ValueError("one or more note IDs no longer exist")
        new_note_specs = tuple(_new_midi_note(note) for note in new_notes)
        if guarded_quality:
            changed_ids = [change["noteId"] for change in params["changes"]]
            changed_notes = clip.get_notes_by_id(changed_ids)
            changed_by_id = {int(note.note_id): note for note in changed_notes}
            if set(changed_by_id) != set(changed_ids):
                raise ValueError("one or more MIDI chord-quality note IDs no longer exist")
            original_pitches = {note_id: changed_by_id[note_id].pitch for note_id in changed_ids}
            removed_set = set(remove_note_ids)
            removed_specs = tuple(_new_midi_note(note) for note in current["notes"]
                                  if note["noteId"] in removed_set)
            added_note_ids = []
            with _undo_step(song):
                try:
                    for change in params["changes"]:
                        changed_by_id[change["noteId"]].pitch = change["pitch"]
                    if changed_notes:
                        clip.apply_note_modifications(changed_notes)
                    if remove_note_ids:
                        clip.remove_notes_by_id(tuple(remove_note_ids))
                    added_note_ids = list(clip.add_new_notes(new_note_specs)) if new_note_specs else []
                    readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                    observed = {note["noteId"]: note for note in readback}
                    exact = ("pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute")
                    retained_match = set(expected_quality[0]).issubset(observed) and all(
                        all(observed[note_id][field] == expected[field] for field in exact) and
                        abs(observed[note_id]["start"] - expected["start"]) <= 2e-7 and
                        abs(observed[note_id]["duration"] - expected["duration"]) <= 2e-7
                        for note_id, expected in expected_quality[0].items())
                    added = [observed.get(note_id) for note_id in added_note_ids]
                    additions_match = len(added_note_ids) == len(expected_quality[1]) and \
                        len(set(added_note_ids)) == len(added_note_ids) and not any(note is None for note in added) and all(
                            all(actual[field] == expected[field] for field in exact) and
                            abs(actual["start"] - expected["start"]) <= 2e-7 and
                            abs(actual["duration"] - expected["duration"]) <= 2e-7
                            for actual, expected in zip(added, expected_quality[1]))
                    if not retained_match or not additions_match or \
                            len(readback) != len(expected_quality[0]) + len(expected_quality[1]):
                        raise ValueError("native MIDI chord-quality readback does not match the signed plan")
                except Exception as mutation_error:
                    try:
                        if added_note_ids:
                            clip.remove_notes_by_id(tuple(added_note_ids))
                        for note_id, pitch in original_pitches.items():
                            changed_by_id[note_id].pitch = pitch
                        if changed_notes:
                            clip.apply_note_modifications(changed_notes)
                        if removed_specs:
                            clip.add_new_notes(removed_specs)
                    except Exception as rollback_error:
                        raise RuntimeError("MIDI chord quality failed and rollback was incomplete (%s); original error: %s" %
                                           (rollback_error, mutation_error))
                    raise mutation_error
            return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                    "clipId": params["clipId"], "lengthBeats": float(clip.length),
                    "removedNoteIds": remove_note_ids, "addedNoteIds": added_note_ids, "notes": readback}
        if guarded_ratchet:
            selected_ids = set(remove_note_ids)
            original_specs = tuple(_new_midi_note(note) for note in current["notes"] if note["noteId"] in selected_ids)
            added_note_ids = []
            with _undo_step(song):
                try:
                    clip.remove_notes_by_id(tuple(remove_note_ids))
                    added_note_ids = list(clip.add_new_notes(new_note_specs))
                    readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                    by_readback_id = {note["noteId"]: note for note in readback}
                    exact = ("pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute")
                    preserved_match = len(by_readback_id) == len(readback) and all(
                        expected["noteId"] in by_readback_id and
                        all(by_readback_id[expected["noteId"]][field] == expected[field] for field in exact) and
                        abs(by_readback_id[expected["noteId"]]["start"] - expected["start"]) <= 2e-7 and
                        abs(by_readback_id[expected["noteId"]]["duration"] - expected["duration"]) <= 2e-7
                        for expected in expected_ratchet[0])
                    added = [by_readback_id.get(note_id) for note_id in added_note_ids]
                    additions_match = len(added_note_ids) == len(expected_ratchet[1]) and \
                        len(set(added_note_ids)) == len(added_note_ids) and not any(note is None for note in added) and all(
                            all(actual[field] == expected[field] for field in exact) and
                            abs(actual["start"] - expected["start"]) <= 2e-7 and
                            abs(actual["duration"] - expected["duration"]) <= 2e-7
                            for actual, expected in zip(added, expected_ratchet[1]))
                    if not preserved_match or not additions_match or \
                            len(readback) != len(expected_ratchet[0]) + len(expected_ratchet[1]):
                        raise ValueError("native MIDI ratchet readback does not match the signed plan")
                except Exception as mutation_error:
                    try:
                        if added_note_ids:
                            clip.remove_notes_by_id(tuple(added_note_ids))
                        clip.add_new_notes(original_specs)
                    except Exception as rollback_error:
                        raise RuntimeError("MIDI ratchet failed and rollback was incomplete (%s); original error: %s" %
                                           (rollback_error, mutation_error))
                    raise mutation_error
            return {
                "stateVersion": state_version + 1, "trackId": params["trackId"],
                "clipId": params["clipId"], "lengthBeats": float(clip.length),
                "removedNoteIds": remove_note_ids, "addedNoteIds": added_note_ids,
                "notes": readback,
            }
        if guarded_doubling or guarded_harmony:
            expected_additions = expected_doubling if guarded_doubling else expected_harmony
            operation_label = "chord-doubling" if guarded_doubling else "diatonic-harmony"
            added_note_ids = []
            with _undo_step(song):
                try:
                    added_note_ids = list(clip.add_new_notes(new_note_specs))
                    readback = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
                    by_readback_id = {note["noteId"]: note for note in readback}
                    exact = ("pitch", "velocity", "velocityDeviation", "releaseVelocity", "probability", "mute")
                    preserved_match = len(by_readback_id) == len(readback) and all(
                        expected["noteId"] in by_readback_id and
                        all(by_readback_id[expected["noteId"]][field] == expected[field] for field in exact) and
                        abs(by_readback_id[expected["noteId"]]["start"] - expected["start"]) <= 2e-7 and
                        abs(by_readback_id[expected["noteId"]]["duration"] - expected["duration"]) <= 2e-7
                        for expected in expected_additions[0])
                    added = [by_readback_id.get(note_id) for note_id in added_note_ids]
                    additions_match = len(added_note_ids) == len(expected_additions[1]) and \
                        len(set(added_note_ids)) == len(added_note_ids) and not any(note is None for note in added) and all(
                            all(actual[field] == expected[field] for field in exact) and
                            abs(actual["start"] - expected["start"]) <= 2e-7 and
                            abs(actual["duration"] - expected["duration"]) <= 2e-7
                            for actual, expected in zip(added, expected_additions[1]))
                    if not preserved_match or not additions_match or \
                            len(readback) != len(expected_additions[0]) + len(expected_additions[1]):
                        raise ValueError("native MIDI %s readback does not match the signed plan" % operation_label)
                except Exception as mutation_error:
                    try:
                        if added_note_ids:
                            clip.remove_notes_by_id(tuple(added_note_ids))
                    except Exception as rollback_error:
                        raise RuntimeError("MIDI %s failed and rollback was incomplete (%s); original error: %s" %
                                           (operation_label, rollback_error, mutation_error))
                    raise mutation_error
            return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                    "clipId": params["clipId"], "lengthBeats": float(clip.length),
                    "removedNoteIds": [], "addedNoteIds": added_note_ids, "notes": readback}
        with _undo_step(song):
            added_note_ids = list(clip.add_new_notes(new_note_specs)) if new_note_specs else []
            try:
                if remove_note_ids:
                    clip.remove_notes_by_id(tuple(remove_note_ids))
            except Exception:
                if added_note_ids:
                    clip.remove_notes_by_id(tuple(added_note_ids))
                raise
        return {
            "stateVersion": state_version + 1, "trackId": params["trackId"],
            "clipId": params["clipId"], "lengthBeats": float(clip.length),
            "removedNoteIds": remove_note_ids, "addedNoteIds": added_note_ids,
            "notes": [_midi_note_record(note) for note in clip.get_all_notes_extended()],
        }
    if method in ("get_clip_parameter_envelope", "set_clip_parameter_envelope"):
        _, _, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not slot.has_clip:
            raise ValueError("clip slot is empty")
        clip = slot.clip
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
        owner_id, track = _device_owner(song, params["trackId"])
        return {"stateVersion": state_version, "trackId": owner_id, "devices": [_device_tree(device, f"{owner_id}:device-{i}") for i, device in enumerate(track.devices)]}
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
        chain_kind = "return-chain" if chain_id.rsplit("/", 1)[-1].startswith("return-chain-") else "chain"
        rack_id, separator, suffix = chain_id.rpartition("/" + chain_kind + "-")
        if not separator or not suffix.isdigit():
            raise ValueError("invalid target chain ID")
        _, _, rack = _device(song, params["targetTrackId"], rack_id)
        chains = getattr(rack, "return_chains", ()) if chain_kind == "return-chain" else rack.chains
        if not rack.can_have_chains or int(suffix) >= len(chains):
            raise ValueError("unknown target chain")
        if _device_tree(device, params["deviceId"]) != params["beforeDevice"]:
            raise ValueError("source device state changed")
        if _device_tree(rack, rack_id) != params["beforeTargetRack"]:
            raise ValueError("target rack state changed")
        if chain_id.startswith(params["deviceId"] + "/"):
            raise ValueError("cannot move a rack into its own descendant")
        target = chains[int(suffix)]
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
        _, target_track = _device_owner(song, params["targetTrackId"])
        def find_rack(devices, prefix):
            for index, candidate in enumerate(devices):
                candidate_id = f"{prefix}{index}"
                if candidate == rack:
                    return candidate_id
                if candidate.can_have_chains:
                    for kind, children in (("chain", candidate.chains), ("return-chain", getattr(candidate, "return_chains", ()))):
                        for chain_index, chain in enumerate(children):
                            found = find_rack(chain.devices, f"{candidate_id}/{kind}-{chain_index}/device-")
                            if found is not None:
                                return found
            return None
        current_rack_id = find_rack(target_track.devices, params["targetTrackId"] + ":device-")
        if current_rack_id is None:
            raise RuntimeError("moved device target rack could not be resolved; use Live undo")
        new_id = f"{current_rack_id}/{chain_kind}-{int(suffix)}/device-{actual}"
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
        chain_id = params["chainId"]
        is_return = chain_id.startswith(params["deviceId"] + "/return-chain-")
        if is_return and method == "set_rack_chain_note_routing":
            raise ValueError("note routing is not available for return chains")
        prefix = params["deviceId"] + ("/return-chain-" if is_return else "/chain-")
        chains = getattr(rack, "return_chains", ()) if is_return else rack.chains
        suffix = chain_id.removeprefix(prefix)
        if not chain_id.startswith(prefix) or not suffix.isdigit() or int(suffix) >= len(chains):
            raise ValueError("unknown rack chain")
        chain = chains[int(suffix)]
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
        if not changes or set(changes) - {"volume", "pan", "mute", "solo", "sends"}:
            raise ValueError("invalid chain mixer changes")
        state = _chain_mixer(chain)
        for key, value in changes.items():
            if key == "sends":
                if not isinstance(value, list) or not value:
                    raise ValueError("send changes must be a nonempty list")
                seen = set()
                for change in value:
                    if not isinstance(change, dict) or set(change) != {"index", "value"}:
                        raise ValueError("invalid send change")
                    index, level = change["index"], change["value"]
                    if type(index) is not int or index < 0 or index >= len(state["sends"]) or index in seen:
                        raise ValueError("unknown or duplicate send index")
                    seen.add(index)
                    native = state["sends"][index]
                    if type(level) not in (int, float) or not math.isfinite(level) or not native["enabled"] or not native["min"] <= level <= native["max"]:
                        raise ValueError("send is outside the writable native range")
            elif key in ("mute", "solo"):
                if type(value) is not bool or state[key] is None:
                    raise ValueError(f"{key} is not writable")
            elif type(value) not in (int, float) or not math.isfinite(value) or state[key] is None or not state[key]["enabled"] or not state[key]["min"] <= value <= state[key]["max"]:
                raise ValueError(f"{key} is outside the writable native range")
        song.begin_undo_step()
        try:
            for key, value in changes.items():
                if key == "sends":
                    for change in value:
                        chain.mixer_device.sends[change["index"]].value = change["value"]
                elif key in ("mute", "solo"):
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
        parameters = [_parameter_record(parameter, i, include_native_choice_labels=True)
                      for i, parameter in enumerate(device.parameters)]
        names = {}
        for parameter in parameters:
            names.setdefault(parameter["name"], []).append(parameter["id"])
        ambiguities = [{"name": name, "parameterIds": identifiers}
                       for name, identifiers in names.items() if len(identifiers) > 1]
        return {"stateVersion": state_version, "trackId": params["trackId"], "deviceId": params["deviceId"],
                "parameters": parameters, "nameAmbiguities": ambiguities}
    if method == "set_device_parameters":
        _, _, device = _device(song, params["trackId"], params["deviceId"])
        if "beforeDevice" in params or "beforeParameters" in params:
            current_parameters = [_parameter_record(p, i) for i, p in enumerate(device.parameters)]
            if (_device_tree(device, params["deviceId"]) != params.get("beforeDevice") or
                    current_parameters != params.get("beforeParameters")):
                raise ValueError("snapshot target changed before parameter write")
        # Validate the whole batch before writing. Recheck enabled state below,
        # since changing a mode may disable a later control during execution.
        for change in params["changes"]:
            index = int(change["id"].removeprefix("parameter-"))
            if not device.parameters[index].is_enabled:
                raise ValueError("parameter is disabled")
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
        track, slot_index, slot = _clip_slot(song, params["trackId"], params["clipId"])
        if not getattr(track, "has_midi_input", True):
            raise ValueError("track cannot host MIDI clips")
        if slot.has_clip:
            raise ValueError("clip slot already contains a clip")
        notes = tuple((
            int(note["pitch"]), float(note["start"]), float(note["duration"]),
            int(note["velocity"]), bool(note.get("mute", False))
        ) for note in params["notes"])
        guarded_melody = params.get("operation") == "create_scale_melody_clip"
        if guarded_melody:
            current_slot = _clip_list(song, params["trackId"], state_version)["clips"][slot_index]
            if params.get("before") != current_slot:
                raise ValueError("melody destination slot changed since observation")
            _validate_scale_melody_payload(song, params, state_version, fingerprint)
            with _undo_step(song):
                try:
                    slot.create_clip(float(params["lengthBeats"]))
                    clip = slot.clip
                    clip.set_notes(notes)
                    if "name" in params:
                        clip.name = params["name"]
                    readback = _basic_midi_note_records(clip)
                    expected = params["notes"]
                    if len(readback) != len(expected):
                        raise ValueError("native melody note readback count %d does not match signed count %d" %
                                         (len(readback), len(expected)))
                    note_key = lambda note: (note["pitch"], note["start"], note["duration"],
                                             note["velocity"], note["mute"])
                    for index, (left, right) in enumerate(zip(
                            sorted(readback, key=note_key), sorted(expected, key=note_key))):
                        if left["pitch"] != right["pitch"] or left["velocity"] != right["velocity"] or \
                                left["mute"] != right["mute"] or abs(left["start"] - right["start"]) > 2e-7 or \
                                abs(left["duration"] - right["duration"]) > 2e-7:
                            raise ValueError("native melody note readback mismatch at index %d: expected %r, observed %r" %
                                             (index, right, left))
                    return {
                        "stateVersion": state_version + 1, "trackId": params["trackId"],
                        "clip": {"id": params["clipId"], "name": clip.name, "hasClip": True,
                                 "lengthBeats": float(clip.length), "noteCount": len(notes),
                                 "isPlaying": bool(clip.is_playing)},
                        "notes": readback,
                    }
                except Exception as mutation_error:
                    try:
                        if slot.has_clip:
                            slot.delete_clip()
                    except Exception as rollback_error:
                        raise RuntimeError("melody creation failed and rollback was incomplete (%s); original error: %s" %
                                           (rollback_error, mutation_error))
                    raise mutation_error
        slot.create_clip(float(params["lengthBeats"]))
        clip = slot.clip
        clip.set_notes(notes)
        if "name" in params:
            clip.name = params["name"]
        return {"stateVersion": state_version + 1, "trackId": params["trackId"],
                "clip": {"id": params["clipId"], "name": clip.name, "hasClip": True,
                         "lengthBeats": clip.length, "noteCount": len(notes), "isPlaying": clip.is_playing}}
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


def _track_topology_signature(song):
    return (
        tuple((track, bool(getattr(track, "is_foldable", False)),
               getattr(track, "group_track", None) if bool(getattr(track, "is_grouped", False)) else None)
              for track in song.tracks),
        tuple(song.scenes),
    )


class SocketBridge:
    def __init__(self, control_surface, socket_path):
        self.control_surface = control_surface
        self.socket_path = socket_path
        self.requests = queue.Queue()
        self.stopped = threading.Event()
        self.state_version = 1
        self._last_topology_signature = None
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
                song = self.control_surface.song()
                topology = _track_topology_signature(song)
                if self._last_topology_signature is not None and topology != self._last_topology_signature:
                    self.state_version += 1
                self._last_topology_signature = topology
                result = dispatch_request(
                    song, request, self.state_version, self.control_surface.application()
                )
                self.state_version = result.get("stateVersion", self.state_version)
                self._last_topology_signature = _track_topology_signature(song)
                response = {"id": request.get("id"), "result": result}
            except Exception as error:
                response = {"id": request.get("id"), "error": {"message": str(error) or error.__class__.__name__}}
            try:
                client.sendall(encode_message(response))
            except OSError:
                # A timed-out client may close while Live is busy. Keep the
                # main-thread drain task alive for later requests.
                pass

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
