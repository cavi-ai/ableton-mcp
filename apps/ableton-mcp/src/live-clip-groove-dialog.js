// JavaScript for Automation. Only the clip's None choice is an edit action.
function run(argv) {
  ObjC.import("ApplicationServices");
  var input=JSON.parse(argv[0]),events=Application("System Events"),processes=events.applicationProcesses.whose({unixId:input.pid})();
  if(processes.length!==1||processes[0].bundleIdentifier()!=="com.ableton.live")throw Error("Expected the exact Live process");
  var process=processes[0],app=$.AXUIElementCreateApplication(input.pid),retained=[];
  function read(e,key){var ref=Ref(),error=$.AXUIElementCopyAttributeValue(e,$(key),ref);if(error===-25212||error===-25205)return null;if(error!==0)throw Error("Native accessibility read failed: "+key);var result=ObjC.castRefToObject(ref[0]);retained.push(result);return result;}
  function value(e,key){var raw=read(e,key);return raw===null?null:ObjC.unwrap(raw);}
  function items(array){var result=[];if(array)for(var i=0;i<array.count;i++)result.push(array.objectAtIndex(i));return result;}
  function children(e){return items(read(e,"AXChildren"));}
  function windows(){return items(read(app,"AXWindows"));}
  function wait(fn,message){for(var i=0;i<30;i++){var result=fn();if(result)return result;delay(0.05);}throw Error(message);}
  function foreground(){if(!process.frontmost())throw Error("Live is not foreground");}
  wait(function(){return process.frontmost();},"Live did not become foreground");
  function file(w){var document=value(w,"AXDocument");return typeof document==="string"&&document.indexOf("file://")===0?decodeURIComponent(document.slice(7)):null;}
  var all=windows();
  if(all.some(function(w){return value(w,"AXModal")===true||value(w,"AXSubrole")==="AXDialog"||items(read(w,"AXSheets")).length>0;}))throw Error("Resolve the existing Live dialog before groove removal");
  var matches=all.filter(function(w){return value(w,"AXSubrole")==="AXStandardWindow"&&value(w,"AXMain")===true&&file(w)===input.filePath;});
  if(matches.length!==1)throw Error("Exact saved Live Set window is unavailable");
  var window=matches[0],roots=[];
  function findRoot(e,depth){if(depth>5)return;var id=value(e,"AXIdentifier"),role=value(e,"AXRole");if(id==="ClipDetailView"){roots.push(e);return;}if(role==="AXTable"||role==="AXOutline"||role==="AXBrowser")return;children(e).forEach(function(c){findRoot(c,depth+1);});}
  findRoot(window,0);if(roots.length!==1)throw Error("One native Clip View is required");
  var controls={};
  function cache(e,depth){if(depth>4)return;var id=value(e,"AXIdentifier");if(id==="ClipDetailView.Header.HeaderText"||id==="ClipDetailView.MainProperties.ClipGrooveView.GrooveChooser"){if(controls[id])throw Error("Ambiguous native clip control");controls[id]=e;}children(e).forEach(function(c){cache(c,depth+1);});}
  cache(roots[0],0);
  var header=controls["ClipDetailView.Header.HeaderText"],chooser=controls["ClipDetailView.MainProperties.ClipGrooveView.GrooveChooser"];
  if(!header||!chooser)throw Error("Native clip groove control is unavailable");
  function same(){foreground();if(!windows().some(function(w){return $.CFEqual(w,window);})||file(window)!==input.filePath||value(header,"AXValue")!==input.clipName)throw Error("Displayed document or clip changed");}
  function menus(){var result=[];windows().filter(function(w){return value(w,"AXSubrole")==="AXUnknown";}).forEach(function(w){function walk(e,depth){if(depth>3)return;if(value(e,"AXIdentifier")==="ChooserPopUp"||value(e,"AXRole")==="AXMenu"){result.push(e);return;}children(e).forEach(function(c){walk(c,depth+1);});}walk(w,0);});return result;}
  function menu(){var found=menus();if(found.length!==1)throw Error("Expected one native groove menu");return found[0];}
  function menuItems(m){return children(m).filter(function(e){return value(e,"AXRole")==="AXMenuItem";});}
  function titles(m){return menuItems(m).map(function(e){return value(e,"AXTitle");});}
  function press(e){same();if(value(e,"AXEnabled")!==true)throw Error("Native groove control is disabled");if($.AXUIElementPerformAction(e,$("AXPress"))!==0)throw Error("Native groove action refused");}
  same();
  if(value(chooser,"AXValue")!==input.grooveName)throw Error("Displayed groove changed");
  if(input.action==="prepare"){
    if(menus().length)throw Error("An existing native menu is open");
    press(chooser);var owned=wait(function(){var m=menus();return m.length===1&&m[0];},"Groove choice menu did not appear"),entries=titles(owned);
    if(entries.filter(function(title){return title==="None";}).length!==1)throw Error("Native None choice is unavailable or ambiguous");
    return JSON.stringify({prepared:true,menuTitles:entries});
  }
  var current=menu();if(JSON.stringify(titles(current))!==JSON.stringify(input.menuTitles))throw Error("Prepared groove menu changed");
  if(input.action==="cancel"){
    same();events.keyCode(53);wait(function(){return menus().length===0;},"Owned groove menu did not close");return JSON.stringify({cancelled:true});
  }
  if(input.action!=="commit")throw Error("Unknown native groove action");
  var none=menuItems(current).filter(function(e){return value(e,"AXTitle")==="None";});if(none.length!==1)throw Error("Native None choice is ambiguous");
  press(none[0]);wait(function(){same();return value(chooser,"AXValue")==="None"&&menus().length===0;},"Native groove removal readback is unverified");
  return JSON.stringify({noneSelected:true,clipName:input.clipName,filePath:input.filePath,pid:input.pid});
}
