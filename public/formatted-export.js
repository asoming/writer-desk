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
      if(window.WriterDesktop?.printBookPDF){const result=await window.WriterDesktop.printBookPDF({title:book.title,paper:options.paper});if(!result.canceled)toast(label('PDF 已导出。'));return;}
      // Browser edition uses the platform's print dialog; choose Save as PDF.
      await new Promise(resolve=>{const done=()=>{window.removeEventListener('afterprint',done);resolve();};window.addEventListener('afterprint',done,{once:true});try{window.print();}catch(error){window.removeEventListener('afterprint',done);throw error;}});
    }finally{cleanup();}
  }
  function show(book){
    if(!book?.id||busy)return;
    const targetId=book.id,body=el('form','formatted-export-options'),grid=el('div','formatted-export-fields');
    const format=select([['Word 文档','docx'],['EPUB 电子书','epub'],['PDF 文档','pdf']],'docx'),paper=select([['A4','a4'],['A5','a5']],'a4'),font=select([['12 pt',12],['14 pt',14],['16 pt',16]],12);
    function field(text,input){const node=el('label','formatted-export-field');node.append(el('span',null,label(text)),input);return node;}
    grid.append(field('格式',format),field('纸张',paper),field('字号',font));
    const cover=el('input'),toc=el('input');cover.type=toc.type='checkbox';cover.checked=toc.checked=true;
    const checks=el('div','formatted-export-checks');checks.append(field('包含封面',cover));if(book.kind==='long')checks.append(field('包含目录',toc));else toc.checked=false;
    const hint=el('p','dialog-description'),buttons=el('div','dialog-actions'),submit=el('button','primary-button',label('导出'));submit.type='submit';buttons.append(action(label('取消'),'secondary-button',closeDialog),submit);body.append(grid,checks,hint,buttons);
    const update=()=>{paper.disabled=format.value==='epub';hint.textContent=format.value==='pdf'&&!window.WriterDesktop?.printBookPDF?label('浏览器版会打开打印窗口，请选择另存为 PDF。'):'';hint.hidden=!hint.textContent;};format.addEventListener('change',update);update();
    const visible=()=>$('dialog').open&&$('dialog-body').contains(body);
    body.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||!visible())return;busy=true;submit.disabled=true;
      try{await transition(async()=>{
        if(!visible()||!await requireSaved()||!visible())return;
        const record=await api('/api/books/'+encodeURIComponent(targetId));if(!visible())return;if(record.book?.id!==targetId)throw new Error(label('作品与目标不匹配，请重试。'));
        const options={cover:cover.checked,toc:toc.checked,paper:paper.value,font:Number(font.value),lang:typeof uiLanguage!=='undefined'&&uiLanguage==='en'?'en':'zh'};
        if(options.cover)options.coverData=await normalizeCover(record.book);
        const chosen=format.value,response=await request(record.book,chosen==='pdf'?'html':chosen,options);if(!visible())return;
        if(chosen==='pdf')await printHTML(await response.text(),record.book,options);
        else{const blob=await response.blob();if(!visible())return;download(filename('.'+chosen,record.book),blob,blob.type);toast(label('排版文档已导出。'));}
      });}catch(error){if(visible())toast(error.message);}finally{busy=false;submit.disabled=false;}
    });
    showDialog(T('排版导出 · {0}',book.title),body);
  }
  return Object.freeze({show,printHTML});
})();
function showFormattedExport(book){window.WriterFormattedExport.show(book);}
