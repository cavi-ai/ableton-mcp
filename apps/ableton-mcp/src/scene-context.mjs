export async function getSceneLaunchContext(bridge,{sceneId}){
  if(typeof sceneId!=='string'||!/^scene-(0|[1-9][0-9]*)$/.test(sceneId))throw Error('canonical sceneId required');
  const before=await bridge.request('get_scene_launch_context',{sceneId});
  if(before?.scene?.id!==sceneId||!Number.isInteger(before.stateVersion)||typeof before.identityToken!=='string'||
    !before.identityToken||!before.recording||!before.song||!Array.isArray(before.tracks)||before.tracks.length>256){
    throw Error('updated bridge scene launch context required');
  }
  const rowSummary={launchClipTrackIds:[],emptyStopTrackIds:[],emptyContinueTrackIds:[],groupTrackIds:[],unknownEmptyTrackIds:[],
    armedEmptyTrackIds:[],willRecordOnStartTrackIds:[],alreadyRecordingTrackIds:[],unknownArmEmptyTrackIds:[]};
  const sceneIndex=sceneId.slice(6),actions={'launch-clip':'launchClipTrackIds','empty-stop':'emptyStopTrackIds',
    'empty-no-stop':'emptyContinueTrackIds','group-slot':'groupTrackIds','unknown-empty':'unknownEmptyTrackIds'};
  for(const [index,row] of before.tracks.entries()){
    const slot=row?.slot;
    if(row?.id!==`track-${index}`||typeof row.isGroup!=='boolean'||!slot||typeof slot.hasClip!=='boolean'||
      slot.id!==`${row.id}:clip-${sceneIndex}`||![true,false,null].includes(slot.hasStopButton)||
      ![true,false,null].includes(row.armed)||![true,false,null].includes(slot.willRecordOnStart))throw Error('invalid scene row context');
    const action=row.isGroup?'group-slot':slot.hasClip?'launch-clip':slot.hasStopButton===true?'empty-stop':slot.hasStopButton===false?'empty-no-stop':'unknown-empty';
    if(slot.action!==action||(slot.hasClip?!slot.clip||typeof slot.clip.name!=='string':slot.clip!==null))throw Error('invalid scene row context');
    rowSummary[actions[action]].push(row.id);
    if(!row.isGroup&&!slot.hasClip){
      if(row.armed===true)rowSummary.armedEmptyTrackIds.push(row.id);
      if(row.armed===null)rowSummary.unknownArmEmptyTrackIds.push(row.id);
    }
    if(slot.willRecordOnStart===true)rowSummary.willRecordOnStartTrackIds.push(row.id);
    if(slot.clip?.isRecording===true||row.playingClip?.isRecording===true)rowSummary.alreadyRecordingTrackIds.push(row.id);
  }
  return {...before,rowSummary,limitation:'Launch metadata and native row identity only. Does not prove notes, envelope contents, follow actions, audible output or every armed-empty launch preference. Group actions can affect descendants. This read does not launch, record or move selection.'};
}
