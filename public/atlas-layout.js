/* Offline layered graph layout. Load vendor/dagre.min.js before this file. */
(() => {
  'use strict';

  const PADDING = 48;
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

  function labelSize(edge) {
    const label = String(edge.label || '');
    const lines = label.split(/\r?\n/);
    const estimatedWidth = Math.max(...lines.map(line => [...line].reduce((width, character) => width + (character.charCodeAt(0) > 255 ? 12 : 7), 0))) + 16;
    return {
      width: label ? positive(edge.width, Math.max(36, estimatedWidth)) : 0,
      height: label ? positive(edge.height, lines.length * 20 + 8) : 0,
    };
  }

  function middlePoint(points) {
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    let remaining = lengths.reduce((sum, value) => sum + value, 0) / 2;
    for (let index = 0; index < lengths.length; index += 1) {
      if (remaining <= lengths[index]) {
        const ratio = lengths[index] ? remaining / lengths[index] : 0;
        return {
          x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
          y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
        };
      }
      remaining -= lengths[index];
    }
    return points[0] || { x: 0, y: 0 };
  }

  /**
   * Return node CENTERS and edge routes in one padded SVG coordinate system.
   * Input objects are never changed. Parallel edges use independent Graphlib names.
   */
  function layout({ nodes = [], edges = [], direction = 'LR' } = {}) {
    if (!globalThis.dagre?.graphlib?.Graph) throw new Error('Dagre must load before atlas-layout.js');
    if (!nodes.length) return { width: PADDING * 2, height: PADDING * 2, nodes: [], edges: [] };

    const graph = new globalThis.dagre.graphlib.Graph({ directed: true, multigraph: true });
    graph.setGraph({
      rankdir: direction === 'TB' ? 'TB' : 'LR',
      ranksep: 104,
      nodesep: 38,
      edgesep: 26,
      marginx: 0,
      marginy: 0,
      acyclicer: 'greedy',
      ranker: 'network-simplex',
    });
    graph.setDefaultEdgeLabel(() => ({}));
    const nodeIds = new Set();
    const acceptedNodes = nodes.map(node => {
      const id = String(node.id);
      if (nodeIds.has(id)) throw new Error(`Duplicate graph node: ${id}`);
      nodeIds.add(id);
      const dimensions = { width: positive(node.width, 172), height: positive(node.height, 72) };
      graph.setNode(id, dimensions);
      return { id, ...dimensions };
    });
    const acceptedEdges = [];
    edges.forEach((edge, index) => {
      const fromId = String(edge.fromId);
      const toId = String(edge.toId);
      // A temporarily deleted person must not create an invisible phantom node.
      if (!nodeIds.has(fromId) || !nodeIds.has(toId)) return;
      const id = edge.id == null ? `edge-${index}` : String(edge.id);
      const name = `route-${index}`;
      const dimensions = labelSize(edge);
      graph.setEdge(fromId, toId, { ...dimensions, labelpos: 'c', minlen: 1, weight: 1 }, name);
      acceptedEdges.push({ id, fromId, toId, name, ...dimensions });
    });

    globalThis.dagre.layout(graph);
    const resultNodes = acceptedNodes.map(node => {
      const placed = graph.node(node.id);
      return { ...node, x: placed.x, y: placed.y };
    });
    const resultEdges = acceptedEdges.map(edge => {
      const placed = graph.edge(edge.fromId, edge.toId, edge.name);
      const points = placed.points.map(point => ({ x: point.x, y: point.y }));
      const middle = middlePoint(points);
      return {
        id: edge.id,
        points,
        labelX: Number.isFinite(placed.x) ? placed.x : middle.x,
        labelY: Number.isFinite(placed.y) ? placed.y : middle.y,
        labelWidth: edge.width,
        labelHeight: edge.height,
      };
    });

    // Include labels and self-loop routes, not only node boxes, in fit-to-view.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    function include(x, y, width = 0, height = 0) {
      minX = Math.min(minX, x - width / 2);
      minY = Math.min(minY, y - height / 2);
      maxX = Math.max(maxX, x + width / 2);
      maxY = Math.max(maxY, y + height / 2);
    }
    resultNodes.forEach(node => include(node.x, node.y, node.width, node.height));
    resultEdges.forEach(edge => {
      edge.points.forEach(point => include(point.x, point.y));
      include(edge.labelX, edge.labelY, edge.labelWidth, edge.labelHeight);
    });
    const offsetX = PADDING - minX;
    const offsetY = PADDING - minY;
    resultNodes.forEach(node => { node.x += offsetX; node.y += offsetY; });
    resultEdges.forEach(edge => {
      edge.points.forEach(point => { point.x += offsetX; point.y += offsetY; });
      edge.labelX += offsetX;
      edge.labelY += offsetY;
    });
    return { width: maxX - minX + PADDING * 2, height: maxY - minY + PADDING * 2, nodes: resultNodes, edges: resultEdges };
  }

  globalThis.WriterAtlasLayout = Object.freeze({ layout });
})();
