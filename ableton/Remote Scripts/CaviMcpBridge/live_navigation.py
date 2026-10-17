"""Explicit native selection and view changes without musical writes."""
import re
import uuid

try:
    from .bridge import (_device_owner, _device, _track, _clip_slot, _clip_reference,
                         _selection_context, _set_fingerprint)
except ImportError:
    from bridge import (_device_owner, _device, _track, _clip_slot, _clip_reference,
                        _selection_context, _set_fingerprint)

_targets = {}
_views = ('Session', 'Arranger', 'Detail', 'Detail/Clip', 'Detail/DeviceChain')


def _visible(application):
    if application is None or not hasattr(application, 'view'):
        raise ValueError('native Live view control is unavailable')
    return {name: bool(application.view.is_view_visible(name)) for name in _views}


def _device_views(owner, device_id):
    prefix, suffix = device_id.split(':device-', 1)
    parts = suffix.split('/')
    device = owner.devices[int(parts[0])]
    current_id = prefix + ':device-' + parts[0]
    path = []
    for position in range(1, len(parts), 2):
        chain_part, child = parts[position:position+2]
        returning = chain_part.startswith('return-chain-')
        index = int(chain_part.removeprefix('return-chain-' if returning else 'chain-'))
        chain = (device.return_chains if returning else device.chains)[index]
        path.append((device, chain, {'deviceId': current_id, 'chainId': current_id + '/' + chain_part,
                     'isCollapsed': bool(device.view.is_collapsed),
                     'chainDevicesVisible': bool(device.view.is_showing_chain_devices),
                     'selectedChainMatches': device.view.selected_chain == chain}))
        current_id += '/' + chain_part + '/' + child
        device = chain.devices[int(child.removeprefix('device-'))]
    path.append((device, None, {'deviceId': current_id, 'isCollapsed': bool(device.view.is_collapsed)}))
    return path


def _resolve(song, params):
    owner_id, owner = _device_owner(song, params['trackId'])
    view, clip_id, device_id = params.get('view'), params.get('clipId'), params.get('deviceId')
    if view not in ('Session', 'Arranger') or clip_id is not None and device_id is not None:
        raise ValueError('one exact navigation target and Session/Arranger view required')
    target, slot, scene, detail = owner, None, None, None
    record = {'kind': 'track', 'trackId': owner_id, 'name': str(getattr(owner, 'name', 'Main')), 'view': view}
    if device_id is not None:
        pattern = re.escape(owner_id) + r':device-(0|[1-9][0-9]*)(/(chain|return-chain)-(0|[1-9][0-9]*)/device-(0|[1-9][0-9]*))*'
        if not isinstance(device_id, str) or re.fullmatch(pattern, device_id) is None:
            raise ValueError('canonical device path required')
        _, _, target = _device(song, owner_id, device_id)
        detail = 'Detail/DeviceChain'
        record.update(kind='device', deviceId=device_id, name=str(target.name))
    elif clip_id is not None:
        _track(song, owner_id)
        if isinstance(clip_id, str) and ':arrangement-clip-' in clip_id:
            if view != 'Arranger' or bool(getattr(owner, 'is_foldable', False)):
                raise ValueError('Arrangement clips require an ordinary track and Arranger view')
            target, timeline = _clip_reference(song, owner_id, clip_id)
            record.update(kind='clip', clipId=clip_id, location='arrangement', name=str(target.name), timeline=timeline)
            detail = 'Detail/Clip'
        else:
            if view != 'Session':
                raise ValueError('Session slots require Session view')
            _, index, slot = _clip_slot(song, owner_id, clip_id)
            scene = song.scenes[index]
            target = slot.clip if slot.has_clip else slot
            record.update(kind='clip' if slot.has_clip else 'slot', clipId=clip_id,
                          location='session', name=str(target.name) if slot.has_clip else None,
                          hasClip=bool(slot.has_clip))
            detail = 'Detail/Clip' if slot.has_clip else None
    groups, parent, seen = [], owner, []
    while bool(getattr(parent, 'is_grouped', False)):
        parent = parent.group_track
        if parent in seen or len(seen) >= 32:
            raise ValueError('navigation Group ancestry is cyclic or exceeds 32 levels')
        seen.append(parent)
        index = next((i for i, t in enumerate(song.tracks) if t == parent), None)
        if index is None:
            raise ValueError('navigation Group ancestor is unavailable')
        groups.append((parent, {'trackId': f'track-{index}', 'foldState': int(parent.fold_state)}))
    device_views = _device_views(owner, device_id) if device_id is not None else []
    return owner, target, slot, scene, detail, groups, record, device_views


