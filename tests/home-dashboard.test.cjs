'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const model=require('../public/home-dashboard.js');
const source=fs.readFileSync(path.join(__dirname,'../public/home-dashboard.js'),'utf8');
function result(title='当前作品',count=1,goal=2000){
  const today='2026-10-15',last=Date.parse(today+'T00:00:00Z');
  return{today,settings:{dailyGoal:goal},totals:{todayChars:0,totalChars:100,bookCount:count,longCount:count,shortCount:0,chapterCount:1,writingDays:0,currentStreak:0,bestStreak:0,last7Chars:0,last30Chars:0},days:Array.from({length:90},(_,index)=>({date:new Date(last-(89-index)*86400000).toISOString().slice(0,10),addedChars:0})),recentBooks:count?[{id:'book',title,kind:'long',charCount:100,cover:'',latestChapterTitle:'第一章'}]:[]};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.attributes={};this.dataset={};this.hidden=false;this.scrollTop=0;this.className='';this.value='';this._text='';this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),...names])].join(' ');},toggle:(name,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));if(on??!set.has(name))set.add(name);else set.delete(name);this.className=[...set].join(' ');}};}
  append(...children){this.children.push(...children);for(const child of children)if(child&&typeof child==='object')child.parentElement=this;}
  replaceChildren(...children){this.children=[];this._text='';this.append(...children);}
  set textContent(text){this._text=String(text);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.className=value;if(key==='id')this.id=value;}
  addEventListener(name,listener){this.listeners[name]=listener;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  querySelectorAll(selector){const matching=item=>selector.startsWith('#')?item.id===selector.slice(1):selector.startsWith('.')?item.className.split(' ').includes(selector.slice(1)):item.tagName===selector.toUpperCase();const all=[];function visit(item){for(const child of item.children){if(typeof child!=='object')continue;if(matching(child))all.push(child);visit(child);}}visit(this);return all;}
  focus(){} setCustomValidity(value){this.validation=value;} reportValidity(){return!this.validation;}
}
function harness(api){const root=new Element('section');root.id='home-view';let view='home';const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>id===root.id?root:root.querySelector('#'+id)};const window={document};vm.runInNewContext(source,{window,console});window.WriterHomeDashboard.configure({api,getView:()=>view,translate:(text,...values)=>text.replace(/\{(\d+)\}/g,(_,index)=>values[index]??''),getLanguage:()=> 'zh'});return{root,controller:window.WriterHomeDashboard,element:id=>document.getElementById(id),setView:value=>view=value};}

test('calendar follows Monday weeks, leap days and year boundaries without timezone arithmetic',()=>{
  const days=model.monthGrid('2024-02');assert.equal(days.length%7,0);assert.equal(days.filter(Boolean).length,29);assert.equal(days[3],'2024-02-01');assert.equal(days.filter(Boolean).at(-1),'2024-02-29');assert.equal(model.shiftMonth('2026-01',-1),'2025-12');assert.equal(model.shiftMonth('2026-12',1),'2027-01');
});
test('trend points retain zero days and finite coordinates for 7 and 30 day ranges',()=>{
  for(const length of[7,30]){const days=result().days.slice(-length),zero=model.chartPoints(days);assert.equal(zero.points.length,length);assert.ok(zero.points.every(point=>point.y===164&&Number.isFinite(point.x)));days[2].addedChars=50;const changed=model.chartPoints(days);assert.equal(changed.maximum,50);assert.equal(changed.points[2].y,36);assert.ok(!changed.line.includes('NaN'));}
});
test('statistics validation rejects impossible dates, gaps and unsafe counters',()=>{
  assert.equal(model.validate(result()).totals.bookCount,1);
  for(const change of[value=>value.today='2026-02-31',value=>value.days[20].date=value.days[19].date,value=>value.totals.todayChars=true,value=>value.settings.dailyGoal=1000001,value=>value.days[0].addedChars=-1]){const value=result();change(value);assert.throws(()=>model.validate(value),/统计读取失败/);}
});
test('leaving home clears book DOM and rejects a late private response',async()=>{
  const delayed=deferred(),h=harness(()=>delayed.promise),loading=h.controller.render(h.root);h.setView('write');h.controller.sync();assert.equal(h.root.textContent,'');delayed.resolve(result('已删除的私密书名'));await loading;assert.equal(h.root.textContent,'');h.setView('home');const fresh=deferred();h.controller.configure({api:()=>fresh.promise,getView:()=> 'home'});const next=h.controller.render(h.root);fresh.resolve(result('新的可见作品'));await next;assert.ok(h.root.textContent.includes('新的可见作品'));assert.ok(!h.root.textContent.includes('私密'));
});
test('forced refresh discards older book results and stale request errors',async()=>{
  const old=deferred(),next=deferred();let calls=0;const h=harness(()=>++calls===1?old.promise:next.promise),first=h.controller.render(h.root),second=h.controller.sync({force:true});next.resolve(result('最新作品',2));await second;old.resolve(result('旧作品'));await first;assert.equal(h.element('home-book-count').textContent,'2');assert.ok(h.root.textContent.includes('最新作品'));assert.ok(!h.root.textContent.includes('旧作品'));
});
test('editing the independent goal survives forced redraw and suppresses ordinary refresh',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return result();});await h.controller.render(h.root);await h.element('home-goal-edit').listeners.click();h.element('home-daily-goal').value='3210';h.element('home-daily-goal').listeners.input();h.controller.sync();assert.equal(calls,1);await h.controller.render(h.root);assert.equal(h.element('home-daily-goal').value,'3210');assert.equal(calls,2);
});
test('goal response cannot replace a newly opened home after leaving during save',async()=>{
  const saving=deferred();let stored=2000,puts=0;const h=harness(async(path,method,body)=>{if(method==='PUT'){puts++;assert.deepEqual(JSON.parse(JSON.stringify(body)),{dailyGoal:5432});await saving.promise;stored=5432;return{settings:{dailyGoal:5432}};}return result('新页面作品',1,stored);});await h.controller.render(h.root);await h.element('home-goal-edit').listeners.click();const input=h.element('home-daily-goal');input.value='5432';input.listeners.input();const submit=input.parentElement.listeners.submit({preventDefault(){}});h.setView('write');h.controller.sync();assert.equal(h.root.textContent,'');h.setView('home');await h.controller.render(h.root);saving.resolve();await submit;await new Promise(resolve=>setImmediate(resolve));assert.equal(puts,1);assert.ok(h.root.textContent.includes('5,432'));assert.ok(h.root.textContent.includes('新页面作品'));assert.equal(h.element('home-daily-goal'),null);
});
test('reading and rendering home never sends book or settings mutations',async()=>{
  const requests=[],h=harness(async(...args)=>{requests.push(args);return result();});await h.controller.render(h.root);await h.controller.sync({force:true});assert.equal(requests.length,2);assert.ok(requests.every(args=>args.length===1&&/^\/api\/home\?localDay=\d{4}-\d{2}-\d{2}$/.test(args[0])));assert.equal(h.element('home-today-chars').textContent,'0');h.controller.dispose();assert.equal(h.root.textContent,'');
});

