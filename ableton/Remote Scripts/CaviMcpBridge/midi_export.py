"""Bind a native MIDI clip and prepare its view for native file export."""
import os
import uuid
try:
    from .bridge import _track, _midi_clip, _clip_timing, _midi_note_record, _set_fingerprint
except ImportError:
    from bridge import _track, _midi_clip, _clip_timing, _midi_note_record, _set_fingerprint

_song = None
_identities = {}


def _track_ui_path(song, track):
    tracks, current, parts, seen = list(song.tracks), track, [], []
    def parent(item):
        return item.group_track if bool(getattr(item, 'is_grouped', False)) else None
    while current is not None:
        if current in seen or current not in tracks:
            raise ValueError('native track hierarchy is unavailable or cyclic')
        seen.append(current)
        owner = parent(current)
        siblings = [item for item in tracks if parent(item) == owner]
        parts.insert(0, ('.GroupTrack' if getattr(current, 'is_foldable', False) else '.Track') + '[%s]' % siblings.index(current))
        current = owner
    return ''.join(parts)


def source(song, params, version):
    global _song, _identities
    _, track = _track(song, params['trackId'])
    clip, timeline = _midi_clip(song, params['trackId'], params['clipId'])
    if bool(getattr(clip, 'is_audio_clip', False)):
        raise ValueError('MIDI export requires a MIDI clip')
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)):
        raise ValueError('MIDI export requires stopped playback and recording')
    if bool(getattr(clip, 'is_recording', False)) or bool(getattr(clip, 'is_triggered', False)) or any(int(t.fired_slot_index) != -1 for t in song.tracks):
        raise ValueError('resolve recording and pending launches before MIDI export')
    notes = list(clip.get_all_notes_extended())
    if len(notes) > 4096:
        raise ValueError('MIDI export supports at most 4096 stored notes')
    if _song != song:
        _song, _identities = song, {}
    identity = (song, tuple(song.tracks), track, tuple(track.arrangement_clips) if timeline is not None else tuple(track.clip_slots), clip)
    key = (params['trackId'], params['clipId'])
    if key not in _identities or _identities[key][0] != identity:
        if len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        _identities[key] = identity, str(uuid.uuid4())
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': _identities[key][1],
            'filePath': str(getattr(song, 'file_path', None) or ''), 'scriptDirectory': os.path.dirname(__file__),
            'trackId': params['trackId'], 'trackName': str(track.name), 'trackUIPath': _track_ui_path(song, track),
            'clipId': params['clipId'], 'name': str(clip.name), 'location': 'arrangement' if timeline is not None else 'session',
            'muted': bool(getattr(clip, 'muted', False)), 'hasEnvelopes': bool(getattr(clip, 'has_envelopes', False)),
            'notes': sorted([_midi_note_record(note) for note in notes], key=lambda n: n['noteId']),
            'timing': _clip_timing(song, params['trackId'], params['clipId'], version)}


def select(song, params, version, application):
    before = source(song, params, version)
    if params.get('expectedStateVersion') != version or before != params.get('before'):
        raise ValueError('MIDI export source changed before selection')
    if application is None:
        raise ValueError('native MIDI export selection is unavailable')
    _, track = _track(song, params['trackId'])
    clip, timeline = _midi_clip(song, params['trackId'], params['clipId'])
    song.view.selected_track = track
    song.view.detail_clip = clip
    if timeline is None:
        song.view.selected_scene = song.scenes[int(params['clipId'].split(':clip-', 1)[1])]
    application.view.show_view('Arranger' if timeline is not None else 'Session')
    application.view.show_view('Detail')
    hide_envelope = getattr(clip.view, 'hide_envelope', None)
    if callable(hide_envelope):
        hide_envelope()
    application.view.focus_view('Detail/Clip')
    if song.view.detail_clip != clip or song.view.selected_track != track:
        raise RuntimeError('native MIDI export selection did not verify')
    return {'stateVersion': version + 1, 'source': source(song, params, version + 1)}
