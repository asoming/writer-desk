'use strict';

(function(global){
  function attach(input,{container=input.parentElement,window:win=input.ownerDocument.defaultView||global}={}){
    const previous={height:input.style.height,overflowY:input.style.overflowY};
    let disposed=false,frame=null,lastWidth=-1,lastContainerHeight=-1;
    const number=value=>Number.parseFloat(value)||0;
    function measure(){
      if(disposed||!input.isConnected)return;
      lastWidth=input.clientWidth;lastContainerHeight=container?.clientHeight||0;if(!lastWidth)return;
      const css=win.getComputedStyle(input),minimum=number(css.minHeight),cssMaximum=Number.parseFloat(css.maxHeight);
      // A long prompt scrolls inside its box while the conversation keeps room.
      const maximum=Math.max(minimum,Math.min(Number.isFinite(cssMaximum)?cssMaximum:Infinity,lastContainerHeight>0?lastContainerHeight*.3:Infinity));
      const scrollTop=input.scrollTop,padding=number(css.paddingTop)+number(css.paddingBottom),border=number(css.borderTopWidth)+number(css.borderBottomWidth);
      input.style.overflowY='hidden';input.style.height='0px';
      const contentHeight=input.scrollHeight+(css.boxSizing==='border-box'?border:-padding);
      input.style.height=Math.ceil(Math.max(minimum,Math.min(maximum,contentHeight)))+'px';
      const overflowing=input.scrollHeight>input.clientHeight+1;
      input.style.overflowY=overflowing?'auto':'hidden';
      input.scrollTop=overflowing?scrollTop:0;
    }
    function refresh(){if(!disposed&&frame===null)frame=win.requestAnimationFrame(()=>{frame=null;measure();});}
    function layoutChanged(){if(input.clientWidth!==lastWidth||(container?.clientHeight||0)!==lastContainerHeight)refresh();}
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(layoutChanged):null;
    observer?.observe(input);if(container&&container!==input)observer?.observe(container);
    input.addEventListener('input',refresh);input.addEventListener('compositionend',refresh);win.addEventListener('resize',refresh);
    input.ownerDocument.fonts?.ready.then(refresh);refresh();
    return{refresh,dispose(){
      if(disposed)return;disposed=true;if(frame!==null)win.cancelAnimationFrame(frame);observer?.disconnect();
      input.removeEventListener('input',refresh);input.removeEventListener('compositionend',refresh);win.removeEventListener('resize',refresh);
      input.style.height=previous.height;input.style.overflowY=previous.overflowY;
    }};
  }
  const api={attach};if(typeof module==='object'&&module.exports)module.exports=api;else global.WriterTextareaAutosize=api;
})(typeof window==='object'?window:globalThis);
