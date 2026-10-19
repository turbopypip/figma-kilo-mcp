import { designContext } from './context';
// Inspect plugins use Figma's resizable sidebar instead of a fixed-size dialog.
figma.showUI(__html__, figma.editorType === 'dev'
  ? { themeColors: true }
  : { width: 340, height: 300, themeColors: true });
let busy = false;
let generation = 0;
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Parameter out of range');
  return value;
}
async function getNode(id?: string): Promise<SceneNode> {
  if (id !== undefined && (typeof id !== 'string' || id.length > 100)) throw new Error('Invalid node ID');
  const node = id ? await figma.getNodeByIdAsync(id) : figma.currentPage.selection.length === 1 ? figma.currentPage.selection[0] : null;
  if (!node) throw new Error(id ? 'Node no longer exists or is inaccessible' : 'Select exactly one frame or pass nodeId');
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error('Choose a frame or a scene node');
  return node;
}
async function exportNode(node: SceneNode, format: 'PNG' | 'SVG', requestedScale: number) {
  const bounds = ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null) || node.absoluteBoundingBox;
  const edge = bounds ? Math.max(bounds.width, bounds.height, node.width, node.height) : Math.max(node.width, node.height);
  if (!Number.isFinite(edge) || edge <= 0) throw new Error('Node has no renderable bounds');
  const scale = Math.min(requestedScale, 2048 / edge);
  // SVG has no raster-resolution cap; cap scene complexity before native export.
  let visited = 0;
  const inspect = (n: SceneNode, depth = 0) => {
    if (++visited > 1000 || depth > 64) throw new Error('Export subtree exceeds 1000 nodes or 64 levels. Export a smaller node.');
    if ('children' in n) for (const child of n.children) inspect(child, depth + 1);
  };
  inspect(node);
  const bytes = await node.exportAsync(format === 'PNG'
    ? { format: 'PNG', constraint: { type: 'SCALE', value: scale } }
    : { format: 'SVG', svgIdAttribute: true, svgOutlineText: true });
  if (bytes.byteLength > 3 * 1024 * 1024) throw new Error('Export exceeds 3 MiB; choose a smaller node or lower PNG scale');
  return { nodeId: node.id, name: node.name.slice(0, 500), format, data: figma.base64Encode(bytes), ...(format === 'PNG' ? { scale } : {}) };
}
figma.ui.onmessage = async message => {
  if (message?.type === 'disconnect') { generation++; return; }
  if (message?.type !== 'request' || typeof message.id !== 'string') return;
  const id = message.id;
  if (busy) { figma.ui.postMessage({ type: 'response', id, error: 'Plugin is busy finishing the previous request' }); return; }
  busy = true;
  const session = generation;
  try {
    const params = message.params || {};
    let result: unknown;
    switch (message.method) {
      case 'get_selection': {
        const selection = figma.currentPage.selection;
        result = { editorType: figma.editorType, mode: figma.mode,
          skippedInvisibleInstanceChildren: figma.skipInvisibleInstanceChildren, page: { id: figma.currentPage.id, name: figma.currentPage.name.slice(0, 500) },
          nodes: selection.slice(0, 500).map(n => ({ id: n.id, name: n.name.slice(0, 500), type: n.type })),
          total: selection.length, truncated: selection.length > 500 };
        break;
      }
      case 'get_design_context': {
        const depth = bounded(params.depth, 4, 0, 12), maxNodes = bounded(params.maxNodes, 200, 1, 500);
        if (!Number.isInteger(depth) || !Number.isInteger(maxNodes)) throw new Error('Depth and maxNodes must be integers');
        result = await designContext(await getNode(params.nodeId), depth, maxNodes);
        break;
      }
      case 'get_screenshot':
      case 'export_asset': {
        const format = message.method === 'get_screenshot' ? 'PNG' : params.format;
        if (format !== 'PNG' && format !== 'SVG') throw new Error('Unsupported image format');
        result = await exportNode(await getNode(params.nodeId), format, bounded(params.scale, 1, 0.1, 2));
        break;
      }
      default: throw new Error('Unknown bridge method');
    }
    if (session === generation) figma.ui.postMessage({ type: 'response', id, result });
  } catch (error) {
    if (session === generation) figma.ui.postMessage({ type: 'response', id, error: error instanceof Error ? error.message : 'Plugin request failed' });
  } finally { busy = false; }
};
