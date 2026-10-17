"""Read-only document and mix readiness for native audio export."""
import uuid

try:
    from .bridge import dispatch_request, _track_record, _set_mixer, _send_records, _track_routing, _track_midi_routing
    from .crossfader import context as crossfader_context
    from .panning import context as panning_context
except ImportError:
    from bridge import dispatch_request, _track_record, _set_mixer, _send_records, _track_routing, _track_midi_routing
    from crossfader import context as crossfader_context
    from panning import context as panning_context

_identity = None
_token = None


def source(song, version):
    global _identity, _token
    if song.is_playing or song.record_mode or song.session_record:
        raise ValueError("native audio export requires stopped transport and recording off")
    if len(song.tracks) > 256:
        raise ValueError("audio export readiness supports at most 256 tracks")
    tracks, slots = [], 0
    for index, track in enumerate(song.tracks):
        row = _track_record(song, track, index)
        if row["armed"]:
            raise ValueError("resolve armed tracks before native audio export")
        clips = list(track.clip_slots)
        slots += len(clips)
        if slots > 16384:
            raise ValueError("audio export readiness supports at most 16384 Session slots")
        if int(track.fired_slot_index) != -1 or any(bool(getattr(slot, "is_triggered", False)) or
                slot.has_clip and (bool(getattr(slot.clip, "is_recording", False)) or
                                  bool(getattr(slot.clip, "is_triggered", False))) for slot in clips):
            raise ValueError("resolve recording or pending launches before native audio export")
        row.update(sends=_send_records(song, track), playingSlotIndex=int(track.playing_slot_index),
                   arrangementOverride=bool(getattr(track, "back_to_arranger", False)),
                   routing=_track_routing(song, row["id"], version), midiRouting=_track_midi_routing(song, row["id"], version))
        tracks.append(row)
    identity = (song, tuple(song.tracks), tuple(song.return_tracks), song.master_track)
    if _identity != identity:
        _identity, _token = identity, str(uuid.uuid4())
    live = dispatch_request(song, {"method": "get_live_state", "params": {}}, version)
    return {"stateVersion": version, "setFingerprint": live["setFingerprint"], "identityToken": _token,
            "filePath": live["filePath"], "scriptDirectory": live["scriptDirectory"],
            "tempo": float(song.tempo), "numerator": int(song.signature_numerator),
            "denominator": int(song.signature_denominator), "tracks": tracks,
            "setMixer": _set_mixer(song, version), "crossfader": crossfader_context(song, {}, version),
            "panning": [panning_context(song, {"trackId": key}, version) for key in
                        [*[f'track-{i}' for i in range(len(song.tracks))],
                         *[f'return-{i}' for i in range(len(song.return_tracks))], 'master']],
            "arrangementOverride": bool(song.back_to_arranger)}
