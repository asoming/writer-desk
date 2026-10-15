'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),backup=JSON.parse(fs.readFileSync(path.join(root,'examples/tide-archive.yejian.json'),'utf8')),book=backup.book;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;

test('the original 101506 character manuscript, 36 chapters, 32 people and planning examples remain unchanged',()=>{
  assert.equal(sha(fs.readFileSync(path.join(root,'examples/潮汐档案馆.txt'))),'6aee9103c98a04ea6b79e8184aa372fb9366fc298b716560def609cdd2e9878b');
  assert.equal(book.chapters.length,36);assert.equal(book.volumes.length,6);assert.equal(book.notes.filter(item=>item.type==='人物').length,32);
  assert.equal(book.chapters.reduce((sum,chapter)=>sum+Array.from(chapter.body).filter(char=>!(/\s/u.test(char))).length,0),101506);
  assert.equal(sha(book.chapters.map(chapter=>chapter.id+'\0'+chapter.title+'\0'+chapter.body+'\0'+chapter.volumeId+'\n').join('')),'74a803a3b9a6fcbe8c0382f837ed03aeda22ec51af7c380f7e21c7459880681b');
  assert.equal(book.storyTools.foreshadows.length,12);assert.equal(book.storyTools.timeline.length,18);
  const original={...book};delete original.reviewTools;assert.equal(sha(JSON.stringify(ordered(original))),'c58e484b9e0b8afd72b431e819bbec5db99ec8f3fbe146f9c11db30537bad470','Every existing JSON value remains unchanged');
});

test('each of six volumes has one bookmark anchored to the full real first paragraph of its first chapter',()=>{
  const tools=book.reviewTools;assert.equal(tools.version,1);assert.deepEqual(tools.dictionary,[]);assert.equal(tools.bookmarks.length,6);
  book.volumes.forEach((volume,index)=>{const chapter=book.chapters.find(item=>item.volumeId===volume.id&&!item.deletedAt),mark=tools.bookmarks[index];assert.equal(mark.chapterId,chapter.id);assert.equal(mark.quote,chapter.body.split('\n\n').find(part=>part.trim()));assert.equal(mark.start,0);assert.ok(mark.label.includes(volume.title));});
});

test('three annotation examples have accurate UTF16 quotes and context, stable unique ids and one resolved reminder',()=>{
  const tools=book.reviewTools;assert.equal(tools.annotations.length,3);assert.equal(tools.annotations.filter(item=>item.resolved).length,1);const ids=new Set();
  for(const mark of [...tools.annotations,...tools.bookmarks]){const chapter=book.chapters.find(item=>item.id===mark.chapterId);assert.ok(chapter);assert.ok(!ids.has(mark.id));ids.add(mark.id);assert.equal(mark.status,'linked');assert.equal(chapter.body.slice(mark.start,mark.end),mark.quote);assert.equal(mark.quote.length,mark.end-mark.start);assert.equal(mark.prefix,chapter.body.slice(Math.max(0,mark.start-64),mark.start));assert.equal(mark.suffix,chapter.body.slice(mark.end,mark.end+64));assert.ok(mark.prefix.length<=64);assert.ok(mark.suffix.length<=64);assert.equal(mark.createdAt,'2026-10-15T00:00:00Z');assert.equal(mark.updatedAt,mark.createdAt);}
  for(const mark of tools.annotations){assert.ok(mark.body.includes('核对')||mark.body.includes('复核')||mark.body.includes('检查'));assert.ok(mark.quote.length>20);}
});
