'use strict';

// Image bytes live in the book's local image store. Conversation preferences
// retain only validated references, never data URLs or external image URLs.
window.WriterChatImages=(()=>{
  const maxImages=4,maxBytes=8*1024*1024,viewers=new Set();
  const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
  const translate=(text,...values)=>typeof T==='function'?T(text,...values):text.replace(/\{(\d+)\}/g,(_,index)=>values[index]??'');
  function baseURL(bookId){
    if(typeof bookId!=='string'||!bookId)return null;
    try{return '/api/books/'+encodeURIComponent(bookId)+'/ai/images';}catch{return null;}
  }
  function validReference(ref,bookId){
    const base=baseURL(bookId);
    return !!(base&&ref&&typeof ref==='object'&&!Array.isArray(ref)&&typeof ref.id==='string'&&/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(ref.id)&&Object.hasOwn(extensions,ref.mime)&&ref.id.endsWith('.'+extensions[ref.mime])&&typeof ref.name==='string'&&ref.name.trim()&&Array.from(ref.name).length<=200&&!/[\u0000-\u001f\u007f]/.test(ref.name)&&ref.url===base+'/'+ref.id&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=maxBytes);
  }
  function normalizeReferences(refs,bookId){
    const normalized=[],seen=new Set();
    if(!Array.isArray(refs))return normalized;
    for(const ref of refs){
      if(!validReference(ref,bookId)||seen.has(ref.id))continue;
      seen.add(ref.id);normalized.push({id:ref.id,name:ref.name,url:ref.url,mime:ref.mime,bytes:ref.bytes});
      if(normalized.length===maxImages)break;
    }
    return normalized;
  }
  function element(tag,className){const node=document.createElement(tag);if(className)node.className=className;return node;}
  function iconButton(symbol,className,label){
    const button=element('button',className);button.type='button';button.textContent=symbol;button.setAttribute('aria-label',label);button.title=label;return button;
  }
  function listen(node,event,handler,cleanup){node.addEventListener(event,handler);cleanup?.push(()=>node.removeEventListener(event,handler));}
  function notifyViewerClosed(){
    const view=document.defaultView||window;
    if(typeof view.dispatchEvent==='function'&&typeof view.CustomEvent==='function')view.dispatchEvent(new view.CustomEvent('writer-chat-image-viewer-closed'));
  }
  function imageNode(ref){
    const image=element('img');image.alt=ref.name;image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';image.src=ref.url;return image;
  }
  function attachComposer({bookId,input,composer,toolbar,initial=[],onChange,onBusy,current=()=>true,onError}){
    let refs=normalizeReferences(initial,bookId),pending=[],disposed=false,generation=0,queue=Promise.resolve(),busy=false;
    const cleanup=[],strip=element('div','ai-chat-attachments'),add=iconButton('＋','ai-chat-attach-button',translate('添加图片')),fileInput=element('input');
    strip.setAttribute('aria-label',translate('附加图片'));fileInput.type='file';fileInput.accept='image/png,image/jpeg,image/webp';fileInput.multiple=true;fileInput.hidden=true;
    composer.insertBefore(strip,input);toolbar.prepend(add);composer.append(fileInput);
    const active=()=>{try{return !disposed&&current()!==false;}catch{return false;}};
    const snapshot=()=>refs.map(ref=>({...ref}));
    function notifyChange(){if(active())onChange?.(snapshot());}
    function notifyError(message){if(active())onError?.(message);}
    function updateBusy(){const next=pending.length>0;if(next!==busy){busy=next;if(!disposed)onBusy?.(next);}}
    function removePending(item){item.cancelled=true;item.reader?.abort();pending=pending.filter(value=>value!==item);}
    function renderStrip(){
      strip.replaceChildren();strip.hidden=!refs.length&&!pending.length;
      for(const ref of refs){
        const tile=element('div','ai-chat-attachment'),image=imageNode(ref),remove=iconButton('×','ai-chat-attachment-remove',translate('移除图片 {0}',ref.name)),error=element('span','ai-chat-image-error');
        error.textContent=translate('图片无法显示');error.hidden=true;
        image.addEventListener('error',()=>{image.hidden=true;error.hidden=false;tile.classList.add('is-error');});
        remove.addEventListener('click',()=>{if(!active())return;refs=refs.filter(value=>value.id!==ref.id);renderStrip();notifyChange();});
        tile.append(image,error,remove);strip.append(tile);
      }
      for(const item of pending){
        const tile=element('div','ai-chat-attachment is-pending'),name=element('span','ai-chat-attachment-pending'),remove=iconButton('×','ai-chat-attachment-remove',translate('移除图片 {0}',item.name));
        tile.setAttribute('aria-busy','true');name.textContent='…';name.title=item.name;name.setAttribute('aria-label',translate('正在添加图片 {0}',item.name));
        remove.addEventListener('click',()=>{if(!active())return;removePending(item);renderStrip();updateBusy();});tile.append(name,remove);strip.append(tile);
      }
    }
    function fileName(file){return Array.from(String(file.name||'image.'+extensions[file.type.toLowerCase()]).replace(/[\u0000-\u001f\u007f]/g,'').trim()).slice(0,200).join('')||'image.'+extensions[file.type.toLowerCase()];}
    function readFile(item){
      return new Promise((resolve,reject)=>{
        const reader=new FileReader();item.reader=reader;reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error(translate('无法读取图片，请重新选择。')));reader.onabort=()=>resolve(null);reader.readAsDataURL(item.file);
      });
    }
    async function upload(item,sequence){
      const live=()=>active()&&sequence===generation&&!item.cancelled;
      if(!live()){if(sequence===generation&&!disposed){pending=pending.filter(value=>value!==item);renderStrip();updateBusy();}return;}
      try{
        const dataUrl=await readFile(item);item.reader=null;if(!live()||!dataUrl)return;
        const response=await api(baseURL(bookId),'POST',{name:item.name,dataUrl});if(!live())return;
        if(!validReference(response,bookId))throw Error(translate('图片保存结果无效，请重试。'));
        if(!refs.some(ref=>ref.id===response.id)){refs=normalizeReferences([...refs,response],bookId);notifyChange();}
      }catch(error){if(live())notifyError(error?.message||translate('图片添加失败，请重试。'));}
      finally{if(sequence===generation&&!disposed){pending=pending.filter(value=>value!==item);renderStrip();updateBusy();}}
    }
    function enqueue(files){
      if(!active())return;
      const accepted=[];
      for(const file of files){
        const mime=typeof file?.type==='string'?file.type.toLowerCase():'';
        if(!Object.hasOwn(extensions,mime)){notifyError(translate('请选择 PNG、JPEG 或 WebP 图片。'));continue;}
        if(!Number.isSafeInteger(file.size)||file.size<1||file.size>maxBytes){notifyError(translate('每张图片须小于或等于 8 MB。'));continue;}
        accepted.push(file);
      }
      const remaining=maxImages-refs.length-pending.length;
      if(accepted.length>remaining)notifyError(translate('每条消息最多添加 4 张图片。'));
      const sequence=generation;
      for(const file of accepted.slice(0,Math.max(0,remaining))){
        const item={file,name:fileName(file),cancelled:false,reader:null};pending.push(item);queue=queue.then(()=>upload(item,sequence));
      }
      renderStrip();updateBusy();
    }
    listen(add,'click',()=>{if(active())fileInput.click();},cleanup);
    listen(fileInput,'change',()=>{const files=Array.from(fileInput.files||[]);fileInput.value='';enqueue(files);},cleanup);
    listen(input,'paste',event=>{
      const files=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(file=>file&&/^image\//i.test(file.type));
      if(!files.length||!active())return;
      // Let the textarea handle mixed clipboard text so selection and undo keep
      // their native behavior. A clipboard containing only images needs no text.
      let text='';try{text=event.clipboardData.getData?.('text/plain')||'';}catch{}
      if(!text)event.preventDefault();enqueue(files);
    },cleanup);
    renderStrip();
    return{
      get:snapshot,
      set(next,{notify=false}={}){
        if(disposed)return;++generation;pending.forEach(removePending);pending=[];queue=Promise.resolve();refs=normalizeReferences(next,bookId);renderStrip();updateBusy();if(notify)notifyChange();
      },
      isBusy:()=>busy,
      dispose(){
        if(disposed)return;++generation;pending.forEach(removePending);pending=[];updateBusy();disposed=true;cleanup.forEach(remove=>remove());strip.remove();add.remove();fileInput.remove();
      }
    };
  }
  function render(container,refs,{bookId}={}){
    let disposed=false,viewer=null;
    const gallery=element('div','ai-chat-image-gallery'),references=normalizeReferences(refs,bookId);
    function closeViewer(){if(viewer){const closing=viewer;viewer=null;viewers.delete(closing);if(closing.open)closing.close();closing.remove();}}
    function openViewer(ref,trigger){
      if(disposed)return;closeViewer();
      const dialog=element('dialog','ai-chat-image-viewer'),bar=element('div','ai-chat-image-viewer-bar'),caption=element('span','ai-chat-image-caption'),close=iconButton('×','ai-chat-image-viewer-close',translate('关闭图片')),image=imageNode(ref),error=element('p','ai-chat-image-error');
      dialog.setAttribute('aria-label',translate('图片预览'));caption.textContent=ref.name;error.textContent=translate('图片无法显示');error.hidden=true;image.loading='eager';
      image.addEventListener('error',()=>{image.hidden=true;error.hidden=false;});bar.append(caption,close);dialog.append(bar,image,error);viewer=dialog;viewers.add(dialog);document.body.append(dialog);
      const dismiss=()=>{if(viewer===dialog)viewer=null;viewers.delete(dialog);if(dialog.open)dialog.close();dialog.remove();if(!disposed&&trigger.isConnected)trigger.focus();};
      close.addEventListener('click',dismiss);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});dialog.addEventListener('close',()=>{if(viewer===dialog)viewer=null;viewers.delete(dialog);dialog.remove();notifyViewerClosed();});dialog.addEventListener('click',event=>{if(event.target===dialog)dismiss();});
      dialog.showModal();close.focus();
    }
    for(const ref of references){
      const button=iconButton('','ai-chat-image-thumbnail',translate('查看图片 {0}',ref.name)),image=imageNode(ref),error=element('span','ai-chat-image-error');
      error.textContent=translate('图片无法显示');error.hidden=true;button.title=ref.name;button.append(image,error);image.addEventListener('error',()=>{image.hidden=true;error.hidden=false;button.classList.add('is-error');});button.addEventListener('click',()=>openViewer(ref,button));gallery.append(button);
    }
    if(references.length)container.append(gallery);
    return{dispose(){if(disposed)return;disposed=true;closeViewer();gallery.remove();}};
  }
  function closeViewers(){for(const dialog of [...viewers]){viewers.delete(dialog);if(dialog.open)dialog.close();dialog.remove();}}
  return{validReference,normalizeReferences,attachComposer,render,closeViewers,viewerOpen:()=>[...viewers].some(dialog=>dialog.open)};
})();
