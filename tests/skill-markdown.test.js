'use strict';

const assert=require('node:assert/strict'),{test}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {render}=require('../public/skill-markdown.js');

class Node{
  constructor(document,tag,value=''){this.ownerDocument=document;this.tagName=tag;this.value=value;this.children=[];this.dataset={};this.attributes={};this.listeners={};}
  append(...nodes){for(const node of nodes){assert.ok(node instanceof Node);this.children.push(node);node.parentElement=this;}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){assert.ok(!/^(?:on|src|href)/i.test(name),'The reader cannot set active URL or event attributes');this.attributes[name]=String(value);}
  addEventListener(name,callback){this.listeners[name]=callback;}
  get textContent(){return this.tagName==='#text'?this.value:this.children.map(node=>node.textContent).join('');}
  set innerHTML(_){throw Error('Markdown must never pass through HTML parsing');}
}
function harness(){
  const document={createElement(tag){assert.ok(!['script','img','iframe','style','object','embed','a'].includes(tag),'No executable or networking elements');return new Node(document,tag);},createTextNode:value=>new Node(document,'#text',String(value))};
  return new Node(document,'div');
}
function all(node,tag){return node.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...all(child,tag)]);}
function read(markdown,options){const host=harness(),result=render(host,markdown,options);return{host,result,article:host.children[0]};}

test('Skill details render headings, paragraphs and emphasis while hiding only a leading YAML header',()=>{
  const {article}=read('\uFEFF---\r\nname: test\r\ndescription: hidden metadata\r\n---\r\n# 写作规则\r\n\r\n普通 **重点** 和 *细节*、`原样`。\r\n继续说明。\r\n\r\n## 检查\r\n\r\n---\r\nname: 保留正文\r\n---');
  assert.equal(article.tagName,'article');assert.equal(article.className,'writing-skill-markdown');
  assert.deepEqual(all(article,'h1').map(node=>node.textContent),['写作规则']);
  assert.deepEqual(all(article,'h2').map(node=>node.textContent),['检查','name: 保留正文']);
  assert.deepEqual(all(article,'strong').map(node=>node.textContent),['重点']);
  assert.deepEqual(all(article,'em').map(node=>node.textContent),['细节']);
  assert.deepEqual(all(article,'code').map(node=>node.textContent),['原样']);
  assert.ok(article.textContent.includes('继续说明。'));assert.ok(!article.textContent.includes('hidden metadata'));assert.ok(article.textContent.includes('保留正文'));
});

test('ordered and nested lists, quotations, rules and fenced code remain readable blocks',()=>{
  const {article}=read('# 标题\n\n- 一项\n  - 内层 **重点**\n  - 另一项\n- 二项\n\n3. 第三项\n4. 第四项\n\n> 引文\n>\n> - 引文中的项目\n\n***\n\n```js\n<script>alert(1)</script>\n**原样代码**\n```\n\n收尾');
  assert.equal(all(article,'ul').length,3);assert.equal(all(article,'ol').length,1);assert.equal(all(article,'ol')[0].attributes.start,'3');
  assert.equal(all(article,'li').length,7);assert.equal(all(article,'blockquote').length,1);assert.equal(all(article,'hr').length,1);
  const code=all(article,'pre')[0].children[0];assert.equal(code.className,'language-js');assert.equal(code.textContent,'<script>alert(1)</script>\n**原样代码**');
  assert.equal(all(article,'strong').length,1);assert.equal(all(article,'p').at(-1).textContent,'收尾');
});

test('local Markdown references call the parent viewer without browser navigation or fetching images',()=>{
  const references=[],{article}=read('[大纲](references/小说-大纲.md) 和 [上一级](../world.md#地点)\n\n[网站](https://example.org) [危险](javascript:alert(1)) [根目录](/private.md) [协议](//bad.test/a.md) [反斜线](..\\private.md)\n\n![人物照片](https://bad.test/person.png)',{onReference:href=>references.push(href)});
  const buttons=all(article,'button');assert.equal(buttons.length,2);assert.deepEqual(buttons.map(button=>button.dataset.reference),['references/小说-大纲.md','../world.md#地点']);
  let prevented=0;buttons.forEach(button=>{assert.equal(button.type,'button');button.listeners.click({preventDefault(){prevented++;}});});
  assert.equal(prevented,2);assert.deepEqual(references,['references/小说-大纲.md','../world.md#地点']);assert.ok(article.textContent.includes('人物照片'));assert.ok(!article.textContent.includes('https://bad.test'));
  assert.equal(all(article,'a').length,0);assert.equal(all(article,'img').length,0);assert.equal(all(article,'script').length,0);
  assert.equal(all(read('[参考](references/world.md)').article,'button').length,0,'A viewer without a reference handler cannot navigate');
});

