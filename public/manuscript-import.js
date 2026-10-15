'use strict';
(function(global){
  const MAX_FILE_BYTES=12*1024*1024;
  function base64(bytes){let result='';for(let index=0;index<bytes.length;index+=32768)result+=String.fromCharCode(...bytes.subarray(index,index+32768));return btoa(result);}
  async function show(){
    if(state.composing||state.transitioning||!await requireSaved())return;
    const root=el('div','manuscript-import'),fields=el('div','manuscript-import-fields'),file=el('input','text-field'),kind=el('select','text-field'),strategy=el('select','text-field'),encoding=el('select','text-field'),title=el('input','text-field');
    const status=el('p','subtle manuscript-import-status'),warning=el('div','manuscript-import-warnings'),previewArea=el('div','manuscript-import-preview'),buttons=el('div','dialog-actions');
    file.type='file';file.accept='.docx,.txt,.md,.markdown';file.setAttribute('aria-label',T('稿件文件'));title.maxLength=200;title.setAttribute('aria-label',T('作品名称'));title.placeholder=T('默认使用文件名或稿件标题');
    function field(label,input){const row=el('label','manuscript-import-field');row.append(el('span','field-label',T(label)),input);fields.append(row);input.setAttribute('aria-label',T(label));}
    function choices(input,items){for(const [value,label] of items){const option=el('option',null,T(label));option.value=value;input.append(option);}}
    choices(kind,[['long','长篇'],['short','短篇']]);kind.value=state.kind||'long';choices(strategy,[['auto','自动识别'],['chinese','按第几卷、章识别'],['headings','按标题层级识别'],['single','不分章']]);strategy.value='auto';choices(encoding,[['auto','自动识别'],['utf-8','UTF-8'],['utf-16','UTF-16'],['gb18030','GB18030']]);encoding.value='auto';
    field('稿件文件',file);field('作品类型',kind);field('分章策略',strategy);field('文字编码',encoding);field('作品名称',title);
    const previewButton=action(T('预览'),'secondary-button',preview),commitButton=action(T('导入为新作品'),'primary-button',commit);commitButton.disabled=true;
    buttons.append(action(T('取消'),'secondary-button',closeDialog),previewButton,commitButton);root.append(fields,status,warning,previewArea,buttons);showDialog(T('导入稿件'),root);
    let source=null,plan=null,revision=0,readRevision=0,busy=false,edits={volumes:{},chapters:{}},requestId=null;
    const visible=()=>root.isConnected&&$('dialog').open;
    function invalidate(){revision++;plan=null;requestId=null;edits={volumes:{},chapters:{}};commitButton.disabled=true;previewArea.replaceChildren();warning.replaceChildren();status.textContent='';}
    for(const control of [kind,strategy,encoding,title])control.addEventListener('input',()=>{invalidate();strategy.disabled=kind.value==='short';});
    file.addEventListener('change',async()=>{
      invalidate();source=null;const token=++readRevision,selected=file.files?.[0];if(!selected)return;
      if(!/\.(docx|txt|md|markdown)$/i.test(selected.name)||!selected.size||selected.size>MAX_FILE_BYTES){status.textContent=T('请选择不超过 12 MB 的 Word .docx、TXT 或 Markdown 稿件。');return;}
      try{const content=base64(new Uint8Array(await selected.arrayBuffer()));if(!visible()||token!==readRevision)return;source={filename:selected.name,content};encoding.disabled=/\.docx$/i.test(selected.name);status.textContent=T('点击预览确认分卷、章节和正文。');}catch{if(visible()&&token===readRevision)status.textContent=T('无法读取这个稿件，请重新选择。');}
    });
    function payload(){return{...source,kind:kind.value,title:title.value.trim(),options:{strategy:kind.value==='short'?'single':strategy.value,encoding:encoding.value}};}
    async function preview(){
      if(busy||!source||!visible())return;busy=true;previewButton.disabled=commitButton.disabled=true;const token=revision,request=payload();status.textContent=T('正在预览…');
      try{const result=await api('/api/manuscript-import/preview','POST',request);if(!visible()||token!==revision)return;plan={...result,request};edits={volumes:{},chapters:{}};requestId=null;renderPreview();commitButton.disabled=false;}
      catch(error){if(visible()&&token===revision){plan=null;status.textContent=error.message;}}
      finally{busy=false;previewButton.disabled=false;}
    }
    function renderPreview(){
      previewArea.replaceChildren();warning.replaceChildren();for(const message of plan.warnings||[])warning.append(el('p','subtle',T(message)));
      status.textContent=plan.kind==='short'?T('{0} 字 · 连续正文',plan.words.toLocaleString()):T('{0} 卷 · {1} 章 · {2} 字',plan.volumes.length,plan.chapters.length,plan.words.toLocaleString());
      const list=el('div','manuscript-import-list'),reading=el('div','manuscript-import-reading'),body=el('textarea','text-field manuscript-import-body');body.readOnly=true;body.setAttribute('aria-label',T('预览正文'));const heading=el('strong'),words=el('small','subtle');reading.append(heading,words,body);previewArea.append(list,reading);
      function select(chapter){heading.textContent=edits.chapters[chapter.key]||chapter.title;words.textContent=T('{0} 字',chapter.words.toLocaleString());body.value=chapter.body;body.scrollTop=0;}
      function rename(item,type,label){const input=el('input','text-field');input.value=item.title;input.maxLength=200;input.setAttribute('aria-label',T(label)+' '+item.title);input.addEventListener('input',()=>{edits[type][item.key]=input.value;requestId=null;if(type==='chapters'&&body.value===item.body)heading.textContent=input.value;});return input;}
      if(plan.kind==='short'){list.append(el('strong',null,plan.title));select(plan.chapters[0]);return;}
      const groups=[{key:null,title:T('未分卷')},...plan.volumes];
      for(const volume of groups){const chapters=plan.chapters.filter(chapter=>chapter.volumeKey===volume.key);if(!chapters.length&&!volume.key)continue;const group=el('section','manuscript-import-group');if(volume.key)group.append(rename(volume,'volumes','卷名'));else group.append(el('small','subtle',volume.title));
        for(const chapter of chapters){const row=el('div','manuscript-import-chapter');row.append(rename(chapter,'chapters','章节标题'),action(T('查看'),'text-button',()=>select(chapter)));group.append(row);}list.append(group);
      }
      select(plan.chapters[0]);
    }
    async function commit(){
      if(busy||!plan||!visible()||state.composing)return;const sourcePlan=plan,token=revision,selectedEdits=JSON.parse(JSON.stringify(edits));
      for(const values of Object.values(selectedEdits))for(const name of Object.values(values))if(!name.trim()){status.textContent=T('卷名和章节标题不能为空。');return;}
      requestId??=crypto.randomUUID();const request={...sourcePlan.request,sourceHash:sourcePlan.sourceHash,edits:selectedEdits,requestId};busy=true;previewButton.disabled=commitButton.disabled=true;
      try{await transition(async()=>{
        if(!await requireSaved()||!visible()||token!==revision||plan!==sourcePlan)return;
        const result=await api('/api/manuscript-import/commit','POST',request);
        if(!visible()||token!==revision)return;
        setBook(result);state.view='write';state.collection=null;closeDialog();await refreshBooks();renderShell();toast(T('稿件已导入为新作品。'));
      });}catch(error){if(visible())status.textContent=error.message;}
      finally{busy=false;previewButton.disabled=false;if(visible())commitButton.disabled=!plan;}
    }
    strategy.disabled=kind.value==='short';
  }
  global.ManuscriptImport=Object.freeze({show,MAX_FILE_BYTES});
})(window);
