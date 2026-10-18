import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';
import {createRouter} from '../src/server.mjs';

function fixture(){
 const before={stateVersion:4,trackId:'track-0',clipId:'track-0:arrangement-clip-0',identityToken:'native',
  clip:{id:'track-0:arrangement-clip-0',name:'Idea',startBeats:16,endBeats:24,type:'midi'}};
 let writes=0;
 const service=new ToolService({bridge:{async request(method){
  if(method==='get_arrangement_clip_name_context')return structuredClone(before);
  if(method==='rename_arrangement_clip'){writes++;return {verified:false,nativeReturned:true,error:'end failed',observed:{clip:{name:'Verse'}}};}
  throw Error(method);
 }}});
 return {before,service,args:{trackId:'track-0',clipId:'track-0:arrangement-clip-0',expectedStateVersion:4,name:'Verse'},writes:()=>writes};
}
test('rename planning is inert and preserves a partial native receipt after one confirmation',async()=>{
 const f=fixture(),p=await f.service.call('rename_arrangement_clip',f.args);assert.equal(f.writes(),0);assert.deepEqual(p.plan.before,f.before);
 const args={...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash};
 const r=await f.service.call('rename_arrangement_clip',args);assert.equal(r.observed.verified,false);assert.equal(r.observed.observed.clip.name,'Verse');
 await assert.rejects(f.service.call('rename_arrangement_clip',args));assert.equal(f.writes(),1);
});
test('same-version manual rename or replacement rejects the old plan',async()=>{
 for(const change of [f=>f.before.identityToken='other',f=>f.before.clip.name='Manual label',f=>f.before.clip.startBeats=20]){
  const f=fixture(),p=await f.service.call('rename_arrangement_clip',f.args);change(f);
  await assert.rejects(f.service.call('rename_arrangement_clip',{...f.args,dryRun:false,confirmationToken:p.confirmation.token,planHash:p.confirmation.planHash}));assert.equal(f.writes(),0);
 }
});
test('Arrangement names stay outside core and require exact guarded arguments',async()=>{
 const f=fixture(),route=createRouter(f.service),core=createRouter(f.service,{toolProfile:'core'});
 for(const args of [{trackId:'track-0',name:'Verse'},{...f.args,name:''},{...f.args,name:'line\nbreak'},{...f.args,name:'x'.repeat(129)}])
  assert.equal((await route({id:1,method:'tools/call',params:{name:'rename_arrangement_clip',arguments:args}})).error.code,-32602);
 assert.equal((await core({id:2,method:'tools/call',params:{name:'rename_arrangement_clip',arguments:f.args}})).error.code,-32601);assert.equal(f.writes(),0);
});
