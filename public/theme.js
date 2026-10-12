'use strict';

// Run in the head so the saved palette is in place before the first paint.
const appearanceKey='writer-desk.appearance';
let appearanceStorage=null,appearanceBound=false;
let appearance={theme:'light',eyeComfort:false};
try{
  appearanceStorage=window.WriterDesktop?.storage||window.localStorage;
  const saved=JSON.parse(appearanceStorage.getItem(appearanceKey));
  if(saved&&typeof saved==='object')appearance={theme:saved.theme==='dark'?'dark':'light',eyeComfort:saved.eyeComfort===true};
}catch{/* Missing or unavailable preferences use the default palette. */}

function applyAppearance(){
  document.documentElement.dataset.theme=appearance.theme;
  document.documentElement.dataset.eyeComfort=String(appearance.eyeComfort);
}
function syncAppearanceControls(){
  const dark=appearance.theme==='dark',button=document.getElementById('theme-toggle');
  if(button){
    const label=T(dark?'切换到白天模式':'切换到黑夜模式');
    button.title=label;button.setAttribute('aria-label',label);
    const icon=document.getElementById('theme-icon');icon.dataset.icon=dark?'moon':'sun';icon.innerHTML=svgIcon(icon.dataset.icon);
  }
  const theme=document.getElementById('settings-theme'),comfort=document.getElementById('eye-comfort');
  if(theme)theme.value=appearance.theme;
  if(comfort){comfort.checked=appearance.eyeComfort;comfort.setAttribute('aria-checked',String(appearance.eyeComfort));}
}
function setAppearance(next){
  if(!next||!['light','dark'].includes(next.theme)||typeof next.eyeComfort!=='boolean')return false;
  appearance={theme:next.theme,eyeComfort:next.eyeComfort};applyAppearance();syncAppearanceControls();
  try{if(!appearanceStorage)throw new Error();appearanceStorage.setItem(appearanceKey,JSON.stringify(appearance));}
  catch{toast(T('外观已切换，但未能保存设置。'));}
  return true;
}
function bindAppearanceEvents(){
  if(appearanceBound)return;appearanceBound=true;syncAppearanceControls();
  document.getElementById('theme-toggle').addEventListener('click',()=>setAppearance({...appearance,theme:appearance.theme==='dark'?'light':'dark'}));
  document.getElementById('settings-theme').addEventListener('change',event=>setAppearance({...appearance,theme:event.target.value}));
  document.getElementById('eye-comfort').addEventListener('change',event=>setAppearance({...appearance,eyeComfort:event.target.checked}));
}
applyAppearance();
