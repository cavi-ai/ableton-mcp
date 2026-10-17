import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function row(index,{action='launch-clip',armed=false,recording=false,willRecord=null}={}){
  const group=action==='group-slot',hasClip=action==='launch-clip';
  return {id:`track-${index}`,name:`Part ${index}`,mute:false,solo:false,armed,volume:.75,pan:0,type:group?'group':'midi',
    isGroup:group,isGrouped:false,groupTrackId:null,foldState:group?0:null,playingSlotIndex:group?null:-1,
    firedSlotIndex:group?null:-1,arrangementOverride:false,monitoring:group?null:1,frozen:false,playingClip:null,
    slot:{id:`track-${index}:clip-0`,hasClip,hasStopButton:action==='empty-stop'?true:action==='empty-no-stop'?false:null,
      isTriggered:false,willRecordOnStart:willRecord,action,clip:hasClip?{name:'Phrase',muted:false,isRecording:recording,
        launchQuantization:0,launchMode:0,legato:false}:null}};
}
function context(){return {stateVersion:4,identityToken:'scene-native-a',setFingerprint:'set-a',
  scene:{id:'scene-0',name:'Chorus',launchQuantization:{value:0,name:'global'},tempo:{enabled:false,bpm:null},
    timeSignature:{enabled:false,numerator:null,denominator:null}},
  tracks:[row(0),row(1,{action:'empty-stop',armed:true}),row(2,{action:'empty-no-stop',armed:true,willRecord:true}),
    row(3,{action:'group-slot'}),row(4,{action:'unknown-empty',armed:null}),row(5,{recording:true})],
  recording:{stateVersion:4,isPlaying:true,metronome:false,arrangement:{record:false,overdub:false,punchIn:false,punchOut:false,backToArranger:false},
    session:{record:true,overdub:false},automationArm:false,midiCapture:{available:false,midiTrackIds:['track-0','track-1','track-2','track-4','track-5']}},
  song:{tempo:120,numerator:4,denominator:4,launchQuantization:4}};}

test('scene preview summarizes all row actions and recording risks from one inert native read',async()=>{
  const before=context(),original=structuredClone(before),calls=[];
  before.tracks[1].playingClip={id:'track-1:clip-1',name:'Active take',isRecording:true};
  before.tracks[1].playingSlotIndex=1;
  Object.assign(original,structuredClone(before));
  const service=new ToolService({bridge:{request:async(method,args)=>{calls.push({method,args});return before;}}});
  const result=await service.call('get_scene_launch_context',{sceneId:'scene-0'});
  assert.deepEqual(result.rowSummary,{launchClipTrackIds:['track-0','track-5'],emptyStopTrackIds:['track-1'],emptyContinueTrackIds:['track-2'],
    groupTrackIds:['track-3'],unknownEmptyTrackIds:['track-4'],armedEmptyTrackIds:['track-1','track-2'],
    willRecordOnStartTrackIds:['track-2'],alreadyRecordingTrackIds:['track-1','track-5'],unknownArmEmptyTrackIds:['track-4']});
  assert.deepEqual(result.scene,before.scene);assert.deepEqual(result.recording,before.recording);
  assert.deepEqual(calls,[{method:'get_scene_launch_context',args:{sceneId:'scene-0'}}]);assert.deepEqual(before,original);
});

test('scene preview rejects stale targets and malformed or partial row metadata',async()=>{
  const changes=[c=>c.scene.id='scene-1',c=>delete c.identityToken,c=>c.tracks[1].id='track-0',
    c=>c.tracks[0].slot.id='track-0:clip-1',c=>c.tracks[1].slot.action='launch-clip',c=>c.tracks[0].slot.clip=null,
    c=>c.tracks=Array(257).fill(row(0))];
  for(const change of changes){const value=context();change(value);const service=new ToolService({bridge:{request:async()=>value}});
    await assert.rejects(service.call('get_scene_launch_context',{sceneId:'scene-0'}),/scene.*context|row.*context/);}
});

test('scene preview validates identities before native access and stays outside core',async()=>{
  let calls=0;const service=new ToolService({bridge:{request:async()=>{calls++;return context();}}});
  for(const sceneId of [undefined,'scene-00','scene--1','other'])await assert.rejects(service.call('get_scene_launch_context',{sceneId}),/sceneId/);
  assert.equal(calls,0);
  const all=createRouter(service),core=createRouter(service,{toolProfile:'core'}),listed=await all({id:1,method:'tools/list'});
  assert.equal(listed.result.tools.find(t=>t.name==='get_scene_launch_context').annotations.readOnlyHint,true);
  assert.equal((await core({id:2,method:'tools/call',params:{name:'get_scene_launch_context',arguments:{sceneId:'scene-0'}}})).error.code,-32601);
  assert.equal((await all({id:3,method:'tools/call',params:{name:'get_scene_launch_context',arguments:{sceneId:'scene-0'}}})).result.structuredContent.scene.name,'Chorus');
});
