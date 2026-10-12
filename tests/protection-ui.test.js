'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
const sample=JSON.parse(fs.readFileSync(path.join(root,'examples/tide-archive.yejian.json'),'utf8')).book;

class Element{
  constructor(tag='div',className='',text=''){this.tagName=tag;this.className=className;this.textContent=text;this.children=[];this.listeners={};this.value='';this.open=false;this.disabled=false;this.isConnected=true;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children.forEach(child=>{child.isConnected=false;});this.children=[];this.append(...children);}
  setAttribute(name,value){this[name]=value;}
  addEventListener(name,listener){this.listeners[name]=listener;}
}
function descendants(node){return[node,...node.children.flatMap(descendants)];}
function find(node,predicate){return descendants(node).find(predicate);}
function harness(){
  const dialogs=[],messages=[],calls=[],renders=[],elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const original=structuredClone(sample),changed=structuredClone(sample);changed.chapters[0].body+='\n最近修改。';
  const charCount=book=>book.chapters.reduce((sum,chapter)=>sum+Array.from(chapter.body).filter(char=>!char.match(/\s/)).length,0);
  const state={book:changed,books:[{id:changed.id,charCount:charCount(changed)}],revision:2,view:'outline',transitioning:false,composing:false};
  let database={book:structuredClone(changed),revision:2,updatedAt:'2026-10-10T00:00:00Z'},allowSave=true,failRestore=false;
  const context=vm.createContext({
    state,uiLanguage:'zh',Date,Promise,encodeURIComponent,
    $:get,el:(tag,cls,text)=>new Element(tag,cls,text),
    action:(text,cls,handler)=>{const button=new Element('button',cls,text);button.listeners.click=handler;return button;},
    T:(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),
    addField:(form,title,input)=>form.append(new Element('label','',title),input),
    toast:message=>messages.push(message),
    requireSaved:async()=>allowSave,
    transition:async task=>{if(state.transitioning)return false;state.transitioning=true;try{return await task();}finally{state.transitioning=false;}},
    closeAppSettings:()=>{get('settings-dialog').open=false;},
    showDialog:(title,content)=>{dialogs.push({title,content});get('dialog').open=true;},
    setBook:result=>{context.setCount++;state.book=result.book;state.revision=result.revision;},
    renderShell:()=>{renders.push(structuredClone(state.books));},refreshBooks:async()=>{context.refreshCount++;state.books=[{id:database.book.id,charCount:charCount(database.book)}];},
    api:async(endpoint,method='GET',data)=>{
      calls.push({endpoint,method,data});
      if(context.apiOverride){const override=context.apiOverride(endpoint,method,data);if(override!==undefined)return override;}
      if(endpoint==='/api/protection/settings')return{settings:method==='PUT'?data:{enabled:true,intervalMinutes:5,retentionCount:20}};
      if(endpoint.endsWith('/restore')){
        if(failRestore||data.revision!==database.revision)throw new Error('作品已在另一个窗口更新，请重新查看版本后恢复');
        database={book:structuredClone(original),revision:database.revision+1,updatedAt:'2026-10-10T01:00:00Z'};return structuredClone(database);
      }
      if(endpoint.endsWith('/checkpoint'))return{backup:{revision:database.revision,token:'snapshot'}};
      if(endpoint.endsWith('/history'))return{versions:[{revision:1,savedAt:'2026-10-10T00:00:00Z',chapterCount:36,charCount:101506}],currentRevision:database.revision};
      if(endpoint.endsWith('/backups'))return{backups:[{revision:1,token:'r1-snapshot.json',reason:'manual',savedAt:'2026-10-10T00:00:00Z',chapterCount:36,charCount:101506}],currentRevision:database.revision};
      if(endpoint.includes('/history/')||endpoint.includes('/backups/'))return{book:structuredClone(original),revision:1,savedAt:'2026-10-10T00:00:00Z',chapterCount:36,charCount:101506,currentRevision:database.revision};
      return structuredClone(database);
    },setCount:0,refreshCount:0,
  });
  vm.runInContext(fs.readFileSync(path.join(root,'public/protection.js'),'utf8'),context);
  return{context,state,get,dialogs,messages,calls,renders,run:source=>vm.runInContext(source,context),
    allowSave:value=>{allowSave=value;},failRestore:value=>{failRestore=value;},advanceDatabase:()=>{database.revision++;}};
}
function currentContent(h){return h.dialogs.at(-1).content;}
async function openPreview(h){await h.run('showHistory()');const row=find(currentContent(h),node=>node.className==='protection-version');await row.listeners.click();return find(currentContent(h),node=>node.textContent==='恢复此版本');}

