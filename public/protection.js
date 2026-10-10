'use strict';

function protectionDate(value){return new Date(value).toLocaleString(uiLanguage==='en'?'en-GB':'zh-CN');}
function protectionVersion(item){return T('版本 {0}',item.revision)+' · '+protectionDate(item.savedAt);}
function protectionInfo(item){return T('{0} 章 · {1} 字',item.chapterCount,item.charCount.toLocaleString());}
function protectionReason(item){return T(({automatic:'自动备份',manual:'手动备份','before-restore':'恢复前备份'})[item.reason]||'历史版本');}

async function showHistory(bookId=state.book?.id){
  if(!bookId){toast(T('请先从书架打开一本书。'));return;}
  if(state.transitioning||state.composing)return;
  if(!await requireSaved())return;
  if($('settings-dialog')?.open)closeAppSettings();
  const content=el('div','protection-browser'),loading=el('p','empty-hint',T('正在读取版本…'));
  content.append(loading);showDialog(T('历史与备份'),content);
  const visible=()=>content.isConnected&&$('dialog').open;
  try{
    const [current,history,backups]=await Promise.all([
      api('/api/books/'+encodeURIComponent(bookId)),
      api('/api/books/'+encodeURIComponent(bookId)+'/history'),
      api('/api/books/'+encodeURIComponent(bookId)+'/backups')]);
    if(!visible())return;
    const list=el('div','protection-version-list'),preview=el('div','protection-preview'),heading=el('div','protection-heading');let previewRequest=0;
    heading.append(el('strong',null,current.book.title),action(T('立即备份'),'secondary-button',async event=>{
      const button=event.currentTarget;if(button.disabled)return;button.disabled=true;
      try{if(!await requireSaved())return;await api('/api/books/'+encodeURIComponent(bookId)+'/checkpoint','POST',{});toast(T('备份已保存。'));await showHistory(bookId);}catch(error){toast(error.message);}finally{button.disabled=false;}
    }));
    content.replaceChildren(heading,list,preview);
    function addGroup(title,items,kind){
      const group=el('section','protection-version-group');group.append(el('h3',null,title));
      if(!items.length)group.append(el('p','empty-hint',T('暂无记录。')));
      items.forEach(item=>{
        const row=action('','protection-version',async()=>{
          const request=++previewRequest;
          const path='/api/books/'+encodeURIComponent(bookId)+'/'+kind+'/'+encodeURIComponent(kind==='history'?item.revision:item.token);
          try{const snapshot=await api(path);if(!visible()||request!==previewRequest)return;renderPreview(snapshot,path);}catch(error){if(request===previewRequest)toast(error.message);}
        });
        row.append(el('strong',null,protectionVersion(item)),el('small',null,(kind==='backups'?protectionReason(item)+' · ':'')+protectionInfo(item)));group.append(row);
      });list.append(group);
    }
    function renderPreview(snapshot,path){
      const heading=el('div','protection-heading'),selector=el('select','text-field'),body=el('textarea','text-field protection-prose');
      body.readOnly=true;body.setAttribute('aria-label',T('版本正文预览'));
      const active=snapshot.book.chapters.filter(chapter=>!chapter.deletedAt),volumeIds=new Set(snapshot.book.volumes.filter(volume=>!volume.deletedAt).map(volume=>volume.id));
      const chapters=snapshot.book.kind==='short'?active:[...snapshot.book.volumes.filter(volume=>!volume.deletedAt).flatMap(volume=>active.filter(chapter=>chapter.volumeId===volume.id)),...active.filter(chapter=>!volumeIds.has(chapter.volumeId))];
      chapters.forEach(chapter=>{const option=el('option',null,chapter.title||T('未命名章节'));option.value=chapter.id;selector.append(option);});
      const showChapter=()=>{body.value=chapters.find(chapter=>chapter.id===selector.value)?.body||'';};
      selector.setAttribute('aria-label',T('预览章节'));selector.addEventListener('change',showChapter);selector.value=chapters[0]?.id||'';selector.hidden=!chapters.length;showChapter();
      const restore=action(T('恢复此版本'),'primary-button',async()=>{
        if(restore.disabled)return;restore.disabled=true;
        try{
          if(!await requireSaved())return;
          const expected=state.book?.id===bookId?state.revision:current.revision;
          const result=await api(path+'/restore','POST',{revision:expected});
          if(state.book?.id===bookId){const view=state.view;setBook(result);state.view=view;renderShell();}
          await refreshBooks();
          renderShell();
          if(result.folderWarning)toast(T(result.folderWarning));else toast(T('已恢复，恢复前的内容也已保留。'));
          await showHistory(bookId);
        }catch(error){toast(error.message);}finally{restore.disabled=false;}
      });
      heading.append(el('strong',null,protectionVersion(snapshot)),restore);
      const plans=el('details','protection-plans');plans.append(el('summary',null,T('大纲与人物预览')));
      const planText=el('div','protection-plan-text');
      snapshot.book.outline.filter(item=>!item.deletedAt).forEach(item=>planText.append(el('h4',null,item.title),el('p',null,item.body)));
      snapshot.book.notes.filter(item=>!item.deletedAt&&item.type==='人物').forEach(item=>planText.append(el('h4',null,item.title),el('p',null,item.body)));plans.append(planText);
      preview.replaceChildren(heading,el('p','subtle',T('恢复前会先保留当前版本。')),selector,body,plans);body.hidden=!chapters.length;
    }
    addGroup(T('历史版本'),history.versions,'history');addGroup(T('本机备份'),backups.backups,'backups');
    preview.append(el('p','empty-hint',T('选择一个版本查看内容，再决定是否恢复。')));
  }catch(error){if(visible())content.replaceChildren(el('p','empty-hint',error.message));}
}

function appendProtectionSettings(content){
  const section=el('details','settings-section protection-settings'),summary=el('summary',null,T('数据保护'));
  const form=el('form','protection-settings-form'),enabled=el('input'),interval=el('input','text-field'),retention=el('input','text-field'),status=el('p','subtle');
  enabled.type='checkbox';enabled.checked=true;enabled.id='protection-enabled';interval.id='protection-interval';interval.type='number';interval.min='1';interval.max='1440';interval.value='5';retention.id='protection-retention';retention.type='number';retention.min='1';retention.max='100';retention.value='20';
  const toggle=el('label','checkbox-row');toggle.append(enabled,el('span',null,T('自动备份')));form.append(toggle);
  addField(form,T('备份间隔（分钟）'),interval);addField(form,T('每部作品保留份数'),retention);
  form.append(el('p','subtle',T('保存后按间隔备份。历史版本保留最近 30 次保存。')));
  const buttons=el('div','dialog-actions'),save=el('button','secondary-button',T('保存备份设置'));save.type='submit';
  buttons.append(action(T('历史与备份'),'secondary-button',()=>showHistory()),save);form.append(buttons,status);section.append(summary,form);content.append(section);
  function apply(value){enabled.checked=value.enabled;interval.value=String(value.intervalMinutes);retention.value=String(value.retentionCount);}
  form.inert=true;api('/api/protection/settings').then(result=>{if(section.isConnected)apply(result.settings);}).catch(error=>{status.textContent=error.message;}).finally(()=>{form.inert=false;});
  form.addEventListener('submit',async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;try{
    const result=await api('/api/protection/settings','PUT',{enabled:enabled.checked,intervalMinutes:Number(interval.value),retentionCount:Number(retention.value)});
    apply(result.settings);status.textContent=T('备份设置已保存。');
  }catch(error){status.textContent=error.message;}finally{save.disabled=false;}});
  return section;
}
