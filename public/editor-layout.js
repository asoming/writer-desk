'use strict';

(function(global){
  const mirrors=new WeakMap();
  function resize(editor,container,minimum=390){
    if(!editor?.isConnected||editor.getBoundingClientRect().width<=0)return;
    let mirror=mirrors.get(editor);
    if(!mirror?.isConnected){
      mirror=editor.cloneNode(false);mirror.removeAttribute('id');mirror.removeAttribute('name');
      mirror.setAttribute('aria-hidden','true');mirror.tabIndex=-1;mirror.disabled=true;
      mirror.style.cssText='position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;height:0;min-height:0;max-height:none;min-width:0;margin:0;overflow:hidden;resize:none;box-sizing:border-box;';
      editor.parentElement.append(mirror);mirrors.set(editor,mirror);
    }
    const css=global.getComputedStyle(editor);
    for(const name of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','textIndent','tabSize','whiteSpace','overflowWrap','wordBreak','paddingTop','paddingBottom','paddingLeft','paddingRight','borderTopWidth','borderBottomWidth','borderLeftWidth','borderRightWidth'])mirror.style[name]=css[name];
    mirror.style.width=editor.getBoundingClientRect().width+'px';mirror.value=editor.value;
    const height=Math.ceil(Math.max(minimum,mirror.scrollHeight+(parseFloat(css.borderTopWidth)||0)+(parseFloat(css.borderBottomWidth)||0)));
    if(editor.style.height===height+'px')return;
    // Measure a separate node so the live manuscript never collapses during typing.
    const top=container?.scrollTop,behavior=container?.style.scrollBehavior;
    if(container)container.style.scrollBehavior='auto';
    editor.style.height=height+'px';
    if(container){container.scrollTop=top;container.style.scrollBehavior=behavior;}
  }
  global.WriterEditorLayout={resize};
})(window);
