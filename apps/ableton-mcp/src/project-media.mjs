import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,realpath,lstat,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';

const run=promisify(execFile),script=fileURLToPath(new URL('./live-project-media.js',import.meta.url));
const focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
const limit=64*1024*1024;
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&rel!=='..'&&!isAbsolute(rel);};
const identity=async path=>{const s=await stat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),bytes:Number(s.size),mtimeNs:String(s.mtimeNs),regular:s.isFile()};};

async function hashFile(path,signal){
  const canonical=await realpath(path),before=await identity(canonical);
  if(!before.regular)throw Error('media source is not a regular file');
  const hash=createHash('sha256');for await(const chunk of createReadStream(canonical,{signal}))hash.update(chunk);
  if(hashPlan(await identity(canonical))!==hashPlan(before))throw Error('media file changed during inspection');
  return {path:canonical,...before,sha256:hash.digest('hex')};
}

export async function inspectSavedProject(path,{signal}={}){
  if(!isAbsolute(path??'')||!path.toLowerCase().endsWith('.als'))throw Error('saved absolute .als path required');
  const canonical=await realpath(path),before=await identity(canonical);
  if(!before.regular||before.bytes>limit)throw Error('saved Set must be a regular file within the 64 MiB inspection bound');
  let project;
  for(let folder=dirname(canonical);;folder=dirname(folder)){
    try{const marker=await lstat(join(folder,'Ableton Project Info'),{bigint:true});if(!marker.isDirectory())throw Error('Project marker must be a directory');project={path:folder,dev:String(marker.dev),ino:String(marker.ino)};break;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(folder)===folder)throw Error('save the Set into a dedicated Live Project before collecting media');
  }
  const bytes=await readFile(canonical,{signal});
  if(hashPlan(await identity(canonical))!==hashPlan(before))throw Error('saved Set changed during inspection');
  const xml=gunzipSync(bytes,{maxOutputLength:limit}).toString('utf8');
  if(/<!DOCTYPE|<!ENTITY/iu.test(xml))throw Error('XML declarations for external entities or document types are unsupported');
  if(XMLValidator.validate(xml)!==true)throw Error('saved Set XML is malformed');
  const tree=new XMLParser({ignoreAttributes:false,preserveOrder:true,parseAttributeValue:false,parseTagValue:false}).parse(xml);
  const root=tree.find(node=>Object.hasOwn(node,'Ableton'));
  if(root?.[':@']?.['@_MajorVersion']!=='5'||!/^12\./u.test(root?.[':@']?.['@_MinorVersion']??''))throw Error('unsupported saved Set XML schema; requires Live 12');
  const references=[],deviceDependencies={},value=(nodes,key)=>nodes.find(n=>Object.hasOwn(n,key))?.[':@']?.['@_Value']??'';
  let count=0;
  function visit(nodes,depth=0){
    if(depth>128)throw Error('Set XML nesting exceeds inspection bounds');
    for(const node of nodes){if(++count>1000000)throw Error('Set XML exceeds inspection bounds');const tag=Object.keys(node).find(k=>k!==':@');if(!Array.isArray(node[tag]))continue;
      if(/^(PluginDevice|MxDeviceAudioEffect|MxDeviceInstrument|MxDeviceMidiEffect)$/u.test(tag))deviceDependencies[tag]=(deviceDependencies[tag]??0)+1;
      if(tag==='SampleRef'){
        const refs=node[tag].filter(n=>Object.hasOwn(n,'FileRef'));if(refs.length!==1)throw Error('unknown SampleRef schema');
        const children=refs[0].FileRef,absolute=value(children,'Path'),relativePath=value(children,'RelativePath'),relativeType=value(children,'RelativePathType');
        if(absolute||relativePath)references.push({key:'sample-'+references.length,absolute,relativePath,relativeType});
        if(references.length>4096)throw Error('Set exceeds 4096 sample references');
      }
      visit(node[tag],depth+1);
    }
  }
  visit(root.Ableton);
  const cache=new Map(),samples=[];
  async function file(candidate){if(!candidate)return null;if(!cache.has(candidate))try{cache.set(candidate,await hashFile(candidate,signal));}catch(error){if(error.code==='ENOENT')cache.set(candidate,null);else throw error;}return cache.get(candidate);}
  for(const reference of references){
    signal?.throwIfAborted();const {absolute,relativePath,relativeType}=reference;
    const relativeCandidate=relativePath&&['1','3'].includes(relativeType)?resolve(relativeType==='3'?project.path:dirname(canonical),relativePath):null;
    const rel=await file(relativeCandidate),abs=await file(isAbsolute(absolute)?absolute:null);
    if(rel&&abs&&rel.path!==abs.path&&relativeType!=='3'){samples.push({...reference,status:'ambiguous',candidates:[rel.path,abs.path]});continue;}
    const source=rel??abs;
    samples.push({...reference,...source,status:source?'available':'missing',insideProject:!!source&&inside(project.path,source.path),
      projectRelative:!!rel&&relativeType==='3'&&inside(project.path,relativeCandidate)&&inside(project.path,rel.path)});
  }
  for(const source of cache.values())if(source&&hashPlan(await identity(source.path))!==hashPlan(Object.fromEntries(Object.entries(source).filter(([k])=>!['path','sha256'].includes(k)))))throw Error('media changed during inventory');
  if(hashPlan(await identity(canonical))!==hashPlan(before))throw Error('saved Set changed during media inspection');
  return {file:{path:canonical,...before,sha256:createHash('sha256').update(bytes).digest('hex')},project,samples,deviceDependencies,
    completePortabilityVerified:false,limitation:'Inventory covers saved Live 12 SampleRef entries, including device/clip samples. Unsaved edits, opaque plug-in libraries, licenses, Max for Live dependencies and other Sets are not certified. Transfer the entire Project and resolve device requirements separately.'};
}

