import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,realpath,lstat,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {join,relative,isAbsolute,extname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {hashPlan} from './confirmation-store.mjs';
import {requestSignal} from './request-context.mjs';
import {MacLiveSetHost} from './live-set-host.mjs';

const run=promisify(execFile),script=fileURLToPath(new URL('./live-device-preset.js',import.meta.url));
const focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));
const extensions=['.adv','.adg','.vstpreset','.aupreset'],limit=64*1024*1024;
const fold=value=>value.normalize('NFC').toLocaleLowerCase('en-US');
const inside=(root,path)=>{const p=relative(root,path);return p!== '..'&&!p.startsWith('../')&&!isAbsolute(p);};

export function presetName(value){
  if(typeof value!=='string'||!value||value.length>80||value!==value.trim()||value.startsWith('.')||value.endsWith('.')||/[/\\:\x00-\x1f\x7f]/u.test(value)||extensions.some(ext=>fold(value).endsWith(ext)))throw Error('preset name must be a visible filename stem of at most 80 characters');
  return value.normalize('NFC');
}

async function matchingPresets(root,name,{signal}={}){
  const matches=[],visited=new Set();let count=0;
  async function walk(folder,recursive,depth=0){
    signal?.throwIfAborted();const canonical=await realpath(folder);
    if(!inside(root,canonical))throw Error('preset directory leaves the User Library');
    if(visited.has(canonical))return;visited.add(canonical);
    if(depth>32||visited.size>10000)throw Error('preset inventory exceeds directory bounds');
    for(const entry of await readdir(canonical,{withFileTypes:true})){
      signal?.throwIfAborted();if(++count>250000)throw Error('preset inventory exceeds 250000 entries');
      const path=join(canonical,entry.name),ext=extname(entry.name).toLowerCase();
      if(extensions.includes(ext)&&fold(entry.name.slice(0,-ext.length))===fold(name))matches.push(path);
      if(recursive&&(entry.isDirectory()||entry.isSymbolicLink()&&(await stat(path)).isDirectory()))await walk(path,true,depth+1);
    }
  }
  await walk(root,false);
  let presets=true;try{await lstat(join(root,'Presets'));}catch(error){if(error.code!=='ENOENT')throw error;presets=false;}
  if(presets)await walk(join(root,'Presets'),true);
  return matches;
}

export async function reservePresetName(root,name,{signal}={}){
  name=presetName(name);root=await realpath(root);const directory=await stat(root,{bigint:true});if(!directory.isDirectory())throw Error('User Library must be a directory');
  if((await matchingPresets(root,name,{signal})).length)throw Error('preset name already exists in native User Library save locations');
  return {path:root,dev:String(directory.dev),ino:String(directory.ino),name};
}

export async function verifyPresetArtifact(path,root,source,{signal}={}){
  root=await realpath(root);
  const canonical=await realpath(path);if(!inside(root,canonical))throw Error('preset artifact leaves the User Library');
  const before=await stat(canonical,{bigint:true});if(!before.isFile()||before.size<=0n||before.size>BigInt(limit))throw Error('preset must be a nonempty regular file within 64 MiB');
  const bytes=await readFile(canonical,{signal}),ext=extname(canonical).toLowerCase();
  const allowed=source.className==='PluginDevice'?['.vstpreset','.aupreset']:source.snapshot.canHaveChains?['.adg']:['.adv'];
  if(!allowed.includes(ext))throw Error('saved preset format does not match the native device class');
  if(ext==='.adv'||ext==='.adg'){
    const xml=gunzipSync(bytes,{maxOutputLength:limit}).toString('utf8');if(/<!DOCTYPE|<!ENTITY/iu.test(xml)||XMLValidator.validate(xml)!==true)throw Error('native preset XML is unsupported');
    const tree=new XMLParser({ignoreAttributes:false}).parse(xml),root=tree.Ableton;
    if(root?.['@_MajorVersion']!=='5'||!/^12\./u.test(root?.['@_MinorVersion']??''))throw Error('unsupported native preset schema');
    if(!root[source.className]&&!root.GroupDevicePreset?.Device?.[source.className])throw Error('native preset device class did not verify');
  }else if(ext==='.vstpreset'){
    if(bytes.length<56||bytes.toString('ascii',0,4)!=='VST3'||bytes.readUInt32LE(4)!==1||!/^[0-9A-Fa-f]{32}$/u.test(bytes.toString('ascii',8,40)))throw Error('invalid VST3 preset header');
    const offset=bytes.readBigUInt64LE(40);if(offset<48n||offset>BigInt(bytes.length-8))throw Error('VST3 chunk table is incomplete');
    const start=Number(offset),count=bytes.readUInt32LE(start+4);if(bytes.toString('ascii',start,start+4)!=='List'||count<1||count>128||start+8+count*20>bytes.length)throw Error('VST3 chunk table is invalid');
    let component=false;for(let i=0;i<count;i++){const at=start+8+i*20,pos=bytes.readBigUInt64LE(at+4),length=bytes.readBigUInt64LE(at+12);if(pos<48n||pos+length>offset)throw Error('VST3 preset chunk exceeds file coverage');if(bytes.toString('ascii',at,at+4)==='Comp'&&length>0n)component=true;}
    if(!component)throw Error('VST3 preset has no component state');
  }else throw Error('Audio Unit preset identity and state verification are not supported; inspect the saved file separately');
  const after=await stat(canonical,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw Error('preset file changed during verification');
  return {path:canonical,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),format:ext.slice(1),verified:true};
}

