"""Explicit native color reads and guarded bulk color writes."""
import re
import uuid

try:
    from .bridge import _device_owner, _clip_reference, _selection_context, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _device_owner, _clip_reference, _selection_context, _set_fingerprint, _undo_step

_identities = {}
_object_id = re.compile(r'(?:master|(?:track|return|scene)-(?:0|[1-9][0-9]*)|track-(?:0|[1-9][0-9]*):(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*))')


def _ids(values):
    if not isinstance(values, list) or not 1 <= len(values) <= 64:
        raise ValueError('one to 64 explicit color object IDs required')
    if any(not isinstance(key, str) or _object_id.fullmatch(key) is None for key in values) or len(set(values)) != len(values):
        raise ValueError('unique canonical color object IDs required')
    return values


def _resolve(song, key):
    if key.startswith('scene-'):
        return song, song.scenes[int(key[6:])]
    if ':' in key:
        owner_id = key.split(':', 1)[0]
        _, owner = _device_owner(song, owner_id)
        clip, _ = _clip_reference(song, owner_id, key)
        return owner, clip
    return song, _device_owner(song, key)[1]


def _record(key, obj):
    result = {'objectId': key, 'name': str(obj.name)}
    try:
        color, index = obj.color, obj.color_index
        if key.startswith('scene-') and (index is None or type(index) is int and index == -1) and type(color) is int and color in (0, -1):
            return dict(result, supported=True, color=None, colorIndex=index)
        if type(color) is not int or not 0 <= color <= 0xFFFFFF or type(index) is not int or index < 0:
            raise ValueError(f'invalid native color values: RGB={color!r}, paletteIndex={index!r}')
        return dict(result, supported=True, color=f'#{color:06X}', colorIndex=index)
    except Exception as error:
        return dict(result, supported=False, color=None, colorIndex=None, reason=str(error))


def source(song, params, version):
    ids = _ids(params.get('objectIds'))
    targets = [_resolve(song, key) for key in ids]
    key, identity = tuple(ids), (song, tuple(targets))
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'objects': [_record(key, obj) for key, (_, obj) in zip(ids, targets)],
            'selection': _selection_context(song, version)}


def write(song, params, version):
    changes = params.get('changes')
    if not isinstance(changes, list) or any(not isinstance(c, dict) or set(c) != {'objectId', 'color'} for c in changes):
        raise ValueError('explicit objectId/color changes required')
    ids = _ids([c['objectId'] for c in changes])
    if any(not isinstance(c['color'], str) or re.fullmatch(r'#[0-9A-F]{6}', c['color']) is None for c in changes):
        raise ValueError('normalized six-digit RGB color required')
    before = source(song, {'objectIds': ids}, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('color targets or current context changed; review a fresh plan')
    if any(not r['supported'] for r in before['objects']):
        raise ValueError('native color access unsupported for a requested object')
    targets = [_resolve(song, key) for key in ids]
    expected, returned, error = list(before['objects']), [False] * len(ids), None

    def identities_match():
        return [_resolve(song, key) for key in ids] == targets

    try:
        with _undo_step(song):
            for i, change in enumerate(changes):
                if not identities_match() or [_record(key, obj) for key, (_, obj) in zip(ids, targets)] != expected:
                    raise ValueError('color target identity or values changed during execution')
                targets[i][1].color = int(change['color'][1:], 16)
                returned[i] = True
                actual = _record(ids[i], targets[i][1])
                if any(actual.get(key) != expected[i].get(key) for key in ('objectId', 'name', 'supported')):
                    raise ValueError('color target metadata changed during write')
                if not actual['supported'] or actual['color'] is None:
                    raise ValueError('native color readback unavailable after write')
                expected[i] = actual
    except Exception as failure:
        error = str(failure)
    observed, identity_retained = [], False
    try:
        identity_retained = identities_match()
    except Exception as failure:
        error = error or str(failure)
    for i, change in enumerate(changes):
        try:
            actual = _record(ids[i], _resolve(song, ids[i])[1])
        except Exception as failure:
            actual = {'objectId': ids[i], 'supported': False, 'color': None, 'colorIndex': None, 'reason': str(failure)}
        observed.append(dict(actual, requestedColor=change['color'], writeReturned=returned[i],
                             exactMatch=actual['color'] == change['color']))
    selection, unchanged = None, False
    try:
        selection = _selection_context(song, version+1)
        unchanged = dict(selection, stateVersion=version) == before['selection']
    except Exception as failure:
        error = error or str(failure)
    values_retained = all(all(actual.get(k) == value for k, value in wanted.items()) for actual, wanted in zip(observed, expected))
    completed = not error and all(returned) and identity_retained and unchanged and values_retained
    return {'stateVersion': version+1, 'objects': observed, 'identityRetained': identity_retained,
            'selection': selection, 'selectionUnchanged': unchanged, 'writeCompleted': bool(completed),
            'inspectionRequired': not completed, **({'error': error} if error else {}),
            'limitation': 'Live may choose a nearby palette color; exactMatch compares requested and observed RGB. Track color inheritance may affect Rack-chain appearance. No clip recoloring, naming, musical edits or playback requested beyond the explicit objects. Partial color changes remain; no automatic rollback or replay.'}