test('raw HTML, SVG and event payloads are only visible text, including code spans and escaped Markdown',()=>{
  const attack='<img src="https://bad.test/pixel" onerror="alert(1)"><script>globalThis.pwned=true</script><svg onload="alert(2)"></svg>';
  const {article}=read(attack+'\n\n`'+attack+'`\n\n\\*星号\\*与名称_a_b、**粗体**、\\[括号\\]、` a `。');
  assert.ok(article.textContent.includes(attack));assert.equal(all(article,'code')[0].textContent,attack);assert.equal(all(article,'code')[1].textContent,'a');
  assert.ok(article.textContent.includes('*星号*与名称_a_b'));assert.ok(article.textContent.includes('[括号]'));assert.equal(all(article,'em').length,0);assert.equal(all(article,'strong')[0].textContent,'粗体');assert.equal(globalThis.pwned,undefined);
});

test('tables handle alignment, inline code pipes and escaped pipes without creating resource nodes',()=>{
  const {article}=read('| 人物 | 状态 | 备注 |\n| :--- | :---: | ---: |\n| 沈砚 | **调查** | `a|b` |\n| 江临 | 保密 | 字面 \\| 符号 |');
  assert.equal(all(article,'table').length,1);assert.equal(all(article,'tr').length,3);assert.equal(all(article,'th')[1].dataset.align,'center');assert.equal(all(article,'th')[2].dataset.align,'right');
  assert.equal(all(article,'td')[2].textContent,'a|b');assert.equal(all(article,'td')[5].textContent,'字面 | 符号');assert.equal(all(article,'strong')[0].textContent,'调查');
});

test('unclosed metadata and literal markers stay visible, and successive renders replace the document',()=>{
  const host=harness();render(host,'---\nname: 未关闭\n\n# 标题');assert.ok(host.textContent.includes('name: 未关闭'));
  render(host,'---\n普通正文\n---\n\n未闭合 [链接 **星号 `代码\n\n<https://example.org>');
  assert.equal(host.children.length,1);assert.ok(host.textContent.includes('普通正文'));assert.ok(host.textContent.includes('未闭合 [链接 **星号 `代码'));assert.ok(host.textContent.includes('<https://example.org>'));
  render(host,'清空旧文');assert.equal(host.textContent,'清空旧文');assert.equal(all(host,'hr').length,0);
});

test('all bundled rules and references are rendered as readable documents without exposing frontmatter',()=>{
  const root=path.join(__dirname,'..','bundled-skills'),files=[];
  function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(file.endsWith('.md'))files.push(file);}}
  visit(root);assert.equal(files.length,18);
  for(const file of files){const markdown=fs.readFileSync(file,'utf8'),{article,result}=read(markdown,{onReference(){}});assert.ok(all(article,'h1').length>0,path.relative(root,file));assert.ok(article.textContent.length>20);assert.equal(result.truncated,false);assert.equal(result.plainRemainder,false);if(file.endsWith('SKILL.md'))assert.ok(!article.textContent.includes('description:'));}
});

test('large or adversarial documents have a bounded DOM and preserve the remaining text cheaply',()=>{
  const many=('**一** *二* `三`\n\n').repeat(12000),began=performance.now(),{result,article}=read(many);
  assert.ok(result.nodes<MAX_REASONABLE_NODES);assert.equal(result.plainRemainder,true);assert.equal(result.truncated,false);assert.ok(article.textContent.endsWith('**一** *二* `三`\n\n'),'The unformatted tail remains available');
  const pathological='['.repeat(110000)+'](broken target)'+('* '.repeat(50000));read(pathological);assert.ok(performance.now()-began<5000,'A 256 KB document should not cause quadratic token scans');
  const oversize=read('字'.repeat(300000));assert.equal(oversize.result.truncated,true);assert.ok(oversize.article.textContent.length<=262145);
});
const MAX_REASONABLE_NODES=12100;