const material=source=>{const snapshot=structuredClone(source.snapshot);delete snapshot.name;return snapshot;};

export async function saveNativeDevicePreset(bridge,confirmations,host,args){
  const name=presetName(args.name),params={trackId:args.trackId,deviceId:args.deviceId},read=()=>bridge.request('get_device_preset_source',params),before=await read();
  if(before.stateVersion!==args.expectedStateVersion)throw Error('preset source state changed');
  if(!isAbsolute(before.filePath??'')||!before.identityToken)throw Error('preset saving requires a saved Set and updated bridge');
  const destination=await host.destination(before,name,{signal:requestSignal()}),plan={method:'save_native_device_preset',before,destination,name,
    warning:'Sets the intended preset name on the native device and changes selection/focus before Save Preset. Live may rename the source; partial preparation can leave that naming change even if saving fails. Creates a new preset in native User Library save locations; existing names refuse and overwrite prompts are never accepted. Saving can copy samples according to Live preferences. Audio Unit artifact verification is unavailable. Does not save the Set, start playback, prove recall or audible equivalence, or certify opaque plug-in/sample dependencies. Unknown saves are never replayed, undone or deleted automatically.'};
  if(args.dryRun!==false)return {dryRun:true,plan,confirmation:confirmations.issue(plan)};
  if(args.planHash!==hashPlan(plan))throw Error('preset confirmation context changed');confirmations.consume(args.confirmationToken,args.planHash);
  let working=before,after,ui,artifact,error,selectionRequested=false,saveDispatched=false;
  const unchanged=async expected=>{try{requestSignal()?.throwIfAborted();if(hashPlan(await read())!==hashPlan(expected)||hashPlan(await host.destination(expected,name,{signal:requestSignal()}))!==hashPlan(destination))throw Error('preset source or destination changed before Save');}catch(failure){throw Object.assign(failure,{saveRequested:false});}};
  try{
    await unchanged(before);selectionRequested=true;
    const selected=await bridge.request('select_device_preset_source',{...params,name,before,expectedStateVersion:before.stateVersion});working=selected.source;
    if(working.identityToken!==before.identityToken||hashPlan(material(working))!==hashPlan(material(before))||selected.selection?.selectedDevice?.trackId!==args.trackId||selected.selection.selectedDevice.deviceId!==args.deviceId)throw Object.assign(Error('prepared preset source identity or material did not verify'),{saveRequested:false});
    const prepared=await host.prepare(working,name,{beforePrepare:()=>unchanged(working),signal:requestSignal()});
    saveDispatched=true;ui=await host.commit(working,name,prepared,{beforeSave:async()=>{await unchanged(working);const selection=await bridge.request('get_selection_context',{});if(selection.selectedDevice?.trackId!==args.trackId||selection.selectedDevice.deviceId!==args.deviceId)throw Object.assign(Error('native preset selection changed before Save'),{saveRequested:false});},signal:requestSignal()});
    if(ui.saveRequested===true&&ui.uiIdle===true)artifact=await host.verify(destination,working,{signal:requestSignal()});
  }catch(failure){error=failure;}
  try{after=await read();}catch(failure){error??=failure;}
  const exposedStatePreserved=after?.identityToken===before.identityToken&&after.filePath===before.filePath&&after.stateVersion===working.stateVersion&&hashPlan(material(after))===hashPlan(material(before));
  const saveRequested=error?error.saveRequested??(saveDispatched?ui?.saveRequested??null:false):ui.saveRequested;
  const presetSaveVerified=!error&&saveRequested===true&&ui.uiIdle===true&&artifact?.verified===true&&exposedStatePreserved;
  return {dryRun:false,requested:plan,observed:after??null,selectionRequested,sourceNameChanged:!!after&&after.name!==before.name,saveRequested,presetSaveVerified,exposedStatePreserved,artifact:artifact??null,ui,
    audibleEquivalenceVerified:false,recallVerified:false,completeStatePreservationVerified:false,pendingUserAction:!presetSaveVerified&&(saveRequested!==false||selectionRequested&&!after),
    ...(!presetSaveVerified?{verificationError:error?.message??'native preset file, source state or idle UI did not verify'}:{}),
    limitation:'A native file and exposed source readback do not prove hidden state, recall, sample portability, audible equivalence or a saved Set. Inspect partial preparation and unknown saves before further input; never replay or delete automatically.'};
}

