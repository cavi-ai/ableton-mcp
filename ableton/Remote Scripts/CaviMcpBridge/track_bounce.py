"""Native target and surrounding-track evidence for destructive track bounce."""
import hashlib
import json
import math
import uuid
try:
    from . import track_freeze
    from .bridge import _track, _track_record, _track_state_snapshot, _track_routing
except ImportError:
    import track_freeze
    from bridge import _track, _track_record, _track_state_snapshot, _track_routing

_song = None
_identities = {}


def source(song, params, version):
    global _song, _identities
    if _song != song:
        _song, _identities = song, {}
    result = track_freeze.source(song, params, version)
    index, track = _track(song, params['trackId'])
    others = [t for i, t in enumerate(song.tracks) if i != index]
    identity = (song, index, tuple(others), tuple(song.return_tracks), song.master_track, tuple(song.scenes))
    if index not in _identities or _identities[index][0] != identity:
        _identities[index] = identity, str(uuid.uuid4())
    controls = []
    for i, item in enumerate(song.tracks):
        if i == index:
            continue
        key = 'track-%s' % i
        routing = _track_routing(song, key, version)
        controls.append({'track': _track_record(song, item, i), 'frozen': bool(item.is_frozen),
                         'routing': {side: {k: routing[side][k] for k in ('type', 'channel')} for side in ('input', 'output')}})
    state = _track_state_snapshot(song, params['trackId'], version)
    layout, audio = [], []
    clips = [(dict(location='session', index=i), slot.clip) for i, slot in enumerate(track.clip_slots) if slot.has_clip]
    clips += [(dict(location='arrangement', startBeats=float(c.start_time), endBeats=float(c.end_time)), c)
              for c in getattr(track, 'arrangement_clips', ())]
    if not 1 <= len(clips) <= 128:
        raise ValueError('track bounce requires one to 128 clips')
    for entry, clip in clips:
        layout.append(entry)
        if not bool(getattr(clip, 'is_audio_clip', False)):
            continue
        rate = getattr(clip, 'sample_rate', None)
        # Live exposes the active clip end through loop_end even with Loop off.
        # The independent end_marker can extend beyond a trimmed Arrangement clip.
        end = float(clip.loop_end)
        if not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate <= 0:
            raise ValueError('native bounce source sample rate unavailable')
        required = float(clip.beat_to_sample_time(end)) if clip.warping else end * rate
        if not math.isfinite(required) or required <= 0:
            raise ValueError('native bounce source end unavailable')
        audio.append({'path': str(clip.file_path), 'sampleRate': float(rate),
                      'requiredEndSamples': required, 'nativeLengthSamples': getattr(clip, 'sample_length', None)})
    result.update(type=state['track']['type'], deviceCount=len(track.devices), mixer=state['mixer'],
                  monitoring=state['routing']['monitoring'],
                  output={key: state['routing']['output'][key] for key in ('type', 'channel')},
                  layout=layout, audioClips=audio, otherTracksToken=_identities[index][1],
                  otherTracksDigest=hashlib.sha256(json.dumps(controls, sort_keys=True).encode()).hexdigest())
    return result
