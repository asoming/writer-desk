'use strict';

// Exercise the actual sidebar with isolated books, not the user's library.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
class Element{
  constructor(tag='div'){
    this.tagName=tag.toUpperCase();this.children=[];this.hidden=false;this.value='';this.textContent='';this.listeners={};this.attributes={};
    this.classes=new Set();this.classList={add:key=>this.classes.add(key),remove:key=>this.classes.delete(key),toggle:(key,value)=>{value??=!this.classes.has(key);value?this.classes.add(key):this.classes.delete(key);return value;},contains:key=>this.classes.has(key)};
  }
  append(...items){for(const item of items){this.children.push(item);item.parentElement=this;}}
  replaceChildren(...items){this.children=[];this.append(...items);}
  setAttribute(key,value){this.attributes[key]=String(value);}
  addEventListener(key,listener){(this.listeners[key]??=[]).push(listener);}
  async dispatch(key,event={}){for(const listener of this.listeners[key]||[])await listener(event);}
  focus(){this.document.activeElement=this;}
}
const descend=node=>node.children.flatMap(child=>[child,...descend(child)]);
const copy=value=>JSON.parse(JSON.stringify(value));
function book(id='one',kind='long'){
  return{id,kind,title:'作品 '+id,chapters:[{id:id+'-chapter',title:'既有章',body:'尚未保存的正文也必须保留。',deletedAt:null}],outline:[],notes:[],relations:[]};
}
function harness(initial=book()){
  const nodes=new Map(),document={activeElement:null,documentElement:{lang:'zh'},createElement(tag){const node=new Element(tag);node.document=document;return node;}};
  const get=id=>{if(!nodes.has(id)){const node=document.createElement('div');node.id=id;nodes.set(id,node);}return nodes.get(id);};
  get('work-plan-panel').hidden=true;get('dialog').open=false;
  let dirty=0,notes=0,ai=0,resize=0;const jumps=[];
  const state={book:initial,kind:initial.kind,view:'write'},ctx=vm.createContext({window:null,state,document,uiLanguage:'zh',T:value=>value,$:get,uid:randomUUID,
    el(tag,className,text){const node=document.createElement(tag);node.className=className||'';if(text!==undefined)node.textContent=text;return node;},
    action(text,className,listener){const node=document.createElement('button');node.className=className;node.textContent=text;node.addEventListener('click',listener);return node;},
    outlineTopic:item=>item.category||'',people:()=>state.book.notes.filter(item=>item.type==='人物'&&!item.deletedAt),
    markDirty(){dirty++;},toggleNotes(value){assert.equal(value,false);notes++;},closeAIChat(){ai++;},resizeEditor(){resize++;},jumpToOwner(owner){jumps.push(owner);},
    requestAnimationFrame:callback=>callback(),clearTimeout(){},
  });
  ctx.window=ctx;vm.runInContext(fs.readFileSync(path.join(root,'public/work-plan.js'),'utf8'),ctx);
  const module=ctx.WriterWorkPlan;
  const all=()=>descend(get('work-plan-panel'));
  const field=key=>all().find(node=>node.id==='work-plan-'+key);
  const hint=key=>all().find(node=>node.id==='work-plan-'+key+'-hint');
  const button=label=>all().find(node=>node.tagName==='BUTTON'&&node.textContent===label);
  return{module,state,get,ctx,field,hint,all,button,jumps,counters:()=>({dirty,notes,ai,resize}),async type(key,value){const input=field(key);input.value=value;await input.dispatch('input');}};
}
const tests=[];const check=(name,test)=>tests.push({name,test});

