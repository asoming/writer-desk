'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const model=require('../public/local-proofreading-model.js');
const make=(body='他迫不急待。再接再励。')=>({id:'proof-book',kind:'long',chapters:[{id:'one',title:'第一章',body,deletedAt:null},{id:'two',title:'第二章',body:'他走头无路。',deletedAt:null},{id:'trash',body:'迫不急待',deletedAt:'2026-10-15'}],notes:[],reviewTools:{dictionary:[],annotations:[],bookmarks:[]}});
test('offline rules expose safe corrections but keep literary warnings read-only',()=>{
  const book=make('他迫不急待，然后然后笑了，，“没有闭合。中文,标点。');const plan=model.preview(book,{revision:4});
  assert.ok(plan.findings.some(item=>item.text==='迫不急待'&&item.replacement==='迫不及待'));
  assert.ok(plan.findings.some(item=>item.rule==='repeated-word'&&!item.fixable));assert.ok(plan.findings.some(item=>item.rule==='repeated-punctuation'&&!item.fixable));assert.ok(plan.findings.some(item=>item.rule==='unpaired'&&!item.fixable));assert.ok(plan.findings.some(item=>item.rule==='mixed-punctuation'&&!item.fixable));
  assert.equal(plan.findings.some(item=>item.chapterId==='trash'),false);assert.equal(model.applySelected(book,plan,plan.findings.map(item=>item.id),{revision:4}),2);assert.equal(book.chapters[0].body,'他迫不及待，然后然后笑了，，“没有闭合。中文,标点。');assert.equal(book.chapters[2].body,'迫不急待');
});
test('balanced nesting, literary sound repetition, ellipses, numbers, English and URLs have no warnings',()=>{
  const body='“哈哈，咚咚……她笑着说：‘好。’”「行。」（见【记录《序言》】）\nEnglish, prose; yes! Count 3.14, price 10:20, https://example.com/path?a=1.\n他……嗯……走了。真是！！太好了？！';assert.deepEqual(model.scanChapters([{id:'a',body}]).findings,[]);
});
test('dictionary and existing person names/aliases protect complete terms without single-character overreach',()=>{
  const book=make('迫不急待。王再接再励。走头无路。');book.reviewTools.dictionary=['迫','走头无路'];book.notes=[{type:'人物',title:'王再接再励',aliases:['迫不急待'],deletedAt:null}];let plan=model.preview(book);assert.equal(plan.findings.filter(item=>item.chapterId==='one').length,0);
  book.notes[0].deletedAt='2026';plan=model.preview(book);assert.equal(plan.findings.filter(item=>item.chapterId==='one'&&item.rule==='spelling').length,2);assert.ok(plan.findings.some(item=>item.text==='迫不急待'));
});
test('current-chapter scope leaves other chapters and Unicode offsets exact',()=>{
  const book=make('🐈迫不急待。迫不急待。');const plan=model.preview(book,{chapterId:'one',revision:2}),hit=plan.findings[0];assert.equal(hit.start,2);assert.equal(book.chapters[0].body.slice(hit.start,hit.end),'迫不急待');assert.equal(model.applySelected(book,plan,[hit.id],{revision:2}),1);assert.equal(book.chapters[0].body,'🐈迫不及待。迫不急待。');assert.equal(book.chapters[1].body,'他走头无路。');
});
test('stale book, revision, source, deleted chapter or changed dictionary cannot partially apply',()=>{
  for(const mode of ['book','revision','source','deleted','dictionary']){const book=make(),plan=model.preview(book,{revision:2});let revision=2;if(mode==='book')book.id='other';if(mode==='revision')revision=3;if(mode==='source')book.chapters[1].body+='新稿';if(mode==='deleted')book.chapters[1].deletedAt='2026';if(mode==='dictionary')book.reviewTools.dictionary=['新的词'];const before=structuredClone(book);assert.throws(()=>model.applySelected(book,plan,plan.findings.map(item=>item.id),{revision}),/重新校对/,mode);assert.deepEqual(book,before);}
});
test('warning-only selections and missing IDs never mutate prose',()=>{const book=make('然后然后，，“失配'),plan=model.preview(book,{chapterId:'one'}),before=structuredClone(book);assert.equal(model.applySelected(book,plan,[...plan.findings.map(item=>item.id),'absent']),0);assert.deepEqual(book,before);});
test('scan is bounded and handles a high frequency single-character dictionary without large range allocation',()=>{const book=make('的'.repeat(100000)+'迫不急待。'.repeat(6000));book.reviewTools.dictionary=['的'];const plan=model.preview(book,{chapterId:'one'});assert.equal(plan.findings.length,5000);assert.equal(plan.truncated,true);assert.equal(plan.findings[0].start,100000);});
test('chapter and book capacity guard checks all changes before mutating',()=>{const book=make('甲'.repeat(5000000)+'迫不急待'),plan=model.preview(book);const before=book.chapters[0].body;assert.throws(()=>model.applySelected(book,plan,plan.findings.map(item=>item.id)),/正文过长/);assert.equal(book.chapters[0].body,before);const huge=make();huge.other='甲'.repeat(9000000);const full=model.preview(huge),source=structuredClone(huge);assert.throws(()=>model.applySelected(huge,full,full.findings.map(item=>item.id)),/25 MB/);assert.deepEqual(huge,source);});
test('100k-character sample stays intact; isolated seeded copy exercises safe repairs and protected names',()=>{
  const sample=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/tide-archive.yejian.json'),'utf8')).book,before=JSON.stringify(sample),start=performance.now(),plan=model.preview(sample);
  assert.equal(sample.chapters.filter(item=>!item.deletedAt).length,36);assert.equal(sample.volumes.filter(item=>!item.deletedAt).length,6);assert.equal(JSON.stringify(sample),before);assert.ok(performance.now()-start<10000);assert.ok(plan.findings.every(item=>sample.chapters.find(chapter=>chapter.id===item.chapterId).body.slice(item.start,item.end)===item.text));
  const isolated=structuredClone(sample),chapter=isolated.chapters.find(item=>!item.deletedAt);chapter.body+='\n\n他迫不急待，又一愁莫展。然后然后，，“这句没闭合';isolated.reviewTools={dictionary:['一愁莫展'],annotations:[],bookmarks:[]};const seeded=model.preview(isolated,{chapterId:chapter.id}),newFixes=seeded.findings.filter(item=>item.fixable&&item.start>=sample.chapters.find(item=>item.id===chapter.id).body.length);
  assert.equal(newFixes.length,1);assert.equal(newFixes[0].text,'迫不急待');model.applySelected(isolated,seeded,newFixes.map(item=>item.id));assert.ok(chapter.body.endsWith('他迫不及待，又一愁莫展。然后然后，，“这句没闭合'));assert.equal(isolated.chapters.length,36);assert.equal(JSON.stringify(sample),before);
});

