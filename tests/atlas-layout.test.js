'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ structuredClone });
for (const file of ['public/vendor/dagre.min.js', 'public/atlas-layout.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}
const { layout } = context.WriterAtlasLayout;

function check(input) {
  const before = JSON.stringify(input);
  const output = layout(input);
  assert.equal(JSON.stringify(input), before, 'Layout must not mutate persisted book data');
  assert.ok(Number.isFinite(output.width) && output.width >= 96);
  assert.ok(Number.isFinite(output.height) && output.height >= 96);
  assert.equal(output.nodes.length, input.nodes.length);
  assert.equal(output.edges.length, input.edges?.length || 0, 'Keep every valid parallel, reverse, and self edge');
  const boxes = new Map(output.nodes.map(node => [node.id, node]));
  for (let index = 0; index < output.nodes.length; index += 1) {
    const node = output.nodes[index];
    assert.ok([node.x, node.y, node.width, node.height].every(Number.isFinite));
    assert.ok(node.x - node.width / 2 >= 47.99 && node.y - node.height / 2 >= 47.99);
    assert.ok(node.x + node.width / 2 <= output.width - 47.99);
    assert.ok(node.y + node.height / 2 <= output.height - 47.99);
    for (const other of output.nodes.slice(index + 1)) {
      const overlapX = (node.width + other.width) / 2 - Math.abs(node.x - other.x);
      const overlapY = (node.height + other.height) / 2 - Math.abs(node.y - other.y);
      assert.ok(overlapX <= 0.001 || overlapY <= 0.001, `Overlapping people: ${node.id} / ${other.id}`);
    }
  }
  for (const edge of output.edges) {
    assert.ok(edge.points.length >= 2);
    assert.ok([edge.labelX, edge.labelY, ...edge.points.flatMap(point => [point.x, point.y])].every(Number.isFinite));
    for (const node of output.nodes) {
      const overlapX = (node.width + edge.labelWidth) / 2 - Math.abs(node.x - edge.labelX);
      const overlapY = (node.height + edge.labelHeight) / 2 - Math.abs(node.y - edge.labelY);
      assert.ok(overlapX <= 0.001 || overlapY <= 0.001, `Relationship label must clear person card: ${edge.id} / ${node.id}`);
    }
    const source = input.edges.find(item => String(item.id) === edge.id);
    for (const [point, nodeId] of [[edge.points[0], source.fromId], [edge.points.at(-1), source.toId]]) {
      const node = boxes.get(String(nodeId));
      const dx = Math.abs(point.x - node.x);
      const dy = Math.abs(point.y - node.y);
      assert.ok(dx <= node.width / 2 + 0.001 && dy <= node.height / 2 + 0.001, `Edge endpoint must touch the correct person: ${edge.id}, ${nodeId}, ${dx}, ${dy}`);
      assert.ok(Math.abs(dx - node.width / 2) <= 0.001 || Math.abs(dy - node.height / 2) <= 0.001, 'Edge endpoint must be on the card boundary');
    }
  }
  assert.equal(JSON.stringify(output), JSON.stringify(layout(input)), 'Same book and filters must produce stable routes');
  return output;
}

check({ nodes: [], edges: [] });
check({ nodes: [{ id: 'one' }], edges: [] });
check({ nodes: [{ id: 'one' }, { id: 'two' }], edges: [] });
check({
  nodes: ['one', 'two', 'three', 'island'].map(id => ({ id, width: 172, height: 72 })),
  edges: [
    { id: 'forward', fromId: 'one', toId: 'two', label: '朋友' },
    { id: 'parallel', fromId: 'one', toId: 'two', label: '共同保守秘密' },
    { id: 'reverse', fromId: 'two', toId: 'one', label: '师徒' },
    { id: 'next', fromId: 'two', toId: 'three', label: '家人' },
    { id: 'cycle', fromId: 'three', toId: 'one', label: '敌对' },
    { id: 'self', fromId: 'three', toId: 'three', label: '内心冲突' },
  ],
});
const horizontal = check({ nodes: [{ id: 'one' }, { id: 'two' }], edges: [{ id: 'edge', fromId: 'one', toId: 'two', label: '伙伴' }], direction: 'LR' });
const vertical = check({ nodes: [{ id: 'one' }, { id: 'two' }], edges: [{ id: 'edge', fromId: 'one', toId: 'two', label: '伙伴' }], direction: 'TB' });
assert.ok(horizontal.nodes[0].x < horizontal.nodes[1].x);
assert.ok(vertical.nodes[0].y < vertical.nodes[1].y);

const book = JSON.parse(fs.readFileSync(path.join(root, 'examples/tide-archive.yejian.json'), 'utf8')).book;
const nodes = book.notes.filter(note => note.type === '人物').map(note => ({ id: note.id, width: 172, height: 72 }));
assert.equal(nodes.length, 32);
const edges = book.relations.map(edge => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, label: edge.label }));
assert.equal(edges.length, 35);
let started = performance.now();
const sample = check({ nodes, edges });
const sampleMs = performance.now() - started;
assert.ok(sample.width > 500 && sample.height > 500);

// Dense co-mentions are opt-in, but they must remain responsive and retain all routes.
const denseEdges = [];
for (let from = 0; from < nodes.length; from += 1) {
  for (let to = from + 1; to < nodes.length; to += 1) {
    if (denseEdges.length === 441) break;
    denseEdges.push({ id: `co-${from}-${to}`, fromId: nodes[from].id, toId: nodes[to].id, label: '' });
  }
}
assert.equal(denseEdges.length, 441);
started = performance.now();
check({ nodes, edges: denseEdges });
const denseMs = performance.now() - started;
assert.ok(denseMs < 10000, `Dense layout unexpectedly slow: ${denseMs.toFixed(0)} ms`);
console.log(`Atlas layout passed: 32 people / 35 relations ${sampleMs.toFixed(0)} ms; 441 co-mentions ${denseMs.toFixed(0)} ms (each includes determinism rerun).`);
