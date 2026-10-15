'use strict';

// Only the actions named here are decorated. Manuscripts, inputs, navigation
// labels, category tabs and confirmation buttons are never rewritten.
(function(global){
  const paths={
    menu:'M4 6h16M4 12h16M4 18h16',back:'m9 5-7 7 7 7M2 12h19',
    outline:'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
    people:'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a6 6 0 0 1 12 0v3M17 4a4 4 0 0 1 0 8M17 15a5 5 0 0 1 5 5v1',
    personPlus:'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a6 6 0 0 1 12 0v3M19 8v8M15 12h8',
    pen:'m4 20 4-1L21 6l-3-3L5 16zM15 6l3 3',
    search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14m5-2 6 6',
    review:'M5 3h10l4 4v6M15 3v5h4M5 3v18h7M8 8h3M8 12h7m0 6 2 2 4-5',
    ai:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM19 2v4M17 4h4',
    link:'m10 13 4-4M8 15l-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M14 9l2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0',
    compare:'M3 4h7v16H3zM14 4h7v16h-7zM6 8h1M6 12h1M17 8h1M17 12h1',
    more:'M5 12h.01M12 12h.01M19 12h.01',
    book:'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z',
    volume:'M3 5h12v15H3zM6 2h12v15M9 8v6M6 11h6',
    filePlus:'M5 3h10l4 4v14H5zM15 3v5h4M12 11v7M8.5 14.5h7',
    plus:'M12 4v16M4 12h16',child:'M6 3v9a4 4 0 0 0 4 4h9m-4-4 4 4-4 4',
    up:'m5 14 7-7 7 7',down:'m5 10 7 7 7-7',
    trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
    upload:'M12 17V3m-5 5 5-5 5 5M4 15v6h16v-6',
    import:'M14 3H5v18h14V8M14 3v5h5M9 13h12m-4-4 4 4-4 4',
    download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
    folder:'M3 7V5h6l2 2h10v13H3zM3 7h18',
    cover:'M4 3h16v18H4zM7 15l3-4 3 3 3-4M8 7h.01',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    edit:'m4 20 4-1L20 7l-3-3L5 16zM14 7l3 3',check:'m5 12 4 4L20 5',
    fit:'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z',
    zoomIn:'M4 12h16M12 4v16',zoomOut:'M4 12h16',clear:'m6 6 12 12M18 6 6 18',
    web:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a16 16 0 0 1 0 18 16 16 0 0 1 0-18',
    external:'M14 3h7v7m0-7-11 11M10 3H3v18h18v-7',
    text:'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
    structure:'M12 3v6M4 15V9h16v6M2 15h4v6H2zM10 15h4v6h-4zM18 15h4v6h-4z'
  };
  const action=(icon,label,group,extra={})=>Object.freeze({icon,label,group,...extra});
  const primary={showLabel:true,variant:'primary'};
  const staticActions=Object.freeze({
    'toggle-notes':action('link','关联与资料','references'),
    'library-search':action('search','全局搜索','search'),
    'toggle-sidebar':action('menu','章节目录','navigation'),
    'return-source':action('back',(context,t)=>t(context.trailView==='people'?'返回人物脉络':'返回大纲'),'navigation'),
    'writing-compare':action('compare','对照修改','editing'),
    'editor-tools':action('more','写作工具','editing'),
    'book-search':action('search','全书查找与替换','editing'),
    'writing-review':action('review','校对与批注','editing'),
    'story-tools':action('structure','创作工具','editing',{badge:'#foreshadow-reminder'}),
    'writing-plan':action('outline','作品大纲','planning'),
    'writing-ai':action('ai','AI 辅助','planning'),
    'link-current-chapter':action('link','关联大纲 / 人物','references'),
    'add-volume':action('volume','新建卷','create'),
    'add-chapter':action('filePlus','新建章节','create'),
    'move-up':action('up','章节上移','order'),
    'move-down':action('down','章节下移','order'),
    'trash-chapter':action('trash','将章节移到回收站','delete',{variant:'danger'}),
    'import-manuscript':action('import','导入稿件','import'),
    'import-backup':action('upload','导入备份','import'),
    'load-example':action('book','载入长篇示例','import'),
    'new-book':action('plus',(context,t)=>t('＋ 新建{0}',t(context.kind==='short'?'短篇':'长篇')),'create',primary),
    'outline-read-toggle':action(context=>context.outlineMode==='read'?'edit':'eye',(context,t)=>t(context.outlineMode==='read'?'返回编辑':'完整阅读'),'view'),
    'outline-story-tools':action('structure','创作工具','tools'),
    'outline-ai':action('ai','AI 辅助','tools'),
    'outline-build':action('structure','生成卷章目录','structure'),
    'add-outline':action('plus','＋ 新建节点','create',primary),
    'outline-up':action('up','大纲节点上移','order'),
    'outline-down':action('down','大纲节点下移','order'),
    'outline-child':action('child','＋ 子节点','create'),
    'trash-outline':action('trash','将大纲节点移到回收站','delete',{variant:'danger'}),
    'outline-create-chapter':action('filePlus','按此大纲创建章节','create',{choices:['按此大纲创建章节','打开正文','开始正文','建立对应卷','生成卷章目录','打开关联章节']}),
    'outline-link':action('link','＋ 关联章节','references',{choices:['＋ 关联章节','关联正文']}),
    'people-ai':action('ai','AI 提取关系','tools'),
    'review-candidates':action('search','正文识别人名','tools'),
    'add-relation':action('link','＋ 添加关系','create'),
    'add-person':action('personPlus','＋ 新建人物','create',primary),
    'atlas-edit-view':action('edit','编辑分图','view'),
    'atlas-new-view':action('plus','＋ 新建分图','view'),
    'graph-zoom-out':action('zoomOut','缩小人物图','zoom'),
    'graph-zoom-in':action('zoomIn','放大人物图','zoom'),
    'graph-fit':action('fit','适应图幅','zoom'),
    'atlas-clear-focus':action('clear','取消高亮','view'),
    'person-edit':action(context=>context.personEditing?'check':'edit',(context,t)=>t(context.personEditing?'完成编辑':'编辑人物'),'edit'),
    'trash-person':action('trash','将人物移到回收站','delete',{variant:'danger'}),
    'person-relation':action('link','＋ 添加关系','references'),
    'person-link':action('link','＋ 关联章节','references',{choices:['＋ 关联章节','关联正文']}),
    'close-notes':action('clear','关闭关联与资料','close'),
    'backlinks-edit':action('edit','编辑','edit'),
    'add-note':action('filePlus','新建资料','create'),
    'trash-note':action('trash','将资料移到回收站','delete',{variant:'danger'})
  });
  const dynamicActions=Object.freeze({
    outline:action('outline','大纲','open'),people:action('people','人物脉络','open'),
    write:action('pen','继续写作','open',{variant:'primary',choices:['继续写作','开始正文']}),
    cover:action('cover','封面与书名','book'),backup:action('download','导出与备份','book'),
    folder:action('folder','打开文件夹','book'),trash:action('trash','移入回收站','book',{variant:'danger'}),
    'asset-upload':action('upload','添加文件','asset-create'),
    'asset-web':action('web','网页摘录','asset-create'),
    'asset-text':action('text','文字资料','asset-create'),
    'asset-download':action('download','下载文件','asset-file'),
    'asset-source':action('external','打开来源','asset-file'),
    'asset-delete':action('trash','删除素材','asset-delete',{variant:'danger'})
  });
  const bars=['.writing-toolbar','.shelf-heading-actions','.heading-actions','.detail-tools>div','.chapter-tools','.chapter-add-actions','.atlas-view-actions','.atlas-zoom','.shelf-book-actions','.shelf-book-tools','.asset-tools'];
  let options={},boundDocument=null,pendingFrame=null;
  const pendingButtons=new Set();
  const rendered=new WeakMap();
  function documentFor(){return options.document||global.document;}
  function translate(text,...args){return options.translate?options.translate(text,...args):String(text).replace(/\{(\d+)\}/g,(_,index)=>args[index]??'');}
  function context(){return options.getContext?.()||{};}
  function cleanLabel(value){return String(value||'').replace(/^[＋+]\s*/,'').trim();}
  function iconFor(name,document){
    const supplied=options.icon?.(name,document);
    if(supplied?.namespaceURI==='http://www.w3.org/2000/svg'&&supplied.tagName.toLowerCase()==='svg')return supplied.cloneNode(true);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),line=document.createElementNS('http://www.w3.org/2000/svg','path');
    for(const [key,value]of Object.entries({viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':name==='more'?'3':'1.65','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
    line.setAttribute('d',paths[name]);svg.append(line);return svg;
  }
  function labelFor(button,spec,previous,current){
    if(typeof spec.label==='function')return cleanLabel(spec.label(current,translate));
    if(spec.choices){
      const text=button.querySelector('.ui-action-icon')?null:cleanLabel(button.textContent);
      const key=spec.choices.find(value=>cleanLabel(value)===text||cleanLabel(translate(value))===text)||previous?.labelKey||spec.label;
      return {label:cleanLabel(translate(key)),labelKey:key};
    }
    return cleanLabel(translate(spec.label));
  }
  function decorate(button,spec,current){
    const iconName=typeof spec.icon==='function'?spec.icon(current):spec.icon;
    if(!button||!['BUTTON','A'].includes(button.tagName)||!paths[iconName])return false;
    const previous=rendered.get(button),resolved=labelFor(button,spec,previous,current),label=typeof resolved==='string'?resolved:resolved.label;
    const card=button.closest('.shelf-book'),bookTitle=card?.querySelector('.shelf-book-title')?.textContent?.trim();
    button.title=label;button.setAttribute('aria-label',bookTitle?label+' · '+bookTitle:label);
    button.classList.add('ui-action');button.classList.toggle('ui-action-primary',spec.variant==='primary');button.classList.toggle('ui-action-danger',spec.variant==='danger');button.classList.toggle('ui-action-with-label',!!spec.showLabel);button.dataset.uiGroup=spec.group;
    const existing=button.querySelector('.ui-action-icon'),needsIcon=!existing||previous?.icon!==iconName||previous?.showLabel!==!!spec.showLabel;
    if(needsIcon){
      const badge=spec.badge?button.querySelector(spec.badge):null,icon=documentFor().createElement('span');icon.className='ui-action-icon';icon.setAttribute('aria-hidden','true');icon.append(iconFor(iconName,documentFor()));
      button.replaceChildren(icon);
      if(spec.showLabel){const text=documentFor().createElement('span');text.className='ui-action-label';text.textContent=label;button.append(text);}
      if(badge)button.append(badge);
    }else if(spec.showLabel){const text=button.querySelector('.ui-action-label');if(text&&text.textContent!==label)text.textContent=label;}
    rendered.set(button,{icon:iconName,labelKey:typeof resolved==='object'?resolved.labelKey:undefined,showLabel:!!spec.showLabel});
    return true;
  }
  function controlsWithin(root,selector){const result=[...root.querySelectorAll(selector)];if(root.matches?.(selector))result.unshift(root);return result;}
  function apply(root=documentFor()){
    const document=documentFor();if(!root||!document)return;
    document.documentElement.classList.add('interface-polished');const current=context();
    for(const [id,spec]of Object.entries(staticActions)){
      const button=root.id===id?root:root.querySelector('#'+id);if(button)decorate(button,spec,current);
    }
    for(const button of controlsWithin(root,'[data-ui-action]')){const spec=dynamicActions[button.dataset.uiAction];if(spec)decorate(button,spec,current);}
    for(const selector of bars)for(const bar of controlsWithin(root,selector)){
      bar.classList.add('ui-action-bar');let previous;
      for(const button of bar.querySelectorAll('.ui-action')){if(button.hidden)continue;const group=button.dataset.uiGroup;button.classList.toggle('ui-action-group-start',!!previous&&group!==previous);previous=group;}
    }
  }
  function mappedButton(target){const button=target?.closest?.('button,a');return button&&(staticActions[button.id]||dynamicActions[button.dataset.uiAction])?button:null;}
  function clicked(event){
    const button=mappedButton(event.target);if(!button)return;
    // Some existing toggles rewrite their own caption synchronously. Refresh
    // only that action after the click; never observe the writing surface.
    pendingButtons.add(button);
    const refresh=()=>{pendingFrame=null;const buttons=[...pendingButtons];pendingButtons.clear();for(const item of buttons)if(item.isConnected)apply(item);};
    if(typeof global.requestAnimationFrame==='function'){if(pendingFrame===null)pendingFrame=global.requestAnimationFrame(refresh);}else refresh();
  }
  function configure(value={}){
    options={...options,...value};const document=documentFor();
    if(document!==boundDocument){destroy();boundDocument=document;boundDocument?.addEventListener('click',clicked,true);}
    return api;
  }
  function destroy(){boundDocument?.removeEventListener('click',clicked,true);boundDocument=null;if(pendingFrame!==null)global.cancelAnimationFrame?.(pendingFrame);pendingFrame=null;pendingButtons.clear();}
  const api=Object.freeze({configure,apply,destroy});
  if(typeof module==='object'&&module.exports)module.exports=api;else global.WriterInterfacePolish=api;
})(typeof window==='object'?window:globalThis);
