"""Observe a bounded warped audio region using Live's native source-time mapping."""
import math

try:
    from .bridge import _audio_clip, _audio_clip_state
except ImportError:
    from bridge import _audio_clip, _audio_clip_state


def source(song, params, state_version):
    track_id, clip_id = params['trackId'], params['clipId']
    clip, _ = _audio_clip(song, track_id, clip_id)
    if not clip.warping:
        raise ValueError('warped audio required; the source clip is not changed')
    explicit = 'startBeats' in params or 'endBeats' in params
    kind = 'explicit' if explicit else ('loop' if clip.looping else 'markers')
    start = params.get('startBeats') if explicit else (clip.loop_start if clip.looping else clip.start_marker)
    end = params.get('endBeats') if explicit else (clip.loop_end if clip.looping else clip.end_marker)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
           for value in (start, end)) or not 0 < end - start <= 256:
        raise ValueError('region requires finite start/end beats spanning at most 256 beats')
    convert = getattr(clip, 'beat_to_sample_time', None)
    rate, length = getattr(clip, 'sample_rate', None), getattr(clip, 'sample_length', None)
    if not callable(convert) or any(isinstance(value, bool) or not isinstance(value, (int, float))
                                    or not math.isfinite(value) or value <= 0 for value in (rate, length)):
        raise ValueError('native beat-to-source conversion unavailable')
    first, last = convert(start) / rate, convert(end) / rate
    if not all(math.isfinite(value) for value in (first, last)) or last <= first:
        raise ValueError('native source conversion is not increasing and finite')
    bounded_first, bounded_last = max(0.0, first), min(length / rate, last)
    if not 0.256 <= bounded_last - bounded_first <= 30:
        raise ValueError('source region must contain 0.256 to 30 seconds of file audio')
    return {'stateVersion': state_version, 'trackId': track_id, 'clipId': clip_id,
            'region': {'kind': kind, 'startBeats': float(start), 'endBeats': float(end)},
            'timeSignature': {'numerator': int(clip.signature_numerator), 'denominator': int(clip.signature_denominator)},
            'sourceWindow': {'startSeconds': bounded_first, 'durationSeconds': bounded_last - bounded_first,
                             'sampleRate': float(rate), 'lengthSeconds': length / rate,
                             'requestedStartSeconds': first, 'requestedEndSeconds': last,
                             'clampedToFile': bounded_first != first or bounded_last != last},
            'audioState': _audio_clip_state(song, track_id, clip_id, state_version)}