function withSessions(value=result()){
  const record={id:'session',bookId:'book',bookTitle:'沉浸小说',localDay:'2026-10-15',startedAt:'2026-10-15T01:00:00Z',endedAt:'2026-10-15T02:00:00Z',typedChars:3600,activeMs:2400000,idleMs:1200000,foregroundMs:3300000,speedPerHour:5400,speedPerMinute:90};value.writingSessions={today:{count:1,typedChars:3600,activeMs:2400000,idleMs:1200000,foregroundMs:3300000,speedPerHour:5400,speedPerMinute:90,startedAt:record.startedAt,endedAt:record.endedAt},recent:[record]};return value;
}
test('optional immersive records preserve old home payloads and reject invalid or unsafe metrics',()=>{
  assert.equal(model.validate(result()).writingSessions,undefined);assert.equal(model.validate(withSessions()).writingSessions.today.typedChars,3600);
  for(const change of[value=>value.writingSessions.today.idleMs=-1,value=>value.writingSessions.recent[0].typedChars=true,value=>value.writingSessions.recent[0].endedAt='invalid',value=>value.writingSessions.recent[0].localDay='2026-02-31',value=>value.writingSessions.recent=Array(21).fill(value.writingSessions.recent[0])]){const value=withSessions();change(value);assert.throws(()=>model.validate(value),/统计读取失败/);}
});
test('home displays all requested immersive session facts and safely expands recent record rows',async()=>{
  const h=harness(async()=>withSessions());await h.controller.render(h.root);const section=h.element('home-writing-sessions');assert.ok(section);for(const label of['空闲时间','前台时间','码字时间','码字速率','开始 / 结束','沉浸小说'])assert.ok(section.textContent.includes(label));assert.ok(section.textContent.includes('00:20:00'));assert.ok(section.textContent.includes('00:40:00'));assert.equal(section.querySelectorAll('details').length,1);assert.equal(section.querySelectorAll('summary').length,1);assert.equal(section.querySelector('details').dataset.sessionId,'session');assert.match(section.title,/开始日期/);
});
test('immersive section empty state and local dates are stable without inferring old manuscript timestamps',async()=>{
  const value=withSessions();value.writingSessions.recent=[];Object.assign(value.writingSessions.today,{count:0,typedChars:0,activeMs:0,idleMs:0,foregroundMs:0,speedPerHour:0,speedPerMinute:0,startedAt:null,endedAt:null});const requests=[],h=harness(async(url)=>{requests.push(url);return value;});await h.controller.render(h.root);assert.ok(h.root.textContent.includes('还没有码字记录。'));assert.equal(h.element('home-session-today').textContent.includes('NaN'),false);assert.match(requests[0],/^\/api\/home\?localDay=\d{4}-\d{2}-\d{2}$/);assert.equal(model.duration(90061000),'25:01:01');assert.equal(model.localDate(new Date(2026,0,1,0,1)),'2026-01-01');
});
