import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {MacLiveSetHost} from './live-set-host.mjs';
const execute=promisify(execFile),script=fileURLToPath(new URL('./live-track-menu.js',import.meta.url)),focusScript=fileURLToPath(new URL('./live-app-focus.js',import.meta.url));

export class MacTrackMenuHost{
  constructor({operation,platform=process.platform,liveSetHost=new MacLiveSetHost(),run=execute}={}){if(!['freeze','bounce'].includes(operation))throw Error('unknown track menu operation');this.operation=operation;this.platform=platform;this.liveSetHost=liveSetHost;this.run=run;this.busy=false;}
  async owner(source){
    if(this.platform!=='darwin')throw Object.assign(Error('track rendering requires macOS English Live'),{operationRequested:false});
    const appPath=await realpath(this.liveSetHost.appPathFor(source)),executable=await realpath(appPath+'/Contents/MacOS/Live'),processes=await this.liveSetHost.runningProcesses();
    if(processes.length!==1||processes[0].path!==executable)throw Object.assign(Error('exactly one expected Live app is required'),{operationRequested:false});
    return {pid:processes[0].pid,appPath};
  }
  async call(owner,source,input,signal){
    const result=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify({...owner,operation:this.operation,filePath:source.filePath,setName:source.setName,uiPath:source.uiPath,trackName:source.name,...input})],{timeout:30000,maxBuffer:131072,signal})).stdout);
    if(result.error)throw Object.assign(Error(result.error),{operationRequested:result.operationRequested,prepared:result.prepared?{...owner,...result.prepared}:null,requiresInspection:result.requiresInspection});return result;
  }
  async prepare(source,{beforePrepare,signal}){
    if(this.busy)throw Object.assign(Error('another track menu action is active'),{operationRequested:false});this.busy=true;
    let preparationDispatched=false;
    try{
      const owner=await this.owner(source),view=await this.call(owner,source,{action:'inspect'},signal);
      const focused=JSON.parse((await this.run('/usr/bin/osascript',['-l','JavaScript',focusScript,JSON.stringify({...owner,windowId:view.mainWindowId})],{timeout:10000,maxBuffer:65536,signal})).stdout);
      if(!focused.focused)throw Error('Live did not become visible');
      await beforePrepare();preparationDispatched=true;return {...owner,...await this.call(owner,source,{action:'prepare',expectedMain:view,frozen:source.freeze.frozen},signal)};
    }catch(error){this.busy=false;error.operationRequested??=false;if(preparationDispatched)error.requiresInspection=true;throw error;}
  }
  async commit(source,prepared,frozen,{beforeCommit,signal}){
    try{await beforeCommit();const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Object.assign(Error('Live process changed'),{operationRequested:false});return await this.call(owner,source,{action:'commit',prepared,frozen},signal);}
    finally{this.busy=false;}
  }
  async cancel(source,prepared){try{const owner=await this.owner(source);if(owner.pid!==prepared.pid)throw Error('Live process changed');return await this.call(owner,source,{action:'cancel',prepared});}finally{this.busy=false;}}
}
