"""Bind clip loop edits to native identity, complete material and edit state."""
import copy
import math
import re
import uuid
try:
    from .bridge import _track, _clip_reference, _clip_timing, _audio_clip_state, _set_fingerprint, _arrangement_clip_record, _apply_clip_timing
    from .midi_note_removal import _notes, _flag
except ImportError:
    from bridge import _track, _clip_reference, _clip_timing, _audio_clip_state, _set_fingerprint, _arrangement_clip_record, _apply_clip_timing
    from midi_note_removal import _notes, _flag

_song = None
_identities = {}
_EPSILON = 2e-7


def context(song, params, version):
    global _song
    track_id, clip_id = params.get('trackId'), params.get('clipId')
    if not isinstance(track_id, str) or not re.fullmatch(r'track-(?:0|[1-9][0-9]*)', track_id):
        raise ValueError('canonical ordinary track ID required')
    if not isinstance(clip_id, str) or not re.fullmatch(re.escape(track_id)+r':(?:clip|arrangement-clip)-(?:0|[1-9][0-9]*)', clip_id):
        raise ValueError('canonical exact clip ID required')
    if len(song.tracks) > 256: raise ValueError('clip loop edits support at most 256 tracks')
    _, track = _track(song, track_id)
    clips = track.arrangement_clips if ':arrangement-clip-' in clip_id else track.clip_slots
    if len(clips) > 4096: raise ValueError('clip loop edits support at most 4096 clips per collection')
    clip, timeline = _clip_reference(song, track_id, clip_id)
    owners = tuple(song.tracks)
    binding = song, owners, track, tuple(clips), clip
    if _song != song:
        _song = song
        _identities.clear()
    key = track_id, clip_id
    cached = _identities.get(key)
    if cached is None or cached[0] != binding:
        if len(_identities) >= 64: del _identities[next(iter(_identities))]
        cached = binding, str(uuid.uuid4())
        _identities[key] = cached
    def read():
        audio = _flag(clip, 'is_audio_clip')
        if audio is None: raise ValueError('native clip kind unavailable')
        if audio:
            if len(getattr(clip, 'warp_markers', ())) > 4096: raise ValueError('clip loop edits support at most 4096 warp markers')
            material = _audio_clip_state(song, track_id, clip_id, version)
            material = {k:v for k,v in material.items() if k not in ('stateVersion','trackId','clipId','location','timeline','loop','markers')}
            material['kind'] = 'audio'
        else: material = {'kind':'midi', 'notes':_notes(clip)}
        pending = _flag(clip, 'is_triggered')
        fired = getattr(track, 'fired_slot_index', None)
        if type(fired) is not int: pending = None
        elif fired != -1: pending = True
        return {'clipTiming':_clip_timing(song, track_id, clip_id, version), 'material':material,
                'arrangementClips':[_arrangement_clip_record(c,track_id,i) for i,c in enumerate(clips)] if timeline is not None else None,
                'editContext':{'frozen':_flag(track,'is_frozen'), 'clipRecording':_flag(clip,'is_recording'),
                               'clipOverdubbing':_flag(clip,'is_overdubbing'), 'pendingLaunch':pending,
                               'arrangementRecord':_flag(song,'record_mode'), 'sessionRecord':_flag(song,'session_record'),
                               'countingIn':_flag(song,'is_counting_in')}}
    result = read()
    if result != read() or _clip_reference(song,track_id,clip_id) != (clip,timeline) or tuple(song.tracks) != owners:
        raise ValueError('clip loop source changed during read')
    return {'stateVersion':version, 'setFingerprint':_set_fingerprint(song), 'identityToken':cached[1],
            'trackId':track_id, 'clipId':clip_id, **result}


def _finite_interval(start, end):
    if any(type(v) not in (int,float) or not math.isfinite(v) for v in (start,end)) or not 0 <= start < end:
        raise ValueError('finite increasing nonnegative clip interval required')
    return end-start


def _following(before):
    timeline = before['clipTiming']['timeline']
    return [c for c in before['arrangementClips'] if c['id'] != timeline['id'] and c['endBeats'] > timeline['startBeats']]