test('ASCII double quotes pair safely, escaped quotes and apostrophes stay literal, deep nesting is bounded',()=>{const paired=model.scanChapters([{id:'a',body:'He said \"hello\". Don’t change apostrophes. \"escaped \\\" quotation\".'}]);assert.equal(paired.findings.length,0);const broken=model.scanChapters([{id:'a',body:'He said \"hello.'}]);assert.equal(broken.findings.length,1);assert.equal(broken.findings[0].text,'\"');const nested=model.scanChapters([{id:'a',body:'（'.repeat(100000)}]);assert.equal(nested.findings.length,1);assert.equal(nested.findings[0].rule,'nesting');assert.equal(nested.findings[0].fixable,false);});

test('overlapping dictionary entries and regular-expression characters protect full literal terms',()=>{const book=make('甲乙迫不急待。[再接再励]。');book.reviewTools.dictionary=['甲乙','乙迫不急待','[再接再励]'];const result=model.preview(book,{chapterId:'one'});assert.equal(result.findings.length,0);});

test('advanced offline suggestions are deterministic and never rewrite grammar or literary emphasis',()=>{
  const book=make('🌊目前现在他亲眼目睹了这一切。大约三十人左右。之所以失败，原因是因为太急。由于他离开，使得屋里安静了。避免这件事不会再次发生。'),before=structuredClone(book),plan=model.preview(book,{chapterId:'one'});
  for(const rule of ['redundant-expression','approximate-redundancy','reason-redundancy','missing-subject','double-negative'])assert.ok(plan.findings.some(item=>item.rule===rule),rule);
  assert.ok(plan.findings.every(item=>!item.fixable&&typeof item.detail==='string'&&item.detail));assert.equal(plan.findings.find(item=>item.text==='目前现在').start,2);
  assert.equal(model.applySelected(book,plan,plan.findings.map(item=>item.id)),0);assert.deepEqual(book,before);assert.deepEqual(model.preview(book,{chapterId:'one'}),plan);
});

test('ambiguous references require two distinct authored people; aliases and dictionary terms do not invent candidates',()=>{
  const book=make('沈砚对江宁说，他会留下。沈砚看见阿砚，他笑了。甲乙来到码头，他放下包。');
  book.notes=[{id:'shen',type:'人物',title:'沈砚',aliases:['阿砚'],deletedAt:null},{id:'jiang',type:'人物',title:'江宁',aliases:[],deletedAt:null}];book.reviewTools.dictionary=['甲乙'];
  const plan=model.preview(book,{chapterId:'one'}),references=plan.findings.filter(item=>item.rule==='ambiguous-reference');assert.equal(references.length,1);assert.equal(references[0].text,'他');assert.equal(references[0].fixable,false);assert.equal(references[0].start,7);
  book.notes[1].deletedAt='2026';assert.equal(model.preview(book,{chapterId:'one'}).findings.some(item=>item.rule==='ambiguous-reference'),false);
});

test('dictionary and character aliases still protect complete advanced-rule phrases',()=>{
  const book=make('目前现在。亲眼目睹。大约三人左右。沈砚对江宁说，他会留下。');book.notes=[{id:'a',type:'人物',title:'沈砚',aliases:['目前现在'],deletedAt:null},{id:'b',type:'人物',title:'江宁',aliases:[],deletedAt:null}];book.reviewTools.dictionary=['亲眼目睹','大约三人左右','他'];assert.deepEqual(model.preview(book,{chapterId:'one'}).findings,[]);
});
