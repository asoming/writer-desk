'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../public/chat-images.js'),'utf8');
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners=new Map();this.attributes={};this.hidden=false;this.open=false;this.className='';this.textContent='';this.classList={add:value=>this.className+=' '+value};}
  get isConnected(){return this.tagName==='BODY'||!!this.parentElement?.isConnected;}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  prepend(...nodes){for(const node of [...nodes].reverse()){node.remove();node.parentElement=this;this.children.unshift(node);}}
  insertBefore(node,reference){node.remove();node.parentElement=this;this.children.splice(this.children.indexOf(reference),0,node);}
  replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(event,handler){if(!this.listeners.has(event))this.listeners.set(event,new Set());this.listeners.get(event).add(handler);}
  removeEventListener(event,handler){this.listeners.get(event)?.delete(handler);}
  emit(event,value={}){for(const handler of [...this.listeners.get(event)||[]])handler(value);}
  click(){this.emit('click',{target:this});}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;this.emit('close');}
}
const nodes=node=>[node,...node.children.flatMap(nodes)];
const find=(node,predicate)=>nodes(node).find(predicate);
const data=value=>JSON.parse(JSON.stringify(value));
function reference(bookId='one',digit='a',extension='png',name='图片.png'){
  const id=digit.repeat(64)+'.'+extension;
  return{id,name,url:'/api/books/'+encodeURIComponent(bookId)+'/ai/images/'+id,mime:{png:'image/png',jpg:'image/jpeg',webp:'image/webp'}[extension],bytes:68};
}
function harness(){
  const h={calls:[],changes:[],busy:[],errors:[],readers:[],events:[],active:true,body:new Element('body')};
  h.response=()=>reference();
  class Reader{
    readAsDataURL(file){this.file=file;h.readers.push(this);if(!h.holdRead)queueMicrotask(()=>this.finish());}
    finish(){this.result='data:'+this.file.type+';base64,cG5n';this.onload?.();}
    abort(){this.aborted=true;this.onabort?.();}
  }
  const context=vm.createContext({console,document:{createElement:tag=>new Element(tag),body:h.body},FileReader:Reader,CustomEvent:class{constructor(type){this.type=type;}},dispatchEvent:event=>h.events.push({type:event.type,viewerOpen:context.WriterChatImages.viewerOpen()}),T:(text,...args)=>text.replace(/\{(\d+)\}/g,(_,index)=>args[index]??''),api:async(url,method,payload)=>{h.calls.push({url,method,payload:data(payload)});return h.response(payload);}});context.window=context;vm.runInContext(source,context,{filename:'chat-images.js'});h.api=context.WriterChatImages;
  h.composer=new Element('div');h.input=new Element('textarea');h.toolbar=new Element('div');h.model=new Element('select');h.toolbar.append(h.model);h.composer.append(h.input,h.toolbar);h.body.append(h.composer);
  h.mount=(initial=[])=>h.controller=h.api.attachComposer({bookId:'one',input:h.input,composer:h.composer,toolbar:h.toolbar,initial,onChange:refs=>h.changes.push(data(refs)),onBusy:value=>h.busy.push(value),onError:value=>h.errors.push(value),current:()=>h.active});
  h.file=(name='photo.png',type='image/png',size=68)=>({name,type,size});
  h.upload=files=>{const input=find(h.composer,node=>node.type==='file');input.files=files;input.emit('change');};
  h.paste=(items,text='')=>{const event={clipboardData:{items,getData:()=>text},prevented:false,preventDefault(){this.prevented=true;}};h.input.emit('paste',event);return event;};
  h.flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
  h.gallery=refs=>{const host=new Element('div');h.body.append(host);const controller=h.api.render(host,refs,{bookId:'one'});return{host,controller};};return h;
}