def _preflight(before, changes):
    timing, loop = before['clipTiming'], changes.get('loop',{})
    if timing['timeline'] is None or loop.get('enabled',timing['loop']['enabled']) is not False: return
    following = _following(before)
    if not following: return
    seconds = timing['loop'].get('unit') == 'seconds'
    start_key,end_key = ('startSeconds','endSeconds') if seconds else ('startBeats','endBeats')
    old_start,old_end = timing['loop'][start_key],timing['loop'][end_key]
    start,end = loop.get(start_key,old_start),loop.get(end_key,old_end)
    _finite_interval(start,end)
    active_start,active_end = old_start,old_end
    if timing['loop']['enabled']:
        markers = timing['markers']
        if markers.get('supported') is not True or markers.get('unit') != 'beats':
            raise ValueError('cannot bound transient nonlooped Arrangement expansion with following clips')
        active_start,active_end = markers.get('startBeats'),markers.get('endBeats')
        _finite_interval(active_start,active_end)
        active_end = max(active_end,active_start+timing['timeline']['lengthBeats'])
    spans = [_finite_interval(active_start,active_end)]
    if start >= active_end:
        spans.extend((_finite_interval(active_start,end),_finite_interval(start,end)))
    else:
        spans.extend((_finite_interval(start,active_end),_finite_interval(start,end)))
    if seconds:
        if max(spans) > _finite_interval(old_start,old_end):
            raise ValueError('unwarped Arrangement expansion with following clips requires a separately resolved empty destination')
    else:
        maximum_end = timing['timeline']['startBeats']+max(spans)
        if any(c['startBeats'] < maximum_end for c in following):
            raise ValueError('intermediate nonlooped Arrangement span would overlap another clip')


def plan_context(song, params, version):
    before = context(song,params,version)
    if 'changes' in params: _preflight(before,params['changes'])
    return before


def _normalize_resize(current, expected, field):
    timing,old = current['clipTiming'],expected['clipTiming']
    if not field.startswith('loop.') or timing['timeline'] is None or timing['loop']['enabled']:
        return
    actual,previous = timing['timeline'],old['timeline']
    if actual == previous: return
    if any(actual[k] != previous[k] for k in ('id','name','startBeats','type')):
        raise ValueError('Arrangement occurrence ownership or start changed during loop edit')
    start,end = actual['startBeats'],actual['endBeats']
    if not math.isfinite(end) or end <= start or abs(actual['lengthBeats']-(end-start)) > _EPSILON:
        raise ValueError('invalid native Arrangement span after loop edit')
    if timing['loop'].get('unit') == 'seconds':
        following = _following(expected)
        if following and end > previous['endBeats']:
            raise ValueError('unexpected unwarped Arrangement expansion')
    else:
        wanted = start+_finite_interval(timing['loop']['startBeats'],timing['loop']['endBeats'])
        if abs(end-wanted) > _EPSILON: raise ValueError('native Arrangement span does not match active playback bounds')
    if any(c['startBeats'] < end for c in _following(expected)):
        raise ValueError('native Arrangement span overlaps another clip')
    index = int(actual['id'].rsplit('-',1)[1])
    for snapshot in (current,expected):
        for record in (snapshot['clipTiming']['timeline'],snapshot['arrangementClips'][index]):
            record.pop('endBeats')
            record.pop('lengthBeats')


def _targets(changes, timing):
    result = {}
    for group in ('loop','timeSignature','editorGrid'):
        for key,value in changes.get(group,{}).items(): result[group+'.'+key] = value
    for key in ('launchQuantization','launchMode','launchLegato','mute','grooveId'):
        if key in changes: result[key] = changes[key]
    return result


def _value(timing, field):
    value = timing
    for key in field.split('.'): value = value[key]
    if isinstance(value,dict): return value['enabled'] if field in ('launchLegato','mute') else value['value']
    return value


def _without(timing, fields):
    result = copy.deepcopy(timing)
    for field in fields:
        path = field.split('.')
        owner = result
        for key in path[:-1]: owner = owner[key]
        value = owner[path[-1]]
        if isinstance(value,dict):
            if field in ('launchLegato','mute'): value.pop('enabled',None)
            else:
                value.pop('value',None)
                value.pop('name',None)
        else: owner.pop(path[-1])
    return result


def _equal(actual, target, tolerance=False):
    return (abs(actual-target) <= _EPSILON if tolerance and type(actual) in (int,float) and type(target) in (int,float)
            and math.isfinite(actual) and math.isfinite(target) else actual == target)