export class MacDevicePresetHost{
  constructor({liveSetHost=new MacLiveSetHost(),execute=run,home=homedir()}={}){this.liveSetHost=liveSetHost;this.execute=execute;this.home=home;this.busy=false;}
  async owner(source){const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();if(processes.length!==1||processes[0].path!==executable)throw Error('exactly one expected Live app is required');return {appPath,pid:processes[0].pid};}
  async destination(source,name,{signal}={}){
    const {appPath}=await this.owner(source),metadata=JSON.parse((await this.execute('/usr/bin/plutil',['-convert','json','-o','-',appPath+'/Contents/Info.plist'],{timeout:5000,maxBuffer:65536,signal})).stdout),version=/^(12\.\d+(?:\.\d+)?(?:[ab]\d+)?)(?: \([^)]*\))?$/u.exec(metadata.CFBundleShortVersionString??'')?.[1];
    if(!version)throw Error('native preset saving requires Live 12');
    const path=join(this.home,'Library/Preferences/Ableton','Live '+version,'Library.cfg'),bytes=await readFile(path,{signal});if(bytes.length>4*1024*1024)throw Error('Library settings exceed inspection bounds');
    const xml=bytes.toString('utf8');if(/<!DOCTYPE|<!ENTITY/iu.test(xml)||XMLValidator.validate(xml)!==true)throw Error('Live Library settings XML is unavailable');
    const project=new XMLParser({ignoreAttributes:false}).parse(xml).Ableton?.ContentLibrary?.UserLibrary?.LibraryProject,base=project?.ProjectPath?.['@_Value'],folder=project?.ProjectName?.['@_Value'];
    if(typeof base!=='string'||base&&!isAbsolute(base)||typeof folder!=='string'||!folder||folder==='.'||folder==='..'||/[/\\:\x00-\x1f]/u.test(folder))throw Error('Live User Library location is unsupported');
    const destination=await reservePresetName(join(base||join(this.home,'Music/Ableton'),folder),name,{signal});
    return {...destination,document:await this.call(await this.owner(source),source,name,{action:'inspectDocument'},signal)};
  }
  async call(owner,source,name,input,signal){const r=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,filePath:source.filePath,deviceName:source.name,deviceClass:source.snapshot.classDisplayName,uiIdentity:source.uiIdentity,presetName:name,...input})],{timeout:30000,maxBuffer:131072,signal})).stdout);if(r.error)throw Object.assign(Error(r.error),{saveRequested:r.saveRequested,requiresInspection:r.requiresInspection});return r;}
  async prepare(source,name,{beforePrepare,signal}){
    if(this.busy)throw Object.assign(Error('another preset save is active'),{saveRequested:false});this.busy=true;
    try{const owner=await this.owner(source),document=await this.call(owner,source,name,{action:'inspectDocument'},signal),focus=JSON.parse((await this.execute('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:document.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);if(!focus.focused)throw Error('Live focus did not verify');await beforePrepare();const view=await this.call(owner,source,name,{action:'reveal'},signal);return {...owner,...await this.call(owner,source,name,{action:'prepare',expected:view},signal)};}
    catch(error){this.busy=false;error.saveRequested??=false;throw error;}
  }
  async commit(source,name,prepared,{beforeSave,signal}){try{await beforeSave();const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{saveRequested:false});return await this.call(owner,source,name,{action:'commit',prepared},signal);}finally{this.busy=false;}}
  async verify(destination,source,{signal}={}){const matches=await matchingPresets(destination.path,destination.name,{signal});if(matches.length!==1)throw Error('exact new native preset file is unavailable or ambiguous');return verifyPresetArtifact(matches[0],destination.path,source,{signal});}
}
