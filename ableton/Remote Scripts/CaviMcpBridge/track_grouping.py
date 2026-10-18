"""Native evidence for an explicit track-grouping UI command."""
import hashlib
import json
import os
import re
import uuid
try:
    from .bridge import (_track, _track_record, _track_routing, _track_state_snapshot, _persisted_track_state,
                         _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint,
                         _song_musical_context, _transport_recording_context, _set_mixer, _routing_option, _current_routing_option)
except ImportError:
    from bridge import (_track, _track_record, _track_routing, _track_state_snapshot, _persisted_track_state,
                        _clip_timing, _audio_clip_state, _midi_note_record, _set_fingerprint,
                        _song_musical_context, _transport_recording_context, _set_mixer, _routing_option, _current_routing_option)

_contexts = {}


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _parent(track):
    return track.group_track if bool(getattr(track, 'is_grouped', False)) else None


def _global(song):
    recording = _transport_recording_context(song, 0)
    recording['midiCapture'].pop('midiTrackIds', None)
    return {'musical': _song_musical_context(song, 0), 'recording': recording,
            'mixer': _set_mixer(song, 0)}


def _controls(song, tracks, targets):
    rows = []
    for track in tracks:
        i = list(song.tracks).index(track)
        row = _track_record(song, track, i)
        for key in ('id', 'isGrouped', 'groupTrackId'):
            row.pop(key, None)
        routing = _track_routing(song, f'track-{i}', 0)
        row['routing'] = {side: {key: routing[side][key] for key in ('type', 'channel')}
                          for side in ('input', 'output') if side != 'output' or track not in targets}
        row['monitoring'] = routing['monitoring']
        row['sends'] = [float(p.value) for p in track.mixer_device.sends]
        rows.append(row)
    return rows


def _material(song, track, budget, name_override=None, include_note_ids=True):
    index = list(song.tracks).index(track)
    key, refs = f'track-{index}', [track]
    def devices(items):
        for device in items:
            budget['devices'] += 1
            budget['parameters'] += len(device.parameters)
            if budget['devices'] > 512 or budget['parameters'] > 32768:
                raise ValueError('grouping evidence exceeds device or parameter limits')
            refs.extend([device, tuple(device.parameters)])
            if bool(getattr(device, 'can_have_chains', False)):
                for chain in [*device.chains, *getattr(device, 'return_chains', ())]:
                    refs.append(chain)
                    devices(chain.devices)
    devices(track.devices)
    slots = list(track.clip_slots)
    arrangement = [] if bool(getattr(track, 'is_foldable', False)) else list(getattr(track, 'arrangement_clips', ()))
    budget['slots'] += len(slots) + len(arrangement)
    if budget['slots'] > 4096:
        raise ValueError('grouping evidence exceeds 4096 slots and Arrangement clips')
    refs.extend(slots)
    clips = [(f'{key}:clip-{i}', slot.clip) for i, slot in enumerate(slots) if slot.has_clip]
    clips += [(f'{key}:arrangement-clip-{i}', clip) for i, clip in enumerate(arrangement)]
    material = []
    for clip_id, clip in clips:
        if bool(getattr(clip, 'is_recording', False)) or bool(getattr(clip, 'is_triggered', False)):
            raise ValueError('resolve target recording or pending launches before grouping')
        refs.append(clip)
        row = {'name': str(clip.name), 'color': getattr(clip, 'color', None), 'timing': _clip_timing(song, key, clip_id, 0)}
        if bool(getattr(clip, 'is_audio_clip', False)):
            row['audio'] = _audio_clip_state(song, key, clip_id, 0)
        else:
            row['notes'] = [_midi_note_record(note) for note in clip.get_all_notes_extended()]
            budget['notes'] += len(row['notes'])
            if budget['notes'] > 16384:
                raise ValueError('grouping evidence exceeds 16384 stored MIDI notes')
            if not include_note_ids:
                row['notes'] = sorted([{k:v for k,v in note.items() if k != 'noteId'} for note in row['notes']],
                                      key=lambda note: json.dumps(note,sort_keys=True))
        material.append(row)
    state = _persisted_track_state(_track_state_snapshot(song, key, 0))
    if name_override is not None:
        state['track']['name'] = name_override
    state['readiness'] = {'frozen': bool(track.is_frozen), 'armed': bool(track.arm) if getattr(track, 'can_be_armed', True) else False,
                          'audioOutput': bool(getattr(track, 'has_audio_output', False))}
    state['routing'].pop('outputTypeId', None)
    state['routing'].pop('outputChannelId', None)
    def relative(value):
        if isinstance(value, list):
            return [relative(item) for item in value]
        if isinstance(value, dict):
            return {k: 'owner' + v[len(key):] if k == 'id' and isinstance(v, str) and v.startswith(key + ':') else relative(v)
                    for k, v in value.items() if k not in ('stateVersion', 'trackId', 'clipId')}
        return value
    return _hash(relative({'track': state, 'color': getattr(track, 'color', None), 'clips': material})), tuple(refs)


