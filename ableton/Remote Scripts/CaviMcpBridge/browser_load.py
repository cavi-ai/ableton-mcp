"""Bind browser plans and describe immediate native track/scene changes."""
import uuid
try:
    from .bridge import _device_owner, _browser_item, _browser_item_record, _set_fingerprint, _track_record, _arrangement_clip_record
except ImportError:
    from bridge import _device_owner, _browser_item, _browser_item_record, _set_fingerprint, _track_record, _arrangement_clip_record

_song = None
_contexts = {}


def context(song, application, params, version):
    global _song, _contexts
    if _song != song:
        _song, _contexts = song, {}
    _, owner = _device_owner(song, params['trackId'])
    item = _browser_item(application, params['root'], params['path'])
    tracks, scenes = tuple(song.tracks), tuple(song.scenes)
    view = getattr(application, 'view', None)
    visible = getattr(view, 'is_view_visible', None)
    main_view = [bool(visible(name)) for name in ('Session', 'Arranger')] if callable(visible) else None
    identity = (tracks, tuple(song.return_tracks), song.master_track, scenes, owner, _browser_item_record(item),
                tuple((t, getattr(t, 'group_track', None)) for t in tracks),
                getattr(song.view, 'selected_scene', None), getattr(song.view, 'highlighted_clip_slot', None),
                getattr(song.view, 'detail_clip', None), getattr(application.browser, 'hotswap_target', None), main_view)
    key = (params['trackId'], params['root'], tuple(params['path']))
    if key not in _contexts or _contexts[key][0] != identity:
        if len(_contexts) >= 64:
            _contexts.pop(next(iter(_contexts)))
        _contexts[key] = identity, str(uuid.uuid4())
    return {'stateVersion': version, 'trackId': params['trackId'], 'setFingerprint': _set_fingerprint(song),
            'identityToken': _contexts[key][1], 'item': _browser_item_record(item), 'mainView': main_view,
            'tracks': [{'id': f'track-{i}', 'name': t.name} for i, t in enumerate(tracks)],
            'scenes': [{'id': f'scene-{i}', 'name': s.name} for i, s in enumerate(scenes)]}


def validate(song, application, params, version):
    current = context(song, application, params, version)
    if params.get('beforeLoadContext') is not None and current != params['beforeLoadContext']:
        raise ValueError('native browser load context or topology changed')
    if params.get('item') is not None and current['item'] != params['item']:
        raise ValueError('native browser item changed')


def capture(song):
    return tuple(song.tracks), tuple(song.scenes)


def owner_id(song, owner):
    if owner == song.master_track:
        return 'master'
    for prefix, objects in (('track', song.tracks), ('return', song.return_tracks)):
        for index, item in enumerate(objects):
            if item == owner:
                return f'{prefix}-{index}'
    return None


def _delta(before, after, prefix):
    added = [i for i, item in enumerate(after) if not any(item == old for old in before)]
    removed = [f'{prefix}-{i}' for i, item in enumerate(before) if not any(item == new for new in after)]
    surviving = [{'previousTrackId': f'{prefix}-{i}', 'trackId': f'{prefix}-{j}'}
                 for i, old in enumerate(before) for j, new in enumerate(after) if old == new]
    before_order = [old for old in before if any(old == new for new in after)]
    after_order = [new for new in after if any(new == old for old in before)]
    preserved = before_order == after_order
    kind = 'inserted' if added and not removed and preserved else 'unchanged' if not added and not removed and preserved else 'complex_change'
    return added, removed, surviving, preserved, kind


def effects(song, before):
    tracks, scenes = tuple(song.tracks), tuple(song.scenes)
    added, removed, surviving, preserved, kind = _delta(before[0], tracks, 'track')
    records = []
    for index in added[:256]:
        track, track_id = tracks[index], f'track-{index}'
        record = {'id': track_id}
        try:
            record.update(_track_record(song, track, index))
            slots, clips = tuple(track.clip_slots), tuple(getattr(track, 'arrangement_clips', ()))
            if len(slots) + len(clips) > 2048:
                raise ValueError('imported track clip inventory exceeds 2048 entries')
            record['sessionClips'] = [{'id': f'{track_id}:clip-{i}', 'name': s.clip.name,
                                       'type': 'audio' if bool(getattr(s.clip, 'is_audio_clip', False)) else 'midi',
                                       'lengthBeats': float(s.clip.length)} for i, s in enumerate(slots) if s.has_clip]
            record['arrangementClips'] = [_arrangement_clip_record(c, track_id, i) for i, c in enumerate(clips)]
            record['clipsInspected'] = True
        except Exception as error:
            record['clipsInspected'], record['inspectionError'] = False, str(error)
        records.append(record)
    scene_added, scene_removed, _, scene_order, scene_kind = _delta(before[1], scenes, 'scene')
    return {'kind': kind, 'addedTracks': records, 'addedTrackIds': [f'track-{i}' for i in added],
            'addedTracksInspected': len(added) <= 256, 'removedTrackIds': removed,
            'survivingTracks': surviving, 'oldOrderPreserved': preserved,
            'sceneEffect': {'kind': scene_kind, 'addedScenes': [{'id': f'scene-{i}', 'name': scenes[i].name} for i in scene_added],
                            'removedSceneIds': scene_removed, 'oldOrderPreserved': scene_order},
            'scope': 'Immediate native object changes only. Concurrent changes are not attributable to the load; unchanged does not prove completion. Clip inventories contain no note, controller or file-content comparison. Re-read current IDs before further edits; never replay an uncertain load or delete partial imports automatically.'}
