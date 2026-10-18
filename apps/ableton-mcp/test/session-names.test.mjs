import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolService} from '../src/tool-service.mjs';

for(const targetType of ['track','return','scene']){
  test(`${targetType} rename binds label identity and retains a partial receipt once`,async()=>{
    let identity='original',name='Original',writes=0;
    const args={targetType,targetId:`${targetType}-0`,name:'Verse — layer',expectedStateVersion:4};
    const service=new ToolService({bridge:{request:async(method,params)=>{
      if(method==='get_session_object_name_context')return {stateVersion:4,targetType,targetId:args.targetId,identityToken:identity,object:{id:args.targetId,name}};
      assert.equal(method,'rename_session_object');assert.equal(params.target.previousName,name);writes++;
      return {writeRequested:true,nativeReturned:false,verified:false,observed:{object:{id:args.targetId,name:'Verse — layer'}},error:'write failed after applying'};
    }}});
    const dry=await service.call('rename_session_object',args);assert.equal(writes,0);assert.equal(dry.plan.target.previousName,'Original');
    const confirmed={...args,dryRun:false,confirmationToken:dry.confirmation.token,planHash:dry.confirmation.planHash};
    identity='replacement';await assert.rejects(service.call('rename_session_object',confirmed),/changed|mismatch/);identity='original';
    name='Manual label';await assert.rejects(service.call('rename_session_object',confirmed),/changed|mismatch/);name='Original';
    assert.equal((await service.call('rename_session_object',confirmed)).observed.verified,false);
    await assert.rejects(service.call('rename_session_object',confirmed));assert.equal(writes,1);
  });
}

test('session object rename requires current state and an updated exact native context',async()=>{
  let calls=0;
  const args={targetType:'track',targetId:'track-0',name:'Layer',expectedStateVersion:4};
  const service=new ToolService({bridge:{request:async method=>{calls++;assert.equal(method,'get_session_object_name_context');return {stateVersion:4,targetType:'track',targetId:'track-1',identityToken:'wrong'};}}});
  await assert.rejects(service.call('rename_session_object',{...args,expectedStateVersion:undefined}));assert.equal(calls,0);
  await assert.rejects(service.call('rename_session_object',args),/updated native|identity/);
});