check('opening an empty book shows all complete guidance without writing records or manuscript',()=>{
  const h=harness(),before=copy(h.state.book);h.module.bind();h.module.bind();assert.equal(h.get('writing-plan').listeners.click.length,1);
  assert.equal(h.module.isOpen(),false);h.module.open();assert.equal(h.module.isOpen(),true);assert.equal(h.get('writing-plan').attributes['aria-expanded'],'true');
  assert.deepEqual(h.state.book,before);assert.equal(h.counters().dirty,0);assert.equal(h.counters().notes,1);assert.equal(h.counters().ai,1);
  for(const key of ['world','characters','plot','synopsis']){assert.equal(h.field(key).value,'');assert.equal(h.hint(key).hidden,false);}
  const world=h.hint('world').children[0].textContent;for(const text of ['世界背景','描述世界的基本历史、风土人情','金手指','主角独有的能力或特质，能够起到推动剧情，解决矛盾危机的作用','背景事件','非当下、直接发生在主角身上，但对后续剧情走向，有重要作用的全文大事件'])assert.ok(world.includes(text));
  const characters=h.hint('characters').children[0].textContent;for(const text of ['主角','配角','反派1'])assert.ok(characters.includes(text));for(const label of ['姓名：','性别：','性格：','外貌：','人物简介：','人物关系：'])assert.equal(characters.split(label).length-1,3);
  const plot=h.hint('plot').children[0].textContent;for(const label of ['主线','主角的主要目标，主线故事的起因、经过、结果','支线','主角的次要目标，支线故事的起因、经过、结果。','支线通常是依附于主线目标，将主线目标拆分成若干个小目标，即是支线内容。','第一卷（卷名）','第二卷（卷名）'])assert.ok(plot.includes(label));
  for(const label of ['一句话概括内容：人物，世界观，金手指，主要目标。','什么人，在什么地方，凭借什么，做什么。','故事1：','故事2：','故事3：'])assert.equal(plot.split(label).length-1,2);
  assert.equal(h.hint('synopsis').children[0].textContent,'故事的梗概');
});
check('typing creates one real outline record and hides the entire guidance; clearing shows it again',async()=>{
  const h=harness();h.module.bind();h.module.open();await h.type('world','北境的冬天持续九个月。');
  assert.equal(h.state.book.outline.length,1);const node=h.state.book.outline[0],id=node.id;assert.equal(node.body,'北境的冬天持续九个月。');assert.equal(node.category,'世界设定');assert.equal(node.title,'世界观');assert.equal(h.hint('world').hidden,true);assert.equal(h.counters().dirty,1);
  await h.type('world','北境的冬天持续九个月。');assert.equal(h.counters().dirty,1);await h.type('world',' ');assert.equal(h.hint('world').hidden,true);
  await h.type('world','');assert.equal(h.hint('world').hidden,false);assert.equal(h.state.book.outline.length,1);assert.equal(h.state.book.outline[0].id,id);assert.equal(h.state.book.outline[0].body,'');
  assert.equal(h.state.book.chapters[0].body,'尚未保存的正文也必须保留。');
});
check('existing canonical and category nodes are edited in place, retaining identity and associations',async()=>{
  const value=book();value.outline=[{id:'world-other',title:'遗迹',category:'世界设定',kind:'scene',parentId:'root',body:'另一个子节点',chapterIds:[]},{id:'world',title:'世界规则与声段边界',category:'世界设定',kind:'scene',parentId:null,body:'一个世界规则',chapterIds:['one-chapter'],volumeId:null,deletedAt:null},{id:'roles',title:'人物群像与分组',category:'人物设定',body:'角色安排',chapterIds:[]},{id:'plot',title:'全书总纲',category:'故事主线',body:'故事主线内容',chapterIds:['one-chapter']},{id:'reference',title:'使用说明',category:'参考资料',body:'不能覆盖的参考',chapterIds:[]}];
  const h=harness(value);h.module.bind();h.module.open();assert.equal(h.field('world').value,'一个世界规则');assert.equal(h.field('characters').value,'角色安排');assert.equal(h.field('plot').value,'故事主线内容');assert.equal(h.field('synopsis').value,'');
  const before=copy(value.outline);await h.type('world','新的世界规则');assert.equal(value.outline.length,5);assert.deepEqual(value.outline[1],{...before[1],body:'新的世界规则'});assert.deepEqual(value.outline[0],before[0]);
  await h.type('synopsis','故事讲述两人的相遇。');assert.equal(value.outline.length,6);assert.deepEqual(value.outline[4],before[4]);assert.equal(value.outline[5].category,'参考资料');assert.equal(value.outline[5].title,'故事梗概');
});
check('synopsis reuses a real existing summary and ignores deleted outline nodes',async()=>{
  const value=book();value.outline=[{id:'dead',title:'世界观',category:'世界设定',body:'回收内容',deletedAt:'2026-10-12'}, {id:'summary',title:'故事摘要',category:'参考资料',body:'已有梗概',chapterIds:[]}];
  const h=harness(value);h.module.bind();h.module.open();assert.equal(h.field('world').value,'');assert.equal(h.field('synopsis').value,'已有梗概');await h.type('synopsis','新梗概');assert.equal(value.outline.length,2);assert.equal(value.outline[1].body,'新梗概');await h.type('world','新世界');assert.equal(value.outline.length,3);assert.equal(value.outline[0].body,'回收内容');
});
check('short stories show continuous plot guidance without suggesting volumes or chapters',()=>{
  const h=harness(book('short','short'));h.module.bind();h.module.open();const hint=h.hint('plot').children[0].textContent;assert.ok(!/第一卷|第二卷|卷名|章节/.test(hint));for(const text of ['主线','支线','开端：','发展：','转折：','高潮：','结局：'])assert.ok(hint.includes(text));
});
check('each book uses its own records and stale input handlers cannot change a previous book',async()=>{
  const one=book('one'),two=book('two','short'),h=harness(one);h.module.bind();h.module.open();await h.type('plot','第一本的剧情');const oldField=h.field('plot');
  h.state.book=two;h.state.kind='short';h.module.sync();assert.equal(h.field('plot').value,'');await h.type('plot','第二本的剧情');oldField.value='过时输入';await oldField.dispatch('input');assert.equal(one.outline[0].body,'第一本的剧情');assert.equal(two.outline[0].body,'第二本的剧情');
  h.state.book=one;h.state.kind='long';h.module.sync();assert.equal(h.field('plot').value,'第一本的剧情');
});
check('sync preserves the focused textarea and composition while reflecting external edits when idle',async()=>{
  const h=harness();h.module.bind();h.module.open();const input=h.field('characters');input.focus();await input.dispatch('compositionstart');assert.equal(h.state.composing,true);await h.type('characters','林');h.module.sync();assert.equal(h.field('characters'),input);
  h.state.book.outline[0].body='来自别处的角色设定';h.module.sync();assert.equal(input.value,'林');await input.dispatch('compositionend');assert.equal(h.state.composing,false);assert.equal(h.state.book.outline[0].body,'林');
  h.ctx.document.activeElement=null;h.state.book.outline[0].body='已经保存的人物';h.module.sync();assert.equal(h.field('characters'),input);assert.equal(input.value,'已经保存的人物');
});
check('characters are live book records and cards open the existing person instead of duplicating it',async()=>{
  const value=book();value.notes=[{id:'person',type:'人物',title:'沈砚',body:'档案修复师',profile:{group:'档案馆',role:'主角',desire:'找到父亲',flaw:'固执',ending:'修复真相'}},{id:'dead',type:'人物',title:'已删除',deletedAt:'2026-10-12'}];
  const h=harness(value),before=copy(value);h.module.bind();h.module.open();await h.button('人物卡片').dispatch('click');const cards=h.all().filter(node=>node.className==='work-plan-person');assert.equal(cards.length,1);assert.equal(cards[0].children[0].textContent,'沈砚');await cards[0].dispatch('click');assert.equal(h.jumps[0].type,'person');assert.equal(h.jumps[0].item,value.notes[0]);assert.deepEqual(value,before);assert.equal(h.counters().dirty,0);
  value.notes[0].title='新名字';h.module.sync();assert.equal(h.all().find(node=>node.className==='work-plan-person').children[0].textContent,'新名字');
});
check('the full outline button opens an actual owner and respects an empty book',async()=>{
  const h=harness();h.module.bind();h.module.open();let jump=h.all().find(node=>node.className==='icon-button work-plan-open-outline');assert.equal(jump.disabled,true);await h.type('plot','现有大纲');assert.equal(jump.disabled,false);await jump.dispatch('click');assert.equal(h.jumps[0].type,'outline');assert.equal(h.jumps[0].item,h.state.book.outline[0]);
});
check('closing and leaving writing restores toggle state without mutation or rebuilding on reopen',async()=>{
  const h=harness();h.module.bind();await h.get('writing-plan').dispatch('click');const input=h.field('world');await h.get('writing-plan').dispatch('click');assert.equal(h.module.isOpen(),false);assert.equal(h.get('writing-plan').attributes['aria-expanded'],'false');assert.equal(h.ctx.document.activeElement,h.get('writing-plan'));
  h.module.open();assert.equal(h.field('world'),input);h.state.view='shelf';h.module.sync();assert.equal(h.module.isOpen(),false);assert.equal(h.get('writing-plan').disabled,true);h.module.open();assert.equal(h.module.isOpen(),false);assert.equal(h.counters().dirty,0);
});
check('guidance supports manual wheel and keyboard scrolling with hidden scrollbars and no automatic motion',async()=>{
  const h=harness(),before=copy(h.state.book);h.module.bind();h.module.open();const hint=h.hint('world');
  assert.equal(hint.tabIndex,0);hint.focus();assert.equal(h.ctx.document.activeElement,hint);
  let prevented=false;await hint.dispatch('wheel',{deltaY:120,preventDefault(){prevented=true;}});await hint.dispatch('keydown',{key:'ArrowDown',preventDefault(){prevented=true;}});assert.equal(prevented,false);h.module.sync();assert.deepEqual(h.state.book,before);assert.equal(h.counters().dirty,0);
  const css=fs.readFileSync(path.join(root,'public/work-plan.css'),'utf8'),source=fs.readFileSync(path.join(root,'public/work-plan.js'),'utf8');
  assert.match(css,/\.work-plan-hint\{[^}]*overflow-y:auto;overflow-x:hidden/);assert.match(css,/\.work-plan-hint\{[^}]*scrollbar-width:none/);assert.match(css,/\.work-plan-hint::-webkit-scrollbar\{display:none/);assert.match(css,/\.work-plan-input\{[^}]*overflow:auto;scrollbar-width:none/);assert.match(css,/\.work-plan-input\{[^}]*resize:none/);
  assert.doesNotMatch(css,/@keyframes|animation|transform/);assert.doesNotMatch(source,/measureHint|resizeHints|ResizeObserver|hint-shift|hint-duration|scrollTop\s*=/);
});
check('keyboard tabs and escape work without requiring pointer input',async()=>{
  const h=harness();h.module.bind();h.module.open();const outline=h.button('作品大纲'),characters=h.button('人物卡片');await outline.dispatch('keydown',{key:'ArrowRight',preventDefault(){}});assert.equal(characters.attributes['aria-selected'],'true');assert.equal(h.ctx.document.activeElement,characters);
  await characters.dispatch('keydown',{key:'Home',preventDefault(){}});assert.equal(outline.attributes['aria-selected'],'true');await h.get('work-plan-panel').dispatch('keydown',{key:'Escape',preventDefault(){}});assert.equal(h.module.isOpen(),false);
});

(async()=>{for(const{name,test}of tests){await test();process.stdout.write('ok '+name+'\n');}process.stdout.write('Passed '+tests.length+' work-plan checks.\n');})().catch(error=>{console.error(error);process.exitCode=1;});
