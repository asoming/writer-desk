'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
require(path.resolve(__dirname, '../public/story-analysis.js'));
const { analyzeBook } = globalThis.WriterAnalysis;

function person(id, title, aliases = []) {
  return { id, title, aliases, type: '人物', chapterIds: ['manual-link'], deletedAt: null };
}
function chapter(id, body, extra = {}) {
  return { id, title: id, body, deletedAt: null, ...extra };
}
function freezeDeep(object) {
  if (!object || typeof object !== 'object') return object;
  Object.freeze(object);
  Object.values(object).forEach(freezeDeep);
  return object;
}

const book = freezeDeep({
  notes: [person('zhou', '林舟', ['小舟']), person('mother', '林母', '母亲，娘亲'),
    person('chen', '陈河'), { ...person('archived', '李云'), deletedAt: '2026-01-01' },
    { id: 'place', title: '雾港', type: '地点', chapterIds: [] }],
  chapters: [
    chapter('one', '林舟抬头望着雾港，母亲站在门口。陈河说：“回来啦。”王明问：“信呢？”王明说：“先别着急。”'),
    chapter('two', '小舟看向陈河。王明递来信封，李小雨笑着离开。'),
    chapter('three', '娘亲问林舟：“走吗？”'),
    chapter('deleted', '李云说话，孙宁问候。林舟与陈河也在这里。', { deletedAt: '2026-01-01' })
  ],
  relations: [{ id: 'manual', fromId: 'mother', toId: 'zhou', deletedAt: null }]
});
const before = JSON.stringify(book);
const result = analyzeBook(book);
assert.deepEqual(result.appearances, { zhou: ['one', 'two', 'three'], mother: ['one', 'three'], chen: ['one', 'two'] });
assert.equal(JSON.stringify(book), before, 'analysis leaves all source data and manual links unchanged');
assert.deepEqual(result.cooccurrences, [
  { fromId: 'chen', toId: 'mother', chapterIds: ['one'] },
  { fromId: 'chen', toId: 'zhou', chapterIds: ['one', 'two'] }
]);
assert.deepEqual(result.candidates.map(candidate => [candidate.name, candidate.chapterIds]), [
  ['王明', ['one']]
]);
assert.equal(result.candidates[0].excerpts.length, 1, 'one excerpt per chapter, rather than repeated mentions');
assert.ok(result.candidates[0].excerpts[0].text.includes('王明问'));
assert.ok(!result.candidates.some(candidate => ['林舟', '陈河', '小舟', '孙宁'].includes(candidate.name)));

assert.deepEqual(analyzeBook({ chapters: [chapter('plain', '雨落在窗上。屋里只有脚步声，没有人开口。')] }), {
  appearances: {}, cooccurrences: [], candidates: [], ambiguous: []
}, 'unnamed prose must not invent a person');
assert.deepEqual(analyzeBook({ chapters: [chapter('words', '高兴笑了。白衣走来，林间站着一棵树。于是李明说话。赵长名字说话。')] }).candidates, [],
  'common words and suffixes of longer Chinese runs are not candidates');
assert.deepEqual(analyzeBook({ chapters: [chapter('compound', '欧阳青问：“什么？”司马明月抬头。')] }).candidates.map(item => item.name),
  ['欧阳青'], 'compound surnames work without treating the final surname character as a fresh boundary');

const archivedRelation = analyzeBook({
  notes: [person('a', '阿青', ['青儿']), person('b', '林宁')],
  chapters: [chapter('active', '青儿望向林宁。')],
  relations: [{ fromId: 'b', toId: 'a', deletedAt: '2026-01-01' }]
});
assert.deepEqual(archivedRelation.cooccurrences, [{ fromId: 'a', toId: 'b', chapterIds: ['active'] }],
  'a deleted manual relationship does not suppress a current suggestion');
const reverseRelation = analyzeBook({
  notes: [person('a', '林青'), person('b', '林宁')],
  chapters: [chapter('active', '林青看向林宁。')],
  relations: [{ fromId: 'b', toId: 'a', deletedAt: null }]
});
assert.equal(reverseRelation.cooccurrences.length, 0, 'manual pair suppression ignores direction');

const candidates = Array.from({ length: 30 }, (_, index) => '赵' + String.fromCharCode(0x4e00 + index) + '说：“来了。”').join('');
assert.equal(analyzeBook({ chapters: [chapter('many', candidates)] }).candidates.length, 20, 'candidate limit is enforced');
const narration = analyzeBook({notes:[person('known','沈砚'),person('prefix','林舟')],chapters:[chapter('narration','沈砚想问。沈砚回答。沈砚又说。终于说完。林舟扬说：“来了。”')]});
assert.deepEqual(narration.candidates.map(item=>item.name),['林舟扬'], 'registered names with narration suffixes do not become new people; distinct three-character names remain candidates');
assert.deepEqual(analyzeBook(null), { appearances: {}, cooccurrences: [], candidates: [], ambiguous: [] });

const overlaps = analyzeBook({
  notes: [person('short', '林舟'), person('long', '小林舟')],
  chapters: [chapter('long-only', '小林舟走进门。'), chapter('both', '小林舟与林舟在门口。')]
});
assert.deepEqual(overlaps.appearances, { short: ['both'], long: ['long-only', 'both'] },
  'the longest name takes precedence over a nested shorter registered name');
const aliasConflict = analyzeBook({
  notes: [person('a', '陈河', ['阿河']), person('b', '陈海', ['阿河']), person('c', '李明')],
  chapters: [chapter('ambiguous', '阿河走向李明。'), chapter('clear', '陈河跟陈海谈起阿河。')]
});
assert.deepEqual(aliasConflict.appearances, { a: ['clear'], b: ['clear'], c: ['ambiguous'] });
assert.deepEqual(aliasConflict.ambiguous, [{ name: '阿河', personIds: ['a', 'b'], chapterIds: ['ambiguous', 'clear'] }]);
assert.deepEqual(aliasConflict.cooccurrences, [{ fromId: 'a', toId: 'b', chapterIds: ['clear'] }],
  'an ambiguous alias does not create a pair or attribute a mention to either owner');

// Many registered names and a long chapter exercise the one-pass name matcher.
const manyPeople = Array.from({ length: 1000 }, (_, index) => person('p' + index, '人物' + index + '号'));
const longText = '安静的房间里只有雨声。'.repeat(50000) + '人物987号停下脚步。';
const start = performance.now();
const large = analyzeBook({ notes: manyPeople, chapters: [chapter('long', longText)] });
assert.deepEqual(large.appearances.p987, ['long']);
assert.equal(Object.values(large.appearances).filter(ids => ids.length).length, 1, 'overlapping numeric names do not produce spurious matches');
console.log('PASS: aliases, appearances, shared chapters, archive filters, manual pairs, candidates, immutability, cap, and long text (' + Math.round(performance.now() - start) + ' ms).');
