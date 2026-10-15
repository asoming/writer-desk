'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/ai-stream.js'),'utf8');
function harness(lines,options={}){
  const calls=[],bytes=new TextEncoder().encode(lines.join('\n')),chunks=[];for(let index=0;index<bytes.length;index+=options.chunkSize||3)chunks.push(bytes.slice(index,index+(options.chunkSize||3)));
  let cancelled=false;const body=new ReadableStream({pull(controller){if(chunks.length)controller.enqueue(chunks.shift());else controller.close();},cancel(){cancelled=true;}});
  const context=vm.createContext({window:{},TextDecoder,DOMException,T:text=>text,fetch:async(url,request)=>{calls.push({url,request});return{ok:options.ok!==false,json:async()=>({error:'本机错误'}),headers:{get:()=>options.contentType||'text/event-stream; charset=utf-8'},body};}});vm.runInContext(source,context);
  return{request:context.window.WriterAIStream.request,calls,get cancelled(){return cancelled;}};
}
const event=value=>'data: '+JSON.stringify(value)+'\r\n';
test('SSE HTTP chunks split inside UTF-8; final candidate stays distinct from text deltas',async()=>{
  const final={bookId:'book',action:'draft',chat:true,reply:'你好😀',data:{title:'候选',body:'尚未采用'}},h=harness([': heartbeat\n',event({type:'delta',text:'你好'}),event({type:'delta',text:'😀'}),event({type:'result',result:final})]),pieces=[];
  const result=await h.request('/api/books/book/ai',{chat:true},{onDelta:text=>pieces.push(text)});
  assert.equal(pieces.join(''),'你好😀');assert.equal(JSON.stringify(result),JSON.stringify(final));assert.equal(h.calls[0].url,'/api/books/book/ai/stream');assert.equal(h.calls[0].request.headers['X-Writer-Client'],'1');assert.ok(!h.calls[0].request.headers.Authorization);
});
test('partial EOF, invalid protocol and provider errors never return a completed candidate',async()=>{
  for(const lines of [[event({type:'delta',text:'未完成'})],['not SSE'],[event({type:'error',error:'模型失败'})]]){
    const h=harness(lines);await assert.rejects(h.request('/ai',{},{}));assert.equal(h.calls.length,1);
  }
});
test('abort during output rejects the response without retrying',async()=>{
  const abort=new AbortController(),h=harness([event({type:'delta',text:'首段'}),event({type:'result',result:{data:{body:'不应采用'}}})]);
  await assert.rejects(h.request('/ai',{}, {signal:abort.signal,onDelta:()=>abort.abort()}),{name:'AbortError'});assert.equal(h.calls.length,1);
});
test('non-OK and non-stream responses fail without additional provider calls',async()=>{
  for(const options of [{ok:false},{contentType:'application/json'}]){const h=harness([],options);await assert.rejects(h.request('/ai',{}));assert.equal(h.calls.length,1);}
});