test('references admit only this book’s validated raster images and strip unrelated data',()=>{
  const h=harness(),valid=reference();assert.equal(h.api.validReference(valid,'one'),true);
  for(const bad of [{...valid,id:'../outside.png'},{...valid,url:'https://example.org/photo.png'},{...valid,url:reference('other').url},{...valid,mime:'image/svg+xml'},{...valid,mime:'image/jpeg'},{...valid,bytes:8*1024*1024+1},{...valid,bytes:0},{...valid,bytes:NaN},{...valid,name:'x\n.png'},{...valid,name:'x'.repeat(201)},{...valid,id:'A'.repeat(64)+'.png'}])assert.equal(h.api.validReference(bad,'one'),false);
  assert.deepEqual(data(h.api.normalizeReferences([{...valid,dataUrl:'secret bytes',html:'<img>'},valid,null,reference('other')],'one')),[valid]);
  const unusual=reference("书籍 !'()*");assert.equal(h.api.validReference(unusual,"书籍 !'()*"),true);assert.equal(h.api.validReference(valid,'\ud800'),false);
  assert.equal(h.api.normalizeReferences('not an array','one').length,0);
});

test('composer opens a local file picker, saves a validated image and does not emit initial callbacks',async()=>{
  const h=harness();h.mount();assert.deepEqual(h.changes,[]);assert.deepEqual(h.busy,[]);assert.equal(h.calls.length,0);const add=h.toolbar.children[0],file=find(h.composer,node=>node.type==='file');assert.equal(add.textContent,'＋');assert.equal(add.attributes['aria-label'],'添加图片');assert.equal(h.toolbar.children[1],h.model);assert.equal(file.accept,'image/png,image/jpeg,image/webp');assert.equal(file.multiple,true);assert.equal(file.hidden,true);
  let clicked=false;file.addEventListener('click',()=>clicked=true);add.click();assert.equal(clicked,true);h.upload([h.file()]);assert.equal(h.controller.isBusy(),true);await h.flush();assert.deepEqual(h.busy,[true,false]);assert.deepEqual(h.changes,[[reference()]]);assert.deepEqual(h.calls,[{url:'/api/books/one/ai/images',method:'POST',payload:{name:'photo.png',dataUrl:'data:image/png;base64,cG5n'}}]);assert.equal(h.controller.get()[0].url,reference().url);
  const copy=h.controller.get();copy[0].name='changed';assert.equal(h.controller.get()[0].name,'图片.png');assert.ok(find(h.composer,node=>node.tagName==='IMG'&&node.src===reference().url));
});

test('uploads reject non-raster and oversized files and reserve four places across overlapping batches',async()=>{
  const h=harness();h.holdRead=true;h.mount();h.upload([h.file('bad.svg','image/svg+xml'),h.file('huge.png','image/png',8*1024*1024+1),h.file('empty.jpg','image/jpeg',0),h.file('one.png'),h.file('two.jpg','image/jpeg')]);h.upload([h.file('three.webp','image/webp'),h.file('four.png'),h.file('five.png')]);await h.flush();assert.equal(h.readers.length,1);assert.equal(h.controller.isBusy(),true);assert.ok(h.errors.includes('请选择 PNG、JPEG 或 WebP 图片。'));assert.ok(h.errors.includes('每张图片须小于或等于 8 MB。'));assert.ok(h.errors.includes('每条消息最多添加 4 张图片。'));
  h.response=payload=>reference('one',String.fromCharCode(97+h.calls.length-1),payload.name.endsWith('.jpg')?'jpg':payload.name.endsWith('.webp')?'webp':'png',payload.name);
  for(let i=0;i<4;i++){h.readers[i].finish();await h.flush();}assert.equal(h.calls.length,4);assert.deepEqual(data(h.controller.get()).map(ref=>ref.name),['one.png','two.jpg','three.webp','four.png']);assert.equal(h.controller.isBusy(),false);assert.equal(h.controller.get().length,4);
});

