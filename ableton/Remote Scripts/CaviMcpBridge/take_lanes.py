"""Read bounded native take-lane inventories and selected stored performances."""
import re
import uuid
import os

try:
    from .bridge import _track, _midi_note_record, _arrangement_clip_record, _set_fingerprint
except ImportError:
    from bridge import _track, _midi_note_record, _arrangement_clip_record, _set_fingerprint

_song = None
_identities = {}


def _ui_path(song, target):
    tracks, lineage, seen = list(song.tracks), [], []
    if len(tracks) > 256:
        raise ValueError('take UI context supports at most 256 tracks')
    def parent(track):
        return track.group_track if bool(getattr(track, 'is_grouped', False)) else None
    current = target
    while current is not None:
        if current in seen or current not in tracks:
            raise ValueError('native group hierarchy is unavailable or cyclic')
        seen.append(current)
        owner = parent(current)
        siblings = [track for track in tracks if parent(track) == owner]
        segment = ('GroupTrack' if bool(getattr(current, 'is_foldable', False)) else 'Track') + '[%s]' % siblings.index(current)
        lineage.insert(0, (current, segment))
        current = owner
    path, ancestors = 'ArrangementView', []
    for track, segment in lineage:
        path += '.' + segment
        if track != target:
            ancestors.append({'id': 'track-%s' % tracks.index(track), 'name': str(track.name), 'uiPath': path,
                              'folded': bool(track.fold_state), 'mute': bool(track.mute)})
    return path, ancestors


def _resolve(song, params):
    _, track = _track(song, params['trackId'])
    if bool(getattr(track, 'is_foldable', False)):
        raise ValueError('take lanes require an ordinary audio or MIDI track')
    native = getattr(track, 'take_lanes', None)
    lanes = list(native) if native is not None else []
    if len(lanes) > 128 or sum(len(lane.arrangement_clips) for lane in lanes) > 4096 or len(track.arrangement_clips) > 4096:
        raise ValueError('take context supports at most 128 lanes, 4096 take clips and 4096 Arrangement clips')
    selected = None
    if 'takeClipId' in params:
        prefix = re.escape(params['trackId'])
        match = re.fullmatch(prefix + r':take-lane-(0|[1-9][0-9]*):clip-(0|[1-9][0-9]*)', params['takeClipId']) if isinstance(params['takeClipId'], str) else None
        if not match:
            raise ValueError('canonical take clip ID required')
        lane_index, clip_index = map(int, match.groups())
        try:
            selected = lanes[lane_index].arrangement_clips[clip_index]
        except IndexError:
            raise ValueError('take clip is unavailable') from None
    return track, lanes, selected, native is not None


def _content(clip):
    audio = bool(clip.is_audio_clip)
    warped = bool(clip.warping) if audio else False
    result = {'name': str(clip.name), 'kind': 'audio' if audio else 'midi',
              'muted': bool(getattr(clip, 'muted', False)),
              'timing': {'unit': 'seconds' if audio and not warped else 'beats',
                  'looping': bool(clip.looping), 'loopStart': float(clip.loop_start), 'loopEnd': float(clip.loop_end),
                  'startMarker': float(clip.start_marker), 'endMarker': float(clip.end_marker),
                  'numerator': int(clip.signature_numerator), 'denominator': int(clip.signature_denominator)}}
    if audio:
        markers = getattr(clip, 'warp_markers', None)
        if markers is not None and len(markers) > 4096:
            raise ValueError('take inspection supports at most 4096 warp markers')
        result['audio'] = {'path': getattr(clip, 'file_path', None), 'lengthSamples': getattr(clip, 'sample_length', None),
            'gain': float(clip.gain), 'pitchCoarse': int(clip.pitch_coarse), 'pitchFine': int(clip.pitch_fine),
            'warping': warped, 'warpMode': int(clip.warp_mode),
            'warpMarkers': None if markers is None else [{'sampleTime': float(m.sample_time), 'beatTime': float(m.beat_time)} for m in markers]}
    else:
        notes = list(clip.get_all_notes_extended())
        if len(notes) > 4096:
            raise ValueError('take inspection supports at most 4096 stored MIDI notes per selected clip')
        result['notes'] = sorted([_midi_note_record(note) for note in notes], key=lambda note: note['noteId'])
    return result


def context(song, params, version):
    global _song
    track, lanes, selected, supported = _resolve(song, params)
    arrangement = tuple(track.arrangement_clips)
    identity = (song, tuple(song.tracks), track, tuple(lanes), tuple(tuple(lane.arrangement_clips) for lane in lanes), arrangement)
    key = params['trackId']
    if _song != song:
        _song = song
        _identities.clear()
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    ui_path, ancestors = _ui_path(song, track)
    file_path = str(song.file_path)
    result = {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'trackId': key,
        'filePath': file_path, 'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(file_path))[0] or 'Untitled'),
        'scriptDirectory': os.path.dirname(__file__), 'uiTrackPath': ui_path, 'uiAncestors': ancestors,
        'supported': supported, 'takePromotionSupported': False, 'identityToken': cached[1],
        'track': {'name': str(track.name), 'frozen': bool(track.is_frozen), 'armed': bool(track.arm),
                  'firedSlotIndex': int(track.fired_slot_index), 'mute': bool(track.mute), 'solo': bool(track.solo),
                  'arrangementOverride': bool(track.back_to_arranger) if hasattr(track, 'back_to_arranger') else None},
        'recording': {'isPlaying': bool(song.is_playing), 'arrangement': bool(song.record_mode), 'session': bool(song.session_record)},
        'lanes': [{'id': '%s:take-lane-%s' % (key, i), 'name': str(lane.name), 'clips': [
            {**_arrangement_clip_record(clip, key, j), 'id': '%s:take-lane-%s:clip-%s' % (key, i, j)}
            for j, clip in enumerate(lane.arrangement_clips)]} for i, lane in enumerate(lanes)],
        'arrangement': [_arrangement_clip_record(clip, key, i) for i, clip in enumerate(arrangement)], 'selected': None}
    if selected is not None:
        result['takeClipId'] = params['takeClipId']
        result['selected'] = {'id': params['takeClipId'], 'startBeats': float(selected.start_time),
            'endBeats': float(selected.end_time), 'recording': bool(getattr(selected, 'is_recording', False)), 'content': _content(selected)}
    return result
