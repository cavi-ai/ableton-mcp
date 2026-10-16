"""Bounded read-only Arrangement snapshots for one explicit song-time window."""
import math
try:
    from .bridge import (_track, _track_record, _clip_tonal_context, _song_musical_context,
                         _transport_recording_context, _set_fingerprint)
except ImportError:
    from bridge import (_track, _track_record, _clip_tonal_context, _song_musical_context,
                        _transport_recording_context, _set_fingerprint)


def read(song, params, version):
    start, end = params.get("startBeats"), params.get("endBeats")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
           for value in (start, end)) or start < 0 or end <= start or end - start > 512:
        raise ValueError("Arrangement section requires an increasing nonnegative beat range of at most 512 beats")
    requested = params.get("trackIds")
    if requested is None:
        requested = [f"track-{index}" for index, track in enumerate(song.tracks)
                     if not bool(getattr(track, "is_foldable", False))]
        if len(requested) > 64:
            raise ValueError("choose at most 64 explicit tracks for this section")
    if (not isinstance(requested, list) or not (0 if params.get("trackIds") is None else 1) <= len(requested) <= 64 or
            any(not isinstance(identity, str) for identity in requested) or len(set(requested)) != len(requested)):
        raise ValueError("choose one to 64 unique ordinary track IDs")
    parts, tracks, scanned, total_notes = [], [], 0, 0
    for identity in requested:
        index, owner = _track(song, identity)
        if bool(getattr(owner, "is_foldable", False)):
            raise ValueError("choose audio or MIDI tracks, not Group Tracks, for section analysis")
        track = _track_record(song, owner, index)
        track["arrangementOverride"] = bool(owner.back_to_arranger) if hasattr(owner, "back_to_arranger") else None
        track["mutedViaSolo"] = bool(owner.muted_via_solo) if hasattr(owner, "muted_via_solo") else None
        tracks.append(track)
        clips = owner.arrangement_clips
        scanned += len(clips)
        if scanned > 4096:
            raise ValueError("section scan exceeds 4096 Arrangement clips; choose fewer tracks")
        for clip_index, clip in enumerate(clips):
            if not (float(clip.start_time) < end and float(clip.end_time) > start):
                continue
            if len(parts) == 128:
                raise ValueError("section overlaps more than 128 clips; choose a shorter range or fewer tracks")
            part = _clip_tonal_context(song, identity, f"{identity}:arrangement-clip-{clip_index}")
            part.pop("range", None)
            part.pop("rangeBasis", None)
            if part["status"] == "available":
                total_notes += len(part["notes"])
                if total_notes > 16384:
                    raise ValueError("section exceeds 16384 stored MIDI notes; choose a shorter range or fewer tracks")
                part["clipTiming"] = {"looping": bool(clip.looping), "loopStartBeats": float(clip.loop_start),
                                      "loopEndBeats": float(clip.loop_end), "startMarkerBeats": float(clip.start_marker),
                                      "endMarkerBeats": float(clip.end_marker)}
            parts.append(part)
    return {"stateVersion": version, "setFingerprint": _set_fingerprint(song),
            "range": {"startBeats": start, "endBeats": end}, "tracks": tracks, "parts": parts,
            "scannedClips": scanned, "trackScope": "all" if params.get("trackIds") is None else "explicit",
            "musicalContext": _song_musical_context(song, version),
            "transport": _transport_recording_context(song, version)}
