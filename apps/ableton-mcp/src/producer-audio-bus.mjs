import {isDeepStrictEqual} from "node:util";
import {getProducerChainBlueprint,verifyProducerChain,collectFactoryDeviceProfileIds,collectPluginProfileIds} from "./producer-chain-knowledge.mjs";

const topology = tracks => tracks.map(({id,name,type,isGroup,isGrouped,groupTrackId}) => ({id,name,type,isGroup,isGrouped,groupTrackId}));
function selectedChoice(part,names,channel=false) {
  const current=channel?part.channel:part.type,options=channel?part.availableChannels:part.availableTypes;
  const matches=(options??[]).filter(option=>names.includes(option.name));
  return matches.length===1&&current?.id===matches[0].id&&current?.name===matches[0].name;
}
const nativeClasses = devices => devices.map(device=>({...device,name:device.className,classDisplayName:undefined,
  ...(device.chains?{chains:device.chains.map(chain=>({...chain,devices:nativeClasses(chain.devices??[])}))}:{}),
  ...(device.returnChains?{returnChains:device.returnChains.map(chain=>({...chain,devices:nativeClasses(chain.devices??[])}))}:{})}));

export async function inspectProducerAudioBus(bridge,args) {
  const blueprint=getProducerChainBlueprint(args.target);
  if(!["shared-instrument-bus","shared-audio-bus"].includes(blueprint.topology))throw Error("target must be a shared-bus blueprint");
  const children=args.children;
  if(!Array.isArray(children)||children.length!==blueprint.children.length||
    new Set(children.map(c=>c.role)).size!==children.length||new Set(children.map(c=>c.trackId)).size!==children.length||
    children.some(c=>c.trackId===args.busTrackId)||blueprint.children.some(e=>!children.some(c=>c.role===e.role)))
    throw Error("children must map every blueprint role to a distinct track other than the bus itself");
  const initial=await bridge.request("list_tracks",{}),bus=initial.tracks.find(t=>t.id===args.busTrackId);
  if(!bus||bus.isGroup||bus.type!=="audio")throw Error("audio bus requires an ordinary audio track");
  const ids=[args.busTrackId,...blueprint.children.map(e=>children.find(c=>c.role===e.role).trackId)];
  if(ids.some(id=>!initial.tracks.some(t=>t.id===id)))throw Error("unknown child track");
  const read=async()=>{
    const result=[];
    for(const trackId of ids){
      const value=await bridge.request("get_track_state_snapshot",{trackId});
      const track=initial.tracks.find(t=>t.id===trackId);
      if(value.stateVersion!==initial.stateVersion||value.trackId!==trackId||value.track?.id!==trackId||
        value.track.name!==track.name||value.track.type!==track.type||Boolean(value.track.isGroup)!==Boolean(track.isGroup)||
        !value.routing?.input||!value.routing?.output||!value.mixer||!Array.isArray(value.devices))
        throw Error("audio bus snapshot identity or state observation changed");
      result.push(value);
    }
    return result;
  };
  const first=await read(),second=await read(),final=await bridge.request("list_tracks",{});
  if(final.stateVersion!==initial.stateVersion||!isDeepStrictEqual(topology(initial.tracks),topology(final.tracks))||!isDeepStrictEqual(first,second))
    throw Error("audio bus observations changed; re-read before assessing the configuration");
  const native=second[0],routing=native.routing;
  const busChain=verifyProducerChain(args.target,nativeClasses(native.devices));
  const busConfiguration={noInput:selectedChoice(routing.input,["No Input"]),monitorIn:routing.monitoring?.value===0&&routing.monitoring?.name==="in",
    outputMain:selectedChoice(routing.output,["Main","Master"])};
  const uniqueName=typeof bus.name==="string"&&bus.name.length>0&&initial.tracks.filter(t=>t.name===bus.name).length===1;
  const observedChildren=blueprint.children.map((expected,index)=>{
    const observed=second[index+1],requested=children.find(c=>c.role===expected.role),output=observed.routing.output;
    const profiles=collectFactoryDeviceProfileIds(nativeClasses(observed.devices)),plugins=collectPluginProfileIds(observed.devices);
    const instrumentMatches=requested.pluginId?plugins.includes(requested.pluginId):expected.instrumentProfileId?profiles.includes(expected.instrumentProfileId):null;
    const expectedSourceType=expected.sourceType??"midi";
    const sourceMatches=observed.track.type===expectedSourceType&&!observed.track.isGroup&&(instrumentMatches??true);
    const options=output.availableTypes??[];
    const byName=options.filter(o=>o.name===bus.name);
    const named=uniqueName&&byName.length===1&&output.type?.id===byName[0].id&&output.type?.name===bus.name;
    const trackIn=selectedChoice(output,["Track In"],true);
    return {role:expected.role,trackId:requested.trackId,expectedSourceType,observedSourceType:observed.track.type,
      expectedInstrumentProfileId:requested.pluginId?null:expected.instrumentProfileId??null,expectedPluginId:requested.pluginId??null,
      observedInstrumentProfileIds:profiles,observedPluginIds:plugins,instrumentMatches,sourceMatches,
      output:output.type,outputChannel:output.channel,trackIn,routed:Boolean(named&&trackIn),
      mute:observed.mixer.mute,solo:observed.mixer.solo,armed:observed.track.armed??null};
  });
  return {target:args.target,busTrackId:args.busTrackId,busKind:"audio",stateVersion:initial.stateVersion,
    consistency:"matching_two_pass_reads",busChain,busConfiguration,children:observedChildren,
    matchesBlueprint:busChain.matchesRequiredOrder&&Object.values(busConfiguration).every(Boolean)&&observedChildren.every(c=>c.sourceMatches&&c.routed),
    playbackState:{busMute:native.mixer.mute,busSolo:native.mixer.solo,busArmed:native.track.armed??null},
    limitation:"Two matching sequential native snapshot passes, not an atomic multi-track snapshot or continuous identity lease. Checks exposed devices and direct routing to Main, not clips, audible signal, phase alignment, sample availability, automation, hidden plug-in state or sound quality. Sends and other downstream processing are not assessed."};
}
