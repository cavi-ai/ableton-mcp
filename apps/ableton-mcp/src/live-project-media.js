function run(argv){
 ObjC.import('AppKit');ObjC.import('ApplicationServices');ObjC.import('CoreGraphics');
 var input=JSON.parse(argv[0]),retained=[],prepared=input.prepared||null,collectionRequested=false,opened=false;
 function read(e,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),ref);if(error===-25212||error===-25205)return null;if(error)throw Error('Native accessibility unavailable: '+key);var value=ObjC.castRefToObject(ref[0]);retained.push(value);return value;}
 function list(value){var result=[];if(value)for(var i=0;i<value.count;i++)result.push(value.objectAtIndex(i));return result;}
 function get(e,key){return ObjC.unwrap(read(e,key));}
 function one(items,message){if(items.length!==1)throw Error(message);return items[0];}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(input.pid);
 if(!app||ObjC.unwrap(app.bundleIdentifier)!=='com.ableton.live'||ObjC.unwrap(app.bundleURL.path)!==input.appPath)throw Error('Expected exact Live process');
 var root=$.AXUIElementCreateApplication(input.pid);
 function windows(){return list(read(root,'AXWindows'));}
 function cg(){return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1,0))).filter(function(w){return w.kCGWindowOwnerPID===input.pid;});}
 function screenIds(){return cg().map(function(w){return Number(w.kCGWindowNumber);}).sort(function(a,b){return a-b;});}
 function modal(){return windows().filter(function(w){return get(w,'AXModal')===true||get(w,'AXSubrole')==='AXDialog'||list(read(w,'AXSheets')).length;});}
 function foreground(){if(Number(app.active)!==1)throw Error('Live is not frontmost');}
 function main(){
  var main=one(windows().filter(function(w){return get(w,'AXDocument')!==null;}),'Exact saved Set window unavailable'),url=get(main,'AXDocument');
  if(typeof url!=='string'||!/^file:\/\//.test(url))throw Error('Saved Set document unavailable');
  var file=$.NSURL.URLWithString($(url));if(Number(file.isFileURL)!==1||ObjC.unwrap(file.path.stringByResolvingSymlinksInPath)!==ObjC.unwrap($(input.filePath).stringByResolvingSymlinksInPath))throw Error('Saved Set document changed');return main;
 }
 function rows(element){var result=[];function walk(e,depth){if(depth>12||result.length>20000)throw Error('Native UI exceeds collection bounds');result.push(e);list(read(e,'AXChildren')).forEach(function(c){walk(c,depth+1);});}walk(element,0);return result;}
 function stopped(){var all=rows(main());['Transport.Play','Transport.GlobalRecord','Transport.SessionRecord'].forEach(function(id){var value=get(one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Native transport control unavailable'),'AXValue');if(value!==0&&value!==false)throw Error('Native playback or recording changed');});}
 function fileMenu(){var bar=read(root,'AXMenuBar'),item=one(list(read(bar,'AXChildren')).filter(function(e){return get(e,'AXTitle')==='File';}),'English File menu unavailable');return one(list(read(item,'AXChildren')),'File menu unavailable');}
 function menuItem(title){return one(list(read(fileMenu(),'AXChildren')).filter(function(e){return get(e,'AXTitle')===title;}),'Exact File command unavailable');}
 function windowId(){var title=get(main(),'AXTitle');return Number(one(cg().filter(function(w){return w.kCGWindowName===title;}),'Exact document window identity unavailable').kCGWindowNumber);}
 function state(){if(modal().length)throw Error('Resolve native dialog before collection');stopped();var save=menuItem('Save Live Set'),enabled=get(save,'AXEnabled');if(typeof enabled!=='boolean')throw Error('Native saved state unavailable');return {path:input.filePath,clean:!enabled,mainWindowId:windowId()};}
 var labels=['Files from elsewhere','Files from other Projects','Files from User Library','Files from Factory Packs'];
 function panel(){
  var dialog=one(modal(),'Exact collection dialog unavailable'),all=rows(dialog);
  one(all.filter(function(e){return get(e,'AXIdentifier')==='DialogText'&&get(e,'AXValue')==='Specify which used media files are to be copied into the project.';}),'Exact English collection dialog unavailable');
  var options=all.filter(function(e){return get(e,'AXRole')==='AXButton'&&['Yes','No'].indexOf(get(e,'AXValue'))>=0;});
  if(options.length!==4)throw Error('All four collection choices are required');
  var pairs=all.filter(function(e){return options.indexOf(e)>=0||get(e,'AXRole')==='AXStaticText'&&labels.indexOf(get(e,'AXValue'))>=0;});
  if(pairs.length!==8||labels.some(function(label,i){return pairs[i*2]!==options[i]||get(pairs[i*2+1],'AXValue')!==label;}))throw Error('Collection choice labels are ambiguous');
  var snapshot=all.map(function(e){return {role:get(e,'AXRole'),id:get(e,'AXIdentifier'),title:get(e,'AXTitle'),value:get(e,'AXValue'),enabled:get(e,'AXEnabled')};});
  function button(id){var b=one(all.filter(function(e){return get(e,'AXIdentifier')===id;}),'Collection button unavailable');if(get(b,'AXEnabled')!==true)throw Error('Collection button disabled');return b;}
  return {options:options,snapshot:snapshot,ok:button('OK'),cancel:button('Cancel')};
 }
 function owned(){foreground();stopped();if(windowId()!==prepared.mainWindowId||!same(screenIds(),prepared.screenIds))throw Error('Owned collection window changed');var p=panel();if(!same(p.snapshot,prepared.panel))throw Error('Collection choices changed');return p;}
 function closed(){return modal().length===0&&prepared.dialogWindowIds.length>0&&prepared.dialogWindowIds.every(function(id){return screenIds().indexOf(id)<0;});}
 function wait(check,milliseconds){var deadline=Date.now()+milliseconds;do{try{if(check())return true;}catch(error){}delay(0.1);}while(Date.now()<deadline);return false;}
 try{
  if(input.action==='inspect')return JSON.stringify(state());
  foreground();
  if(input.action==='prepare'){
   if(!same(state(),input.expected)||!input.expected.clean)throw Error('Clean document changed before collection');
   var command=menuItem('Collect All and Save');if(get(command,'AXEnabled')!==true)throw Error('Collect All and Save is disabled');
   var beforeIds=screenIds();if($.AXUIElementPerformAction(command,$('AXPress')))throw Error('Collection preparation outcome unknown');opened=true;
   if(!wait(function(){return modal().length===1;},3000))throw Error('Collection dialog did not appear');
   var p=panel();p.options.forEach(function(option){if(get(option,'AXValue')==='No'&&$.AXUIElementPerformAction(option,$('AXPress')))throw Error('Collection choice outcome unknown');});
   p=panel();if(p.options.some(function(option){return get(option,'AXValue')!=='Yes';}))throw Error('All media categories did not verify');
   var ids=screenIds(),newIds=ids.filter(function(id){return beforeIds.indexOf(id)<0;});if(!newIds.length||newIds.length>4)throw Error('Collection dialog identity unavailable');
   prepared={mainWindowId:input.expected.mainWindowId,screenIds:ids,dialogWindowIds:newIds,panel:p.snapshot};return JSON.stringify(prepared);
  }
  if(!prepared)throw Error('Owned collection preparation required');
  if(input.action==='cancel'){if(closed())return JSON.stringify({cancelled:true,alreadyClosed:true});var p=owned();if($.AXUIElementPerformAction(p.cancel,$('AXPress')))throw Error('Collection cancellation outcome unknown');if(!wait(closed,3000))throw Error('Collection dialog closure unverified');return JSON.stringify({cancelled:true});}
  if(input.action!=='commit')throw Error('Unknown collection action');
  var p=owned();if(p.options.some(function(option){return get(option,'AXValue')!=='Yes';}))throw Error('Collection scope changed');
  collectionRequested=null;if($.AXUIElementPerformAction(p.ok,$('AXPress')))throw Error('Collection request outcome unknown');collectionRequested=true;
  var idle=wait(function(){return closed()&&state().clean&&windowId()===prepared.mainWindowId;},30000);
  return JSON.stringify({collectionRequested:true,popupClosed:closed(),uiIdle:idle});
 }catch(error){return JSON.stringify({error:String(error.message||error),collectionRequested:collectionRequested,prepared:prepared,requiresInspection:opened||!!prepared});}
}
