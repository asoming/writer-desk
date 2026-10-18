'use strict';
(function(global){
  const IDLE_AFTER_MS=5000,QUEUE_KEY='yejian.writing-sessions.pending.v1';
  const countChars=text=>Array.from(String(text||'')).filter(char=>!(/\s/u.test(char))).length;
  function insertedText(previous,next){
    const before=Array.from(String(previous)),after=Array.from(String(next));let start=0,end=0;
    while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
    return after.slice(start,after.length-end).join('');
  }
  function formatDuration(value){const seconds=Math.max(0,Math.floor(value/1000));return[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(part=>String(part).padStart(2,'0')).join(':');}
  function sessionSpeed(record){return{perHour:record.activeMs?Math.round(record.typedChars*3600000/record.activeMs):0,perMinute:record.activeMs?Math.round(record.typedChars*60000/record.activeMs):0};}
  // Time advances on a monotonic clock. Only a short tail following a real
  // manuscript input is active, so timer throttling and sleep never become typing.
  function createTracker({id,bookId,now=()=>performance.now(),wallNow=()=>Date.now(),localDay,idleAfterMs=IDLE_AFTER_MS,foreground=true}={}){
    const started=now(),epoch=wallNow();let previous=started,lastInput=null,activeMs=0,idleMs=0,foregroundMs=0,typedChars=0,finished=false;
    const day=localDay||[new Date(epoch).getFullYear(),String(new Date(epoch).getMonth()+1).padStart(2,'0'),String(new Date(epoch).getDate()).padStart(2,'0')].join('-');
    function advance(){if(finished)return;const current=Math.max(previous,now()),elapsed=current-previous;
      const active=foreground&&lastInput!==null?Math.max(0,Math.min(current,lastInput+idleAfterMs)-previous):0;
      activeMs+=Math.min(elapsed,active);idleMs+=elapsed-Math.min(elapsed,active);if(foreground)foregroundMs+=elapsed;previous=current;
    }
    function snapshot(){advance();return{id,bookId,startedAt:new Date(epoch).toISOString(),endedAt:new Date(epoch+previous-started).toISOString(),localDay:day,typedChars,activeMs:Math.floor(activeMs),idleMs:Math.floor(idleMs),foregroundMs:Math.floor(foregroundMs)};}
    function input(chars=0){if(finished)return;advance();if(foreground){lastInput=previous;typedChars+=Math.max(0,Math.floor(chars));}}
    function setForeground(value){if(finished)return;advance();if(foreground!==!!value)lastInput=null;foreground=!!value;}
    function finish(){const result=snapshot();finished=true;return result;}
    return{input,setForeground,snapshot,finish};
  }
  // Browser composition events differ in whether the final input arrives before
  // or after compositionend. Comparing actual values makes both paths count once.
  // Chromium can emit an untrusted compositionend after trusted IME inputs; it
  // may finalize only that exact observed value, never a programmatic replacement.
  function createInputCounter(initial=''){
    let previous=String(initial),compositionBase=null,trustedCompositionValue=null,blocked=false;
    function start(value){compositionBase=String(value);trustedCompositionValue=null;previous=String(value);}
    function block(){blocked=true;}
    function before(event,value){if(event?.isTrusted===true&&compositionBase===null&&!event.isComposing)previous=String(value);}
    function end(value,trusted=true){const next=String(value),accepted=trusted||trustedCompositionValue!==null&&next===trustedCompositionValue,chars=accepted&&!blocked&&compositionBase!==null?countChars(insertedText(compositionBase,next)):0;const activity=accepted&&!blocked&&compositionBase!==null;compositionBase=null;trustedCompositionValue=null;previous=next;blocked=false;return{chars,activity};}
    function input(event,value){const next=String(value),type=event?.inputType||'',trusted=event?.isTrusted===true;let chars=0,activity=false;
      if(trusted&&!blocked){
        if(event.isComposing||type==='insertCompositionText'){if(compositionBase===null)compositionBase=previous;trustedCompositionValue=next;activity=true;}
        else if(compositionBase!==null){activity=true;}
        else if(type==='insertText'||type==='insertFromComposition'){chars=countChars(insertedText(previous,next));if(typeof event.data==='string')chars=Math.min(chars,countChars(event.data));activity=next!==previous;}
        else if(type==='insertLineBreak'||type==='insertParagraph'||type.startsWith('delete'))activity=next!==previous;
      }
      previous=next;if(!event?.isComposing&&compositionBase===null)blocked=false;return{chars,activity};
    }
    function reset(value){previous=String(value);compositionBase=null;trustedCompositionValue=null;blocked=false;}
    return{start,end,before,input,block,reset};
  }
  const model={IDLE_AFTER_MS,QUEUE_KEY,countChars,insertedText,formatDuration,sessionSpeed,createTracker,createInputCounter};
  if(typeof module==='object'&&module.exports){module.exports=model;return;}
  global.WriterImmersiveWriting=createController(global);

  function createController(window){
    const doc=window.document;let options={},active=null,entering=false,entryCancelled=false,exiting=false,bound=false,timer=null,checkpointTimer=null,pending=null,overlay=null,outlineButton=null,exitButton=null,fields={},lastSummary=null,memoryQueue=[],settled=new Map(),purged=new Set();
    const tr=(text,...values)=>options.translate?options.translate(text,...values):text.replace(/\{(\d+)\}/g,(_,index)=>values[index]??'');
    const editor=()=>options.getEditor?.()||doc.getElementById('editor');
    const area=()=>options.getWritingArea?.()||doc.getElementById('writing-area');
    const number=value=>Math.max(0,value).toLocaleString(doc.documentElement?.lang==='en'?'en-GB':'zh-CN');
    const storage=()=>options.storage||window.localStorage;
    function node(tag,className,text){const item=doc.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;}
    function glyph(name){const span=node('span');span.setAttribute('aria-hidden','true');const supplied=name==='exitFullscreen'?null:options.icons?.(name);if(supplied)span.innerHTML=supplied;else span.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="'+(name==='outline'?'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01':'M8 3v5H3M21 8h-5V3M16 21v-5h5M3 16h5v5')+'"/></svg>';return span;}
    function iconButton(label,name,run){const button=node('button','immersive-icon');button.type='button';button.title=tr(label);button.setAttribute('aria-label',tr(label));button.append(glyph(name));button.addEventListener('click',run);return button;}
    function uuid(){if(window.crypto?.randomUUID)return window.crypto.randomUUID();const bytes=window.crypto.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;return Array.from(bytes,(byte,index)=>([4,6,8,10].includes(index)?'-':'')+byte.toString(16).padStart(2,'0')).join('');}
    const metricKeys=['id','bookId','startedAt','endedAt','localDay','typedChars','activeMs','idleMs','foregroundMs'];
    const cleanRecord=item=>Object.fromEntries(metricKeys.map(key=>[key,item[key]]));
    function validRecord(item){return item&&typeof item.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(item.id)&&typeof item.bookId==='string'&&item.bookId.length>0&&item.bookId.length<=100&&typeof item.startedAt==='string'&&Number.isFinite(Date.parse(item.startedAt))&&typeof item.endedAt==='string'&&Number.isFinite(Date.parse(item.endedAt))&&typeof item.localDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(item.localDay)&&['typedChars','activeMs','idleMs','foregroundMs'].every(key=>Number.isSafeInteger(item[key])&&item[key]>=0);}
    function unsettled(item){const previous=settled.get(item.id);return!purged.has(item.bookId)&&(!previous||item.endedAt>previous.endedAt||['typedChars','activeMs','idleMs','foregroundMs'].some(key=>item[key]>previous[key]));}
    function queueRead(){let stored=[];try{const value=JSON.parse(storage().getItem(QUEUE_KEY)||'[]');if(Array.isArray(value))stored=value.filter(validRecord).slice(-200).map(cleanRecord);}catch{}return[...new Map([...stored,...memoryQueue].filter(unsettled).map(item=>[item.id,item])).values()].slice(-200);}
    function queueWrite(items){items=items.map(cleanRecord);memoryQueue=items;try{if(items.length)storage().setItem(QUEUE_KEY,JSON.stringify(items));else storage().removeItem(QUEUE_KEY);return true;}catch{return false;}}
    function enqueue(record){const items=queueRead().filter(item=>item.id!==record.id);items.push(record);return queueWrite(items.slice(-200));}
    function forget(record){settled.set(record.id,record);queueWrite(queueRead());}
    async function drain(){if(pending||!options.api)return pending;pending=(async()=>{let saved=false;for(let attempt=0;attempt<200;attempt++){const record=queueRead()[0];if(!record)break;
      try{await options.api('/api/writing-sessions','POST',record);forget(record);saved=true;}
      catch(problem){if([404,409,410].includes(problem?.status)||[404,409,410].includes(problem?.statusCode)){forget(record);continue;}return false;}
    }if(saved){options.onSessionSaved?.();for(const notice of doc.querySelectorAll?.('.immersive-summary-pending')||[])notice.hidden=true;}return true;})().finally(()=>{pending=null;});return pending;}
    async function checkpoint(){if(active)enqueue(active.tracker.snapshot());if(pending)await pending;return drain();}
    function foreground(){return!doc.hidden&&(typeof doc.hasFocus!=='function'||doc.hasFocus());}
    function preserveLayout(run){const element=editor(),scroll=area()?.scrollTop,start=element?.selectionStart,end=element?.selectionEnd,direction=element?.selectionDirection;run();options.resizeEditor?.();if(area()&&scroll!==undefined)area().scrollTop=scroll;if(element&&start!==undefined)element.setSelectionRange?.(start,end,direction);}
    function createOverlay(){
      if(overlay)return;overlay=node('header','immersive-header');overlay.id='immersive-writing-hud';overlay.hidden=true;
      const summary=node('div','immersive-live'),title=node('strong','immersive-book-title');title.id='immersive-book-title';fields.title=title;summary.append(title);
      const stats=node('dl','immersive-live-stats');for(const[key,label]of[['typedChars','本次码字'],['speed','码字速率'],['activeMs','码字时间'],['idleMs','空闲时间']]){const item=node('div','immersive-live-stat');fields[key+'Label']=node('dt',null,tr(label));item.append(fields[key+'Label']);fields[key]=node('dd',null,'0');fields[key].id='immersive-'+key;item.append(fields[key]);stats.append(item);}
      stats.title=tr('连续 5 秒没有正文输入计为空闲；切到其他窗口立即计为空闲。');summary.append(stats);
      const controls=node('div','immersive-controls');outlineButton=iconButton('作品大纲','outline',()=>{if(!active||exiting)return;preserveLayout(()=>options.toggleOutline?.());update();});outlineButton.id='immersive-outline-toggle';outlineButton.setAttribute('aria-controls','work-plan-panel');exitButton=iconButton('退出沉浸式码字','exitFullscreen',()=>exit());exitButton.id='immersive-exit';controls.append(outlineButton,exitButton);overlay.append(summary,controls);doc.body.append(overlay);
    }
    function update(){if(!active||!overlay)return;const record=active.tracker.snapshot(),speed=sessionSpeed(record);for(const[key,label]of[['typedChars','本次码字'],['speed','码字速率'],['activeMs','码字时间'],['idleMs','空闲时间']])fields[key+'Label'].textContent=tr(label);fields.title.textContent=active.title;fields.typedChars.textContent=number(record.typedChars);fields.speed.textContent=tr('{0} 字/时',number(speed.perHour));fields.activeMs.textContent=formatDuration(record.activeMs);fields.idleMs.textContent=formatDuration(record.idleMs);outlineButton.setAttribute('aria-pressed',String(!!options.isOutlineOpen?.()));outlineButton.title=tr(options.isOutlineOpen?.()?'收起作品大纲':'作品大纲');outlineButton.setAttribute('aria-label',outlineButton.title);exitButton.title=tr('退出沉浸式码字');exitButton.setAttribute('aria-label',exitButton.title);fields.title.nextElementSibling?.setAttribute('title',tr('连续 5 秒没有正文输入计为空闲；切到其他窗口立即计为空闲。'));}
    function resetEditorCounter(){if(active)active.counter.reset(editor()?.value||'');}
    function bind(){if(bound)return;bound=true;const input=editor();
      input?.addEventListener('beforeinput',event=>active?.counter.before(event,input.value));
      input?.addEventListener('compositionstart',event=>{if(active&&event.isTrusted)active.counter.start(input.value);});
      input?.addEventListener('compositionend',event=>{if(!active)return;const value=active.counter.end(input.value,event.isTrusted===true);if(value.activity)active.tracker.input(value.chars);update();});
      for(const name of['paste','drop'])input?.addEventListener(name,()=>active?.counter.block());
      input?.addEventListener('input',event=>{if(!active)return;if(options.getBook?.()?.id!==active.bookId||options.getChapter?.()?.id!==active.chapterId){sync();return;}const value=active.counter.input(event,input.value);if(value.activity)active.tracker.input(value.chars);update();});
      window.addEventListener('blur',()=>{if(active){active.tracker.setForeground(false);update();checkpoint();}});
      window.addEventListener('focus',()=>{if(active){active.tracker.setForeground(foreground());resetEditorCounter();update();}});
      doc.addEventListener('visibilitychange',()=>{if(active){active.tracker.setForeground(foreground());resetEditorCounter();update();checkpoint();}});
      doc.addEventListener('keydown',event=>{if(active&&event.key==='Escape'&&!event.isComposing&&!doc.querySelector('dialog[open]')){event.preventDefault();event.stopImmediatePropagation();exit();}},true);
      window.addEventListener('online',()=>drain());
      window.setInterval(()=>{if(queueRead().length)drain();},30000);
      window.addEventListener('pagehide',()=>{if(active){active.tracker.setForeground(false);enqueue(active.tracker.snapshot());}});
    }
    async function enter(){
      if(active||entering||exiting)return false;const book=options.getBook?.(),chapter=options.getChapter?.(),input=editor();if(options.getView?.()!=='write'||!book||!chapter||input?.disabled)return false;entering=true;entryCancelled=false;
      try{if(options.saveNow&&await options.saveNow()===false)return false;if(options.getBook?.()!==book||options.getChapter?.()?.id!==chapter.id)return false;
        const nativeState=await options.enterFullscreen?.();if(nativeState===false)return false;if(entryCancelled){try{await options.exitFullscreen?.(nativeState);return false;}catch{options.toast?.(tr('无法退出全屏，请按 Esc。'));}}if(options.getBook?.()!==book||options.getChapter?.()?.id!==chapter.id){await options.exitFullscreen?.(nativeState);return false;}
        const record={bookId:book.id,chapterId:chapter.id,title:book.title,outlineWasOpen:!!options.isOutlineOpen?.(),nativeState};
        record.tracker=createTracker({id:uuid(),bookId:book.id,now:()=>window.performance.now(),wallNow:()=>Date.now(),foreground:foreground()});record.counter=createInputCounter(input.value);active=record;createOverlay();
        preserveLayout(()=>{if(options.isOutlineOpen?.())options.toggleOutline?.();doc.body.classList.add('immersive-writing');doc.getElementById('workspace')?.classList.add('focus');overlay.hidden=false;});
        input.focus({preventScroll:true});active.tracker.setForeground(foreground());update();timer=window.setInterval(update,1000);checkpointTimer=window.setInterval(checkpoint,15000);enqueue(active.tracker.snapshot());return true;
      }catch(problem){if(active){enqueue(active.tracker.finish());restore();}try{await options.exitFullscreen?.();}catch{}options.toast?.(tr(problem?.message||'无法进入沉浸式码字。'));return false;}finally{entering=false;}
    }
    function restore(){window.clearInterval(timer);window.clearInterval(checkpointTimer);timer=checkpointTimer=null;const record=active;active=null;preserveLayout(()=>{doc.body.classList.remove('immersive-writing');doc.getElementById('workspace')?.classList.remove('focus');if(overlay)overlay.hidden=true;if(record&&!!options.isOutlineOpen?.()!==record.outlineWasOpen)options.toggleOutline?.();});return record;}
    function summary(record,title){
      const content=node('div','immersive-summary');content.append(node('p','immersive-summary-book',title));
      const date=node('p','immersive-summary-date',new Date(record.startedAt).toLocaleDateString(doc.documentElement?.lang==='en'?'en-GB':'zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}));content.append(date);
      const rows=node('dl','immersive-summary-rows'),speed=sessionSpeed(record),time=stamp=>new Date(stamp).toLocaleTimeString(doc.documentElement?.lang==='en'?'en-GB':'zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
      for(const[label,value]of[['字数',tr('{0} 字',number(record.typedChars))],['码字速率',tr('{0} 字/时 · {1} 字/分',number(speed.perHour),number(speed.perMinute))],['码字时间',formatDuration(record.activeMs)],['前台时间',formatDuration(record.foregroundMs)],['空闲时间',formatDuration(record.idleMs)],['开始 / 结束',time(record.startedAt)+' — '+time(record.endedAt)]]){const row=node('div','immersive-summary-row');row.append(node('dt',null,tr(label)),node('dd',null,value));rows.append(row);}content.append(rows);
      rows.title=tr('连续 5 秒没有正文输入计为空闲；切到其他窗口立即计为空闲。');
      if(queueRead().some(item=>item.id===record.id))content.append(node('p','immersive-summary-pending',tr('码字记录已暂存本机，稍后自动重试。')));
      options.showDialog?.(tr('本次码字'),content);return content;
    }
    async function exit({showSummary=true,save=true,nativeExited=false}={}){
      if(!active||entering||exiting)return false;exiting=true;if(exitButton)exitButton.disabled=true;
      const input=editor(),readOnly=input?.readOnly;
      try{if(save&&options.saveNow&&await options.saveNow()===false){active.tracker.setForeground(foreground());if(nativeExited)try{await options.enterFullscreen?.();}catch{}return false;}
        const checkpoint=active.tracker.snapshot();const durable=enqueue(checkpoint);if(!durable&&await drain()===false){options.toast?.(tr('码字记录暂时无法保存，请稍后重试。'));return false;}
        // The save gate has completed. Prevent a keystroke during an asynchronous
        // native fullscreen transition from becoming an unsaved, uncounted edit.
        if(input)input.readOnly=true;
        if(!nativeExited){try{await options.exitFullscreen?.(active.nativeState);}catch{options.toast?.(tr('无法退出全屏，请按 Esc。'));return false;}}
        const record=active.tracker.finish(),title=active.title;enqueue(record);restore();lastSummary={record,title};drain();if(showSummary)summary(record,title);return true;
      }catch(problem){options.toast?.(tr(problem?.message||'无法退出全屏，请按 Esc。'));return false;}
      finally{if(input)input.readOnly=readOnly;exiting=false;if(exitButton)exitButton.disabled=false;}
    }
    async function flush(value={}){
      if(value.finish&&active)return exit({showSummary:false,save:false});
      const saved=await checkpoint();
      // Closing remains possible when a retryable record is already durable
      // locally; the next launch can submit it without holding the app open.
      return value.finish&&saved===false?queueWrite(queueRead()):saved;
    }
    function fullscreenChanged(value){if(value!==false)return false;if(entering){entryCancelled=true;return false;}if(active&&!exiting)return exit({nativeExited:true});return false;}
    function sync(){if(!active)return;if(options.getBook?.()?.id!==active.bookId||options.getChapter?.()?.id!==active.chapterId||options.getView?.()!=='write')return exit({showSummary:true,save:false});update();}
    function purgeBook(bookId){purged.add(bookId);queueWrite(queueRead().filter(record=>record.bookId!==bookId));if(lastSummary?.record.bookId===bookId)lastSummary=null;}
    function configure(value){options=value||{};bind();drain();}
    return{configure,enter,exit,isActive:()=>!!active,flush,fullscreenChanged,sync,purgeBook,showLastSummary:()=>lastSummary&&summary(lastSummary.record,lastSummary.title)};
  }
})(typeof window==='undefined'?globalThis:window);
