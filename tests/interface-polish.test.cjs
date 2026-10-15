'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../public/interface-polish.js'),'utf8');
class Element{
  constructor(tag,namespaceURI=null){this.tagName=tag.toUpperCase();this.namespaceURI=namespaceURI;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.className='';this._text='';this.replaceCount=0;this.hidden=false;this.disabled=false;this.value='';}
  get classList(){const node=this;return{contains:name=>node.className.split(/\s+/).includes(name),add(...names){node.className=[...new Set([...node.className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove(...names){node.className=node.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},toggle(name,force){const present=this.contains(name),next=force??!present;next?this.add(name):this.remove(name);return next;}};}
  set textContent(value){this._text=String(value);for(const child of this.children)child.parentElement=null;this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);if(name==='class')this.className=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  append(...children){for(const child of children){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(item=>item!==child);child.parentElement=this;this.children.push(child);}}
  replaceChildren(...children){this.replaceCount++;this.textContent='';this.append(...children);}
  matches(selector){return selector.split(',').some(part=>{part=part.trim();if(part.includes('>')){const [parent,child]=part.split('>').map(item=>item.trim());return this.matches(child)&&!!this.parentElement?.matches(parent);}if(part.startsWith('#'))return this.id===part.slice(1);if(part.startsWith('.'))return this.classList.contains(part.slice(1));if(part==='[data-ui-action]')return typeof this.dataset.uiAction==='string';return this.tagName.toLowerCase()===part;});}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  get isConnected(){for(let node=this;node;node=node.parentElement)if(node.nodeType===9)return true;return false;}
  addEventListener(name,handler){(this.listeners[name]??=[]).push(handler);}
  removeEventListener(name,handler){this.listeners[name]=(this.listeners[name]||[]).filter(item=>item!==handler);}
  cloneNode(deep=false){const copy=new Element(this.tagName,this.namespaceURI);copy.attributes={...this.attributes};copy.className=this.className;if(deep)copy.append(...this.children.map(child=>child.cloneNode(true)));return copy;}
}
class Document extends Element{
  constructor(){super('document');this.nodeType=9;this.documentElement=new Element('html');this.body=new Element('body');this.append(this.documentElement);this.documentElement.append(this.body);}
  createElement(tag){return new Element(tag);}
  createElementNS(namespace,tag){return new Element(tag,namespace);}
}
function setup(){
  const document=new Document(),frames=new Map();let nextFrame=0,context={kind:'long',outlineMode:'edit',personEditing:false,trailView:'outline'};
  const window={document,requestAnimationFrame:callback=>{frames.set(++nextFrame,callback);return nextFrame;},cancelAnimationFrame:id=>frames.delete(id),MutationObserver:class{constructor(){throw Error('The polish module must not observe editing mutations');}}};
  vm.runInNewContext(source,{window});const api=window.WriterInterfacePolish;
  const translate=(text,...args)=>String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??'');api.configure({translate,getContext:()=>context});
  function element(tag,id,text='',parent=document.body,className=''){const node=document.createElement(tag);node.id=id;node.className=className;node.textContent=text;parent.append(node);return node;}
  function click(node){for(const handler of document.listeners.click||[])handler({target:node});for(const handler of node.listeners.click||[])handler({target:node});}
  function flush(){const queued=[...frames.values()];frames.clear();queued.forEach(callback=>callback());}
  return{document,api,window,element,context,click,flush};
}
test('only mapped action controls change; navigation, text inputs, confirmations and control state stay intact',()=>{
  const h=setup(),button=h.element('button','writing-plan','作品大纲'),nav=h.element('button','nav-write','写作'),confirm=h.element('button','confirm-delete','彻底删除'),input=h.element('textarea','editor','');
  button.hidden=true;button.disabled=true;button.setAttribute('aria-expanded','true');button.setAttribute('aria-controls','work-plan-panel');input.value='原文🌊';input.selectionStart=2;input.selectionEnd=4;h.document.body.scrollTop=517;
  let clicked=0;button.addEventListener('click',()=>clicked++);h.api.apply();h.click(button);
  assert.equal(button.title,'作品大纲');assert.equal(button.getAttribute('aria-label'),'作品大纲');assert.equal(button.textContent,'');assert.ok(button.querySelector('svg'));
  assert.equal(button.hidden,true);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(button.getAttribute('aria-controls'),'work-plan-panel');assert.equal(clicked,1);
  assert.equal(nav.textContent,'写作');assert.equal(confirm.textContent,'彻底删除');assert.equal(input.value,'原文🌊');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,4);assert.equal(h.document.body.scrollTop,517);
});
test('repeated application keeps existing icon nodes and the live foreshadow badge',()=>{
  const h=setup(),button=h.element('button','story-tools','创作工具'),badge=h.element('span','foreshadow-reminder','7',button),editor=h.element('textarea','editor');
  h.api.apply();const icon=button.querySelector('.ui-action-icon'),replaced=button.replaceCount;editor.value='持续输入';editor.scrollTop=624;
  for(let repeat=0;repeat<20;repeat++)h.api.apply();
  assert.equal(button.querySelector('.ui-action-icon'),icon);assert.equal(button.replaceCount,replaced);assert.equal(button.querySelector('#foreshadow-reminder'),badge);assert.equal(badge.textContent,'7');assert.equal(editor.replaceCount,0);assert.equal(editor.value,'持续输入');assert.equal(editor.scrollTop,624);
});
test('major new actions retain a short text label and editing tools receive useful distinct icons',()=>{
  const h=setup(),book=h.element('button','new-book','新建长篇'),person=h.element('button','add-person','新建人物'),outline=h.element('button','writing-plan','作品大纲'),ai=h.element('button','writing-ai','AI 辅助');h.api.apply();
  assert.equal(book.textContent,'新建长篇');assert.equal(person.textContent,'新建人物');assert.ok(book.classList.contains('ui-action-primary'));assert.ok(book.classList.contains('ui-action-with-label'));
  assert.notEqual(outline.querySelector('path').getAttribute('d'),ai.querySelector('path').getAttribute('d'));
  h.context.kind='short';h.api.apply();assert.equal(book.textContent,'新建短篇');
});
test('explicit dynamic shelf actions retain the correct book target and accessible context without parsing user titles as HTML',()=>{
  const h=setup(),card=h.element('article','card','',h.document.body,'shelf-book');h.element('button',null,'书名 <img onerror=x>',card,'shelf-book-title');
  const actions=h.element('div',null,'',card,'shelf-book-actions'),opened=[];
  for(const name of ['outline','people','write','cover','backup','folder','trash']){const node=h.element('button',null,name==='write'?'开始正文':name,actions);node.dataset.uiAction=name;node.addEventListener('click',()=>opened.push('target-book:'+name));}
  h.api.apply(card);const buttons=actions.children;
  assert.equal(buttons[0].getAttribute('aria-label'),'大纲 · 书名 <img onerror=x>');assert.equal(buttons[2].title,'开始正文');assert.ok(buttons[2].classList.contains('ui-action-primary'));assert.ok(buttons[6].classList.contains('ui-action-danger'));
  assert.equal(card.querySelector('img'),null);buttons.forEach(h.click);assert.deepEqual(opened,['target-book:outline','target-book:people','target-book:write','target-book:cover','target-book:backup','target-book:folder','target-book:trash']);
});
test('read/edit and person toggles refresh after their existing handlers, including several clicks before one frame',()=>{
  const h=setup(),read=h.element('button','outline-read-toggle','完整阅读'),person=h.element('button','person-edit','编辑人物');
  read.addEventListener('click',()=>{h.context.outlineMode='read';read.textContent='返回编辑';});person.addEventListener('click',()=>{h.context.personEditing=true;person.textContent='完成编辑';});h.api.apply();
  h.click(read);h.click(person);h.flush();assert.equal(read.title,'返回编辑');assert.equal(person.title,'完成编辑');assert.ok(read.querySelector('svg'));assert.ok(person.querySelector('svg'));assert.equal(read.textContent,'');assert.equal(person.textContent,'');
});
test('dynamic outline action captions and translated labels follow the renderer without rewriting user content',()=>{
  const h=setup(),create=h.element('button','outline-create-chapter','生成卷章目录'),read=h.element('button','outline-read-toggle','完整阅读');h.api.apply();assert.equal(create.title,'生成卷章目录');
  const translations={'生成卷章目录':'Build chapters','完整阅读':'Read outline','返回编辑':'Back to editing'};h.api.configure({translate:text=>translations[text]||text});h.api.apply();assert.equal(create.title,'Build chapters');assert.equal(read.title,'Read outline');
  create.textContent='打开关联章节';h.api.apply(create);assert.equal(create.title,'打开关联章节');
});
test('asset tags preserve file/source behavior and unknown tags or supplied markup cannot affect unrelated controls',()=>{
  const h=setup(),link=h.element('a',null,'打开来源');link.dataset.uiAction='asset-source';link.href='https://example.test/notes';link.target='_blank';
  const upload=h.element('button',null,'添加文件');upload.dataset.uiAction='asset-upload';const unknown=h.element('button',null,'保存');unknown.dataset.uiAction='not-a-tool';
  h.api.configure({icon:()=>'<img src=x onerror=alert(1)>'});h.api.apply();assert.equal(link.href,'https://example.test/notes');assert.equal(link.target,'_blank');assert.equal(link.title,'打开来源');assert.equal(upload.title,'添加文件');assert.equal(unknown.textContent,'保存');assert.equal(upload.querySelector('img'),null);assert.ok(upload.querySelector('svg'));
});
