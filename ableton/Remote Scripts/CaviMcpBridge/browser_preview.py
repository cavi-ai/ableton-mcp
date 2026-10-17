"""Explicit global browser preview requests, with no inferred audio outcome."""
import uuid
try:
    from .bridge import _browser_item, _browser_item_record, _set_fingerprint
except ImportError:
    from bridge import _browser_item, _browser_item_record, _set_fingerprint

_contexts = {}
_song = None


def _target(application, params):
    root, path = params.get('root'), params.get('path')
    if root is None and path is None: return None
    if (not isinstance(root, str) or not isinstance(path, list) or not 1 <= len(path) <= 32
            or any(not isinstance(part, str) or not part or len(part) > 256 for part in path)):
        raise ValueError('exact browser root and 1-32 nonempty path segments required')
    return _browser_item(application, root, path)


def context(song, application, params, version):
    global _song
    if _song != song:
        _song = song
        _contexts.clear()
    item = _target(application, params)
    tracks, returns, scenes = tuple(song.tracks), tuple(song.return_tracks), tuple(song.scenes)
    if len(tracks) > 256 or len(returns) > 64 or len(scenes) > 1024:
        raise ValueError('browser preview context exceeds bounded Set topology')
    view = song.view
    identity = (song, tracks, returns, song.master_track, scenes,
                getattr(view, 'selected_track', None), getattr(view, 'selected_scene', None),
                getattr(view, 'detail_clip', None), getattr(view, 'highlighted_clip_slot', None))
    key = (params.get('root'), tuple(params.get('path', [])))
    cached = _contexts.get(key)
    if cached is None or cached[0] != identity:
        if len(_contexts) >= 64: del _contexts[next(iter(_contexts))]
        cached = identity, str(uuid.uuid4())
        _contexts[key] = cached
    browser = application.browser
    return {'stateVersion': version, 'setFingerprint': _set_fingerprint(song), 'identityToken': cached[1],
            'root': params.get('root'), 'path': params.get('path'),
            'item': _browser_item_record(item) if item is not None else None,
            'previewSupported': callable(getattr(browser, 'preview_item', None)),
            'stopSupported': callable(getattr(browser, 'stop_preview', None)), 'previewStateObserved': False,
            'transport': {'isPlaying': bool(song.is_playing), 'arrangementRecord': bool(song.record_mode),
                          'sessionRecord': bool(song.session_record), 'countingIn': getattr(song, 'is_counting_in', None)}}


def apply(song, application, params, version):
    action = params.get('action')
    before = context(song, application, params, version)
    if before != params.get('before'): raise ValueError('browser preview context changed after planning')
    if action not in ('start', 'stop'): raise ValueError('preview action must be start or stop')
    if not before['stopSupported']: raise ValueError('native browser stop preview is unavailable')
    if action == 'start':
        if not before['previewSupported'] or before['item'] is None or before['item']['folder']:
            raise ValueError('select an exact non-folder browser item with native preview support')
        if any(before['transport'][key] is not False for key in ('arrangementRecord', 'sessionRecord', 'countingIn')):
            raise ValueError('resolve recording and count-in before previewing browser sounds')
    elif before['item'] is not None:
        raise ValueError('global preview stop does not accept an item scope')
    item = _target(application, params) if action == 'start' else None
    if item is not None and _browser_item_record(item) != before['item']:
        raise ValueError('browser preview item changed before dispatch')
    error, native_returned = None, False
    try:
        if action == 'start': application.browser.preview_item(item)
        else: application.browser.stop_preview()
        native_returned = True
    except Exception as failure: error = str(failure)
    observed = None
    try: observed = context(song, application, params, version + 1)
    except Exception as failure:
        error = f'{error}; readback: {failure}' if error else f'readback: {failure}'
    stable = observed is not None and {**observed, 'stateVersion': version} == before
    return {'stateVersion': version + 1, 'action': action, 'commandRequested': True,
            'nativeReturned': native_returned,
            'error': error, 'globalPreviewAffected': True, 'contextPreserved': stable,
            'previewStateObserved': False, 'previewVerified': False, 'audibleOutputVerified': False,
            'observed': observed}
