function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),retained=[],saveRequested=false;
 function read(e,key){var r=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),r);if(error===-25212||error===-25205)return null;if(error){var failure=Error('Native accessibility unavailable: '+key);failure.retryableRead=error===-25204||error===-25202;throw failure;}var v=ObjC.castRefToObject(r[0]);retained.push(v);return v;}
 function get(e,key){return ObjC.unwrap(read(e,key));}
 function list(v){var out=[];if(v)for(var i=0;i<v.count;i++)out.push(v.objectAtIndex(i));return out;}
 function one(items,message){if(items.length!==1)throw Error(message);return items[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected exact Live app');
 var root=$.AXUIElementCreateApplication(input.pid);
 function windows(){return list(read(root,'AXWindows'));}
 function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost');}
 function rows(e){var out=[];function walk(e,depth){if(depth>24||out.length>20000)throw Error('Native device UI exceeds supported bounds');out.push(e);list(read(e,'AXChildren')).forEach(function(c){walk(c,depth+1);});}walk(e,0);return out;}
 function main(){
  var all=windows();if(all.some(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;}))throw Error('Resolve native dialog before preset saving');
  var w=one(all.filter(function(w){return get(w,'AXDocument')!==null;}),'Saved Set window unavailable'),url=get(w,'AXDocument');
  if(typeof url!=='string'||!/^file:\/\//.test(url))throw Error('Saved Set document unavailable');var file=$.NSURL.URLWithString($(url));
  if(Number(file.isFileURL)!==1||ObjC.unwrap(file.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath))throw Error('Saved Set document changed');return w;
 }
 function editor(all){return all.filter(function(e){return get(e,'AXRole')==='AXTextField'&&get(e,'AXDescription')==='Browser Content Pane';});}
 function documentState(allowEditor){
  var w=main(),all=rows(w);
  if(all.some(function(e){return ['ContextMenu','ChooserPopUp'].indexOf(get(e,'AXIdentifier'))>=0;}))throw Error('Resolve existing native popup first');
  if(!allowEditor&&editor(all).length)throw Error('Resolve the existing browser name editor before preset saving');
  ['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var e=one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Native transport control unavailable'),value=get(e,'AXValue');if(value!==0&&value!==false)throw Error('Native playback or recording changed');});
  var title=get(w,'AXTitle'),cg=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))).filter(function(v){return v.kCGWindowOwnerPID===input.pid&&v.kCGWindowName===title;});
  return {path:input.filePath,mainWindowId:Number(one(cg,'Exact Set window identity unavailable').kCGWindowNumber)};
 }
 function owner(all){
  var expected=input.uiIdentity;
  if(!expected||typeof expected.trackPath!=='string'||typeof expected.devicePath!=='string'||!Array.isArray(expected.chains))throw Error('Updated native device UI identity required');
  var headers=all.filter(function(e){return get(e,'AXRole')==='AXOutline'&&get(e,'AXDescription')==='Track Headers';});
  var selected=[];headers.forEach(function(e){selected=selected.concat(list(read(e,'AXSelectedRows')));});
  var track=one(selected,'Exactly one owning track must be selected'),id=get(track,'AXIdentifier');
  if(['SessionView','ArrangementView'].every(function(prefix){return id!==prefix+expected.trackPath+'.TitleBar';}))throw Error('Native device owning track changed');
  return id;
 }
 function target(reveal){
  var all=rows(main()),track=owner(all),expected=input.uiIdentity,focus=read(root,'AXFocusedUIElement'),id=get(focus,'AXIdentifier');
  if(get(focus,'AXRole')!=='AXGroup'||id!==expected.devicePath)throw Error('Exact selected device path must have native device-view focus');
  var device=one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Focused device UI is ambiguous'),children=list(read(device,'AXChildren'));
  var title=get(device,'AXTitle'),validNames=[input.deviceName,input.presetName];
  if(!validNames.some(function(name){return title===name+(name===input.deviceClass?'':', '+input.deviceClass);}))throw Error('Native device name or class changed');
  var chains=[];
  expected.chains.forEach(function(chain){
   var rack=one(all.filter(function(e){return get(e,'AXIdentifier')===chain.rackUIId;}),'Native ancestor rack is ambiguous');
   if(reveal){var toggle=one(list(read(rack,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXCheckBox'&&get(e,'AXDescription')==='Show/Hide Chain List';}),'Native rack chain-list control unavailable');if(get(toggle,'AXValue')===0){if($.AXUIElementPerformAction(toggle,$('AXPress')))throw Error('Native chain list did not open');}}
   var outline=one(list(read(rack,'AXChildren')).filter(function(e){return get(e,'AXRole')==='AXOutline'&&get(e,'AXDescription')==='Chain List';}),'Visible native rack chain list required');
   var chainRows=list(read(outline,'AXRows')),selected=list(read(outline,'AXSelectedRows'));
   if(chainRows.length!==chain.count||selected.length!==1||!chainRows[chain.index]||!$.CFEqual(chainRows[chain.index],selected[0]))throw Error('Native owning rack chain changed or is ambiguous');
   chains.push({rackUIId:chain.rackUIId,index:chain.index,count:chain.count});
  });
  var save=one(children.filter(function(e){return get(e,'AXRole')==='AXButton'&&get(e,'AXDescription')==='Save Preset';}),'Exact device Save Preset button unavailable');
  if(get(save,'AXEnabled')!==true)throw Error('Native Save Preset is disabled');return {device:device,save:save,state:{trackUIId:track,deviceUIId:id,deviceTitle:title,chains:chains}};
 }
 function inspection(reveal){return Object.assign(documentState(false),target(reveal).state);}

 try{
  if(input.action==='inspectDocument')return JSON.stringify(documentState(false));
  if(input.action==='inspect')return JSON.stringify(inspection(false));
  foreground();
  if(input.action==='reveal')return JSON.stringify(inspection(true));
  if(input.action==='prepare'){var observed=inspection();if(!same(observed,input.expected))throw Error('Native device UI changed before preparation');return JSON.stringify(observed);}
  if(input.action!=='commit'||!input.prepared)throw Error('Owned preset preparation required');
  var observed=inspection(),expected={path:input.prepared.path,mainWindowId:input.prepared.mainWindowId,trackUIId:input.prepared.trackUIId,deviceUIId:input.prepared.deviceUIId,deviceTitle:input.prepared.deviceTitle,chains:input.prepared.chains};
  if(!same(observed,expected))throw Error('Native device focus or document changed before Save');
  var finalTarget=target(false);if(!same(finalTarget.state,{trackUIId:expected.trackUIId,deviceUIId:expected.deviceUIId,deviceTitle:expected.deviceTitle,chains:expected.chains}))throw Error('Native device ownership changed immediately before Save');var save=finalTarget.save;saveRequested=null;if($.AXUIElementPerformAction(save,$('AXPress')))throw Error('Native Save Preset outcome unknown');saveRequested=true;
  var deadline=Date.now()+5000,committed=false;
  do{
   try{
   foreground();if(!same(documentState(true),{path:expected.path,mainWindowId:expected.mainWindowId}))throw Error('Set window changed after Save');
   var all=rows(main()),editors=editor(all);
   if(editors.length){
    var field=one(editors,'Preset name editor is ambiguous'),value=get(field,'AXValue'),focus=read(root,'AXFocusedUIElement');
    if(typeof value!=='string'||!['.adv','.adg','.vstpreset','.aupreset'].some(function(ext){return value===input.presetName+ext;}))throw Error('Native preset filename changed or format is unsupported');
    if(get(focus,'AXRole')!=='AXTextField'||get(focus,'AXDescription')!=='Browser Content Pane'||get(focus,'AXValue')!==value)throw Error('Owned preset name editor lost focus');
    if(!committed){Application('System Events').keyCode(36);committed=true;delay(0.1);}
   }else if(committed||Date.now()>deadline-3000)return JSON.stringify({saveRequested:true,uiIdle:true,nameCommitted:committed});
   }catch(readFailure){if(!readFailure.retryableRead)throw readFailure;}
   delay(0.1);
  }while(Date.now()<deadline);
  return JSON.stringify({saveRequested:true,uiIdle:false,nameCommitted:committed});
 }catch(error){return JSON.stringify({error:String(error.message||error),saveRequested:saveRequested,requiresInspection:saveRequested!==false});}
}