def _budget():
    return dict(devices=0, parameters=0, slots=0, notes=0)


def source(song, params, version):
    ids = params.get('trackIds')
    if not isinstance(ids, list) or not 2 <= len(ids) <= 64 or any(not isinstance(key, str) or re.fullmatch(r'track-(0|[1-9][0-9]*)', key) is None for key in ids):
        raise ValueError('two to 64 explicit canonical track IDs required')
    indices, tracks = zip(*[_track(song, key) for key in ids])
    if list(indices) != list(range(indices[0], indices[0] + len(ids))):
        raise ValueError('grouping requires consecutive tracks in Live order without duplicates')
    if not str(getattr(song, 'file_path', '')).startswith('/') or len(song.tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('grouping requires a saved Set with at most 256 tracks and 64 Returns')
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)) or any(int(t.fired_slot_index) != -1 for t in song.tracks):
        raise ValueError('grouping requires stopped playback/recording and no pending launches')
    targets, material, native, budget = [], [], [], _budget()
    roots = [t for t in song.tracks if _parent(t) is None]
    for key, track in zip(ids, tracks):
        if bool(getattr(track, 'is_foldable', False)) or _parent(track) is not None or bool(track.arm) or bool(track.is_frozen) or not bool(getattr(track, 'has_audio_output', False)):
            raise ValueError('grouping requires ungrouped, unarmed, unfrozen ordinary audio-producing tracks')
        route = _track_routing(song, key, 0)['output']
        if route['type']['name'] != 'Main':
            raise ValueError('grouping requires each source output on Main')
        digest, refs = _material(song, track, budget)
        material.append(digest)
        native.append(refs)
        targets.append({'trackId': key, 'name': str(track.name), 'uiPath': f'.Track[{roots.index(track)}]',
                        'output': {k: route[k] for k in ('type', 'channel')}, 'contentSha256': digest})
    identity = (song, tuple(song.tracks), tuple(song.return_tracks), tuple(song.scenes), tuple(native), song.master_track)
    observed = {'filePath': str(song.file_path), 'setFingerprint': _set_fingerprint(song), 'targets': targets,
                'controls': _controls(song, song.tracks, tracks), 'globalContext': _global(song)}
    digest = _hash(observed)
    previous = next(((key, entry) for key, entry in _contexts.items() if entry['identity'] == identity and entry['digest'] == digest), None)
    if previous is None:
        if len(_contexts) >= 64:
            _contexts.pop(next(iter(_contexts)))
        token = str(uuid.uuid4())
        _contexts[token] = {'identity': identity, 'digest': digest, 'before': observed, 'tracks': tuple(song.tracks),
                            'targets': tracks, 'ids': ids, 'material': material, 'native': native,
                            'parents': tuple(_parent(t) for t in song.tracks), 'first': indices[0]}
    else:
        token = previous[0]
    return {'stateVersion': version, 'groupingId': token, 'identityToken': token, **observed,
            'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(song.file_path))[0])}


def status(song, params, version):
    entry = _contexts.get(params.get('groupingId'))
    if entry is None or entry['identity'][0] != song:
        raise ValueError('grouping handle unavailable for this Live Set; inspect current tracks')
    current, original, targets = list(song.tracks), list(entry['tracks']), entry['targets']
    context = (str(song.file_path) == entry['before']['filePath'] and tuple(song.return_tracks) == entry['identity'][2]
               and tuple(song.scenes) == entry['identity'][3] and song.master_track == entry['identity'][5])
    extra = [t for t in current if t not in original]
    group = extra[0] if len(extra) == 1 and bool(getattr(extra[0], 'is_foldable', False)) else None
    order = group is not None and current == original[:entry['first']] + [group] + original[entry['first']:]
    membership = group is not None and _parent(group) is None and [t for t in current if _parent(t) == group] == list(targets)
    other_parents = all(_parent(t) == parent for t, parent in zip(original, entry['parents']) if t in current and t not in targets)
    members, preserved, routed, original_routing, budget, error = [], True, True, True, _budget(), None
    for i, target in enumerate(targets):
        member = {'sourceTrackId': entry['ids'][i], 'trackId': f'track-{current.index(target)}' if target in current else None}
        try:
            if target not in current:
                raise ValueError('original target is no longer present')
            digest, refs = _material(song, target, budget)
            route = _track_routing(song, member['trackId'], 0)['output']
            original_routing = original_routing and {k: route[k] for k in ('type', 'channel')} == entry['before']['targets'][i]['output']
            preserved = preserved and digest == entry['material'][i] and refs == entry['native'][i]
            routed = routed and route['type']['name'] == 'Group' and route['channel'] == entry['before']['targets'][i]['output']['channel']
            member.update(name=str(target.name), output={k: route[k] for k in ('type', 'channel')}, materialPreserved=digest == entry['material'][i] and refs == entry['native'][i])
        except Exception as failure:
            preserved, routed, original_routing = False, False, False
            error = error or str(failure)
        members.append(member)
    controls, global_context, group_record, renumbered = False, False, None, []
    try:
        expected_controls = []
        for i, (track, row) in enumerate(zip(original, entry['before']['controls'])):
            expected = dict(row)
            if order and track not in targets and bool(getattr(track, 'is_foldable', False)) and row['name'] == f'{i + 1}-Group':
                name = f'{current.index(track) + 1}-Group'
                if str(track.name) == name and name != row['name']:
                    expected['name'] = name
                    renumbered.append({'sourceTrackId': f'track-{i}', 'trackId': f'track-{current.index(track)}',
                                       'before': row['name'], 'after': name})
            expected_controls.append(expected)
        controls = _controls(song, original, targets) == expected_controls
        global_context = _global(song) == entry['before']['globalContext']
        if group is not None:
            key = f'track-{current.index(group)}'
            route = _track_routing(song, key, 0)['output']
            group_record = {**_track_record(song, group, current.index(group)), 'output': {k: route[k] for k in ('type', 'channel')}}
            routed = routed and route['type']['name'] == 'Main' and all(route['channel'] == t['output']['channel'] for t in entry['before']['targets'])
    except Exception as failure:
        error = error or str(failure)
    verified = not error and context and order and membership and other_parents and preserved and routed and controls and global_context
    unchanged = context and current == original and all(_parent(t) == p for t, p in zip(original, entry['parents'])) and preserved and controls and global_context and original_routing
    return {'stateVersion': version, 'groupingId': params['groupingId'], 'status': 'grouped' if verified else 'unchanged' if unchanged else 'changed',
            'group': group_record, 'members': members, 'renumberedGroupNames': renumbered,
            'originalOrderPreserved': bool(order), 'membershipVerified': bool(membership and other_parents),
            'materialPreserved': preserved, 'routingVerified': bool(routed), 'sourceOutputsPreserved': original_routing,
            'controlsPreserved': context and controls and global_context and bool(original_routing or group is not None and membership and routed),
            'groupVerified': bool(verified), 'inspectionRequired': not verified and not unchanged,
            **({'error': error} if error else {}),
            'limitation': 'Checks retained native tracks, exact membership and order, exposed target notes/timing/audio/device state and existing mixer/routing controls. Excludes automation envelopes, hidden plug-in state and external file bytes; does not establish audio equivalence or saved state. Track IDs shift after insertion. No automatic undo or ungrouping.'}


_ungroup_contexts = {}


def _ancestors(track, tracks):
    parents, parent = [], _parent(track)
    while parent is not None:
        if parent not in tracks or parent in parents:
            raise ValueError('invalid native Group hierarchy')
        parents.append(parent)
        parent = _parent(parent)
    return parents


def _sidechain_controls(owners, removed_name=None):
    records, refs = [], []
    def visit(devices, owner, prefix=''):
        for i, device in enumerate(devices):
            path = prefix + f'device-{i}'
            refs.append(device)
            if len(refs) > 512:
                raise ValueError('ungrouping dependency evidence exceeds 512 devices')
            if all(hasattr(device, key) for key in ('input_routing_type', 'input_routing_channel')):
                route = {'type': _routing_option(device.input_routing_type), 'channel': _routing_option(device.input_routing_channel)}
                if removed_name is not None and removed_name in (route['type']['id'], route['type']['name']):
                    raise ValueError('resolve exposed sidechain dependencies on this Group before ungrouping')
                records.append({'owner': owner, 'path': path, **route})
            if bool(getattr(device, 'can_have_chains', False)):
                for kind, chains in (('chain', device.chains), ('return-chain', getattr(device, 'return_chains', ()))):
                    for j, chain in enumerate(chains):
                        visit(chain.devices, owner, path + f'/{kind}-{j}/')
    for i, owner in enumerate(owners):
        visit(owner.devices, i)
    return records, tuple(refs)


def _auxiliary_routing(owners, removed_name=None):
    records = []
    for i, owner in enumerate(owners):
        for side in ('input', 'output'):
            current, available = f'current_{side}_routing', f'available_{side}_routing_types'
            if hasattr(owner, current) and hasattr(owner, available):
                route = _current_routing_option(getattr(owner, current), list(getattr(owner, available)))
                if removed_name is not None and removed_name in (route['id'], route['name']):
                    raise ValueError('resolve Return/Main routing dependencies on this Group before ungrouping')
                channel, choices = f'current_{side}_sub_routing', f'available_{side}_routing_channels'
                records.append({'owner': i, 'side': side, 'type': route,
                                'channel': _current_routing_option(getattr(owner, channel), list(getattr(owner, choices)))
                                if hasattr(owner, channel) and hasattr(owner, choices) else None})
    return records


def ungroup_source(song, params, version):
    key = params.get('groupTrackId')
    if not isinstance(key, str) or re.fullmatch(r'track-(0|[1-9][0-9]*)', key) is None:
        raise ValueError('one canonical Group track ID required')
    index, group = _track(song, key)
    tracks = list(song.tracks)
    if not bool(getattr(group, 'is_foldable', False)):
        raise ValueError('ungrouping requires an existing Group Track')
    if not str(getattr(song, 'file_path', '')).startswith('/') or len(tracks) > 256 or len(song.return_tracks) > 64:
        raise ValueError('ungrouping requires a saved Set with at most 256 tracks and 64 Returns')
    if song.is_playing or song.record_mode or song.session_record or bool(getattr(song, 'is_counting_in', False)) or any(int(t.fired_slot_index) != -1 for t in tracks):
        raise ValueError('ungrouping requires stopped playback/recording and no pending launches')
    descendants = [t for t in tracks if group in _ancestors(t, tracks)]
    if not descendants:
        raise ValueError('empty Groups use explicit track deletion instead of ungrouping')
    if [tracks.index(t) for t in descendants] != list(range(index + 1, index + 1 + len(descendants))):
        raise ValueError('native Group descendants are not contiguous')
    for track in [group, *descendants]:
        if bool(track.is_frozen) or getattr(track, 'can_be_armed', True) and bool(track.arm):
            raise ValueError('ungrouping requires unarmed, unfrozen Group descendants')
    visible = [t for t in tracks if not any(int(p.fold_state) != 0 for p in _ancestors(t, tracks))]
    if group not in visible:
        raise ValueError('unfold the enclosing Groups before planning ungrouping')
    retained = tracks[:index] + tracks[index + 1:]
    controls = _controls(song, retained, [])
    for track, row in zip(retained, controls):
        for side in ('input', 'output'):
            if side == 'output' and row['routing'][side]['type']['name'] == 'Group' and _parent(track) is not None:
                continue
            if str(group.name) in (row['routing'][side]['type']['id'], row['routing'][side]['type']['name']):
                raise ValueError('resolve track routes referring to this Group before ungrouping')
    owners = tuple([*retained, *song.return_tracks, song.master_track])
    sidechains, sidechain_refs = _sidechain_controls(owners, str(group.name))
    auxiliary = _auxiliary_routing([*song.return_tracks, song.master_track], str(group.name))
    budget, material, native, members = _budget(), [], [], []
    for track in descendants:
        i = tracks.index(track)
        digest, refs = _material(song, track, budget)
        material.append(digest)
        native.append(refs)
        route = _track_routing(song, f'track-{i}', 0)['output']
        expected_output = {k: route[k] for k in ('type', 'channel')}
        if _parent(track) == group and route['type']['name'] == 'Group' and _parent(group) is None:
            main = [r for r in route['availableTypes'] if r['name'] == 'Main']
            if len(main) != 1 or route['channel']['name'] != '':
                raise ValueError('native Main destination unavailable for a promoted Group child')
            expected_output = {'type': main[0], 'channel': route['channel']}
        members.append({'sourceTrackId': f'track-{i}', 'name': str(track.name), 'contentSha256': digest,
                        'directChild': _parent(track) == group, 'expectedOutput': expected_output})
    group_material, group_refs = _material(song, group, budget)
    removed = _persisted_track_state(_track_state_snapshot(song, key, 0))
    observed = {'filePath': str(song.file_path), 'setFingerprint': _set_fingerprint(song),
                'groupTrackId': key, 'removedGroup': removed, 'hasGroupDevices': bool(group.devices),
                'targets': [{'trackId': key, 'name': str(group.name), 'visibleIndex': visible.index(group), 'isGroup': True}],
                'visibleTracks': [{'trackId': f'track-{tracks.index(t)}', 'name': str(t.name), 'isGroup': bool(getattr(t, 'is_foldable', False))} for t in visible],
                'members': members, 'controls': controls, 'sidechains': sidechains, 'auxiliaryRouting': auxiliary,
                'globalContext': _global(song)}
    parents = tuple(_parent(t) for t in tracks)
    identity = (song, tuple(tracks), tuple(song.return_tracks), tuple(song.scenes), song.master_track,
                tuple(native), group_refs, sidechain_refs, parents)
    digest = _hash(observed)
    previous = next(((token, entry) for token, entry in _ungroup_contexts.items() if entry['identity'] == identity and entry['digest'] == digest), None)
    if previous is None:
        if len(_ungroup_contexts) >= 64:
            _ungroup_contexts.pop(next(iter(_ungroup_contexts)))
        token = str(uuid.uuid4())
        _ungroup_contexts[token] = {'identity': identity, 'digest': digest, 'before': observed, 'group': group,
                                   'tracks': tuple(tracks), 'retained': tuple(retained), 'descendants': tuple(descendants),
                                   'parents': tuple(_parent(t) for t in retained),
                                   'expectedParents': tuple(_parent(group) if _parent(t) == group else _parent(t) for t in retained), 'owners': owners,
                                   'groupMaterial': group_material, 'material': material, 'native': native}
    else:
        token = previous[0]
    return {'stateVersion': version, 'operation': 'ungroup', 'ungroupingId': token, 'identityToken': token, **observed,
            'setName': str(getattr(song, 'name', None) or os.path.splitext(os.path.basename(song.file_path))[0])}


def ungroup_status(song, params, version):
    token = params.get('ungroupingId')
    entry = _ungroup_contexts.get(token)
    if entry is None or entry['identity'][0] != song:
        raise ValueError('ungrouping handle unavailable for this Live Set; inspect current tracks')
    before, original, retained = entry['before'], list(entry['tracks']), list(entry['retained'])
    current, group, targets = list(song.tracks), entry['group'], entry['descendants']
    context = (str(song.file_path) == before['filePath'] and tuple(song.return_tracks) == entry['identity'][2]
               and tuple(song.scenes) == entry['identity'][3] and song.master_track == entry['identity'][4])
    removed = current == retained
    unchanged_order = len(current) == len(original) and current == original
    transitions, label_map, overrides = [], {}, {}
    for i, (track, row) in enumerate(zip(retained, before['controls'])):
        if removed and track in current:
            old_index, new_index = original.index(track), current.index(track)
            prefix, name = f'{old_index + 1}-', str(track.name)
            if row['name'].startswith(prefix) and name == f'{new_index + 1}-' + row['name'][len(prefix):] and name != row['name']:
                transitions.append({'sourceTrackId': f'track-{old_index}', 'trackId': f'track-{new_index}', 'before': row['name'], 'after': name})
                overrides[i] = row['name']
                if sum(r['name'] == row['name'] for r in before['controls']) == 1:
                    label_map[row['name']] = name
    def translated(value):
        if isinstance(value, dict):
            return {k: translated(v) for k, v in value.items()}
        if isinstance(value, list):
            return [translated(v) for v in value]
        return label_map.get(value, value) if isinstance(value, str) else value
    members, preserved, budget, error = [], True, _budget(), None
    for i, target in enumerate(targets):
        source = before['members'][i]
        member = {'sourceTrackId': source['sourceTrackId'], 'trackId': f'track-{current.index(target)}' if target in current else None,
                  'materialPreserved': False}
        try:
            if target not in current:
                raise ValueError('original Group descendant is no longer present')
            digest, refs = _material(song, target, budget, overrides.get(retained.index(target)))
            exact = digest == entry['material'][i] and refs == entry['native'][i]
            preserved = preserved and exact
            route = _track_routing(song, member['trackId'], 0)['output']
            parent = _parent(target)
            member.update(name=str(target.name), materialPreserved=exact,
                          groupTrackId=f'track-{current.index(parent)}' if parent is not None and parent in current else None,
                          output={k: route[k] for k in ('type', 'channel')})
        except Exception as failure:
            preserved = False
            error = error or str(failure)
        members.append(member)
    membership, controls, global_context, sidechains_preserved, routing = False, False, False, False, False
    group_unchanged = False
    try:
        membership = removed and all(_parent(t) == parent for t, parent in zip(retained, entry['expectedParents']))
        expected_controls = []
        for i, (track, row) in enumerate(zip(retained, before['controls'])):
            expected = {**row, 'routing': translated(row['routing'])}
            if i in overrides:
                expected['name'] = str(track.name)
            if removed and track in targets:
                expected['routing']['output'] = translated(before['members'][targets.index(track)]['expectedOutput'])
            expected_controls.append(expected)
        controls = _controls(song, retained, []) == expected_controls
        global_context = _global(song) == before['globalContext']
        sidechains, refs = _sidechain_controls(entry['owners'])
        sidechains_preserved = (sidechains == translated(before['sidechains']) and refs == entry['identity'][7]
                                and _auxiliary_routing([*song.return_tracks, song.master_track]) == translated(before['auxiliaryRouting']))
        routing = removed and all(m.get('output') == translated(b['expectedOutput']) for m, b in zip(members, before['members']))
        if unchanged_order:
            digest, refs = _material(song, group, _budget())
            group_unchanged = (digest == entry['groupMaterial'] and refs == entry['identity'][6]
                               and _persisted_track_state(_track_state_snapshot(song, before['groupTrackId'], 0)) == before['removedGroup'])
    except Exception as failure:
        error = error or str(failure)
    verified = not error and context and removed and membership and preserved and routing and controls and global_context and sidechains_preserved
    unchanged = not error and context and unchanged_order and group_unchanged and preserved and controls and global_context and sidechains_preserved and all(_parent(t) == p for t, p in zip(retained, entry['parents']))
    return {'stateVersion': version, 'ungroupingId': token, 'removedGroupId': before['groupTrackId'],
            'status': 'ungrouped' if verified else 'unchanged' if unchanged else 'changed', 'groupRemoved': removed,
            'members': members, 'expectedMemberCount': len(targets), 'renumberedTrackNames': transitions, 'originalOrderPreserved': removed,
            'membershipVerified': bool(membership), 'materialPreserved': preserved, 'routingVerified': routing,
            'controlsPreserved': context and controls and global_context and sidechains_preserved,
            'ungroupVerified': bool(verified), 'inspectionRequired': not verified and not unchanged,
            **({'error': error} if error else {}),
            'limitation': 'The Group and its processing/mixer stage are removed. Checks retained descendants, hierarchy, exposed material and existing track/sidechain controls. Excludes hidden plug-in state, complete automation and external file bytes; does not prove audio equivalence or saved state. IDs and numbered labels shift. No automatic undo or regrouping.'}
