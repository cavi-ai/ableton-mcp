"""Read-only preset evidence and guarded selection of a native device."""
import hashlib
import json
import os
import re
import uuid
try:
    from .bridge import _device, _device_owner, _snapshot_device, _set_fingerprint, _selection_context
except ImportError:
    from bridge import _device, _device_owner, _snapshot_device, _set_fingerprint, _selection_context

_song = None
_identities = {}


def _ui_identity(song, track, owner_id, device_id):
    if owner_id == 'master':
        track_path = '.MainTrack'
    elif owner_id.startswith('return-'):
        track_path = '.ReturnTrack[%s]' % list(song.return_tracks).index(track)
    else:
        tracks, current, lineage, seen = list(song.tracks), track, [], []
        def parent(item):
            return item.group_track if bool(getattr(item, 'is_grouped', False)) else None
        while current is not None:
            if current in seen or current not in tracks:
                raise ValueError('native track hierarchy is unavailable or cyclic')
            seen.append(current)
            owner = parent(current)
            siblings = [item for item in tracks if parent(item) == owner]
            lineage.insert(0, ('.GroupTrack' if getattr(current, 'is_foldable', False) else '.Track') + '[%s]' % siblings.index(current))
            current = owner
        track_path = ''.join(lineage)
    parts = device_id.split(':device-', 1)[1].split('/')
    device = track.devices[int(parts[0])]
    path, chains = 'TrackView.Device[%s]' % int(parts[0]), []
    for position in range(1, len(parts), 2):
        chain_part, child_part = parts[position:position + 2]
        ordinary = list(device.chains)
        returns = list(getattr(device, 'return_chains', ()))
        is_return = chain_part.startswith('return-chain-')
        index = int(chain_part.split('chain-', 1)[1])
        chains.append({'rackUIId': path, 'index': len(ordinary) + index if is_return else index,
                       'count': len(ordinary) + len(returns)})
        chain = (returns if is_return else ordinary)[index]
        path += '.Device[%s]' % int(child_part.removeprefix('device-'))
        device = chain.devices[int(child_part.removeprefix('device-'))]
    return {'trackPath': track_path, 'devicePath': path, 'chains': chains}


def source(song, params, version):
    global _song, _identities
    if _song != song:
        _song, _identities = song, {}
    owner_id, track = _device_owner(song, params['trackId'])
    parent, index, device = _device(song, owner_id, params['deviceId'])
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)):
        raise ValueError('preset saving requires stopped playback and recording')
    if bool(getattr(track, 'is_frozen', False)) or any(int(t.fired_slot_index) != -1 for t in song.tracks):
        raise ValueError('resolve frozen target or pending launches before preset saving')
    native, counts = [], [0, 0]
    def collect(item):
        parameters = tuple(item.parameters)
        counts[0] += 1
        counts[1] += len(parameters)
        if counts[0] > 512 or counts[1] > 16384:
            raise ValueError('preset source exceeds 512 devices or 16384 parameters')
        native.extend((item, parameters, getattr(item, 'sample', None)))
        if item.can_have_chains:
            for chain in list(item.chains) + list(getattr(item, 'return_chains', ())):
                native.append(chain)
                for child in chain.devices:
                    collect(child)
    collect(device)
    identity = (song, track, tuple(track.devices), parent, index, tuple(native))
    key = (owner_id, params['deviceId'])
    if key not in _identities or _identities[key][0] != identity:
        if len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        _identities[key] = identity, str(uuid.uuid4())
    snapshot = _snapshot_device(device, params['deviceId'])
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song),
            'filePath': str(song.file_path), 'scriptDirectory': os.path.dirname(__file__),
            'identityToken': _identities[key][1], 'trackId': owner_id, 'deviceId': params['deviceId'],
            'uiIdentity': _ui_identity(song, track, owner_id, params['deviceId']),
            'name': str(device.name), 'className': str(device.class_name), 'snapshot': snapshot,
            'contentSha256': hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()}


def select(song, params, version, application):
    before = source(song, params, version)
    if params.get('expectedStateVersion') != version or before != params.get('before'):
        raise ValueError('preset source changed before selection')
    if application is None or not callable(getattr(song.view, 'select_device', None)):
        raise ValueError('native device selection is unavailable')
    _, track = _device_owner(song, params['trackId'])
    _, _, device = _device(song, params['trackId'], params['deviceId'])
    name = params.get('name')
    if not isinstance(name, str) or not 1 <= len(name) <= 80 or name != name.strip() or name.startswith('.') or re.search(r'[/\\:\x00-\x1f\x7f]', name):
        raise ValueError('preset name must be a visible filename stem of at most 80 characters')
    count = [0]
    def check_names(items):
        for item in items:
            count[0] += 1
            if count[0] > 4096:
                raise ValueError('preset name check exceeds 4096 Set devices')
            if item != device and str(item.name) == name:
                raise ValueError('preset name already identifies another Set device')
            if item.can_have_chains:
                for chain in list(item.chains) + list(getattr(item, 'return_chains', ())):
                    check_names(chain.devices)
    for owner in list(song.tracks) + list(song.return_tracks) + [song.master_track]:
        check_names(owner.devices)
    device.name = name
    song.view.selected_track = track
    song.view.select_device(device)
    application.view.show_view('Detail')
    application.view.focus_view('Detail/DeviceChain')
    if song.view.selected_track != track or track.view.selected_device != device:
        raise RuntimeError('native preset device selection did not verify')
    return {'stateVersion': version + 1, 'source': source(song, params, version + 1),
            'selection': _selection_context(song, version + 1)}
