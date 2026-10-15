'use strict';

// A deliberately small offline rule set. Literary choices are suggestions,
// never automatic edits; names and the author's dictionary take precedence.
(function(global){
  const SPELLING = Object.freeze([
    ['迫不急待','迫不及待'], ['再接再励','再接再厉'], ['一愁莫展','一筹莫展'],
    ['穿流不息','川流不息'], ['相形见拙','相形见绌'], ['不径而走','不胫而走'],
    ['谈笑风声','谈笑风生'], ['走头无路','走投无路'], ['随声附合','随声附和'],
    ['按步就班','按部就班'], ['脍灸人口','脍炙人口'], ['默守成规','墨守成规'],
    ['天翻地复','天翻地覆'], ['言简意骇','言简意赅'], ['萎糜不振','萎靡不振'],
    ['甘败下风','甘拜下风'], ['弱不经风','弱不禁风'], ['趁心如意','称心如意'],
    ['悬梁刺骨','悬梁刺股'], ['一如继往','一如既往']
  ]);
  const MAX_FINDINGS=5000,MAX_DICTIONARY=500;
  const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const codepoints=text=>{let size=0;for(const char of text)size++;return size;};
  function dictionaryWords(book){
    const authored=book.reviewTools?.dictionary||[],names=(book.notes||[]).filter(note=>note.type==='人物'&&!note.deletedAt).flatMap(note=>[note.title,...(Array.isArray(note.aliases)?note.aliases:[])]);
    return [...new Set([...authored,...names].filter(word=>typeof word==='string'&&word.trim().length>=1&&Array.from(word).length<=100).map(word=>word.trim()))];
  }
  const STYLE_RULES=Object.freeze([
    {id:'redundant-expression',expression:/(?:目前现在|首先第一|亲眼目睹|完全彻底|非常十分|十分非常|又再次|再一次重新|最首要|唯一的一个)/gu,label:'可能冗余的表达',detail:'检查相邻词语是否重复表达同一意思；修辞性强调可以保留。'},
    {id:'approximate-redundancy',expression:/(?:大约|大概|约莫|估计)[^\n。！？；，,!?;]{1,18}(?:左右|上下)/gu,label:'约数表达可能重复',detail:'约数词和“左右／上下”同时使用，确认是否需要保留两处。'},
    {id:'reason-redundancy',expression:/之所以[^\n。！？；!?;]{1,60}(?:原因是因为|是由于因为|是因为由于)/gu,label:'因果表达可能重复',detail:'检查因果关联词是否叠用，按原意自行调整。'},
    {id:'missing-subject',expression:/(?:由于|通过)[^\n。！？；!?;]{1,60}[，,](?:使得|使|让)[^\n。！？；!?;]{1,30}/gu,label:'句子主语可能不明确',detail:'检查介词结构与“使／让”连用时，句子是否有明确主语。'},
    {id:'double-negative',expression:/(?:避免|防止|杜绝)[^\n。！？；!?;]{0,30}(?:不再|不再不|不会|不能)[^\n。！？；!?;]{1,20}/gu,label:'否定关系需确认',detail:'检查“避免／防止”与否定词叠用后，是否表达了相反意思。'}
  ]);
  function scanChapters(chapters,{dictionary=[],protectedNames=[],people=[],maxFindings=MAX_FINDINGS}={}){
    const limit=Math.max(1,Math.min(MAX_FINDINGS,Number(maxFindings)||MAX_FINDINGS)),findings=[];
    const words=[...new Set([...dictionary,...protectedNames].filter(word=>typeof word==='string'&&word.length>=1&&Array.from(word).length<=100))].sort((a,b)=>b.length-a.length);
    const protection=words.length?new RegExp('(?=('+words.map(escape).join('|')+'))','gu'):null,maxWordUnits=words.reduce((size,word)=>Math.max(size,word.length),0),chapterOrder=new Map(chapters.map((chapter,index)=>[chapter.id,index]));
    const named=new Map();for(const person of people)for(const name of uniqueNames(person.names)){if(!named.has(name))named.set(name,new Set());named.get(name).add(person.id);}
    const namesPattern=people.length>1&&named.size?new RegExp([...named.keys()].sort((a,b)=>b.length-a.length).map(escape).join('|'),'gu'):null;
    let truncated=false;
    for(const chapter of chapters){
      if(chapter.deletedAt||typeof chapter.body!=='string')continue;
      const body=chapter.body;
      function protectedAt(start,end){
        if(!protection)return false;
        // Inspect only this finding's small neighbourhood. A single-character
        // dictionary entry must not allocate millions of protected ranges.
        const offset=Math.max(0,start-maxWordUnits+1),nearby=body.slice(offset,Math.min(body.length,end+maxWordUnits-1));protection.lastIndex=0;
        for(const match of nearby.matchAll(protection))if(offset+match.index<=start&&offset+match.index+match[1].length>=end)return true;
        return false;
      }
      function add(rule,start,end,label,replacement=null,detail=''){
        if(protectedAt(start,end))return;
        if(findings.length>=limit){truncated=true;return;}
        findings.push({id:chapter.id+':'+rule+':'+start+':'+end,chapterId:chapter.id,rule,start,end,text:body.slice(start,end),label,replacement,detail,fixable:typeof replacement==='string',before:body.slice(Math.max(0,start-35),start),after:body.slice(end,end+35)});
      }
      for(const [wrong,right] of SPELLING){
        for(const match of body.matchAll(new RegExp(escape(wrong),'gu'))){add('spelling',match.index,match.index+wrong.length,'常见错词',right);if(truncated)break;}
        if(truncated)break;
      }
      if(truncated)break;
      for(const rule of STYLE_RULES){
        for(const match of body.matchAll(rule.expression)){add(rule.id,match.index,match.index+match[0].length,rule.label,null,rule.detail);if(truncated)break;}
        if(truncated)break;
      }
      if(truncated)break;
      // A referent warning requires two distinct *authored* people in the
      // same sentence. Dictionary entries are never treated as people, and
      // aliases of one person do not manufacture a second candidate.
      if(namesPattern){
        for(const sentence of body.matchAll(/[^\n。！？!?]{1,300}(?:[。！？!?]|$)/gu)){
          const text=sentence[0],pronouns=[...text.matchAll(/[，,：:]\s*([他她其])(?=[^们])/gu)];
          if(!pronouns.length)continue;const appearances=[...text.matchAll(namesPattern)];
          for(const pronoun of pronouns){const candidates=new Set();for(const appearance of appearances){if(appearance.index>=pronoun.index)break;for(const id of named.get(appearance[0]))candidates.add(id);}if(candidates.size<2)continue;const start=sentence.index+pronoun.index+pronoun[0].lastIndexOf(pronoun[1]);add('ambiguous-reference',start,start+1,'人称指代可能不清',null,'同一句出现多位人物，确认代词具体指向谁。');if(truncated)break;}
          if(truncated)break;
        }
      }
      if(truncated)break;
      // Restrict repetition to function phrases. 哈哈、咚咚、重叠修辞和省略号
      // remain untouched; even these repeated phrases only receive a warning.
      for(const match of body.matchAll(/(但是|然后|而且|因为|所以|已经|正在|仍然|他们|她们|我们|你们|他的|她的|我的|你的|这个|那个|这时|此时|于是|却又)(?:[ \t]*)\1/gu)){
        add('repeated-word',match.index,match.index+match[0].length,'可能重复的词语');if(truncated)break;
      }
      if(truncated)break;
      for(const match of body.matchAll(/([，、；：。,;:])\1+/gu)){
        add('repeated-punctuation',match.index,match.index+match[0].length,'可能重复的标点');if(truncated)break;
      }
      if(truncated)break;
      const pairs={'“':'”','‘':'’','「':'」','『':'』','（':'）','【':'】','《':'》','〈':'〉','(' : ')','[':']','{':'}'},closing=new Set(Object.values(pairs)),stack=[];
      let pairingOverflow=false,asciiQuote=null;
      for(let index=0;index<body.length;index++){
        const char=body[index];
        if(char==='"'){let slashes=0;for(let before=index-1;before>=0&&body[before]==='\\';before--)slashes++;if(slashes%2===0)asciiQuote=asciiQuote===null?index:null;}
        if(char==='’'&&/[\p{Script=Latin}]/u.test(body[index-1]||'')&&/[\p{Script=Latin}]/u.test(body[index+1]||''))continue;
        if(pairs[char]){if(stack.length>=256){add('nesting',index,index+1,'引号或括号嵌套过深，请人工检查');pairingOverflow=true;break;}stack.push({char,index});}
        else if(closing.has(char)){
          if(stack.at(-1)&&pairs[stack.at(-1).char]===char)stack.pop();
          else{add('unpaired',index,index+1,'引号或括号未配对');if(truncated)break;}
        }
      }
      if(truncated)break;
      if(asciiQuote!==null&&!pairingOverflow)add('unpaired',asciiQuote,asciiQuote+1,'引号或括号未配对');
      for(const item of pairingOverflow?[]:stack){add('unpaired',item.index,item.index+1,'引号或括号未配对');if(truncated)break;}
      if(truncated)break;
      // ASCII punctuation between Chinese words can be deliberate. Do not
      // touch numbers, URL punctuation, English prose, ellipses or emoticons.
      for(const match of body.matchAll(/[\p{Script=Han}][ \t]*([,:;!?])[ \t]*(?=[\p{Script=Han}])/gu)){
        const offset=match.index+match[0].indexOf(match[1]);add('mixed-punctuation',offset,offset+1,'中文段落中的英文标点');if(truncated)break;
      }
      if(truncated)break;
    }
    findings.sort((a,b)=>chapterOrder.get(a.chapterId)-chapterOrder.get(b.chapterId)||a.start-b.start||a.end-b.end);
    return{findings,truncated,limit};
  }
  function preview(book,{chapterId=null,revision=null,maxFindings}={}){
    const active=(book.chapters||[]).filter(chapter=>!chapter.deletedAt),scope=chapterId?active.filter(chapter=>chapter.id===chapterId):active;
    if(chapterId&&!scope.length)throw new Error('正文已变化，请重新校对。');
    const words=dictionaryWords(book),people=(book.notes||[]).filter(note=>note.type==='人物'&&!note.deletedAt).map(note=>({id:note.id,names:[note.title,...(note.aliases||[])]})),result=scanChapters(scope,{dictionary:words,people,maxFindings});
    return{bookId:book.id,revision,scope:chapterId,sources:scope.map(chapter=>({id:chapter.id,body:chapter.body})),protection:JSON.stringify(words),...result};
  }
  function assertCurrent(book,plan,revision=plan.revision){
    const active=(book.chapters||[]).filter(chapter=>!chapter.deletedAt),scope=plan.scope?active.filter(chapter=>chapter.id===plan.scope):active;
    if(book.id!==plan.bookId||(plan.revision!==null&&revision!==plan.revision)||scope.length!==plan.sources.length||plan.sources.some(source=>!scope.some(chapter=>chapter.id===source.id&&chapter.body===source.body))||JSON.stringify(dictionaryWords(book))!==plan.protection)throw new Error('正文已变化，请重新校对。');
    return scope;
  }
  function applySelected(book,plan,selected,{revision=plan.revision}={}){
    assertCurrent(book,plan,revision);const ids=new Set(selected),changes=new Map();let total=0;
    for(const finding of plan.findings){if(!ids.has(finding.id)||!finding.fixable)continue;if(!changes.has(finding.chapterId))changes.set(finding.chapterId,[]);changes.get(finding.chapterId).push(finding);}
    const bodies=new Map();
    for(const [id,findings] of changes){
      const chapter=book.chapters.find(item=>item.id===id),ordered=[...findings].sort((a,b)=>a.start-b.start);let cursor=0,projected=codepoints(chapter.body),parts=[];
      for(const finding of ordered){
        if(finding.start<cursor||chapter.body.slice(finding.start,finding.end)!==finding.text)throw new Error('正文已变化，请重新校对。');
        projected+=codepoints(finding.replacement)-codepoints(finding.text);cursor=finding.end;
      }
      if(projected>(book.kind==='short'?25000000:5000000))throw new Error('修正后正文过长，请缩小范围。');
      cursor=0;for(const finding of ordered){parts.push(chapter.body.slice(cursor,finding.start),finding.replacement);cursor=finding.end;total++;}parts.push(chapter.body.slice(cursor));bodies.set(id,parts.join(''));
    }
    const candidate={...book,chapters:book.chapters.map(chapter=>bodies.has(chapter.id)?{...chapter,body:bodies.get(chapter.id)}:chapter)};
    if(new TextEncoder().encode(JSON.stringify(candidate)).length>25*1024*1024)throw new Error('修正后作品超过 25 MB，请缩小范围。');
    for(const chapter of book.chapters)if(bodies.has(chapter.id))chapter.body=bodies.get(chapter.id);
    return total;
  }
  function uniqueNames(names){return[...new Set((names||[]).filter(name=>typeof name==='string'&&name.trim()&&Array.from(name).length<=100).map(name=>name.trim()))];}
  const model={SPELLING,STYLE_RULES,MAX_FINDINGS,MAX_DICTIONARY,dictionaryWords,scanChapters,preview,assertCurrent,applySelected};
  if(typeof module==='object'&&module.exports)module.exports=model;else global.LocalProofreadingModel=model;
})(typeof window==='undefined'?globalThis:window);
