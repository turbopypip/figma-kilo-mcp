// No document cache: every request reads the current Plugin API state.
const fields = [
  'id', 'type', 'name', 'visible', 'x', 'y', 'width', 'height', 'rotation',
  'absoluteBoundingBox', 'absoluteRenderBounds', 'relativeTransform', 'constraints',
  'layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow', 'layoutPositioning',
  'itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'clipsContent', 'opacity', 'blendMode',
  'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeTopWeight', 'strokeRightWeight',
  'strokeBottomWeight', 'strokeLeftWeight', 'dashPattern', 'cornerRadius', 'cornerSmoothing',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'effects',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'boundVariables',
  'explicitVariableModes', 'resolvedVariableModes', 'componentProperties', 'variantProperties',
  'componentPropertyDefinitions', 'componentPropertyReferences', 'isMask', 'maskType',
  'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation', 'maxLines',
  'paragraphIndent', 'paragraphSpacing', 'listSpacing', 'hyperlink'
];
const MAX_CHARS = 800_000;
export async function designContext(root: SceneNode, depth: number, maxNodes: number) {
  let count = 0, chars = 0;
  const truncations: { nodeId: string; reason: string }[] = [];
  async function visit(node: SceneNode, level: number): Promise<Record<string, unknown> | null> {
    if (count >= maxNodes || chars >= MAX_CHARS) return null;
    const result: Record<string, unknown> = {};
    const unavailable: string[] = [];
    for (const key of fields) {
      if (!(key in node)) continue;
      try {
        const value = (node as unknown as Record<string, unknown>)[key];
        if (value !== undefined) result[key] = typeof value === 'symbol' ? { unavailable: 'mixed' } : value;
      } catch { unavailable.push(key); }
    }
    if (node.type === 'TEXT') {
      const end = Math.min(node.characters.length, 8000);
      result.characters = node.characters.slice(0, end);
      if (end < node.characters.length) truncations.push({ nodeId: node.id, reason: 'text exceeds 8000 characters' });
      try { result.textSegments = node.getStyledTextSegments([
        'fontName', 'fontSize', 'fontWeight', 'textDecoration', 'textCase', 'lineHeight',
        'letterSpacing', 'fills', 'textStyleId', 'fillStyleId', 'boundVariables', 'hyperlink'
      ], 0, end); } catch { unavailable.push('textSegments'); }
    }
    if (node.type === 'INSTANCE') {
      try {
        const main = await node.getMainComponentAsync();
        result.mainComponent = main ? { id: main.id, key: main.key, name: main.name, remote: main.remote } : { unavailable: 'Main component is inaccessible' };
      } catch { unavailable.push('mainComponent'); }
    }
    if (node.type === 'COMPONENT') result.componentKey = node.key;
    // Bindings are exposed by ID; remote style/variable values are not fetched implicitly.
    if ('boundVariables' in node) result.variableValues = { unavailable: 'Bindings only; values are not resolved by this version' };
    if (unavailable.length) result.unavailable = unavailable;
    const serialized = JSON.stringify(result, (_, value) => typeof value === 'symbol' ? { unavailable: 'mixed' } : value);
    if (serialized.length > 100_000 || chars + serialized.length > MAX_CHARS) {
      truncations.push({ nodeId: node.id, reason: 'property size limit; inspect this node separately' });
      result.id = node.id;
      for (const key of Object.keys(result)) if (!['id', 'type', 'name'].includes(key)) delete result[key];
      result.propertiesTruncated = true;
    }
    chars += Math.min(serialized.length, 100_000);
    count++;
    if ('children' in node && node.children.length) {
      result.childCount = node.children.length;
      const children: Record<string, unknown>[] = [];
      if (level < depth) {
        for (const child of node.children) {
          const data = await visit(child, level + 1);
          if (!data) break;
          children.push(data);
        }
      }
      result.children = children;
      if (children.length < node.children.length) {
        result.childrenTruncated = true;
        result.nextChildId = node.children[children.length].id;
        truncations.push({ nodeId: node.id, reason: level >= depth ? 'depth limit' : 'node or response size limit' });
      }
    }
    return result;
  }
  const node = await visit(root, 0);
  return { node, nodeCount: count, truncated: truncations.length > 0, truncations,
    coordinateSystem: 'x/y relative to parent; absoluteBoundingBox in document coordinates',
    styleValues: { unavailable: 'Style IDs and applied node properties supplied; style definitions are not fetched' } };
}
