'use strict';

// Pages share their original controls and handlers. Switching categories only
// changes visibility, so a partially entered API key or Skill choice stays put.
let settingsLayoutBound=false,selectedSettingsPage='general';
const settingsPageScroll=new Map(),decoratedSettingsForms=new WeakSet();
function settingsPageButtons(){return Array.from($('settings-nav')?.querySelectorAll('[data-settings-page-target]')||[]);}
function syncSettingsOrientation(){$('settings-nav').setAttribute('aria-orientation',window.innerWidth<=540?'horizontal':'vertical');}
function selectSettingsPage(page=selectedSettingsPage,{focus=false}={}){
  if(state.composing||state.transitioning)return false;
  const buttons=settingsPageButtons(),target=buttons.find(button=>button.dataset.settingsPageTarget===page&&!button.hidden);
  if(!target)return false;
  const content=$('settings-content'),changed=page!==selectedSettingsPage;if(changed){settingsPageScroll.set(selectedSettingsPage,content.scrollTop);selectedSettingsPage=page;}
  for(const button of buttons){const active=button===target;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;button.classList.toggle('active',active);}
  $('settings-dialog').querySelectorAll('[data-settings-page]').forEach(panel=>{panel.hidden=panel.dataset.settingsPage!==page;});
  if(changed)content.scrollTop=settingsPageScroll.get(page)||0;
  if(focus)target.focus();return true;
}
function groupAISettings(section){
  if(decoratedSettingsForms.has(section))return;const body=section.querySelector('.ai-settings-body');if(!body)return;
  const endpoint=$('ai-endpoint'),key=$('ai-api-key'),model=$('ai-model-choice')?.parentElement||$('ai-model'),image=$('ai-image-model'),enabled=$('ai-enabled')?.parentElement;
  if(!endpoint||!key||!model||!image||!enabled)return;
  const parts=control=>{const label=control.previousElementSibling;return label?.classList.contains('field-label')?[label,control]:[control];};
  function group(title,controls){
    const fields=controls.flatMap(parts),wrapper=el('section','settings-form-group'),card=el('div','settings-card');wrapper.append(el('h3','settings-group-label',T(title)),card);body.insertBefore(wrapper,fields[0]);card.append(...fields);
  }
  const enableCard=el('div','settings-card settings-enable-card');body.insertBefore(enableCard,enabled);enableCard.append(enabled);
  group('连接',[endpoint,key]);group('模型',[model,image]);decoratedSettingsForms.add(section);
}
function syncSettingsLayout(){
  if(!settingsLayoutBound)return;
  const updates=$('settings-tab-updates');
  const networkUpdates=typeof window.WriterDesktop?.networkInfo==='function'&&typeof window.WriterDesktop?.networkCheck==='function';
  updates.hidden=!!$('settings-updates').hidden&&!networkUpdates;
  for(const id of ['settings-ai','settings-skills','settings-protection']){
    const section=$(id)?.querySelector('details');if(!section)continue;section.open=true;if(id==='settings-ai')groupAISettings(section);
  }
  if(!selectSettingsPage(selectedSettingsPage))selectSettingsPage('general');
}
function bindSettingsLayout(){
  if(settingsLayoutBound)return;settingsLayoutBound=true;
  syncSettingsOrientation();window.addEventListener('resize',syncSettingsOrientation);
  window.addEventListener('pagehide',()=>window.removeEventListener?.('resize',syncSettingsOrientation),{once:true});
  for(const button of settingsPageButtons()){
    button.addEventListener('click',()=>selectSettingsPage(button.dataset.settingsPageTarget));
    button.addEventListener('keydown',event=>{
      if(event.isComposing||state.composing||state.transitioning)return;
      const buttons=settingsPageButtons().filter(item=>!item.hidden),index=buttons.indexOf(button);
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:['ArrowDown','ArrowRight'].includes(event.key)?(index+1)%buttons.length:['ArrowUp','ArrowLeft'].includes(event.key)?(index-1+buttons.length)%buttons.length:null;
      if(next===null)return;event.preventDefault();selectSettingsPage(buttons[next].dataset.settingsPageTarget,{focus:true});
    });
  }
  if(typeof MutationObserver==='function'){
    const observer=new MutationObserver(syncSettingsLayout);
    for(const id of ['settings-ai','settings-skills','settings-protection'])observer.observe($(id),{childList:true});
    observer.observe($('settings-updates'),{attributes:true,attributeFilter:['hidden']});
    window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
  }
  syncSettingsLayout();
}