def _controls(song):
    if len(song.tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('navigation supports at most 256 ordinary and 64 Return tracks')
    owners = [(f'track-{i}', t) for i, t in enumerate(song.tracks)]
    owners += [(f'return-{i}', t) for i, t in enumerate(song.return_tracks)]
    owners.append(('master', song.master_track))
    recording, slots = [], 0
    for index, track in enumerate(song.tracks):
        slots += len(track.clip_slots)
        if slots > 16384:
            raise ValueError('navigation recording inspection exceeds 16384 Session slots')
        recording.extend(f'track-{index}:clip-{i}' for i, slot in enumerate(track.clip_slots)
                         if slot.has_clip and bool(getattr(slot.clip, 'is_recording', False)))
    return {'playing': bool(song.is_playing), 'arrangementRecord': bool(song.record_mode),
            'sessionRecord': bool(song.session_record), 'recordingClips': recording,
            'tracks': [{'id': key, 'mute': None if key == 'master' else bool(t.mute),
                        'solo': None if key == 'master' else bool(t.solo),
                        'arm': None if key == 'master' else bool(getattr(t, 'arm', False)) if bool(getattr(t, 'can_be_armed', True)) else False,
                        'volume': float(t.mixer_device.volume.value), 'pan': float(t.mixer_device.panning.value),
                        'monitoring': getattr(t, 'current_monitoring_state', None)
                        if key.startswith('track-') and not bool(getattr(t, 'is_foldable', False)) else None}
                       for key, t in owners]}


def source(song, params, version, application):
    owner, target, slot, scene, detail, groups, record, device_views = _resolve(song, params)
    controls = _controls(song)
    if controls['arrangementRecord'] or controls['sessionRecord'] or controls['recordingClips']:
        raise ValueError('resolve active recording before changing Live navigation')
    visible = _visible(application)
    view = song.view
    selected = getattr(view, 'selected_track', None)
    identity = (song, owner, target, slot, scene, tuple(t for t, _ in groups),
                selected, getattr(view, 'selected_scene', None), getattr(view, 'detail_clip', None),
                getattr(view, 'highlighted_clip_slot', None),
                getattr(getattr(selected, 'view', None), 'selected_device', None),
                tuple((d, c, d.view.selected_chain if c is not None else None) for d, c, _ in device_views))
    key = (params['trackId'], params.get('clipId'), params.get('deviceId'), params['view'])
    cached = _targets.get(key)
    if cached is None or cached[0] != identity:
        if key not in _targets and len(_targets) >= 64:
            _targets.pop(next(iter(_targets)))
        cached = (identity, str(uuid.uuid4()))
        _targets[key] = cached
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'target': record, 'detailView': detail, 'groupsToReveal': [r for _, r in groups],
            'deviceViews': [r for _, _, r in device_views],
            'selection': _selection_context(song, version), 'views': visible, 'controls': controls}


def show(song, params, version, application):
    before = source(song, params, version, application)
    if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or before != params.get('before'):
        raise ValueError('Live navigation target or current selection changed; review a fresh plan')
    owner, target, slot, scene, detail, groups, record, device_views = _resolve(song, params)
    error = None
    try:
        for group, _ in reversed(groups):
            group.fold_state = 0
        song.view.selected_track = owner
        if slot is not None:
            song.view.selected_scene = scene
            song.view.highlighted_clip_slot = slot
        if record['kind'] == 'clip':
            song.view.detail_clip = target
        elif record['kind'] == 'device':
            for device, chain, _ in device_views:
                device.view.is_collapsed = False
                if chain is not None:
                    device.view.selected_chain = chain
                    device.view.is_showing_chain_devices = True
            song.view.select_device(target)
        application.view.show_view(params['view'])
        if detail:
            application.view.show_view('Detail')
            application.view.show_view(detail)
        application.view.focus_view(detail or params['view'])
    except Exception as failure:
        error = str(failure)
    selection, visible, controls, current_target = None, None, None, None
    identity_retained, device_views_ok, current_device_views = False, False, None
    selection_ok, views_ok = False, False
    try:
        selection = _selection_context(song, version+1)
        visible, controls = _visible(application), _controls(song)
        current = _resolve(song, params)
        current_target = current[6]
        identity_retained = (current[:5] == (owner, target, slot, scene, detail)
                             and tuple(t for t, _ in current[5]) == tuple(t for t, _ in groups)
                             and tuple((d, c) for d, c, _ in current[7]) == tuple((d, c) for d, c, _ in device_views))
        current_device_views = [r for _, _, r in current[7]]
        device_views_ok = all(not r['isCollapsed'] and r.get('chainDevicesVisible', True)
                              and r.get('selectedChainMatches', True) for r in current_device_views)
        selection_ok = identity_retained and song.view.selected_track == owner
        if slot is not None:
            selection_ok = selection_ok and song.view.highlighted_clip_slot == slot and song.view.selected_scene == scene
        if record['kind'] == 'clip':
            selection_ok = selection_ok and song.view.detail_clip == target
        elif record['kind'] == 'device':
            selection_ok = selection_ok and owner.view.selected_device == target
        views_ok = visible[params['view']] and (detail is None or visible['Detail'] and visible[detail])
        views_ok = views_ok and device_views_ok and all(int(group.fold_state) == 0 for group, _ in groups)
    except Exception as failure:
        error = error or str(failure)
    unchanged = controls == before['controls']
    verified = not error and bool(selection_ok) and bool(views_ok) and unchanged
    return {'stateVersion': version+1, 'target': record, 'selection': selection, 'views': visible,
            'currentTarget': current_target, 'targetIdentityRetained': bool(identity_retained),
            'deviceViews': current_device_views, 'deviceViewsVerified': bool(device_views_ok),
            'controls': controls, 'selectionVerified': bool(selection_ok), 'viewsVerified': bool(views_ok),
            'controlsUnchanged': unchanged, 'showVerified': bool(verified), 'inspectionRequired': not verified,
            **({'error': error} if error else {}),
            'limitation': 'Selection and native view visibility only; does not establish desktop activation, pixel visibility, timeline scrolling, plug-in editor visibility, sound or hidden content preservation. Changes control-surface focus and may unfold Group ancestors, expand devices and reveal Rack chains. Partial UI changes are retained.'}
