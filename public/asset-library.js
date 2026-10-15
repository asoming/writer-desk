'use strict';
window.WriterAssetLibrary=(()=>{
  const FILE_LIMIT=5*1024*1024;
  const downloadName=(name,mime)=>{const suffix=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','application/pdf':'.pdf'})[mime]||'';return suffix&&!new RegExp(mime==='image/jpeg'?'\\.jpe?g$':suffix.replace('.','\\.')+'$','i').test(name)?name+suffix:name;};
  const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(value);};
  async function show(selectedId){
    const owner=state.book;if(!owner||state.composing||state.transitioning||!await requireSaved()||state.book!==owner)return;
    owner.assetLibrary??={version:1,items:[]};
    const root=el('div','asset-library'),tools=el('div','asset-tools'),search=el('input','text-field'),picker=el('input'),status=el('p','subtle'),layout=el('div','asset-layout'),list=el('div','asset-list'),detail=el('section','asset-detail');
    search.placeholder=T('查找素材');search.setAttribute('aria-label',T('查找素材'));picker.type='file';picker.accept='.png,.jpg,.jpeg,.webp,.pdf';picker.hidden=true;
    let selected=selectedId||owner.assetLibrary.items[0]?.id,busy=false;
    const current=()=>root.isConnected&&$('dialog').open&&state.book===owner;
    const controls=[];
    function button(label,run){const node=action(T(label),'secondary-button',run);node.dataset.uiAction=({'添加文件':'asset-upload','网页摘录':'asset-web','文字资料':'asset-text'})[label];controls.push(node);return node;}
    tools.append(search,button('添加文件',()=>picker.click()),button('网页摘录',()=>addText('web')),button('文字资料',()=>addText('text')),picker);layout.append(list,detail);root.append(tools,status,layout);showDialog(T('素材库'),root);
    function field(label,control){const row=el('label','asset-field');row.append(el('span','field-label',T(label)),control);control.setAttribute('aria-label',T(label));detail.append(row);return control;}
    function changed(item){if(!current())return;item.updatedAt=new Date().toISOString();markDirty();renderList();}
    function renderList(){
      list.replaceChildren();const query=search.value.trim().toLocaleLowerCase();
      for(const item of owner.assetLibrary.items){if(query&&!`${item.name}\n${item.excerpt}`.toLocaleLowerCase().includes(query))continue;
        const row=action('','asset-row'+(item.id===selected?' active':''),()=>{selected=item.id;render();});row.append(el('strong',null,item.name),el('small','subtle',T({image:'图片',pdf:'PDF',web:'网页摘录',text:'文字资料'}[item.kind])));list.append(row);
      }
      if(!list.children.length)list.append(el('p','empty-hint',T('暂无素材')));
    }
    function render(){
      if(!current())return;renderList();detail.replaceChildren();const item=owner.assetLibrary.items.find(asset=>asset.id===selected);if(!item){window.WriterInterfacePolish?.apply(root);return;}
      const name=field('素材名称',el('input','text-field'));name.value=item.name;name.maxLength=200;
      name.addEventListener('change',()=>{if(!current())return;if(!name.value.trim()){name.value=item.name;return;}item.name=name.value.trim();changed(item);});
      if(item.kind==='image'){const image=el('img','asset-image');image.src='data:'+item.mime+';base64,'+item.data;image.alt=item.name;detail.append(image);}
      if(item.kind==='image'||item.kind==='pdf'){
        const download=action(T('下载文件'),'secondary-button',()=>{if(!current())return;const bytes=Uint8Array.from(atob(item.data),char=>char.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:item.mime})),link=el('a');link.href=url;link.download=downloadName(item.name,item.mime);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});download.dataset.uiAction='asset-download';detail.append(download);
      }
      const source=field('来源网址',el('input','text-field'));source.value=item.sourceUrl;source.maxLength=2048;source.type='url';
      const sourceLink=el('a','asset-source',T('打开来源'));sourceLink.dataset.uiAction='asset-source';sourceLink.target='_blank';sourceLink.rel='noopener noreferrer';sourceLink.hidden=!item.sourceUrl;if(item.sourceUrl)sourceLink.href=item.sourceUrl;detail.append(sourceLink);
      source.addEventListener('change',()=>{if(!current())return;try{const value=source.value.trim();if(value){const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error();}else if(item.kind==='web')throw Error();source.setCustomValidity('');item.sourceUrl=value;sourceLink.hidden=!value;if(value)sourceLink.href=value;else sourceLink.removeAttribute('href');changed(item);}catch{source.setCustomValidity(T('请输入 HTTP 或 HTTPS 网址'));source.reportValidity();}});
      const excerpt=field('摘录与说明',el('textarea','text-field'));excerpt.value=item.excerpt;excerpt.maxLength=200000;excerpt.rows=7;excerpt.addEventListener('input',()=>{if(!current())return;item.excerpt=excerpt.value;changed(item);});
      for(const [key,label,entries]of [['chapterIds','关联正文',owner.chapters],['noteIds','关联资料',owner.notes]]){
        const choices=field(label,el('select','text-field'));choices.multiple=true;choices.size=Math.min(4,Math.max(2,entries.length));
        for(const entry of entries){if(entry.deletedAt&&!item[key].includes(entry.id))continue;const option=el('option',null,(owner.kind==='short'&&key==='chapterIds'?T('正文'):entry.title||T('未命名'))+(entry.deletedAt?' · '+T('已回收'):''));option.value=entry.id;option.selected=item[key].includes(entry.id);option.disabled=!!entry.deletedAt;choices.append(option);}
        choices.addEventListener('change',()=>{if(!current())return;item[key]=Array.from(choices.selectedOptions,option=>option.value);changed(item);});
      }
      const remove=action(T('删除素材'),'text-button danger-button',()=>{if(!current())return;owner.assetLibrary.items=owner.assetLibrary.items.filter(asset=>asset.id!==item.id);markDirty();selected=owner.assetLibrary.items[0]?.id;render();});remove.dataset.uiAction='asset-delete';detail.append(remove);window.WriterInterfacePolish?.apply(root);
    }
    async function insert(item){
      if(busy||!current()||state.composing)return;busy=true;controls.forEach(control=>control.disabled=true);
      try{await transition(async()=>{if(!await requireSaved()||!current())return;
        const result=await api('/api/books/'+encodeURIComponent(owner.id)+'/assets/validate','POST',{asset:item,revision:state.revision});if(!current())return;
        owner.assetLibrary.items.push(result.asset);selected=result.asset.id;markDirty();if(!await saveNow())throw Error(T('素材已保留在当前稿，请重试保存。'));status.textContent='';render();
      });}catch(error){if(current())status.textContent=T(error.message);}finally{busy=false;if(current())controls.forEach(control=>control.disabled=false);}
    }
    function record(kind,name){const stamp=new Date().toISOString();return{id:uid(),name,kind,mime:'',data:'',sourceUrl:'',excerpt:'',chapterIds:state.chapterId?[state.chapterId]:[],noteIds:[],createdAt:stamp,updatedAt:stamp};}
    async function addText(kind){
      const item=record(kind,T(kind==='web'?'网页摘录':'文字资料'));
      if(kind==='web'){
        const form=el('form'),url=el('input','text-field'),name=el('input','text-field'),excerpt=el('textarea','text-field'),buttons=el('div','dialog-actions');
        url.type='url';url.required=true;url.placeholder='https://';url.setAttribute('aria-label',T('来源网址'));name.placeholder=T('素材名称');name.maxLength=200;name.setAttribute('aria-label',T('素材名称'));excerpt.placeholder=T('摘录与说明');excerpt.rows=7;excerpt.maxLength=200000;excerpt.setAttribute('aria-label',T('摘录与说明'));
        const add=el('button','primary-button',T('保存'));add.type='submit';buttons.append(action(T('返回'),'secondary-button',()=>show(selected)),add);form.append(name,url,excerpt,buttons);showDialog(T('网页摘录'),form);
        let inserted=false;const formCurrent=()=>form.isConnected&&$('dialog').open&&state.book===owner;
        form.addEventListener('submit',async event=>{event.preventDefault();if(add.disabled||!formCurrent()||state.composing||state.transitioning)return;add.disabled=true;
          try{if(inserted){if(await requireSaved()&&formCurrent())await show(item.id);return;}const parsed=new URL(url.value);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error(T('请输入 HTTP 或 HTTPS 网址'));
            if(!await requireSaved()||!formCurrent())return;Object.assign(item,{name:name.value.trim()||parsed.hostname,sourceUrl:url.value,excerpt:excerpt.value});
            const result=await api('/api/books/'+encodeURIComponent(owner.id)+'/assets/validate','POST',{asset:item,revision:state.revision});if(!formCurrent())return;owner.assetLibrary.items.push(result.asset);inserted=true;markDirty();if(!await saveNow()){if(formCurrent())toast(T('素材已保留在当前稿，请重试保存。'));return;}if(formCurrent())await show(item.id);
          }catch(error){if(formCurrent())toast(T(error.message));}finally{if(formCurrent())add.disabled=false;}
        });return;
      }
      await insert(item);
    }
    async function upload(file){
      if(!file||busy||!current())return;if(!file.size||file.size>FILE_LIMIT){status.textContent=T('单个素材文件不能超过 5 MB');return;}
      const mime=file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf'}[file.name.split('.').pop().toLowerCase()]);
      if(!['image/png','image/jpeg','image/webp','application/pdf'].includes(mime)){status.textContent=T('请选择 PNG、JPEG、WebP 或 PDF 文件');return;}
      try{const bytes=new Uint8Array(await file.arrayBuffer());if(!current())return;const item=record(mime==='application/pdf'?'pdf':'image',file.name);Object.assign(item,{mime,data:encode(bytes)});await insert(item);}catch(error){if(current())status.textContent=T(error.message);}
    }
    picker.addEventListener('change',()=>{const file=picker.files?.[0];picker.value='';upload(file);});search.addEventListener('input',renderList);
    root.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});root.addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();upload(event.dataTransfer.files[0]);}});
    render();
  }
  return Object.freeze({show});
})();
