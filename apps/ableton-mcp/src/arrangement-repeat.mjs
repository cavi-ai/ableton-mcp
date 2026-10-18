const overlaps=(a,b)=>a.startBeats<b.endBeats&&a.endBeats>b.startBeats;
const safeBeat=value=>Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;

function requestRange(args){
  const {trackIds,sourceStartBeats:start,sourceEndBeats:end,destinationStartBeats:destination,repeatCount=1}=args;
  if(!Array.isArray(trackIds)||trackIds.length<1||trackIds.length>64||new Set(trackIds).size!==trackIds.length||
    trackIds.some(id=>typeof id!=='string'||!/^track-(0|[1-9][0-9]*)$/.test(id)))throw Error('choose one to 64 unique ordinary track IDs');
  if(![start,end,destination].every(safeBeat)||end<=start||end-start>512||!Number.isInteger(repeatCount)||repeatCount<1||repeatCount>16)throw Error('finite increasing source range up to 512 beats and one to 16 repeats required');
  const sourceRange={startBeats:start,endBeats:end},destinationRange={startBeats:destination,endBeats:destination};
  for(let i=0;i<repeatCount;i++)destinationRange.endBeats+=end-start;
  if(!safeBeat(destinationRange.endBeats)||overlaps(sourceRange,destinationRange))throw Error('destination must be finite and outside the source passage');
  return {trackIds,sourceRange,destinationRange,repeatCount,periodBeats:end-start};
}

function inventoryClips(response,trackId,version){
  if(response?.trackId!==trackId||response.stateVersion!==version||!Array.isArray(response.clips))throw Error('Arrangement inventory context changed or unavailable');
  const ids=new Set();
  for(const c of response.clips){
    if(typeof c.id!=='string'||!new RegExp(`^${trackId}:arrangement-clip-(0|[1-9][0-9]*)$`).test(c.id)||ids.has(c.id)||
      typeof c.name!=='string'||!['midi','audio'].includes(c.type)||![c.startBeats,c.endBeats,c.lengthBeats].every(safeBeat)||
      c.endBeats<=c.startBeats||Math.abs(c.endBeats-c.startBeats-c.lengthBeats)>1e-7)throw Error('malformed Arrangement clip inventory');
    ids.add(c.id);
  }
  return response.clips.map(c=>({trackId,clipId:c.id,name:c.name,type:c.type,startBeats:c.startBeats,endBeats:c.endBeats,lengthBeats:c.lengthBeats}));
}

/** Inventory metadata only; never an execution authorization or atomic Set snapshot. */
export async function planArrangementRepeat(bridge,args){
  const map=requestRange(args),initial=await bridge.request('get_live_state',{});
  if(!Number.isSafeInteger(initial?.stateVersion)||typeof initial.setFingerprint!=='string'||!initial.setFingerprint)throw Error('current Live state required');
  const listed=await bridge.request('list_tracks',{});
  if(listed?.stateVersion!==initial.stateVersion||!Array.isArray(listed.tracks))throw Error('track context changed during repeat planning');
  const tracks=[],sources=[],boundaryClips=[],emptyTrackIds=[],observedClips=[];
  let scannedClips=0;
  for(const trackId of map.trackIds){
    const matches=listed.tracks.filter(t=>t.id===trackId),track=matches[0];
    if(matches.length!==1||track.isGroup!==false||!['midi','audio'].includes(track.type))throw Error('choose existing ordinary audio or MIDI tracks');
    tracks.push({trackId,name:track.name,type:track.type});
    const clips=inventoryClips(await bridge.request('list_arrangement_clips',{trackId}),trackId,initial.stateVersion);
    observedClips.push(...clips);
    scannedClips+=clips.length;
    if(scannedClips>4096)throw Error('repeat inventory exceeds 4096 clips; choose fewer tracks');
    const sourceClips=clips.filter(c=>overlaps(c,map.sourceRange));
    if(sourceClips.length===0)emptyTrackIds.push(trackId);
    for(const clip of sourceClips){
      if(clip.startBeats<map.sourceRange.startBeats||clip.endBeats>map.sourceRange.endBeats)boundaryClips.push(clip);
      else sources.push(clip);
    }
    if(sources.length+boundaryClips.length>256)throw Error('repeat map exceeds 256 relevant clips; choose fewer tracks or repeats');
  }
  if(sources.length*map.repeatCount>256)throw Error('repeat map exceeds 256 placements');
  sources.sort((a,b)=>map.trackIds.indexOf(a.trackId)-map.trackIds.indexOf(b.trackId)||a.startBeats-b.startBeats);
  const placements=[],previousByTrack=new Map();
  let repeatStart=map.destinationRange.startBeats;
  for(let repetition=1;repetition<=map.repeatCount;repetition++){
    for(const source of sources){
      const previous=previousByTrack.get(source.trackId);
      let startBeats=repeatStart+(source.startBeats-map.sourceRange.startBeats);
      if(previous&&((previous.repetition===repetition&&previous.sourceEndBeats===source.startBeats)||
        (previous.repetition===repetition-1&&previous.sourceEndBeats===map.sourceRange.endBeats&&source.startBeats===map.sourceRange.startBeats)))startBeats=previous.endBeats;
      const endBeats=startBeats+source.lengthBeats;
      if(!safeBeat(endBeats)||endBeats<=startBeats||Math.abs(endBeats-startBeats-source.lengthBeats)>1e-7)throw Error('destination cannot represent the native clip intervals');
      const placement={repetition,trackId:source.trackId,sourceClipId:source.clipId,
        sourceStartBeats:source.startBeats,sourceEndBeats:source.endBeats,startBeats,endBeats};
      placements.push(placement);previousByTrack.set(source.trackId,placement);
      map.destinationRange.endBeats=Math.max(map.destinationRange.endBeats,endBeats);
    }
    repeatStart+=map.periodBeats;
  }
  if(overlaps(map.sourceRange,map.destinationRange))throw Error('native copy intervals would overlap the source passage');
  const destinationClips=observedClips.filter(c=>overlaps(c,map.destinationRange));
  if(sources.length+boundaryClips.length+destinationClips.length>256)throw Error('repeat map exceeds 256 relevant clips');
  const plannedOverlaps=[];
  for(let i=0;i<placements.length;i++)for(let j=i+1;j<placements.length;j++){
    if(placements[i].trackId===placements[j].trackId&&overlaps(placements[i],placements[j])){
      plannedOverlaps.push({first:i,second:j,trackId:placements[i].trackId});
      if(plannedOverlaps.length>256)throw Error('repeat map has too many overlapping placements');
    }
  }
  const final=await bridge.request('get_live_state',{});
  if(final.stateVersion!==initial.stateVersion||final.setFingerprint!==initial.setFingerprint)throw Error('Live state changed during repeat planning; read again');
  return {stateVersion:final.stateVersion,setFingerprint:final.setFingerprint,atomic:false,
    requiresFreshConfirmation:true,contentVerified:false,automationVerified:false,
    canCopy:sources.length>0&&boundaryClips.length===0&&destinationClips.length===0&&plannedOverlaps.length===0,
    emptySource:sources.length===0,sourceRange:map.sourceRange,destinationRange:map.destinationRange,
    repeatCount:map.repeatCount,periodBeats:map.periodBeats,tracks,scannedClips,sources,placements,
    emptyTrackIds,boundaryClips,destinationClips,plannedOverlaps};
}
