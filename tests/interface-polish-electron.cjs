'use strict';
// Real Chromium layout against the current application markup/styles, without
// loading application services, user data, providers or third-party websites.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..'),temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'writer-interface-polish-')));
const reportIndex=process.argv.indexOf('--report'),reportPath=reportIndex<0?null:path.resolve(process.argv[reportIndex+1]);
const result={passed:false,electron:process.versions.electron,productionMarkup:true,isolated:true,cases:{}};
app.setName('WriterInterfacePolishTest');app.setPath('userData',path.join(temporary,'profile'));let win,finished=false;
const timeout=setTimeout(()=>finish(new Error('Interface polish regression timed out')),60000);
app.on('window-all-closed',()=>{});
async function finish(error){if(finished)return;finished=true;clearTimeout(timeout);if(error){result.error=error.stack||String(error);if(win&&!win.isDestroyed()&&reportPath){try{fs.writeFileSync(reportPath.replace(/\.json$/,'.failure.png'),(await win.webContents.capturePage()).toPNG());}catch{}}}const output=JSON.stringify(result,null,2)+'\n';if(reportPath){fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,output);}(error?console.error:console.log)(output);if(win&&!win.isDestroyed())win.destroy();try{fs.rmSync(temporary,{recursive:true,force:true});}catch{}app.exit(error?1:0);}
app.whenReady().then(async()=>{try{
  let html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const styles=[...new Set([...html.matchAll(/<link\b[^>]*href="\/([^"?#]+\.css)"[^>]*>/g)].map(match=>match[1]).concat('interface-polish.css'))];
  const css=styles.filter(name=>fs.existsSync(path.join(ROOT,'public',name))).map(name=>fs.readFileSync(path.join(ROOT,'public',name),'utf8')).join('\n');
  html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'').replace('</head>','<style>'+css+'</style></head>');
  const file=path.join(temporary,'fixture.html');fs.writeFileSync(file,html);
  win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(file);
  for(const name of ['editor-layout.js','interface-polish.js'])await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT,'public',name),'utf8'));
  const run=async(fn,arg=null)=>{const answer=await win.webContents.executeJavaScript('(async()=>{try{return{ok:true,value:await('+fn.toString()+')('+JSON.stringify(arg)+')}}catch(e){return{ok:false,error:e.stack}}})()');if(!answer.ok)throw Error(answer.error);return answer.value;};
  const tick=()=>run(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const body=JSON.parse(fs.readFileSync(path.join(ROOT,'examples/tide-archive.yejian.json'),'utf8')).book.chapters[0].body;
  await run(body=>{
    window.fixtureContext={kind:'long',outlineMode:'edit',personEditing:false,trailView:'outline'};window.fixtureClicks=[];window.fixtureComposing=false;
    for(const id of ['home-view','shelf-view','outline-view','people-view','no-book','ai-chat-panel','notes-panel','work-plan-panel']){const view=document.getElementById(id);if(view)view.hidden=true;}document.getElementById('write-view').hidden=false;
    document.getElementById('manuscript').hidden=false;const editor=document.getElementById('editor');editor.disabled=false;editor.value=body;document.getElementById('editor-empty').hidden=true;document.getElementById('chapter-title').disabled=false;document.getElementById('chapter-title').value='第1章 未拆的船票';
    editor.addEventListener('compositionstart',()=>fixtureComposing=true);editor.addEventListener('compositionend',()=>fixtureComposing=false);
    const volume=document.getElementById('chapter-volume-control');volume.hidden=false;document.getElementById('chapter-volume').innerHTML='<option>第一卷 盐纸上的声音</option>';
    if(!document.getElementById('editor-tools')){const button=document.createElement('button');button.id='editor-tools';button.className='icon-button';button.textContent='写作工具';document.getElementById('book-search').before(button);}
    for(const button of document.querySelectorAll('.writing-toolbar button'))button.addEventListener('click',()=>fixtureClicks.push(button.id));
    const grid=document.getElementById('shelf-grid');grid.replaceChildren();for(const title of ['潮汐档案馆','短篇样稿']){const card=document.createElement('article');card.className='shelf-book';const cover=document.createElement('div');cover.className='shelf-cover';cover.textContent=title;const info=document.createElement('div');info.className='shelf-book-info';const heading=document.createElement('button');heading.className='shelf-book-title';heading.textContent=title;info.append(heading);const actions=document.createElement('div');actions.className='shelf-book-actions';const tools=document.createElement('div');tools.className='shelf-book-tools';for(const [name,label]of [['outline','大纲'],['people','人物脉络'],['write','继续写作'],['cover','封面与书名'],['backup','导出与备份'],['folder','打开文件夹'],['trash','移入回收站']]){const button=document.createElement('button');button.dataset.uiAction=name;button.textContent=label;(name==='outline'||name==='people'||name==='write'?actions:tools).append(button);}actions.append(tools);card.append(cover,info,actions);grid.append(card);}
    WriterInterfacePolish.configure({translate:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),getContext:()=>fixtureContext});WriterInterfacePolish.apply();WriterEditorLayout.resize(editor,document.getElementById('writing-area'));
  },body);
  win.show();win.focus();win.webContents.debugger.attach('1.3');await tick();
  const baseline=await run(()=>({navigation:document.getElementById('nav-write').textContent,heading:document.getElementById('chapter-title').value,body:document.getElementById('editor').value,plan:document.getElementById('writing-plan').textContent,planTitle:document.getElementById('writing-plan').title,planLabel:document.getElementById('writing-plan').getAttribute('aria-label')}));
  assert.equal(baseline.body,body);assert.equal(baseline.navigation.trim(),'写作');assert.equal(baseline.plan,'');assert.equal(baseline.planTitle,'作品大纲');assert.equal(baseline.planLabel,'作品大纲');result.cases.accessibleActions={iconOnlyTools:true,nativeHoverNames:true,ariaNames:true,navigationLabelsRetained:true,sourceUnchanged:true};

  const layouts=[];for(const width of [1200,1024,760,540,390]){
    win.setContentSize(width,720);await tick();
    const layout=await run(()=>{const toolbar=document.querySelector('.writing-toolbar'),box=toolbar.getBoundingClientRect();return{width:innerWidth,toolbar:{left:box.left,right:box.right,height:box.height},buttons:[...toolbar.querySelectorAll('.ui-action')].filter(button=>button.getClientRects().length&&!button.hidden).map(button=>{const rect=button.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return{id:button.id,width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,hit:button===hit||button.contains(hit)};})};});
    assert.ok(layout.buttons.length>=9);for(const button of layout.buttons){assert.equal(button.width,36,button.id);assert.equal(button.height,36,button.id);assert.ok(button.left>=layout.toolbar.left-1&&button.right<=layout.toolbar.right+1,JSON.stringify({width,button,toolbar:layout.toolbar}));assert.ok(button.hit,JSON.stringify({width,button}));}
    layouts.push({width:layout.width,height:layout.toolbar.height,buttons:layout.buttons.length});
  }result.cases.narrowWriting={sizes:layouts,allControlsHitTested:true,noHorizontalClipping:true};
  if(reportPath)fs.writeFileSync(reportPath.replace(/\.json$/,'.compact.png'),(await win.webContents.capturePage()).toPNG());

  await run(()=>{const editor=document.getElementById('editor'),area=document.getElementById('writing-area');area.style.scrollBehavior='auto';editor.focus({preventScroll:true});editor.setSelectionRange(editor.value.length,editor.value.length);area.scrollTop=area.scrollHeight;});
  for(const type of ['keyDown','keyUp'])for(const key of ['ArrowLeft','ArrowRight'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='ArrowLeft'?37:39});await tick();
  const before=await run(()=>({body:document.getElementById('editor').value,start:document.getElementById('editor').selectionStart,end:document.getElementById('editor').selectionEnd,scroll:document.getElementById('writing-area').scrollTop,active:document.activeElement.id}));
  await run(()=>{for(let index=0;index<30;index++)WriterInterfacePolish.apply();});await tick();const after=await run(()=>({body:document.getElementById('editor').value,start:document.getElementById('editor').selectionStart,end:document.getElementById('editor').selectionEnd,scroll:document.getElementById('writing-area').scrollTop,active:document.activeElement.id}));assert.deepEqual(after,before);
  await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中',selectionStart:1,selectionEnd:1});await tick();const composing=await run(()=>({value:document.getElementById('editor').value,start:document.getElementById('editor').selectionStart,scroll:document.getElementById('writing-area').scrollTop,composing:fixtureComposing}));assert.equal(composing.composing,true);await run(()=>WriterInterfacePolish.apply());await tick();assert.deepEqual(await run(()=>({value:document.getElementById('editor').value,start:document.getElementById('editor').selectionStart,scroll:document.getElementById('writing-area').scrollTop,composing:fixtureComposing})),composing);await win.webContents.debugger.sendCommand('Input.insertText',{text:'中'});await tick();result.cases.editorSafety={repeatedApplyPreservesFocusSelectionScroll:true,nativeImeUnaffected:true};

  await run(()=>{document.getElementById('write-view').hidden=true;document.getElementById('shelf-view').hidden=false;WriterInterfacePolish.apply();});await tick();const shelf=await run(()=>({count:document.querySelectorAll('.shelf-book-actions .ui-action').length,clipped:[...document.querySelectorAll('.shelf-book-actions .ui-action')].some(button=>{const rect=button.getBoundingClientRect();return rect.left<0||rect.right>innerWidth;})}));assert.equal(shelf.count,14);assert.equal(shelf.clipped,false);result.cases.shelf={sevenNamedActionsPerBook:true,narrowNoClipping:true};
  await run(()=>{document.getElementById('shelf-view').hidden=true;document.getElementById('write-view').hidden=false;});
  // Sample final theme values, not the first frame of the color transition;
  // exercising reduced motion also verifies the accessible motion preference.
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await tick();const themeColors=[];
  for(const [theme,eye]of [['light',false],['dark',false],['light',true],['dark',true]]){
    await run(([theme,eye])=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.eyeComfort=String(eye);},[theme,eye]);await tick();
    themeColors.push(await run(([theme,eye])=>{const style=getComputedStyle(document.getElementById('writing-plan'));return{theme,eye,color:style.color,background:getComputedStyle(document.querySelector('.writing-toolbar')).backgroundColor,transitionDuration:style.transitionDuration};},[theme,eye]));
  }assert.equal(new Set(themeColors.map(item=>item.color)).size,4);for(const sample of themeColors)assert.ok(sample.transitionDuration.split(',').every(value=>parseFloat(value)===0));result.cases.themes={tokenColorsDistinct:true,reducedMotion:true,values:themeColors};
  result.passed=true;await finish();
}catch(error){await finish(error);}});
