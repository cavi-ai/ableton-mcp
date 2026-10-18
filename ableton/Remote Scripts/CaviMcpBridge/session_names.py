"""Guard label writes on native tracks, Groups, Returns and scenes."""
import re
import uuid
try:
    from .bridge import _undo_step
except ImportError:
    from bridge import _undo_step

_song = None
_identities = {}


def _ids(params):
    result = params.get("target", params)
    if not isinstance(result, dict):
        raise ValueError("exact session label target required")
    return result


def _objects(song, params):
    ids = _ids(params)
    kind, target_id = ids.get("targetType"), ids.get("targetId")
    collections = {"track": "tracks", "return": "return_tracks", "scene": "scenes"}
    if kind not in collections or not isinstance(target_id, str) or not re.fullmatch(re.escape(kind)+r"-(?:0|[1-9][0-9]*)", target_id):
        raise ValueError("canonical track, return or scene target required")
    items = tuple(getattr(song, collections[kind]))
    if len(items) > (4096 if kind == "scene" else 256):
        raise ValueError("session label lookup exceeds its object bound")
    index = int(target_id.split("-")[1])
    if index >= len(items):
        raise ValueError("unknown %s target" % kind)
    return items[index], items


def context(song, params, version):
    global _song
    ids = _ids(params)
    item, layout = _objects(song, params)
    binding = layout, item
    if _song != song:
        _song = song
        _identities.clear()
    key = ids["targetType"], ids["targetId"]
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if key not in _identities and len(_identities) >= 64:
            _identities.pop(next(iter(_identities)))
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    result = {"stateVersion": version,
              "targetType": ids["targetType"], "targetId": ids["targetId"], "identityToken": cached[1],
              "object": {"id": ids["targetId"], "name": item.name}}
    if ids["targetType"] == "track":
        result["object"]["isGroup"] = bool(getattr(item, "is_foldable", False))
    if ids["targetType"] == "return":
        index = int(ids["targetId"].split("-")[1])
        prefix = chr(65+index)+"-" if index < 26 else ""
        display = result["object"]["name"]
        prefix = prefix if prefix and display.startswith(prefix) else ""
        result["object"].update(displayPrefix=prefix, rawName=display[len(prefix):])
    current, current_layout = _objects(song, params)
    if (current_layout, current) != binding:
        raise ValueError("native label target changed during inspection")
    return result


def rename(song, params, version):
    target = params.get("target", {})
    name = target.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 255:
        raise ValueError("name requires 1 to 255 characters")
    before = context(song, params, version)
    expected = {"targetType": before["targetType"], "targetId": before["targetId"],
                "previousName": before["object"]["name"], "name": name}
    if type(params.get("expectedStateVersion")) is not int or params["expectedStateVersion"] != version or before != params.get("before") or target != expected:
        raise ValueError("session object identity or label changed; review a fresh plan")
    item, layout = _objects(song, params)
    binding = layout, item
    attempted, returned, error = False, False, None
    try:
        if name != before["object"].get("rawName", before["object"]["name"]):
            with _undo_step(song):
                current, current_layout = _objects(song, params)
                if context(song, params, version) != before or (current_layout, current) != binding:
                    raise ValueError("session object changed before name write")
                attempted = True
                item.name = name
                returned = True
    except Exception as failure:
        if not attempted:
            raise
        error = (str(failure) or failure.__class__.__name__)[:600]
    result = {"stateVersion": version+1, "writeRequested": attempted, "nativeReturned": returned,
              "verified": False, "targetRetained": False, "observed": None, "error": error,
              "limitation": "Verifies native label ownership and the observed name. Musical controls, contents, hidden state and file bytes are not compared or backed up. No automatic rollback or replay."}
    try:
        after = context(song, params, version+1)
        current, current_layout = _objects(song, params)
        retained = (current_layout, current) == binding
        expected_name = before["object"].get("displayPrefix", "")+name
        verified = error is None and (not attempted or returned) and retained and after["object"]["name"] == expected_name
        result.update(verified=verified, targetRetained=retained, observed=after,
                      error=error if verified or error else "session object name readback did not match")
        if verified:
            result["target"] = {**target, "name": after["object"]["name"]}
    except Exception as failure:
        result["observationError"] = (str(failure) or failure.__class__.__name__)[:600]
    return result
