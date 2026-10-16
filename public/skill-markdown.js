'use strict';

(function(global){
  const MAX_CHARS=262144,MAX_NODES=12000,MAX_DEPTH=16;
  const punctuation=/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
  const whitespace=/\s/,word=/[\p{L}\p{N}]/u;

  // This viewer deliberately has no HTML or remote-resource renderer.
  function reference(href){
    return !!href&&!/[\u0000-\u0020\u007f\\]/.test(href)&&!href.startsWith('/')&&
      !/^[a-z][a-z\d+.-]*:/i.test(href)&&/^[^?#]+\.md(?:#[^?#]*)?$/i.test(href);
  }
  function after(positions,position,end){
    if(!positions)return-1;
    let low=0,high=positions.length;
    while(low<high){const middle=(low+high)>>>1;if(positions[middle]<=position)low=middle+1;else high=middle;}
    return low<positions.length&&positions[low]<end?positions[low]:-1;
  }
  function inlineIndex(source){
    const all=new Map(),closing=new Map();
    function add(map,mark,index){if(!map.has(mark))map.set(mark,[]);map.get(mark).push(index);}
    for(let i=0;i<source.length;i++){
      const char=source[i];
      if(char==='\\'&&punctuation.test(source[i+1]||'')){i++;continue;}
      if(char==='`'){
        let end=i+1;while(source[end]==='`')end++;
        add(all,source.slice(i,end),i);i=end-1;
      }else if(char==='*'||char==='_'){
        const pair=source[i+1]===char,mark=pair?char+char:char;
        add(all,mark,i);
        if(i>0&&!whitespace.test(source[i-1])&&!(char==='_'&&word.test(source[i-1])&&word.test(source[i+mark.length]||'')))add(closing,mark,i);
        if(pair)i++;
      }else if(char===']')add(all,char,i);
    }
    return{all,closing,links:new Map()};
  }
  function destination(source,close,index){
    if(index.links.has(close))return index.links.get(close);
    let result=null;
    if(source[close+1]==='('){
      let position=close+2,depth=1;
      const limit=Math.min(source.length,position+4096);
      for(;position<limit;position++){
        if(source[position]==='\\'){position++;continue;}
        if(source[position]==='(')depth++;
        if(source[position]===')'&&!--depth)break;
        if(source[position]==='\n')break;
      }
      if(depth===0){
        const raw=source.slice(close+2,position).trim();
        const match=raw.startsWith('<')?raw.match(/^<([^<>]*)>(?:\s+["'][^"']*["'])?$/):raw.match(/^(\S+?)(?:\s+["'][^"']*["'])?$/);
        if(match)result={href:match[1],end:position+1};
      }
    }
    index.links.set(close,result);return result;
  }
  function inline(parent,source,state,depth=0,index=inlineIndex(source),start=0,end=source.length){
    if(depth>=MAX_DEPTH){state.text(parent,source.slice(start,end));return;}
    let buffer=[];
    const flush=()=>{if(buffer.length){state.text(parent,buffer.join(''));buffer=[];}};
    let position=start;
    for(;position<end&&state.nodes<MAX_NODES;){
      const char=source[position];
      if(char==='\\'&&position+1<end&&punctuation.test(source[position+1])){buffer.push(source[position+1]);position+=2;continue;}
      if(char==='`'){
        let tickEnd=position+1;while(tickEnd<end&&source[tickEnd]==='`')tickEnd++;
        const mark=source.slice(position,tickEnd),close=after(index.all.get(mark),position,end);
        if(close!==-1){
          flush();const code=state.make('code');let content=source.slice(tickEnd,close).replace(/\n/g,' ');
          if(content.startsWith(' ')&&content.endsWith(' ')&&content.trim())content=content.slice(1,-1);
          state.text(code,content);parent.append(code);position=close+mark.length;continue;
        }
        buffer.push(mark);position=tickEnd;continue;
      }
      const image=char==='!'&&source[position+1]==='[';
      if(char==='['||image){
        const labelStart=position+(image?2:1),close=after(index.all.get(']'),labelStart-1,end);
        const link=close===-1?null:destination(source,close,index);
        if(link&&link.end<=end){
          flush();
          if(image){state.text(parent,source.slice(labelStart,close).replace(/\\([\\\[\]])/g,'$1'));}
          else if(reference(link.href)&&typeof state.onReference==='function'){
            const button=state.make('button','skill-markdown-reference');button.type='button';button.dataset.reference=link.href;
            inline(button,source,state,depth+1,index,labelStart,close);
            button.addEventListener('click',event=>{event.preventDefault();state.onReference(link.href);});parent.append(button);
          }else inline(parent,source,state,depth+1,index,labelStart,close);
          position=link.end;continue;
        }
      }
      if(char==='*'||char==='_'){
        const mark=source[position+1]===char?char+char:char,next=source[position+mark.length]||'';
        const inWord=char==='_'&&word.test(source[position-1]||'')&&word.test(next);
        const close=!next||whitespace.test(next)||inWord?-1:after(index.closing.get(mark),position,end);
        if(close!==-1&&close>=position+mark.length+1){
          flush();const emphasis=state.make(mark.length===2?'strong':'em');inline(emphasis,source,state,depth+1,index,position+mark.length,close);parent.append(emphasis);position=close+mark.length;continue;
        }
        buffer.push(mark);position+=mark.length;continue;
      }
      buffer.push(char);position++;
    }
    flush();if(position<end){state.formattedLimit=true;state.text(parent,source.slice(position,end));}
  }
  function indentation(line){let count=0;for(const char of line){if(char===' ')count++;else if(char==='\t')count+=4-count%4;else break;}return count;}
  function unindent(line,amount){let offset=0,width=0;while(offset<line.length&&width<amount){if(line[offset]===' ')width++;else if(line[offset]==='\t')width+=4-width%4;else break;offset++;}return line.slice(offset);}
  function listItem(line){
    const match=line.match(/^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/);
    if(!match)return null;
    return{indent:indentation(match[1]),ordered:match[2].length>1,start:parseInt(match[2],10),content:match[3],width:indentation(line.slice(0,line.length-match[3].length))};
  }
  function heading(line){return line.match(/^ {0,3}(#{1,6})[ \t]+(.*)$/);}
  function fence(line){const match=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);return match&&!(match[1][0]==='`'&&match[2].includes('`'))?match:null;}
  function rule(line){return/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);}
  function setext(line){return/^ {0,3}=+[ \t]*$/.test(line)?1:/^ {0,3}-+[ \t]*$/.test(line)?2:0;}
  function cells(line){
    line=line.trim();if(line.startsWith('|'))line=line.slice(1);if(line.endsWith('|')&&!line.endsWith('\\|'))line=line.slice(0,-1);
    const result=[];let buffer='',code='';
    for(let i=0;i<line.length;i++){
      if(line[i]==='\\'&&line[i+1]==='|'){buffer+='|';i++;continue;}
      if(line[i]==='`'){let end=i+1;while(line[end]==='`')end++;const run=line.slice(i,end);if(!code)code=run;else if(code===run)code='';buffer+=run;i=end-1;continue;}
      if(line[i]==='|'&&!code){result.push(buffer.trim());buffer='';}else buffer+=line[i];
    }
    result.push(buffer.trim());return result;
  }
  function tableHeader(lines,index){
    if(!lines[index]?.includes('|')||!lines[index+1])return null;
    const titles=cells(lines[index]),dividers=cells(lines[index+1]);
    return titles.length>=2&&titles.length<=32&&titles.length===dividers.length&&dividers.every(cell=>/^:?-{3,}:?$/.test(cell))?{titles,dividers}:null;
  }
  function boundary(lines,index){const line=lines[index];return!line.trim()||!!heading(line)||!!fence(line)||rule(line)||/^ {0,3}>/.test(line)||!!listItem(line)||!!tableHeader(lines,index);}
  function blocks(parent,lines,state,depth=0){
    if(depth>=MAX_DEPTH){const plain=state.make('pre','skill-markdown-plain');state.text(plain,lines.join('\n'));parent.append(plain);return;}
    let index=0;
    while(index<lines.length&&state.nodes<MAX_NODES){
      const line=lines[index];if(!line.trim()){index++;continue;}
      const fenced=fence(line);
      if(fenced){
        const start=++index,mark=fenced[1][0],length=fenced[1].length;
        while(index<lines.length){const close=lines[index].match(/^ {0,3}([`~]+)[ \t]*$/);if(close&&close[1][0]===mark&&close[1].length>=length&&[...close[1]].every(char=>char===mark))break;index++;}
        const pre=state.make('pre'),code=state.make('code'),language=fenced[2].trim().match(/^[\w+-]{1,40}(?=\s|$)/)?.[0];
        if(language)code.className='language-'+language;
        state.text(code,lines.slice(start,index).join('\n'));pre.append(code);parent.append(pre);if(index<lines.length)index++;continue;
      }
      const title=heading(line);
      if(title){const node=state.make('h'+title[1].length);inline(node,title[2].replace(/[ \t]+#+[ \t]*$/,''),state);parent.append(node);index++;continue;}
      if(rule(line)){parent.append(state.make('hr'));index++;continue;}
      if(/^ {0,3}>/.test(line)){
        const quoted=[];while(index<lines.length){const quote=lines[index].match(/^ {0,3}>[ \t]?(.*)$/);if(quote){quoted.push(quote[1]);index++;}else if(!lines[index].trim()&&/^ {0,3}>/.test(lines[index+1]||'')){quoted.push('');index++;}else break;}
        const node=state.make('blockquote');blocks(node,quoted,state,depth+1);parent.append(node);continue;
      }
      const firstItem=listItem(line);
      if(firstItem){
        const list=state.make(firstItem.ordered?'ol':'ul');if(firstItem.ordered&&firstItem.start!==1)list.setAttribute('start',String(firstItem.start));
        while(index<lines.length&&state.nodes<MAX_NODES){
          const item=listItem(lines[index]);if(!item||item.indent!==firstItem.indent||item.ordered!==firstItem.ordered)break;
          const content=[item.content];index++;
          while(index<lines.length){
            const next=listItem(lines[index]);if(next&&next.indent<=firstItem.indent)break;
            if(!lines[index].trim()){content.push('');index++;continue;}
            if(indentation(lines[index])<=firstItem.indent)break;
            content.push(unindent(lines[index],item.width));index++;
          }
          const node=state.make('li');blocks(node,content,state,depth+1);list.append(node);
        }
        parent.append(list);continue;
      }
      const header=tableHeader(lines,index);
      if(header){
        const wrapper=state.make('div','skill-markdown-table'),table=state.make('table'),head=state.make('thead'),row=state.make('tr'),body=state.make('tbody');
        const appendCell=(row,tag,text,column)=>{const cell=state.make(tag);const divider=header.dividers[column];if(divider.startsWith(':')&&divider.endsWith(':'))cell.dataset.align='center';else if(divider.endsWith(':'))cell.dataset.align='right';inline(cell,text,state);row.append(cell);};
        header.titles.forEach((text,column)=>appendCell(row,'th',text,column));head.append(row);table.append(head);index+=2;
        while(index<lines.length&&lines[index].trim()&&lines[index].includes('|')&&state.nodes<MAX_NODES){const values=cells(lines[index]);if(values.length>header.titles.length)break;const row=state.make('tr');header.titles.forEach((_,column)=>appendCell(row,'td',values[column]||'',column));body.append(row);index++;}
        table.append(body);wrapper.append(table);parent.append(wrapper);continue;
      }
      if(index+1<lines.length&&setext(lines[index+1])){const node=state.make('h'+setext(lines[index+1]));inline(node,line.trim(),state);parent.append(node);index+=2;continue;}
      const paragraph=[line];index++;
      while(index<lines.length&&!boundary(lines,index)&&!setext(lines[index])){paragraph.push(lines[index]);index++;}
      const node=state.make('p');inline(node,paragraph.join('\n'),state);parent.append(node);
    }
    if(index<lines.length){state.formattedLimit=true;const plain=state.make('pre','skill-markdown-plain');state.text(plain,lines.slice(index).join('\n'));parent.append(plain);}
  }
  function contentLines(markdown){
    const lines=markdown.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');
    if(lines[0].trim()==='---'){
      let closing=1;while(closing<lines.length&&!/^(?:---|\.\.\.)[ \t]*$/.test(lines[closing]))closing++;
      if(closing<lines.length&&lines.slice(1,closing).some(line=>/^[a-zA-Z_][\w-]*\s*:/.test(line)))return lines.slice(closing+1);
    }
    return lines;
  }
  function render(host,markdown,{onReference}={}){
    const document=host.ownerDocument||global.document;
    const original=String(markdown??''),source=original.slice(0,MAX_CHARS);
    const state={nodes:0,formattedLimit:false,onReference,
      make(tag,className){this.nodes++;const node=document.createElement(tag);if(className)node.className=className;return node;},
      text(parent,value){this.nodes++;parent.append(document.createTextNode(value));},
    };
    const article=state.make('article','writing-skill-markdown');blocks(article,contentLines(source),state);
    if(original.length>MAX_CHARS)state.text(article,'…');host.replaceChildren(article);
    return{element:article,nodes:state.nodes,truncated:original.length>MAX_CHARS,plainRemainder:state.formattedLimit};
  }
  const api={render};if(typeof module==='object'&&module.exports)module.exports=api;else global.WriterSkillMarkdown=api;
})(typeof window==='object'?window:globalThis);
