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
for(const name of ['ai.js','ai-chat.js','protection.js','continuation.js','story-memory.js','ai-stream.js','book-search.js','version-diff.js','formatted-export.js','manuscript-import.js','local-proofreading.js','review-entry.js','manuscript-marks.js']){
 const feature=fs.readFileSync(path.join(__dirname,'../public',name),'utf8');
 for(const match of feature.matchAll(/T\('([^'\\]*)'/g))assert.ok(Object.hasOwn(en.api.englishMessages,match[1]),'New interface message has an English translation: '+match[1]);
}
assert.equal(en.api.T('AI 服务请求失败（HTTP 429）。请检查配置后重试。'),'The AI request failed (HTTP 429). Check your settings and retry.');
for(const label of ['中文小说创作','小说项目管理','自然中文表达','分章创作、悬念与自然叙事。','人物、分层大纲、伏笔与状态追踪。','润色文字、对白与叙事节奏。','自动匹配','章节创作','续写','润色','大纲规划','人物塑造','一致性检查'])assert.notEqual(en.api.T(label),label,'Dynamic skill labels are translated: '+label);
for(const label of ['随机书名','换一个书名','模板封面','上传图片','文字封面','AI生成','山海','星轨','夜航','花信','霓虹','远山','诗笺','波纹','绿意','曙光','无法绘制封面，请重试。','封面模板不存在。','这张图片无法读取。','作品信息不匹配，请重新打开。','图片模型名称格式不正确或过长。','请先在 AI 设置中填写图片模型。','AI 图片返回格式无效，请检查图片服务配置。','封面图片提示词格式不正确或过长。','封面图片请求只接受文字提示词。','AI 未返回有效的 PNG、JPEG 或 WebP 封面图片。','新书封面方案参数不正确。','封面模板不正确。'])assert.notEqual(en.api.T(label),label,'Dynamic cover labels and errors are translated: '+label);
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
