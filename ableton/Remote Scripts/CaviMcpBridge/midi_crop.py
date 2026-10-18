"""One native MIDI crop with source guards and explicit observed results."""
import math
import re
import uuid
try:
    from .bridge import _midi_clip, _track, _undo_step
    from .midi_note_removal import context as _source_context
except ImportError:
    from bridge import _midi_clip, _track, _undo_step
    from midi_note_removal import context as _source_context

_song = None
_identities = {}


def context(song, params, version):
    global _song
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('canonical ordinary track ID required')
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('canonical exact MIDI clip ID required')
    if len(song.tracks) > 256: raise ValueError('MIDI cropping supports at most 256 tracks')
    _, track = _track(song, track_id)
    clips = track.arrangement_clips if ':arrangement-clip-' in clip_id else track.clip_slots
    if len(clips) > 4096: raise ValueError('MIDI cropping supports at most 4096 clips per collection')
    clip, _ = _midi_clip(song, track_id, clip_id)
    if getattr(clip, 'is_audio_clip', None) is not False: raise ValueError('exact MIDI clip required')
    binding = (song, tuple(song.tracks), track, clip)
    result = _source_context(song, params, version)
    if (song, tuple(song.tracks), _track(song, track_id)[1], _midi_clip(song, track_id, clip_id)[0]) != binding:
        raise ValueError('MIDI crop target changed during read')
    if _song != song:
        _song = song
        _identities.clear()
    key = track_id, clip_id
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if len(_identities) >= 64: del _identities[next(iter(_identities))]
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    timing = result['clipTiming']
    looped = timing['loop']['enabled']
    region = timing['loop'] if looped else timing['markers']
    start, end = region.get('startBeats'), region.get('endBeats')
    if any(type(n) not in (int, float) or not math.isfinite(n) for n in (start, end)) or not 0 <= start < end:
        raise ValueError('finite increasing native crop interval in clip beats required')
    result.pop('removeSupported')
    result.update(identityToken=cached[1], cropSupported=callable(getattr(clip, 'crop', None)),
                  selectedRegion={'fromLoop': looped, 'startBeats': start, 'endBeats': end})
    return result


def apply(song, params, version):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('MIDI crop source changed after planning')
    if not before['cropSupported'] or any(flag is not False for flag in before['editContext'].values()):
        raise ValueError('resolve native crop support, frozen state, recording, count-in and pending launch')
    clip, _ = _midi_clip(song, params['trackId'], params['clipId'])
    attempted, returned, error = False, False, None
    try:
        with _undo_step(song):
            if context(song, params, version) != before: raise ValueError('MIDI crop source changed before write')
            attempted = True
            clip.crop()
            returned = True
    except Exception as failure:
        if not attempted: raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {'stateVersion': version+1, 'trackId': params['trackId'], 'clipId': params['clipId'],
              'writeRequested': attempted, 'nativeReturned': returned, 'readbackAvailable': False,
              'targetIdentityPreserved': None, 'notesChanged': None, 'timingChanged': None,
              'hiddenExpressionVerified': False, 'observed': None, 'error': error, 'observationError': None,
              'limitation': 'Native crop can discard notes, hidden expression and envelopes, shift source coordinates and change note IDs. Complete exposed readback is not proof of equivalent playback or hidden-state preservation. Inspect actual contents before further edits; no automatic rollback or replay.'}
    try:
        observed = context(song, params, version+1)
        result.update(observed=observed, readbackAvailable=True,
                      targetIdentityPreserved=observed['identityToken'] == before['identityToken'],
                      notesChanged=observed['notes'] != before['notes'],
                      timingChanged={**observed['clipTiming'], 'stateVersion': version} != before['clipTiming'])
        if not result['targetIdentityPreserved'] and error is None: result['error'] = 'native crop target changed during readback'
    except Exception as failure:
        result['observationError'] = (str(failure) or failure.__class__.__name__)[:600]
    return result
