'use strict';
(function(global){
  const DAY=86400000;
  function monthGrid(month){
    const [year,number]=month.split('-').map(Number),first=new Date(Date.UTC(year,number-1,1));
    const offset=(first.getUTCDay()+6)%7,count=new Date(Date.UTC(year,number,0)).getUTCDate();
    return Array.from({length:Math.ceil((offset+count)/7)*7},(_,index)=>index<offset||index>=offset+count?null:month+'-'+String(index-offset+1).padStart(2,'0'));
  }
  function shiftMonth(month,offset){const [year,number]=month.split('-').map(Number);return new Date(Date.UTC(year,number-1+offset,1)).toISOString().slice(0,7);}
  function chartPoints(days){
    const maximum=Math.max(1,...days.map(day=>day.addedChars));
    const points=days.map((day,index)=>({date:day.date,amount:day.addedChars,x:24+(days.length>1?index/(days.length-1):.5)*632,y:164-day.addedChars/maximum*128}));
    return{maximum,points,line:points.map((point,index)=>(index?'L':'M')+point.x.toFixed(2)+','+point.y.toFixed(2)).join(' ')};
  }
  function localDate(value=new Date()){return[value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-');}
  function duration(value){const seconds=Math.max(0,Math.floor(value/1000));return[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(part=>String(part).padStart(2,'0')).join(':');}
  function validate(value){
    const integer=number=>Number.isSafeInteger(number)&&number>=0;
    const date=text=>typeof text==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(text)&&Number.isFinite(Date.parse(text+'T00:00:00Z'))&&new Date(text+'T00:00:00Z').toISOString().slice(0,10)===text;
    if(!value||!date(value.today)||!value.settings||!integer(value.settings.dailyGoal)||value.settings.dailyGoal>1000000||!value.totals||!['todayChars','totalChars','bookCount','longCount','shortCount','chapterCount','writingDays','currentStreak','bestStreak','last7Chars','last30Chars'].every(key=>integer(value.totals[key]))||!Array.isArray(value.days)||value.days.length!==90||!value.days.every((day,index)=>date(day.date)&&integer(day.addedChars)&&(!index||Date.parse(day.date)-Date.parse(value.days[index-1].date)===DAY))||value.days.at(-1).date!==value.today||!Array.isArray(value.recentBooks)||value.recentBooks.length>6||!value.recentBooks.every(book=>book&&typeof book.id==='string'&&typeof book.title==='string'&&['long','short'].includes(book.kind)&&integer(book.charCount)&&typeof book.cover==='string'))throw Error('写作统计读取失败，请重试。');
    if(value.writingSessions!==undefined){
      const metrics=item=>item&&['typedChars','activeMs','idleMs','foregroundMs','speedPerHour','speedPerMinute'].every(key=>integer(item[key]));
      const stamp=text=>typeof text==='string'&&Number.isFinite(Date.parse(text));
      const sessions=value.writingSessions;if(!sessions||!metrics(sessions.today)||!integer(sessions.today.count)||!Array.isArray(sessions.recent)||sessions.recent.length>20||!sessions.recent.every(item=>metrics(item)&&typeof item.id==='string'&&typeof item.bookId==='string'&&typeof item.bookTitle==='string'&&date(item.localDay)&&stamp(item.startedAt)&&stamp(item.endedAt))||!['startedAt','endedAt'].every(key=>sessions.today[key]===null||stamp(sessions.today[key])))throw Error('写作统计读取失败，请重试。');
    }
    return value;
  }
  const model={monthGrid,shiftMonth,chartPoints,validate,localDate,duration};
  if(typeof module==='object'&&module.exports){module.exports=model;return;}
  global.WriterHomeDashboard=createController(global);

  function createController(window){
    let options={},root=null,data=null,pending=null,sequence=0,lastLoaded=0,range=7,month=null,error='',editingGoal=false,goalDraft=null,goalSaving=false,disposed=false;
    const doc=window.document;
    const tr=(text,...values)=>options.translate?options.translate(text,...values):text.replace(/\{(\d+)\}/g,(_,index)=>values[index]??'');
    const language=()=>options.getLanguage?.()==='en'?'en-GB':'zh-CN';
    const number=value=>value.toLocaleString(language());
    const words=value=>tr('{0} 字',number(value));
    const visible=()=>!!root&&!root.hidden&&(options.isVisible?options.isVisible():options.getView?options.getView()==='home':true);
    function node(tag,className,text){const item=doc.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;}
    function button(label,run,className=''){const item=node('button',className,tr(label));item.type='button';item.addEventListener('click',()=>Promise.resolve(run()).catch(problem=>{error=problem.message;paint();}));return item;}
    function icon(name,fallback=''){const item=node('span','home-icon',fallback);item.setAttribute('aria-hidden','true');if(typeof options.icons==='function')item.innerHTML=options.icons(name);return item;}
    function dateLabel(stamp,settings){return new Date(stamp+'T12:00:00').toLocaleDateString(language(),settings);}
    function openBook(book){return options.openBook?.(book.id,'write');}
    function heading(title,detail){const header=node('div','home-section-heading');header.append(node('h3',null,tr(title)));if(detail!==undefined)header.append(node('span','home-caption',detail));return header;}
    function paint(){
      if(!root||disposed)return;
      if(editingGoal){const input=root.querySelector('.home-goal-input');if(input)goalDraft=input.value;}
      const scroll=root.scrollTop,host=node('div','home-dashboard');root.replaceChildren(host);
      const header=node('header','home-heading'),titles=node('div');titles.append(node('h2',null,tr('写作概览')));
      if(data)titles.append(node('p','home-date',dateLabel(data.today,{year:'numeric',month:'long',day:'numeric',weekday:'long'})));
      header.append(titles,button('查看书架',()=>options.navigate?.('shelf'),'secondary-button'));host.append(header);
      if(error){const notice=node('div','home-error');notice.setAttribute('role','alert');notice.append(node('span',null,tr(error)),button('重试',()=>refresh(true),'text-button'));host.append(notice);}
      if(!data){if(!error){const loading=node('div','home-loading');loading.setAttribute('role','status');loading.setAttribute('aria-label',tr('正在读取写作统计…'));for(let i=0;i<4;i++)loading.append(node('div','home-loading-card'));host.append(loading);}root.scrollTop=scroll;return;}
      host.append(renderMetrics());if(data.writingSessions)host.append(renderSessions());
      const activity=node('div','home-activity');activity.append(renderTrend(),renderCalendar());host.append(activity,renderRecent());
      root.scrollTop=scroll;
    }
    function metric(label,value,unit,detail,id){
      const card=node('section','home-metric'),valueRow=node('div','home-metric-value');
      const amount=node('strong',null,number(value));if(id)amount.id=id;
      card.append(node('h3',null,tr(label)));valueRow.append(amount,node('span',null,tr(unit)));card.append(valueRow);
      if(detail)card.append(node('p','home-caption',detail));return card;
    }
    function renderMetrics(){
      const totals=data.totals,cards=node('div','home-metrics');
      const today=metric('今日新增',totals.todayChars,'字',null,'home-today-chars');today.classList.add('home-metric-today');
      today.title=tr('仅统计书架作品成功保存的新增正文，导入与恢复不计入。');
      const goalRow=node('div','home-goal-row'),goal=data.settings.dailyGoal;
      goalRow.append(node('span','home-caption',goal?tr('每日目标 {0} 字',number(goal)):tr('未设置每日目标')));
      const edit=button('调整每日目标',()=>{editingGoal=!editingGoal;if(editingGoal)goalDraft=String(data.settings.dailyGoal);else goalDraft=null;paint();if(editingGoal)root.querySelector('.home-goal-input')?.focus();},'home-icon-button');edit.id='home-goal-edit';edit.textContent='';edit.append(icon('pen','✎'));edit.title=tr('调整每日目标');edit.setAttribute('aria-label',tr('调整每日目标'));goalRow.append(edit);today.append(goalRow);
      if(goal){const progress=node('progress','home-goal-progress');progress.max=goal;progress.value=totals.todayChars;progress.setAttribute('aria-label',tr('目标进度'));today.append(progress);}
      if(editingGoal){
        const form=node('form','home-goal-form'),input=node('input','home-goal-input');input.id='home-daily-goal';input.type='number';input.min='0';input.max='1000000';input.step='1';input.value=goalDraft??String(goal);input.required=true;input.setAttribute('aria-label',tr('每日目标'));input.disabled=goalSaving;
        const save=node('button','home-goal-save',tr('保存'));save.id='home-goal-save';save.type='submit';save.disabled=goalSaving;form.append(input,save);
        form.addEventListener('submit',async event=>{event.preventDefault();if(goalSaving)return;if(!/^\d+$/.test(input.value)||Number(input.value)>1000000){input.setCustomValidity(tr('每日目标须为 0 至 1000000 的整数'));input.reportValidity();return;}input.setCustomValidity('');goalSaving=true;input.disabled=save.disabled=true;
          const request=sequence;
          try{const result=await options.api('/api/home/settings','PUT',{dailyGoal:Number(input.value)});if(disposed||!visible()||!data||request!==sequence)return;if(!Number.isSafeInteger(result?.settings?.dailyGoal)||result.settings.dailyGoal<0||result.settings.dailyGoal>1000000)throw Error('写作统计读取失败，请重试。');data.settings=result.settings;editingGoal=false;goalDraft=null;error='';}
          catch(problem){if(visible()&&request===sequence)error=problem.message;}finally{goalSaving=false;if(!disposed&&visible()){if(request===sequence)paint();else refresh(true);}}});
        input.addEventListener('input',()=>{goalDraft=input.value;input.setCustomValidity('');});today.append(form);
      }
      cards.append(today,metric('书架总字数',totals.totalChars,'字',null,'home-total-chars'),metric('连续写作',totals.currentStreak,'天',tr('累计 {0} 天 · 最长 {1} 天',number(totals.writingDays),number(totals.bestStreak)),'home-streak'),metric('作品',totals.bookCount,'本',tr('长篇 {0} · 短篇 {1}',number(totals.longCount),number(totals.shortCount)),'home-book-count'));return cards;
    }
    function sessionTime(stamp){return stamp?new Date(stamp).toLocaleTimeString(language(),{hour:'2-digit',minute:'2-digit',hour12:false}):'—';}
    function sessionFacts(record,className='home-session-facts'){
      const grid=node('dl',className);const facts=[['字数',words(record.typedChars)],['码字速率',tr('{0} 字/时 · {1} 字/分',number(record.speedPerHour),number(record.speedPerMinute))],['码字时间',duration(record.activeMs)],['前台时间',duration(record.foregroundMs)],['空闲时间',duration(record.idleMs)],['开始 / 结束',sessionTime(record.startedAt)+' — '+sessionTime(record.endedAt)]];
      for(const[label,value]of facts){const item=node('div','home-session-fact');item.append(node('dt',null,tr(label)),node('dd',null,value));grid.append(item);}return grid;
    }
    function renderSessions(){
      const sessions=data.writingSessions,section=node('section','home-card home-writing-sessions');section.id='home-writing-sessions';section.append(heading('沉浸式码字',tr('今日 {0} 次',number(sessions.today.count))));
      section.title=tr('码字记录按开始日期归档。');const facts=sessionFacts(sessions.today);facts.id='home-session-today';facts.title=tr('连续 5 秒没有正文输入计为空闲；切到其他窗口立即计为空闲。');section.append(facts);
      if(!sessions.recent.length){section.append(node('p','home-session-empty',tr('还没有码字记录。')));return section;}
      const list=node('div','home-session-records');list.setAttribute('aria-label',tr('最近码字'));
      for(const record of sessions.recent){const item=node('details','home-session-record'),summary=node('summary','home-session-record-title'),book=node('strong',null,record.bookTitle),stamp=node('span','home-session-record-time',new Date(record.startedAt).toLocaleDateString(language(),{month:'numeric',day:'numeric'})+' '+sessionTime(record.startedAt));summary.append(book,stamp,node('span','home-session-record-chars',words(record.typedChars)),node('span','home-icon home-session-chevron','⌄'));item.dataset.sessionId=record.id;item.append(summary,sessionFacts(record,'home-session-record-facts'));list.append(item);}section.append(list);return section;
    }
    function renderTrend(){
      const section=node('section','home-card home-trend'),header=heading('字数趋势'),switcher=node('div','home-range');switcher.setAttribute('role','group');switcher.setAttribute('aria-label',tr('趋势范围'));
      for(const length of[7,30]){const choice=button(tr('近 {0} 天',length),()=>{range=length;paint();});choice.classList.toggle('active',length===range);choice.setAttribute('aria-pressed',String(length===range));switcher.append(choice);}header.append(switcher);section.append(header);
      const days=data.days.slice(-range),total=days.reduce((sum,day)=>sum+day.addedChars,0),summary=node('div','home-trend-summary');summary.append(node('strong',null,words(total)),node('span','home-caption',tr('日均 {0} 字',number(Math.round(total/range)))));section.append(summary);
      const chart=chartPoints(days),ns='http://www.w3.org/2000/svg',svg=doc.createElementNS(ns,'svg');svg.id='home-chart';svg.setAttribute('viewBox','0 0 680 190');svg.setAttribute('class','home-chart');svg.setAttribute('role','img');svg.setAttribute('aria-label',tr('近 {0} 天新增 {1} 字',range,number(total)));
      function shape(tag,attrs){const item=doc.createElementNS(ns,tag);for(const[key,value]of Object.entries(attrs))item.setAttribute(key,value);svg.append(item);return item;}
      for(const y of[36,100,164])shape('line',{x1:24,x2:656,y1:y,y2:y,class:'home-chart-grid'});
      shape('path',{d:chart.line+' L656,164 L24,164 Z',class:'home-chart-area'});shape('path',{d:chart.line,class:'home-chart-line'});
      for(const point of chart.points){const dot=shape('circle',{cx:point.x,cy:point.y,r:range===7?4:2.5,class:'home-chart-dot',tabindex:0,'aria-label':point.date+' · '+words(point.amount)}),title=doc.createElementNS(ns,'title');title.textContent=point.date+' · '+words(point.amount);dot.append(title);}
      section.append(svg);const labels=node('div','home-chart-labels');for(const index of[0,Math.floor((days.length-1)/2),days.length-1])labels.append(node('span',null,dateLabel(days[index].date,{month:'numeric',day:'numeric'})));section.append(labels);return section;
    }
    function renderCalendar(){
      const section=node('section','home-card home-calendar'),header=heading('写作日历'),controls=node('div','home-month-controls'),selected=month||data.today.slice(0,7);section.id='home-calendar';
      const previous=button('上个月',()=>{month=shiftMonth(selected,-1);paint();},'home-icon-button'),next=button('下个月',()=>{month=shiftMonth(selected,1);paint();},'home-icon-button');previous.textContent='‹';next.textContent='›';previous.setAttribute('aria-label',tr('上个月'));next.setAttribute('aria-label',tr('下个月'));previous.disabled=shiftMonth(selected,-1)+'-31'<data.days[0].date;next.disabled=selected>=data.today.slice(0,7);
      controls.append(previous,node('span',null,dateLabel(selected+'-01',{year:'numeric',month:'long'})),next);header.append(controls);section.append(header);
      const grid=node('div','home-calendar-grid'),lookup=new Map(data.days.map(day=>[day.date,day.addedChars]));grid.setAttribute('role','group');grid.setAttribute('aria-label',tr('写作日历'));
      for(const label of['一','二','三','四','五','六','日'])grid.append(node('span','home-weekday',tr(label)));
      for(const stamp of monthGrid(selected)){
        if(!stamp){const blank=node('span','home-calendar-blank');blank.setAttribute('aria-hidden','true');grid.append(blank);continue;}
        const amount=lookup.get(stamp)||0,goal=data.settings.dailyGoal,day=node('div','home-calendar-day',String(Number(stamp.slice(-2))));
        const level=amount?Math.min(4,Math.max(1,Math.ceil(amount/Math.max(1,goal||2000)*4))):0;day.dataset.level=String(level);day.classList.toggle('today',stamp===data.today);day.classList.toggle('future',stamp>data.today);day.classList.toggle('outside-history',stamp<data.days[0].date);
        day.title=stamp+' · '+(stamp<data.days[0].date?tr('暂无记录'):words(amount));day.setAttribute('aria-label',day.title);if(stamp<=data.today&&stamp>=data.days[0].date)day.tabIndex=0;grid.append(day);
      }
      section.append(grid);const footer=node('div','home-calendar-key');footer.append(node('span',null,tr('少')));for(let level=0;level<=4;level++){const swatch=node('i');swatch.dataset.level=String(level);swatch.setAttribute('aria-hidden','true');footer.append(swatch);}footer.append(node('span',null,tr('多')));section.append(footer);return section;
    }
    function renderRecent(){
      const section=node('section','home-recent');section.append(heading('最近作品'));
      if(!data.recentBooks.length){const empty=node('div','home-empty');empty.append(icon('book','▤'),node('p',null,tr('书架还是空的')),button('前往书架',()=>options.navigate?.('shelf'),'secondary-button'));section.append(empty);return section;}
      const list=node('div','home-books');for(const book of data.recentBooks){
        const card=node('article','home-book'),coverButton=button(tr('打开{0}',book.title),()=>openBook(book),'home-cover-button');coverButton.textContent='';coverButton.setAttribute('aria-label',tr('打开{0}',book.title));
        if(book.cover){const image=node('img','home-book-cover');image.src=book.cover;image.alt=tr('{0}封面',book.title);image.loading='lazy';coverButton.append(image);}else{const cover=node('div','home-book-cover home-cover-fallback',book.title);cover.setAttribute('aria-hidden','true');coverButton.append(cover);}
        const content=node('div','home-book-content'),title=button(book.title,()=>openBook(book),'home-book-title');title.textContent=book.title;
        content.append(title,node('p','home-book-meta',tr(book.kind==='long'?'长篇':'短篇')+' · '+words(book.charCount)));
        if(book.latestChapterTitle&&book.kind==='long')content.append(node('p','home-book-chapter',book.latestChapterTitle));
        const resume=button('继续写作',()=>openBook(book),'home-book-resume');resume.dataset.homeBook=book.id;resume.append(node('span',null,' →'));content.append(resume);card.append(coverButton,content);list.append(card);
      }section.append(list);return section;
    }
    async function refresh(force=false){
      if(disposed||!visible())return;if(pending){if(force){sequence++;data=null;lastLoaded=0;pending=null;}else return pending;}
      const current=++sequence;if(force){data=null;error='';paint();}
      pending=(async()=>{try{const result=validate(await options.api('/api/home?localDay='+encodeURIComponent(options.getLocalDay?.()||localDate())));if(disposed||current!==sequence||!visible())return;data=result;lastLoaded=Date.now();month=month&&month>=result.days[0].date.slice(0,7)&&month<=result.today.slice(0,7)?month:null;error='';paint();}catch(problem){if(!disposed&&current===sequence&&visible()){data=null;error=problem.message;paint();}}finally{if(current===sequence)pending=null;}})();return pending;
    }
    function configure(value){options=value||{};disposed=false;}
    function render(target=doc.getElementById('home-view')){if(root!==target){sequence++;pending=null;data=null;}root=target;paint();return refresh(true);}
    function sync(value={}){if(!root)root=doc.getElementById('home-view');if(!visible()){sequence++;pending=null;data=null;lastLoaded=0;editingGoal=false;goalDraft=null;root?.replaceChildren();return;}const force=value===true||value?.force===true;if((editingGoal||goalSaving)&&!force)return;if(force||!data||Date.now()-lastLoaded>5000)return refresh(force);}
    function dispose(){disposed=true;sequence++;pending=null;data=null;goalDraft=null;editingGoal=false;root?.replaceChildren();root=null;}
    function invalidate(){sequence++;pending=null;data=null;lastLoaded=0;root?.replaceChildren();if(visible())return refresh(true);}
    return{configure,render,sync,dispose,invalidate};
  }
})(typeof window==='undefined'?globalThis:window);