def _rebase_markers(current, expected, before, enabled):
    material = current['material']
    if not enabled or material['kind'] != 'audio' or material['warping'] is not False: return False
    start = current['clipTiming']['loop'].get('startSeconds')
    old_start = before['clipTiming']['loop'].get('startSeconds')
    if start is None or old_start is None or start == old_start: return False
    delta = start-old_start
    original = before['material']['warpMarkers']
    actual = material['warpMarkers']
    if actual == original: return False
    if original.get('supported') is not True or actual.get('supported') is not True: return False
    old_markers,markers = original.get('markers',[]),actual.get('markers',[])
    if len(old_markers) != len(markers) or not markers: return False
    if any(a['beatTime'] != b['beatTime'] or not _equal(a['sampleTime'],b['sampleTime']+delta,True)
           for a,b in zip(markers,old_markers)): return False
    # Live can rebase the inactive unwarped grid when moving the active start.
    current['material']['warpMarkers'] = copy.deepcopy(original)
    expected['material']['warpMarkers'] = copy.deepcopy(original)
    return True


def _topology_preserved(current, before):
    if current['identityToken'] != before['identityToken']: return False
    if before['arrangementClips'] is None: return current['arrangementClips'] is None
    actual,old = copy.deepcopy(current['arrangementClips']),copy.deepcopy(before['arrangementClips'])
    index = int(before['clipId'].rsplit('-',1)[1])
    for clips in (actual,old):
        clips[index].pop('endBeats');clips[index].pop('lengthBeats')
    return actual == old


