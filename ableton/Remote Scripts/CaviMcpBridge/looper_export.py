"""Export a fixed native Looper buffer into an empty Session audio slot."""
import math
import re
import uuid

try:
    from .bridge import _device, _device_owner, _clip_slot, _parameter_record, _audio_clip_state, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _device, _device_owner, _clip_slot, _parameter_record, _audio_clip_state, _set_fingerprint, _undo_step

_song = None
_identities = {}


def _objects(song, params):
    owner_id, device_id = params.get('trackId'), params.get('deviceId')
    if not isinstance(owner_id, str) or not re.fullmatch(r'(?:track|return)-(?:0|[1-9][0-9]*)|master', owner_id):
        raise ValueError('canonical device owner required')
    if not isinstance(device_id, str) or not re.fullmatch(re.escape(owner_id) +
            r':device-(?:0|[1-9][0-9]*)(?:/(?:chain|return-chain)-(?:0|[1-9][0-9]*)/device-(?:0|[1-9][0-9]*))*', device_id):
        raise ValueError('canonical device path required')
    _, owner = _device_owner(song, owner_id)
    _, _, device = _device(song, owner_id, device_id)
    if device.class_name != 'Looper':
        raise ValueError('native Looper required')
    parts = device_id[len(owner_id + ':device-'):].split('/')
    lineage = tuple(_device(song, owner_id, owner_id + ':device-' + '/'.join(parts[:end]))[::2]
                    for end in range(1, len(parts) + 1, 2))
    destination, _, slot = _clip_slot(song, params['destinationTrackId'], params['destinationClipId'])
    return owner, device, lineage, destination, slot


def _number(device, name):
    try:
        value = float(getattr(device, name))
        return value if math.isfinite(value) else None
    except (AttributeError, RuntimeError, ValueError, TypeError):
        return None


def context(song, params, version):
    global _song
    owner, device, lineage, destination, slot = _objects(song, params)
    if not 0 < len(device.parameters) <= 512:
        raise ValueError('Looper export requires 1 to 512 exposed parameters')
    identity = (song, owner, lineage, tuple(device.parameters), destination, slot)
    key = tuple(params[name] for name in ('trackId', 'deviceId', 'destinationTrackId', 'destinationClipId'))
    if _song != song:
        _song = song
        _identities.clear()
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    parameters = [_parameter_record(parameter, i) for i, parameter in enumerate(device.parameters)]
    states = [p for p in parameters if p['originalName'] == 'State' and p['quantized'] and p['enabled']]
    state = None
    if len(states) == 1:
        p = states[0]
        index = p['value'] - p['min']
        if float(index).is_integer() and 0 <= index < len(p['valueItems']):
            state = p['valueItems'][int(index)]
    length = _number(device, 'loop_length')
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), **dict(zip(
            ('trackId', 'deviceId', 'destinationTrackId', 'destinationClipId'), key)),
            'identityToken': cached[1], 'deviceName': str(device.name), 'sourceOwnerName': str(owner.name),
            'canExport': callable(getattr(device, 'export_to_clip_slot', None)) and length is not None,
            'loopLength': length, 'tempo': _number(device, 'tempo'), 'state': state,
            'parameters': parameters, 'sourceFrozen': bool(getattr(owner, 'is_frozen', False)),
            'recording': {'arrangement': bool(song.record_mode), 'session': bool(song.session_record)},
            'destination': {'name': str(destination.name), 'hasClip': bool(slot.has_clip),
                'audioTrack': bool(destination.has_audio_input) and not bool(destination.has_midi_input) and
                    not bool(getattr(destination, 'is_foldable', False)),
                'frozen': bool(destination.is_frozen), 'armed': bool(destination.arm),
                'firedSlotIndex': int(destination.fired_slot_index), 'isTriggered': bool(getattr(slot, 'is_triggered', False))},
            'bufferContentAvailable': False}


def export(song, params, version):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or params.get('before') != before:
        raise ValueError('Looper export context changed; review a fresh plan')
    target = before['destination']
    if (not before['canExport'] or before['loopLength'] <= 0 or before['state'] not in ('Stop', 'Play') or
            before['sourceFrozen'] or any(before['recording'].values()) or target['hasClip'] or
            not target['audioTrack'] or target['frozen'] or target['armed'] or target['firedSlotIndex'] >= 0 or target['isTriggered']):
        raise ValueError('Looper export requires a fixed nonempty buffer, Stop/Play state, no recording and an empty inactive unarmed audio destination')
    name = params.get('name')
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 128):
        raise ValueError('name must contain 1 to 128 characters')
    objects = _objects(song, params)
    _, device, _, _, slot = objects
    result = {'stateVersion': version + 1, **{k: params[k] for k in (
        'trackId', 'deviceId', 'destinationTrackId', 'destinationClipId')},
        'exportRequested': True, 'clipCreatedVerified': False, 'bufferContentVerified': False}
    try:
        with _undo_step(song):
            device.export_to_clip_slot(slot)
            if _objects(song, params) != objects or not slot.has_clip or not bool(slot.clip.is_audio_clip):
                raise RuntimeError('destination audio clip or ownership is unconfirmed')
            created = slot.clip
            if name is not None:
                created.name = name
            audio = _audio_clip_state(song, params['destinationTrackId'], params['destinationClipId'], version + 1)
            if not audio['source']['path'] or not float(created.length) > 0 or (name is not None and created.name != name):
                raise RuntimeError('exported clip source, length or name is unconfirmed')
            if _objects(song, params) != objects or slot.clip != created:
                raise RuntimeError('destination ownership changed during readback')
            result.update(clipCreatedVerified=True, name=str(created.name), audio=audio)
    except Exception as error:
        result['verificationError'] = '%s; inspect the Looper and destination before retrying; partial material is retained' % error
    return result