test('text pastes retain browser behavior while clipboard images enter only the local store',async()=>{
  const h=harness();h.mount();assert.equal(h.paste([{kind:'string',type:'text/plain'}]).prevented,false);assert.equal(h.paste([{kind:'file',getAsFile:()=>h.file('readme.txt','text/plain')}]).prevented,false);assert.equal(h.paste([{kind:'file',getAsFile:()=>null}]).prevented,false);assert.equal(h.calls.length,0);
  assert.equal(h.paste([{kind:'string',type:'text/plain'},{kind:'file',getAsFile:()=>h.file('clipboard.png')}]).prevented,true);await h.flush();assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/books/one/ai/images');assert.equal(h.controller.get().length,1);
  h.input.value='已有提示词';assert.equal(h.paste([{kind:'string',type:'text/plain'},{kind:'file',getAsFile:()=>h.file('mixed.png')}],'保留同次粘贴的文字').prevented,false);assert.equal(h.input.value,'已有提示词');await h.flush();assert.equal(h.calls.length,2);
});

test('read and network failures leave a usable composer and never accept unsafe server references',async()=>{
  const h=harness();h.holdRead=true;h.mount();h.upload([h.file()]);await h.flush();h.readers[0].onerror();await h.flush();assert.equal(h.controller.isBusy(),false);assert.equal(h.errors[0],'无法读取图片，请重新选择。');assert.equal(h.calls.length,0);
  h.holdRead=false;h.response=()=>({...reference(),url:'https://example.org/evil.png'});h.upload([h.file()]);await h.flush();assert.equal(h.controller.get().length,0);assert.equal(h.errors.at(-1),'图片保存结果无效，请重试。');assert.equal(h.controller.isBusy(),false);
  h.response=()=>{throw Error('本机保存失败');};h.upload([h.file()]);await h.flush();assert.equal(h.errors.at(-1),'本机保存失败');assert.equal(h.controller.isBusy(),false);
});

test('removing saved and queued images updates references and releases reserved places',async()=>{
  const h=harness();h.holdRead=true;h.mount([reference()]);h.upload([h.file('pending.png'),h.file('queued.jpg','image/jpeg')]);await h.flush();const buttons=nodes(h.composer).filter(node=>node.className==='ai-chat-attachment-remove');buttons[2].click();buttons[1].click();assert.equal(h.readers[0].aborted,true);await h.flush();assert.equal(h.calls.length,0);assert.equal(h.controller.isBusy(),false);
  nodes(h.composer).find(node=>node.className==='ai-chat-attachment-remove').click();assert.deepEqual(data(h.controller.get()),[]);assert.deepEqual(h.changes,[[]]);assert.equal(find(h.composer,node=>node.className==='ai-chat-attachments').hidden,true);
});

test('late image reads and uploads cannot cross book changes, resets or disposal',async()=>{
  for(const mode of ['book','set','dispose']){
    const h=harness();h.mount();let finish;h.response=()=>new Promise(resolve=>finish=()=>resolve(reference()));h.upload([h.file()]);await h.flush();assert.equal(h.calls.length,1);
    if(mode==='book')h.active=false;if(mode==='set')h.controller.set([reference('one','b')]);if(mode==='dispose')h.controller.dispose();finish();await h.flush();assert.equal(h.changes.length,0);assert.equal(h.errors.length,0);assert.equal(h.controller.isBusy(),false);assert.deepEqual(data(h.controller.get()),mode==='set'?[reference('one','b')]:[]);
    if(mode==='dispose'){assert.equal(nodes(h.composer).some(node=>node.type==='file'),false);h.paste([{kind:'file',getAsFile:()=>h.file()}]);assert.equal(h.calls.length,1);}
  }
  const h=harness();h.holdRead=true;h.mount();h.upload([h.file()]);await h.flush();h.controller.set([]);assert.equal(h.readers[0].aborted,true);h.readers[0].finish();await h.flush();assert.equal(h.calls.length,0);assert.deepEqual(h.busy,[true,false]);
  const switched=harness();switched.holdRead=true;switched.mount();switched.upload([switched.file('reading.png'),switched.file('queued.png')]);await switched.flush();switched.active=false;switched.readers[0].finish();await switched.flush();assert.equal(switched.calls.length,0);assert.equal(switched.readers.length,1);assert.equal(switched.controller.isBusy(),false);assert.deepEqual(switched.changes,[]);
});

