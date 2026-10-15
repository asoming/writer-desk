'use strict';

// Same-origin POST preserves the desktop token injection and server CSRF guard.
// The stream is a preview: candidates appear only after a validated final event.
window.WriterAIStream={async request(path,payload,{signal,onDelta=()=>{}}={}){
  const response=await fetch(path+'/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Writer-Client':'1','Accept':'text/event-stream'},body:JSON.stringify(payload),signal});
  if(!response.ok){let error;try{error=await response.json();}catch{}throw Error(T(error?.error||'AI 流式请求失败，请重试。'));}
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw Error(T('AI 流式返回格式无效，请重试。'));
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',size=0,result=null;
  function consume(line){
    if(!line.trim()||line.startsWith(':'))return;
    if(!line.startsWith('data:'))throw Error(T('AI 流式返回格式无效，请重试。'));
    const value=JSON.parse(line.slice(5).trimStart());
    if(value?.type==='delta'&&typeof value.text==='string'){if(result)throw Error(T('AI 流式返回格式无效，请重试。'));onDelta(value.text);}
    else if(value?.type==='result'&&value.result&&!result)result=value.result;
    else if(value?.type==='error'&&typeof value.error==='string')throw Error(T(value.error));
    else throw Error(T('AI 流式返回格式无效，请重试。'));
  }
  try{while(true){if(signal?.aborted)throw new DOMException('Aborted','AbortError');const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>34*1024*1024)throw Error(T('AI 返回内容过大，请减少生成范围后重试。'));buffer+=decoder.decode(chunk.value,{stream:true});let end;while((end=buffer.indexOf('\n'))!==-1){consume(buffer.slice(0,end).replace(/\r$/,''));buffer=buffer.slice(end+1);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer);if(signal?.aborted)throw new DOMException('Aborted','AbortError');if(!result)throw Error(T('AI 流式连接中断，请重试。'));return result;}
  finally{await reader.cancel().catch(()=>{});}
}};
