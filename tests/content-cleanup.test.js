'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{test}=require('node:test');
function harness({fail=false}={}){
  const values=new Map(),removed=[],disposed=[];
  const storage={getItem:key=>values.get(key)||null,key:i=>Array.from(values.keys())[i],get length(){return values.size;},removeItem(key){if(fail)throw Error('disk full');removed.push(key);values.delete(key);},setItem:(key,value)=>values.set(key,value)};
  const ctx={window:{},clientStorage:storage,T:x=>x,clearAIChatBookHistory:id=>disposed.push(id),api:async()=>({purges:[{bookId:'book',purgedAt:'2026-10-12T08:00:00Z'}]})};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/content-cleanup.js'),'utf8'),ctx);
  return {values,removed,disposed,api:ctx.window.WriterContentCleanup};
}
test('purge replay removes all draft owners and chats of one book without touching similarly named books',async()=>{
  const h=harness(),owner='11111111-1111-4111-8111-111111111111';
  for(const key of ['yejian.draft.book.'+owner,'yejian.draft.book.22222222-2222-4222-8222-222222222222','yejian.ai-chat.book.write','yejian.ai-chat.book.outline','yejian.draft.book.other.'+owner,'yejian.ai-chat.book.other.write','writer-desk.language'])h.values.set(key,'authored content');
  h.values.set('yejian.draft.book.legacy-owner',JSON.stringify({book:{id:'book',chapters:[{body:'old text'}]}}));
  await h.api.sync();assert.equal(h.removed.length,5);assert.equal(h.disposed.length,1);assert.ok(h.values.has('yejian.draft.book.other.'+owner));assert.ok(h.values.has('writer-desk.language'));
  h.values.set('yejian.draft.book.'+owner,'new writing after purge');await h.api.sync();assert.equal(h.disposed.length,1);assert.ok(h.values.has('yejian.draft.book.'+owner));
});
test('failed storage cleanup does not acknowledge a receipt or continue to draft recovery',async()=>{
  const h=harness({fail:true});h.values.set('yejian.draft.book.11111111-1111-4111-8111-111111111111','old chapter');await assert.rejects(h.api.sync(),/disk full/);assert.equal(h.values.has('yejian.chapter-purge.book'),false);
});
