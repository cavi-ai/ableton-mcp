"""Native device A/B selection and explicitly scoped other-slot copying."""
import hashlib
import json
import re
import uuid

try:
    from .bridge import _device, _device_owner, _parameter_record, _set_fingerprint, _undo_step
except ImportError:
    from bridge import _device, _device_owner, _parameter_record, _set_fingerprint, _undo_step

_song = None
_identities = {}


def _resolve(song, params):
    owner_id, device_id = params.get('trackId'), params.get('deviceId')
    if not isinstance(owner_id, str) or not re.fullmatch(r'(?:track|return)-(?:0|[1-9][0-9]*)|master', owner_id):
        raise ValueError('canonical device owner required')
    if not isinstance(device_id, str) or not re.fullmatch(re.escape(owner_id) +
            r':device-(?:0|[1-9][0-9]*)(?:/(?:chain|return-chain)-(?:0|[1-9][0-9]*)/device-(?:0|[1-9][0-9]*))*', device_id):
        raise ValueError('canonical device path required')
    _, owner = _device_owner(song, owner_id)
    _, _, device = _device(song, owner_id, device_id)
    parts = device_id[len(owner_id + ':device-'):].split('/')
    lineage = []
    for end in range(1, len(parts) + 1, 2):
        container, _, ancestor = _device(song, owner_id, owner_id + ':device-' + '/'.join(parts[:end]))
        lineage.append((container, ancestor))
    if not 0 < len(device.parameters) <= 2048:
        raise ValueError('device A/B context requires 1 to 2048 exposed parameters')
    return owner, device, tuple(lineage)


def context(song, params, version):
    global _song
    owner, device, lineage = _resolve(song, params)
    if _song != song:
        _song = song
        _identities.clear()
    key = (params['trackId'], params['deviceId'])
    identity = (song, owner, lineage, tuple(device.parameters))
    cached = _identities.get(key)
    if cached is None or cached[0] != identity:
        if key not in _identities and len(_identities) >= 64:
            del _identities[next(iter(_identities))]
        cached = (identity, str(uuid.uuid4()))
        _identities[key] = cached
    supported = bool(getattr(device, 'can_compare_ab', False))
    active_slot = None
    if supported:
        try:
            value = device.is_using_compare_preset_b
            if type(value) is bool:
                active_slot = 'B' if value else 'A'
        except (AttributeError, RuntimeError):
            pass
    parameters = [_parameter_record(parameter, i) for i, parameter in enumerate(device.parameters)]
    digest = hashlib.sha256(json.dumps(parameters, sort_keys=True, allow_nan=False).encode()).hexdigest()
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'trackId': params['trackId'], 'deviceId': params['deviceId'], 'ownerName': str(owner.name),
            'deviceName': str(device.name), 'deviceClass': str(device.class_name),
            'supported': supported, 'activeSlot': active_slot,
            'canCopy': supported and callable(getattr(device, 'save_preset_to_compare_ab_slot', None)),
            'otherSlotContentsAvailable': False, 'parameters': parameters, 'parametersDigest': digest,
            'isFrozen': bool(getattr(owner, 'is_frozen', False)),
            'recording': {'arrangement': bool(song.record_mode), 'session': bool(song.session_record)},
            'isPlaying': bool(song.is_playing)}


def apply(song, params, version, copy_other=False):
    before = context(song, params, version)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or params.get('before') != before:
        raise ValueError('native device A/B context changed; review a fresh plan')
    if not before['supported'] or before['activeSlot'] not in ('A', 'B'):
        raise ValueError('device does not expose supported native A/B selection')
    if before['isFrozen'] or any(before['recording'].values()) or any(
            parameter['automationState'] != {'value': 0, 'name': 'none'} for parameter in before['parameters']):
        raise ValueError('resolve frozen owner, recording and active or unknown parameter automation before device A/B changes')
    if copy_other:
        if params.get('overwriteOtherSlot') is not True:
            raise ValueError('overwriteOtherSlot: true is required to discard the other native A/B slot')
        if not before['canCopy']:
            raise ValueError('native other-slot copy is unavailable')
    elif params.get('targetSlot') not in ('A', 'B'):
        raise ValueError('targetSlot must be A or B')
    owner, device, lineage = _resolve(song, params)
    changed = copy_other or before['activeSlot'] != params['targetSlot']
    result = {'stateVersion': version + 1, 'trackId': params['trackId'], 'deviceId': params['deviceId'],
              'beforeSlot': before['activeSlot'], 'changeRequested': changed, 'hiddenStateVerified': False,
              'automationPreservationVerified': False,
              **({'copyRequested': True, 'copyVerified': False} if copy_other else
                 {'targetSlot': params['targetSlot'], 'switchRequested': changed, 'slotVerified': False})}
    try:
        if changed:
            with _undo_step(song):
                if copy_other:
                    device.save_preset_to_compare_ab_slot()
                else:
                    device.is_using_compare_preset_b = params['targetSlot'] == 'B'
        current_owner, current_device, current_lineage = _resolve(song, params)
        if (current_owner, current_device, current_lineage) != (owner, device, lineage):
            raise RuntimeError('native A/B device ownership changed during the request')
        after = context(song, params, version + 1)
        result['after'] = after
        if copy_other:
            result['observedCurrentStatePreserved'] = after['activeSlot'] == before['activeSlot'] and after['parametersDigest'] == before['parametersDigest']
        else:
            result['slotVerified'] = after['activeSlot'] == params['targetSlot']
    except Exception as error:
        result['verificationError'] = str(error)
    return result