test('programmatic draft restoration is silent unless notified and preserves only four safe references',()=>{
  const h=harness();h.mount([reference()]);h.controller.set([reference('one','b'),reference('other')]);assert.deepEqual(h.changes,[]);assert.deepEqual(data(h.controller.get()),[reference('one','b')]);h.controller.set([reference('one','c')],{notify:true});assert.deepEqual(h.changes,[[reference('one','c')]]);h.controller.set(['bad',...['a','b','c','d','e'].map(digit=>reference('one',digit))]);assert.equal(h.controller.get().length,4);
});

test('gallery renders safe local images and escaped captions with an independent dismissible viewer',()=>{
  const h=harness(),ref=reference('one','a','png','<img src=x onerror=alert(1)>.png'),{host,controller}=h.gallery([ref,{...ref,url:'https://example.org/x.png'}]);const button=find(host,node=>node.tagName==='BUTTON'),image=find(host,node=>node.tagName==='IMG');assert.equal(nodes(host).filter(node=>node.tagName==='IMG').length,1);assert.equal(image.src,ref.url);assert.equal(image.alt,ref.name);assert.equal(image.referrerPolicy,'no-referrer');assert.equal(button.attributes['aria-label'],'查看图片 '+ref.name);
  button.click();assert.equal(h.api.viewerOpen(),true);let dialog=find(h.body,node=>node.tagName==='DIALOG');assert.equal(dialog.attributes['aria-label'],'图片预览');assert.equal(find(dialog,node=>node.className==='ai-chat-image-caption').textContent,ref.name);assert.equal(find(dialog,node=>node.className==='ai-chat-image-caption').children.length,0);assert.equal(dialog.parentElement,h.body);
  let prevented=false;dialog.emit('cancel',{preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(dialog.parentElement,null);assert.equal(h.api.viewerOpen(),false);assert.equal(button.focused,true);
  button.click();dialog=find(h.body,node=>node.tagName==='DIALOG');dialog.emit('click',{target:dialog});assert.equal(h.api.viewerOpen(),false);button.click();controller.dispose();assert.equal(h.api.viewerOpen(),false);assert.equal(host.children.length,0);button.click();assert.equal(h.api.viewerOpen(),false);
});

test('broken images expose a readable state and global viewer cleanup covers multiple galleries',()=>{
  const h=harness(),first=h.gallery([reference()]),second=h.gallery([reference('one','b')]);const image=find(first.host,node=>node.tagName==='IMG');image.emit('error');assert.equal(image.hidden,true);assert.equal(find(first.host,node=>node.className==='ai-chat-image-error').hidden,false);assert.match(find(first.host,node=>node.tagName==='BUTTON').className,/is-error/);
  find(first.host,node=>node.tagName==='BUTTON').click();find(second.host,node=>node.tagName==='BUTTON').click();assert.equal(nodes(h.body).filter(node=>node.tagName==='DIALOG').length,2);h.api.closeViewers();assert.equal(h.api.viewerOpen(),false);assert.equal(nodes(h.body).filter(node=>node.tagName==='DIALOG').length,0);assert.equal(nodes(first.host).filter(node=>node.tagName==='IMG').length,1);
});

test('viewer closure notifies deferred conversation rendering after modal state is cleared',()=>{
  const h=harness(),{host,controller}=h.gallery([reference()]),button=find(host,node=>node.tagName==='BUTTON');
  button.click();find(h.body,node=>node.tagName==='DIALOG').emit('cancel',{preventDefault(){}});assert.deepEqual(h.events,[{type:'writer-chat-image-viewer-closed',viewerOpen:false}]);
  button.click();controller.dispose();assert.deepEqual(h.events,[{type:'writer-chat-image-viewer-closed',viewerOpen:false},{type:'writer-chat-image-viewer-closed',viewerOpen:false}]);controller.dispose();assert.equal(h.events.length,2);
  const another=h.gallery([reference('one','b')]);find(another.host,node=>node.tagName==='BUTTON').click();h.api.closeViewers();assert.equal(h.events.length,3);assert.equal(h.events[2].viewerOpen,false);h.api.closeViewers();assert.equal(h.events.length,3);
});