test('protection settings start collapsed and save only typed backup preferences',async()=>{
  const h=harness(),content=new Element();h.context.content=content;
  const section=h.run('appendProtectionSettings(content)');
  assert.equal(section.tagName,'details');assert.equal(section.open,false);
  await Promise.resolve();await Promise.resolve();
  const interval=find(section,node=>node.id==='protection-interval'),retention=find(section,node=>node.id==='protection-retention');
  interval.value='10';retention.value='7';
  await find(section,node=>node.tagName==='form').listeners.submit({preventDefault(){}});
  const put=h.calls.find(call=>call.method==='PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(put.data)),{enabled:true,intervalMinutes:10,retentionCount:7});
  assert.equal(h.state.revision,2);assert.ok(find(section,node=>node.textContent==='备份设置已保存。'));
});

test('full novel previews are read-only and restoration uses optimistic revision while preserving the current view',async()=>{
  const h=harness(),before=JSON.stringify(h.state.book),restore=await openPreview(h);
  const prose=find(currentContent(h),node=>node.className?.includes('protection-prose'));
  assert.equal(prose.readOnly,true);assert.equal(prose.value,sample.chapters[0].body);
  assert.equal(JSON.stringify(h.state.book),before,'Preview must never replace the current manuscript');
  await restore.listeners.click();
  const post=h.calls.find(call=>call.endpoint.endsWith('/restore'));
  assert.equal(post.data.revision,2);assert.equal(h.state.revision,3);assert.equal(h.context.setCount,1);
  assert.equal(h.state.view,'outline');assert.equal(h.state.book.chapters[0].body,sample.chapters[0].body);
  assert.ok(h.messages.includes('已恢复，恢复前的内容也已保留。'));
});

test('short-story history shows only character counts and previews all legacy active text continuously without a chapter picker',async()=>{
  const h=harness(),short=structuredClone(sample);short.kind='short';short.title='雨后';
  short.chapters=[
    {id:'old-one',title:'旧篇章一',body:'第一部分\n保留原换行。',deletedAt:null},
    {id:'old-deleted',title:'回收内容',body:'回收站正文不能混入预览。',deletedAt:'2026-10-11'},
    {id:'old-two',title:'旧篇章二',body:'第二部分与最后一句。',deletedAt:null},
  ];
  const before=JSON.stringify(short),currentBefore=JSON.stringify(h.state.book);
  h.context.apiOverride=(endpoint,method)=>{
    if(method!=='GET')return undefined;
    if(endpoint==='/api/books/'+h.state.book.id)return{book:structuredClone(short),revision:2};
    if(endpoint.endsWith('/history/1'))return{book:structuredClone(short),revision:1,savedAt:'2026-10-10T00:00:00Z'};
    return undefined;
  };
  await h.run('showHistory()');
  const rows=descendants(currentContent(h)).filter(node=>node.className==='protection-version');
  assert.ok(rows.length>0);
  rows.forEach(row=>{assert.match(row.children[1].textContent,/字$/);assert.ok(!row.children[1].textContent.includes('章'));});
  await rows[0].listeners.click();
  const preview=find(currentContent(h),node=>node.className==='protection-preview');
  assert.ok(!descendants(preview).some(node=>node.tagName==='select'));
  const body=find(preview,node=>node.className?.includes('protection-prose'));
  assert.equal(body.readOnly,true);
  assert.equal(body.value,'第一部分\n保留原换行。\n\n第二部分与最后一句。');
  assert.equal(JSON.stringify(short),before,'Previewing must not alter the saved legacy snapshot');
  assert.equal(JSON.stringify(h.state.book),currentBefore,'Previewing another book must not replace the current draft');
  assert.equal(h.calls.filter(call=>call.method!=='GET').length,0);
});

test('a failed save or stale-window restoration never replaces current text and leaves retry available',async()=>{
  const h=harness(),before=JSON.stringify(h.state.book),restore=await openPreview(h);
  h.allowSave(false);await restore.listeners.click();
  assert.ok(!h.calls.some(call=>call.endpoint.endsWith('/restore')));
  h.allowSave(true);h.advanceDatabase();await restore.listeners.click();
  assert.equal(h.context.setCount,0);assert.equal(h.state.revision,2);
  assert.equal(JSON.stringify(h.state.book),before);assert.equal(restore.disabled,false);
  assert.ok(h.messages.at(-1).includes('另一个窗口'));
});

test('restoration refreshes the visible shelf statistics before reopening history',async()=>{
  const h=harness();h.state.view='shelf';
  assert.ok(h.state.books[0].charCount>101506);
  const restore=await openPreview(h);await restore.listeners.click();
  assert.equal(h.state.view,'shelf');assert.equal(h.context.refreshCount,1);
  assert.equal(h.renders.at(-1)[0].charCount,101506,'The final shelf render must use the restored book summary');
  assert.equal(currentContent(h).className,'protection-browser');
});

test('the manual backup action checks saving and invokes checkpoint without replacing the manuscript',async()=>{
  const h=harness();await h.run('showHistory()');
  const before=JSON.stringify(h.state.book),button=find(currentContent(h),node=>node.textContent==='立即备份');
  h.allowSave(false);await button.listeners.click({currentTarget:button});
  assert.ok(!h.calls.some(call=>call.endpoint.endsWith('/checkpoint')));
  h.allowSave(true);await button.listeners.click({currentTarget:button});
  assert.equal(h.calls.filter(call=>call.endpoint.endsWith('/checkpoint')).length,1);
  assert.equal(JSON.stringify(h.state.book),before);assert.equal(h.context.setCount,0);
});

test('late list/preview responses cannot replace a closed dialog or a newer selection',async()=>{
  const h=harness();let resolveCurrent;
  h.context.apiOverride=endpoint=>endpoint==='/api/books/'+h.state.book.id?new Promise(resolve=>{resolveCurrent=resolve;}):undefined;
  const pending=h.run('showHistory()');await new Promise(resolve=>setImmediate(resolve));
  h.get('dialog').open=false;resolveCurrent({book:h.state.book,revision:2});await pending;
  assert.equal(currentContent(h).children.length,1,'Closing during load must not render a new list');
  h.context.apiOverride=null;await h.run('showHistory()');
  let resolveFirst;h.context.apiOverride=endpoint=>endpoint.endsWith('/history/1')?new Promise(resolve=>{resolveFirst=resolve;}):undefined;
  const rows=descendants(currentContent(h)).filter(node=>node.className==='protection-version');
  const first=rows[0].listeners.click();await rows[1].listeners.click();
  const latestPreview=find(currentContent(h),node=>node.className?.includes('protection-prose'));
  resolveFirst({book:{...sample,title:'迟到的预览'},revision:99,savedAt:'2026-10-10T00:00:00Z'});await first;
  assert.equal(find(currentContent(h),node=>node.className?.includes('protection-prose')),latestPreview);
});

test('the history browser has a wider dialog and collapses to one column on small screens',()=>{
  const css=fs.readFileSync(path.join(root,'public/protection.css'),'utf8');
  assert.match(css,/#dialog:has\(\.protection-browser\)\{max-width:960px\}/);
  assert.match(css,/@media\(max-width:700px\)\{\.protection-browser\{grid-template-columns:1fr;min-width:0\}/);
});