export async function projectMediaInventory(bridge,host){
  const live=await bridge.request('get_live_state',{}),media=await host.inspect(live.filePath,{signal:requestSignal()});
  let native;
  try{native=await host.state(live);}catch(error){requestSignal()?.throwIfAborted();native={status:'unavailable',clean:null,reason:String(error.message??error).slice(0,600)};}
  const after=await bridge.request('get_live_state',{});
  const current=live.isDirty!==true&&after.isDirty!==true&&after.filePath===live.filePath&&after.stateVersion===live.stateVersion&&after.setFingerprint===live.setFingerprint&&native.path===media.file.path&&native.clean===true;
  return {stateVersion:after.stateVersion,setFingerprint:after.setFingerprint,...media,savedSnapshotMatchesLive:current,native};
}

export async function collectProjectMedia(bridge,confirmations,host,args){
  const read=async(includeNative=true)=>{
    const live=await bridge.request('get_live_state',{});
    if(live.stateVersion!==args.expectedStateVersion||live.setFingerprint!==args.expectedSetFingerprint)throw Error('Live Set changed before collection');
    if(live.isDirty===true)throw Error('save a clean Set before collection; bridge reports dirty state');
    const recording=await bridge.request('get_transport_recording_context',{});
    if(live.isPlaying||recording.isPlaying||recording.arrangement.record||recording.session.record)throw Error('collection requires stopped playback and recording');
    const media=await host.inspect(live.filePath,{signal:requestSignal()});
    if(media.samples.some(s=>s.status!=='available'))throw Error('resolve missing or ambiguous saved samples before collection');
    const native=includeNative?await host.state(live):null;
    if(includeNative&&(!native.clean||native.path!==media.file.path))throw Error('save a clean named Set before collection');
    const after=await bridge.request('get_live_state',{});
    if(after.isDirty===true)throw Error('save a clean Set before collection; bridge reports dirty state');
    if(after.stateVersion!==live.stateVersion||after.setFingerprint!==live.setFingerprint||after.filePath!==live.filePath)throw Error('Live Set changed during collection inspection');
    return {live:{stateVersion:live.stateVersion,setFingerprint:live.setFingerprint,filePath:live.filePath,scriptDirectory:live.scriptDirectory},media,...(includeNative?{native}:{})};
  };
  const before=await read(),plan={method:'collect_project_media',before,
    warning:'Collects all four native media categories, including Factory Packs, and saves this Set. Copies files into its existing Project and can use substantial disk space. Saves current native state; no automatic deletion, undo or replay. Sample checks do not certify plug-ins, licenses, Max dependencies or every Set in the Project.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('collection confirmation context changed');
  confirmations.consume(args.confirmationToken,args.planHash);
  let prepared,ui,error,cleanup,after;
  const recheck=async native=>{try{requestSignal()?.throwIfAborted();const expected=native?before:{live:before.live,media:before.media};if(hashPlan(await read(native))!==hashPlan(expected))throw Error('collection context changed before native command');}catch(failure){throw Object.assign(failure,{collectionRequested:false});}};
  try{prepared=await host.prepare(before,{beforePrepare:()=>recheck(true),signal:requestSignal()});ui=await host.commit(before,prepared,{beforeCommit:()=>recheck(false),signal:requestSignal()});}
  catch(failure){error=failure;prepared=failure.prepared??prepared;if(prepared&&failure.collectionRequested===false)try{cleanup=await host.cancel(before,prepared);}catch(failure){cleanup={cancelled:false,error:failure.message};}}
  try{after=await read();}catch(failure){error??=failure;}
  const saved=!!after?.native.clean&&after.media.file.path===before.media.file.path;
  const sameSamples=after?.media.samples.length===before.media.samples.length&&after.media.samples.every((sample,index)=>sample.key===before.media.samples[index].key&&sample.sha256===before.media.samples[index].sha256&&sample.bytes===before.media.samples[index].bytes&&sample.insideProject&&sample.projectRelative);
  const sampleCollectionVerified=!error&&saved&&hashPlan(after.media.project)===hashPlan(before.media.project)&&sameSamples&&ui?.uiIdle===true&&ui.popupClosed===true&&ui.collectionRequested===true;
  const collectionRequested=error?error.collectionRequested??ui?.collectionRequested??null:ui.collectionRequested;
  return {dryRun:false,requested:plan,observed:after??null,collectionRequested,saved,sampleCollectionVerified,completePortabilityVerified:false,ui,dialogCleanup:cleanup,
    pendingUserAction:!sampleCollectionVerified&&(collectionRequested!==false||error?.requiresInspection&&!prepared||!!prepared&&cleanup?.cancelled!==true),
    ...(!sampleCollectionVerified?{verificationError:error?.message??'native save, Project-relative sample references or copied contents did not verify'}:{}),
    limitation:'Sample collection is checked against saved references and file contents. Plug-ins, licenses, Max for Live dependencies, other Sets and audible equivalence require separate checks. Inspect uncertain results; never replay, undo or delete automatically.'};
}

export class MacProjectMediaHost{
  constructor({liveSetHost=new MacLiveSetHost(),execute=run}={}){this.liveSetHost=liveSetHost;this.execute=execute;this.busy=false;}
  inspect(path,options){return inspectSavedProject(path,options);}
  async owner(live){const appPath=await realpath(this.liveSetHost.appPathFor(live)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();if(processes.length!==1||processes[0].path!==executable)throw Error('exactly one configured Live app is required');return {appPath,pid:processes[0].pid};}
  async call(owner,live,input,signal){const r=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,filePath:live.filePath,...input})],{timeout:45000,maxBuffer:131072,signal})).stdout);if(r.error)throw Object.assign(Error(r.error),{collectionRequested:r.collectionRequested,prepared:r.prepared?{...owner,...r.prepared}:null,requiresInspection:r.requiresInspection});return r;}
  async state(live){return this.call(await this.owner(live),live,{action:'inspect'},requestSignal());}
  async prepare(source,{beforePrepare,signal}){
    if(this.busy)throw Object.assign(Error('collection UI is already active'),{collectionRequested:false});this.busy=true;
    let dispatched=false;
    try{const owner=await this.owner(source.live),focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:source.native.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Error('Live focus did not verify');await beforePrepare();dispatched=true;return {...owner,...await this.call(owner,source.live,{action:'prepare',expected:source.native},signal)};}
    catch(error){this.busy=false;error.collectionRequested??=false;if(dispatched)error.requiresInspection=true;throw error;}
  }
  async commit(source,prepared,{beforeCommit,signal}){try{await beforeCommit();const owner=await this.owner(source.live);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{collectionRequested:false});return await this.call(owner,source.live,{action:'commit',prepared},signal);}finally{this.busy=false;}}
  async cancel(source,prepared){try{const owner=await this.owner(source.live);if(owner.pid!==prepared.pid)throw Error('Live process changed');return await this.call(owner,source.live,{action:'cancel',prepared});}finally{this.busy=false;}}
}
