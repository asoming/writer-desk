'use strict';

// Rendering happens from the last saved book on the local service. This pane
// accepts one book ID, never another book's cached prose or arbitrary HTML.
window.WriterFormattedExport=(()=>{
  let busy=false;
  const label=value=>typeof T==='function'?T(value):value;
  function select(items,value){const node=el('select','dialog-input');for(const [text,key]of items){const option=el('option',null,label(text));option.value=String(key);node.append(option);}node.value=String(value);return node;}
  async function normalizeCover(book){
    if(!book.cover?.startsWith('data:image/webp;base64,'))return undefined;
    const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error(label('封面图片无法读取，请更换封面后重试。')));image.src=book.cover;});
    if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>100000000)throw new Error(label('封面图片无法读取，请更换封面后重试。'));
    const scale=Math.min(1,1200/image.naturalWidth,1600/image.naturalHeight),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    // JPEG remains a core format for Word and EPUB readers. The app's cover
    // itself is not changed, and no image ever leaves this local service.
    const value=canvas.toDataURL('image/jpeg',.88);if(value.length>2*1024*1024)throw new Error(label('转换后的封面过大，请使用较小的图片。'));return value;
  }
  async function request(book,format,options){
    const response=await fetch('/api/books/'+encodeURIComponent(book.id)+'/export-formatted',{method:'POST',headers:{'Content-Type':'application/json','X-Writer-Client':'1'},body:JSON.stringify({format,...options})});
    if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(label(error?.error||'暂时无法导出，请重试。'));}
    return response;
  }
  async function printHTML(content,book,options){
    const parsed=new DOMParser().parseFromString(content,'text/html'),manuscript=parsed.querySelector('.formatted-book'),style=parsed.getElementById('formatted-book-styles');
    if(!manuscript||!style||parsed.querySelector('script,iframe,object,embed,link')||manuscript.querySelector('[onload],[onerror]'))throw new Error(label('排版内容无法读取，请重试。'));
    const root=document.createElement('div'),sheet=document.createElement('style');root.id='formatted-print-root';root.dataset.writerExport='book';root.append(document.importNode(manuscript,true));sheet.id='formatted-print-styles';sheet.textContent=style.textContent;
    document.body.append(root);document.head.append(sheet);document.body.classList.add('formatted-printing');
    const cleanup=()=>{root.remove();sheet.remove();document.body.classList.remove('formatted-printing');};
    try{
      await document.fonts?.ready;
      await Promise.all(Array.from(root.querySelectorAll('img')).map(image=>image.decode?.().catch(()=>{})||Promise.resolve()));
      if(window.WriterDesktop?.printBookPDF){const result=await window.WriterDesktop.printBookPDF({title:book.title,paper:options.paper,...(options.paper==='custom'?{pageWidth:options.pageWidth,pageHeight:options.pageHeight}:{})});if(!result.canceled)toast(label('PDF 已导出。'));return;}
      // Browser edition uses the platform's print dialog; choose Save as PDF.
      await new Promise(resolve=>{const done=()=>{window.removeEventListener('afterprint',done);resolve();};window.addEventListener('afterprint',done,{once:true});try{window.print();}catch(error){window.removeEventListener('afterprint',done);throw error;}});
    }finally{cleanup();}
  }
  async function show(book){
    if(!book?.id||busy)return;
    const targetId=book.id,body=el('form','formatted-export-options'),grid=el('div','formatted-export-fields');
    const defaults={paper:'a4',pageWidth:210,pageHeight:297,font:12,fontFamily:'Noto Serif CJK SC',marginTop:20,marginRight:20,marginBottom:20,marginLeft:20,lineHeight:1.8,firstLineIndent:0,paragraphSpace:6,chapterSize:18,chapterAlign:'left',chapterBold:true,chapterPageBreak:true};
    const format=select([['Word 文档','docx'],['EPUB 电子书','epub'],['PDF 文档','pdf']],'docx'),template=select([],''),templateName=el('input','dialog-input'),fields={},status=el('p','dialog-description'),preview=el('iframe','formatted-export-preview');
    template.setAttribute('aria-label',label('排版模板'));templateName.maxLength=100;templateName.setAttribute('aria-label',label('模板名称'));preview.title=label('排版预览');preview.setAttribute('sandbox','');preview.hidden=true;
    function field(text,input){const node=el('label','formatted-export-field');node.append(el('span',null,label(text)),input);return node;}
    function number(key,text,min,max,step=1){const input=el('input','dialog-input');input.type='number';input.min=min;input.max=max;input.step=step;input.setAttribute('aria-label',label(text));fields[key]=input;return field(text,input);}
    fields.paper=select([['A4','a4'],['A5','a5'],['Letter','letter'],['自定义纸张','custom']],'a4');
    fields.fontFamily=select(['Noto Serif CJK SC','Noto Sans CJK SC','Songti SC','SimSun','Georgia','Arial','Times New Roman'].map(name=>[name,name]),defaults.fontFamily);
    fields.chapterAlign=select([['左对齐','left'],['居中','center']],'left');
    grid.append(field('格式',format),field('纸张',fields.paper),field('字体',fields.fontFamily),number('font','字号',8,36,.5),number('lineHeight','行距',1,3,.1),number('firstLineIndent','首行缩进（字）',0,4,.5),number('paragraphSpace','段后间距（pt）',0,24,.5),number('chapterSize','章标题字号',12,40,.5),field('标题对齐',fields.chapterAlign));
    const pageGrid=el('div','formatted-export-fields'),widthField=number('pageWidth','纸张宽度（mm）',100,320,.1),heightField=number('pageHeight','纸张高度（mm）',140,450,.1);pageGrid.append(widthField,heightField,...['Top','Right','Bottom','Left'].map((side,index)=>number('margin'+side,['上边距（mm）','右边距（mm）','下边距（mm）','左边距（mm）'][index],5,50,.5)));
    const cover=el('input'),toc=el('input');cover.type=toc.type='checkbox';cover.checked=toc.checked=true;
    const checks=el('div','formatted-export-checks');checks.append(field('包含封面',cover));if(book.kind==='long')checks.append(field('包含目录',toc));else toc.checked=false;
    for(const [key,text] of [['chapterBold','标题加粗'],['chapterPageBreak','章节另起一页']]){fields[key]=el('input');fields[key].type='checkbox';checks.append(field(text,fields[key]));}
    const templateRow=el('div','formatted-export-template-row'),templateButtons=el('div','formatted-export-template-actions'),saveTemplate=action(label('保存模板'),'secondary-button',()=>saveLayout(false)),saveCopy=action(label('另存模板'),'text-button',()=>saveLayout(true)),removeTemplate=action(label('删除模板'),'text-button',deleteLayout);templateRow.append(field('排版模板',template),field('模板名称',templateName));templateButtons.append(saveTemplate,saveCopy,removeTemplate);
    const hint=el('p','dialog-description'),buttons=el('div','dialog-actions'),submit=el('button','primary-button',label('导出')),previewButton=action(label('预览'),'secondary-button',showPreview);submit.type='submit';buttons.append(action(label('取消'),'secondary-button',closeDialog),previewButton,submit);body.append(templateRow,templateButtons,status,grid,pageGrid,checks,hint,preview,buttons);
    let templates=[],templateReady=false,templateBusy=false,previewSeq=0;
    const visible=()=>$('dialog').open&&$('dialog-body').contains(body);
    const current=()=>visible();
    function layout(){return Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value]));}
    function fill(value){for(const [key,input]of Object.entries(fields)){const value_=value[key]??defaults[key];if(input.type==='checkbox')input.checked=value_;else input.value=value_;}update();}
    function renderTemplates(selected=template.value){template.replaceChildren();for(const item of templates){const option=el('option',null,label(item.name));option.value=item.id;template.append(option);}const custom=el('option',null,label('自定义排版'));custom.value='';template.append(custom);template.value=templates.some(item=>item.id===selected)?selected:'';templateName.value=templates.find(item=>item.id===template.value)?.name||label('我的排版');controls();}
    function controls(){saveTemplate.disabled=saveCopy.disabled=removeTemplate.disabled=!templateReady||templateBusy||busy;removeTemplate.disabled||=!template.value;}
    function update(){const custom=fields.paper.value==='custom';widthField.hidden=heightField.hidden=!custom;pageGrid.hidden=format.value==='epub';hint.textContent=format.value==='pdf'&&!window.WriterDesktop?.printBookPDF?label('浏览器版会打开打印窗口，请选择另存为 PDF。'):'';hint.hidden=!hint.textContent;preview.hidden=true;++previewSeq;}
    async function saveLayout(copy){if(!templateReady||templateBusy||!current())return;const name=templateName.value.trim();if(!name){toast(label('请填写模板名称。'));return;}const id=copy||!template.value?uid():template.value,next={id,name,layout:layout()},value={version:1,templates:templates.some(item=>item.id===id)?templates.map(item=>item.id===id?next:item):[...templates,next]};templateBusy=true;controls();try{const saved=await api('/api/export-templates','PUT',value);if(!current())return;templates=saved.templates;renderTemplates(id);status.textContent=label('排版模板已保存。');}catch(error){if(current())status.textContent=error.message;}finally{templateBusy=false;if(current())controls();}}
    async function deleteLayout(){if(!template.value||templateBusy||!current())return;const id=template.value;templateBusy=true;controls();try{const saved=await api('/api/export-templates','PUT',{version:1,templates:templates.filter(item=>item.id!==id)});if(!current())return;templates=saved.templates;renderTemplates('');status.textContent=label('排版模板已删除。');}catch(error){if(current())status.textContent=error.message;}finally{templateBusy=false;if(current())controls();}}
    function options(){return{...layout(),cover:cover.checked,toc:toc.checked,lang:typeof uiLanguage!=='undefined'&&uiLanguage==='en'?'en':'zh'};}
    async function savedBook(){if(!await requireSaved()||!current())return null;const record=await api('/api/books/'+encodeURIComponent(targetId));if(!current())return null;if(record.book?.id!==targetId)throw new Error(label('作品与目标不匹配，请重试。'));return record.book;}
    async function showPreview(){if(busy||!current())return;const sequence=++previewSeq;previewButton.disabled=true;try{const record=await savedBook();if(!record)return;const opts=options();if(opts.cover)opts.coverData=await normalizeCover(record);const response=await request(record,'html',opts),text=await response.text();if(sequence!==previewSeq||!current())return;preview.srcdoc=text.replace('<main class="formatted-book">','<main id="formatted-print-root" class="formatted-book">');preview.hidden=false;}catch(error){if(current())toast(error.message);}finally{if(current())previewButton.disabled=false;}}
    format.addEventListener('change',update);Object.values(fields).forEach(input=>input.addEventListener('change',update));template.addEventListener('change',()=>{const chosen=templates.find(item=>item.id===template.value);if(chosen){templateName.value=chosen.name;fill(chosen.layout);}controls();});
    fill(defaults);try{const saved=JSON.parse(clientStorage.getItem('writer-desk:export-layout:'+targetId)||'null');if(saved&&typeof saved==='object'&&!Array.isArray(saved))fill({...defaults,...saved});}catch{}
    body.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!current())return;busy=true;submit.disabled=true;controls();
      try{await transition(async()=>{
        const record=await savedBook();if(!record)return;const opts=options();if(opts.cover)opts.coverData=await normalizeCover(record);
        const chosen=format.value,response=await request(record,chosen==='pdf'?'html':chosen,opts);if(!current())return;
        try{clientStorage.setItem('writer-desk:export-layout:'+targetId,JSON.stringify(layout()));}catch{}
        if(chosen==='pdf')await printHTML(await response.text(),record,opts);
        else{const blob=await response.blob();if(!current())return;download(filename('.'+chosen,record),blob,blob.type);toast(label('排版文档已导出。'));}
      });}catch(error){if(current())toast(error.message);}finally{busy=false;submit.disabled=false;if(current())controls();}
    });
    showDialog(T('排版导出 · {0}',book.title),body);controls();
    try{const value=await api('/api/export-templates');if(!current())return;templates=value.templates;templateReady=true;renderTemplates('');}catch(error){if(current())status.textContent=error.message;}
  }
  return Object.freeze({show,printHTML});
})();
function showFormattedExport(book){return window.WriterFormattedExport.show(book);}
