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