class Guard:
    def __init__(self, song, params, version):
        self.song, self.params, self.version = song, params, version
        self.before = context(song,params,version)
        if type(params.get('expectedStateVersion')) is not int or params['expectedStateVersion'] != version or params.get('loopEditContext') != self.before or params.get('before') != self.before['clipTiming']:
            raise ValueError('clip loop identity or context changed after planning')
        if any(v is not False for v in self.before['editContext'].values()):
            raise ValueError('resolve frozen, recording, count-in and pending launch state before clip loop edits')
        _preflight(self.before,params['changes'])
        self.expected = copy.deepcopy(self.before)
        self.targets = _targets(params['changes'],self.before['clipTiming'])
        self.has_writes = any(_value(self.before['clipTiming'],field) != value for field,value in self.targets.items())
        self.native_returned = False
        self.attempted, self.completed, self.error = [], [], None
        self.readback_check = None

    def before_write(self, owner, attribute, value):
        if context(self.song,self.params,self.version) != self.expected:
            raise ValueError('clip loop identity, material or edit context changed before write')
        seconds = self.before['clipTiming']['loop'].get('unit') == 'seconds'
        fields = {'loop_start':'loop.startSeconds' if seconds else 'loop.startBeats',
                  'loop_end':'loop.endSeconds' if seconds else 'loop.endBeats', 'looping':'loop.enabled',
                  'signature_numerator':'timeSignature.numerator', 'signature_denominator':'timeSignature.denominator',
                  'launch_quantization':'launchQuantization', 'launch_mode':'launchMode', 'legato':'launchLegato',
                  'muted':'mute', 'groove':'grooveId', 'grid_quantization':'editorGrid.quantization', 'grid_is_triplet':'editorGrid.isTriplet'}
        field = fields[attribute]
        if field not in self.targets: raise ValueError('unplanned clip timing setter')
        self.attempted.append(field)
        return field

    def after_write(self, field):
        self.completed.append(field)
        observed = context(self.song,self.params,self.version)
        current, expected = copy.deepcopy(observed), copy.deepcopy(self.expected)
        _normalize_resize(current,expected,field)
        _rebase_markers(current,expected,self.before,'loop.startSeconds' in self.completed)
        current['clipTiming'] = _without(current['clipTiming'],[field])
        expected['clipTiming'] = _without(expected['clipTiming'],[field])
        if field == 'loop.enabled':
            for key in ('startBeats','endBeats','startSeconds','endSeconds'):
                current['clipTiming']['loop'].pop(key,None)
                expected['clipTiming']['loop'].pop(key,None)
        if field.startswith('loop.'):
            current['clipTiming'].pop('markers',None)
            expected['clipTiming'].pop('markers',None)
        if current != expected: raise ValueError('unrequested clip edit changed during native setter')
        if not _equal(_value(observed['clipTiming'],field),self.targets[field],field.startswith('loop.') and field != 'loop.enabled'):
            raise ValueError('native clip timing readback did not match requested value')
        self.expected = observed

    def receipt(self, version):
        current_version = version
        return {'stateVersion':current_version,'trackId':self.params['trackId'],'clipId':self.params['clipId'],
                  'writeRequested':bool(self.attempted), 'nativeReturned':bool(self.attempted) and self.native_returned,
                  'attemptedFields':self.attempted,'completedFields':self.completed,'requestedChangesVerified':False,
                  'targetIdentityPreserved':None,'notesPreserved':None,'audioSourcePreserved':None,'audioSourceIdentityPreserved':None,
                  'warpMarkersPreserved':None,'warpMarkersRebased':None,'unrequestedTimingPreserved':None,
                  'markersChanged':None,'arrangementSpanChanged':None,'hiddenExpressionVerified':False,'sourceFileBytesVerified':False,
                  'observedContext':None,'verification':{'topologyStable':False,'recordingOff':False},
                  'error':self.error,'observationError':None}

    def finish(self, song=None, version=None):
        current_song = self.song if song is None else song
        current_version = self.version+1 if version is None else version
        result = self.receipt(current_version)
        if current_song != self.song: result['error']='Set changed before clip loop readback'
        try:
            observed = context(current_song,self.params,current_version)
            identity = observed['identityToken'] == self.before['identityToken'] and current_song == self.song
            material = observed['material'] == self.before['material']
            audio = self.before['material']['kind']=='audio'
            other = _without(observed['clipTiming'],self.targets) == _without({**self.before['clipTiming'],'stateVersion':current_version},self.targets)
            result.update(observed['clipTiming'])
            result.update(targetIdentityPreserved=identity,notesPreserved=material if not audio else None,
                          audioSourcePreserved=material if audio else None,
                          audioSourceIdentityPreserved=observed['material'].get('source') == self.before['material'].get('source') if audio else None,
                          warpMarkersPreserved=observed['material'].get('warpMarkers') == self.before['material'].get('warpMarkers') if audio else None,
                          unrequestedTimingPreserved=other,markersChanged=observed['clipTiming']['markers'] != self.before['clipTiming']['markers'],
                          arrangementSpanChanged=observed['clipTiming']['timeline'] != self.before['clipTiming']['timeline'],observedContext=observed,
                          verification={'topologyStable':_topology_preserved(observed,self.before),
                                        'recordingOff':all(v is False for v in observed['editContext'].values())})
            current,expected = copy.deepcopy(observed),copy.deepcopy(self.expected)
            expected['stateVersion']=expected['clipTiming']['stateVersion']=current_version
            _normalize_resize(current,expected,'loop.settled')
            rebased = _rebase_markers(current,expected,self.before,'loop.startSeconds' in self.completed)
            result['warpMarkersRebased']=rebased if audio else None
            if self.readback_check is not None:
                self.readback_check(current_song)
            result['requestedChangesVerified'] = (result['error'] is None and current == expected and identity and
                all(_equal(_value(observed['clipTiming'],f),v,f in self.completed and f.startswith('loop.') and f != 'loop.enabled') for f,v in self.targets.items()))
            if not result['requestedChangesVerified'] and result['error'] is None:
                result['error']='native clip timing readback did not match the plan'
        except Exception as error: result['observationError']=(str(error) or error.__class__.__name__)[:600]
        return result


def begin(song, params, version):
    if 'loop' not in params.get('changes',{}): raise ValueError('loop changes required')
    guard = _apply_clip_timing(song,params,version,deferred_loop=True)
    return {'guard':guard,'error':guard.error,'lastRead':None}


def unobserved(operation, version, error):
    result = operation['guard'].receipt(version)
    result['error'] = operation['error']
    result['observationError'] = (str(error) or error.__class__.__name__)[:600]
    result['readbackPending'] = False
    return result


def complete(song, operation, version):
    guard = operation['guard']
    if operation['error'] is not None: guard.error=operation['error']
    result = guard.finish(song,version)
    observed = copy.deepcopy(result['observedContext'])
    if observed is not None:
        observed.pop('stateVersion',None)
        observed['clipTiming'].pop('stateVersion',None)
    if result['requestedChangesVerified'] and observed != operation['lastRead']:
        result['requestedChangesVerified']=False
        result['readbackPending']=True
        result['error']='native clip loop readback has not stabilized'
    else: result['readbackPending']=False
    operation['lastRead']=observed
    return result
