"""One read of native peak-hold meters; no listeners, waits or meter conversion."""
import math


def _optional(owner, name, valid):
    try:
        value = getattr(owner, name)
    except Exception:
        return None
    return value if valid(value) else None


def _boolean(owner, name):
    value = _optional(owner, name, lambda value: type(value) in (bool, int) and value in (0, 1))
    return None if value is None else bool(value)


def _meter(track, name):
    try:
        value = getattr(track, name)
    except Exception:
        return {"status": "unavailable", "value": None}
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        return {"status": "invalid", "value": None}
    return {"status": "available", "value": value}


def _solo_context(tracks, returns):
    result = {'status':'available','soloedTracks':[],'unknownTrackIds':[],'reason':None,
              'trackCount':len(tracks),'returnCount':len(returns)}
    if len(tracks) > 256 or len(returns) > 64:
        result.update(status='unavailable',reason='scope_limit')
        return result
    for prefix,owners in [('track-',tracks),('return-',returns)]:
        for index,owner in enumerate(owners):
            track_id = prefix+str(index)
            solo = _boolean(owner,'solo')
            if solo is True:
                result['soloedTracks'].append({'trackId':track_id,'name':_optional(owner,'name',lambda value:isinstance(value,str)),'solo':True})
            elif solo is None:result['unknownTrackIds'].append(track_id)
    if result['unknownTrackIds']:result.update(status='partial',reason='solo_state_unavailable')
    return result


def _group_context(track_id, track, tracks):
    result = {'status':'available','parents':[],'reason':None}
    if track_id == 'master' or track_id.startswith('return-'):
        result['status'] = 'not_applicable'
        return result
    seen,current = [track],track
    while True:
        grouped = _boolean(current,'is_grouped')
        if grouped is False:return result
        reason = None
        if grouped is None:reason = 'group_membership_unavailable'
        elif len(tracks) > 256:reason = 'scope_limit'
        elif len(result['parents']) >= 32:reason = 'depth_limit'
        if reason:
            result.update(status='unavailable',reason=reason)
            return result
        parent = _optional(current,'group_track',lambda value:value is not None)
        if parent is None:reason = 'parent_unavailable'
        else:
            try:
                index = next((i for i,owner in enumerate(tracks) if owner == parent),None)
                cycle = any(parent == owner for owner in seen)
            except Exception:
                reason = 'native_parent_unavailable'
            else:
                group_type = _boolean(parent,'is_foldable')
                if cycle:reason = 'cycle'
                elif index is None:reason = 'parent_not_in_set'
                elif group_type is None:reason = 'parent_group_type_unavailable'
                elif not group_type:reason = 'parent_is_not_group'
        if reason:
            result.update(status='unavailable',reason=reason)
            return result
        result['parents'].append({'trackId':'track-'+str(index),'name':_optional(parent,'name',lambda value:isinstance(value,str)),
                                  'controls':{key:_boolean(parent,attribute) for key,attribute in (
                                      ('mute','mute'),('solo','solo'),('mutedViaSolo','muted_via_solo'))}})
        seen.append(parent);current = parent


def _track_record(track_id, track):
    integer = lambda value: type(value) is int
    return {
        "trackId": track_id, "name": track.name,
        "hasAudioOutput": _boolean(track, "has_audio_output"),
        "hasMidiOutput": _boolean(track, "has_midi_output"),
        "meters": {"input": _meter(track, "input_meter_level"), "output": _meter(track, "output_meter_level")},
        "controls": {
            "mute": _boolean(track, "mute"), "solo": _boolean(track, "solo"),
            "mutedViaSolo": _boolean(track, "muted_via_solo"), "armed": _boolean(track, "arm"),
            "monitoringState": _optional(track, "current_monitoring_state", lambda value: integer(value) and value in (0, 1, 2)),
            "playingSlotIndex": _optional(track, "playing_slot_index", integer),
            "firedSlotIndex": _optional(track, "fired_slot_index", integer),
        },
    }


def snapshot(song, params, state_version):
    try:
        from .bridge import _device_owner
    except ImportError:
        from bridge import _device_owner
    batch = "trackIds" in params
    if batch:
        ids = params["trackIds"]
        if ("trackId" in params or not isinstance(ids, list) or not 1 <= len(ids) <= 64
                or any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids)):
            raise ValueError("provide 1-64 unique trackIds without trackId")
    else:
        ids = [params["trackId"]]
    # Resolve the entire scope before reading meters; never return a partial batch.
    layout = tuple(song.tracks),tuple(song.return_tracks),song.master_track
    owners = [_device_owner(song, track_id) for track_id in ids]
    common = {
        "stateVersion": state_version, "snapshotOnly": True, "audibleOutputVerified": False,
        "meterSemantics": {"unit": "native_0_to_1", "kind": "peak_hold", "holdSeconds": 1},
        "transport": {"isPlaying": bool(song.is_playing), "currentSongTimeBeats": float(song.current_song_time)},
        "soloContext":_solo_context(layout[0],layout[1]),
        "contextSemantics":{"groupMembershipOnly":True,"explicitSolosOnly":True,"routingTraced":False},
    }
    records = [{**_track_record(track_id, track),'groupContext':_group_context(track_id,track,layout[0])} for track_id, track in owners]
    if (tuple(song.tracks),tuple(song.return_tracks),song.master_track) != layout or any(
            _device_owner(song,track_id)[1] != owner for track_id,owner in owners):
        raise ValueError('native track layout changed during signal snapshot; read again')
    return {**common, "tracks": records} if batch else {**common, **records[0]}
