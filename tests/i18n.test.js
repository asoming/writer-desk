'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/i18n.js'),'utf8');
function load(language){
 const values=new Map([['writer-desk.language',language]]),storage={getItem:k=>values.get(k)??null};
 const option={textContent:'人物',value:'',hasAttribute:()=>false};
 const doc={body:{},documentElement:{},createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:q=>q==='option'?[option]:[],getElementById:()=>null};
 const context=vm.createContext({window:{localStorage:storage},document:doc,NodeFilter:{SHOW_TEXT:4}});
 const api=vm.runInContext(source+'\n({T,uiLanguage,englishMessages})',context);
 return {api,doc,option};
}
let zh=load('zh');assert.equal(zh.api.T('书架'),'书架');assert.equal(zh.doc.documentElement.lang,'zh-CN');
let en=load('en');assert.equal(en.api.T('书架'),'Bookshelf');assert.equal(en.doc.documentElement.lang,'en');
assert.equal(en.option.value,'人物','localized note labels preserve the model values');
assert.equal(en.api.T('{0} 卷 · {1} 章',6,36),'6 volumes · 36 chapters');
const authored='人物 {2} <script>不可翻译的书名</script>';
assert.equal(en.api.T('新建{0}',authored),'New '+authored,'authored arguments are never translated or recursively interpolated');
assert.equal(en.api.T('当前作品：'), '当前作品：','plain unknown strings are not guessed');
assert.equal(en.api.T('全书总纲'),'Book outline');assert.equal(zh.api.T('全书总纲'),'全书总纲');
console.log('PASS: Chinese/English messages, locale, stable data values and authored text isolation.');

async function testDelayedLanguageSwitch(){
 const values=new Map([['writer-desk.language','zh']]),elements=new Map(),events=[];
 let releaseLanguage;
 function element(id){
  if(!elements.has(id))elements.set(id,{value:'',inert:false,listeners:{},classList:{toggle(){}},setAttribute(){},addEventListener(name,handler){this.listeners[name]=handler;}});
  return elements.get(id);
 }
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 const doc={body:{},documentElement:{},createTreeWalker:()=>({nextNode:()=>null}),querySelectorAll:()=>[],getElementById:element};
 const desktop={storage,setLanguage:language=>{
  if(language==='zh')return Promise.resolve(true);
  events.push('language');return new Promise(resolve=>{releaseLanguage=resolve;});
 },onBeforeClose(){}};
 const context=vm.createContext({window:{WriterDesktop:desktop},document:doc,NodeFilter:{SHOW_TEXT:4},crypto:{randomUUID:()=> 'language-test-owner'},setTimeout:()=>0,clearTimeout(){},location:{reload:()=>events.push('reload')},recordSave:book=>{events.push('save');assert.equal(book.chapters[0].body,'未翻译的正文 {2}');}});
 vm.runInContext(source,context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
 vm.runInContext("state.book={id:'language-fixture',chapters:[{body:'未翻译的正文 {2}'}]};state.dirty=true;api=async(_path,_method,payload)=>{recordSave(payload.book);return{revision:2};};bindLanguageEvents();",context);
 const select=element('language-select');select.value='en';
 const pending=select.listeners.change({target:select});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,['save','language'],'save finishes before the desktop language request');
 assert.equal(element('workspace').inert,true,'editing stays blocked while desktop IPC is pending');
 assert.equal(element('dialog').inert,true,'dialogs cannot mutate the book before reload');
 assert.equal(vm.runInContext('state.transitioning',context),true);
 assert.equal(values.get('writer-desk.language'),'en');
 releaseLanguage(true);await pending;
 assert.deepEqual(events,['save','language','reload']);
 assert.equal(vm.runInContext('state.dirty',context),false,'reload follows a completed save without a post-save editing window');
 assert.equal(element('workspace').inert,false);assert.equal(element('dialog').inert,false);
 vm.runInContext('state.composing=true;',context);select.value='en';
 await select.listeners.change({target:select});
 assert.equal(select.value,'zh','a rejected transition restores the active interface language');
 assert.deepEqual(events,['save','language','reload'],'IME composition cannot trigger save, desktop IPC or reload');
 console.log('PASS: delayed desktop language IPC keeps editing locked through reload; rejected transitions restore the selector.');
}
testDelayedLanguageSwitch().catch(error=>{console.error(error);process.exitCode=1;});
