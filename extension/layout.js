// Convert inspected labels, never canvas guesses, into reusable CSS information.
export function parseLayout(properties = []) {
  const fields = properties.filter(p => p.section === 'properties-inspection-panel' || p.section === 'typography-inspection-panel').flatMap(p => p.fields || []);
  const css = {}, sizing = {}, unresolved = [], hints = [], source = {};
  const length = value => {
    const normalized = value.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '');
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|rem|em)$/.test(normalized) ? normalized : null;
  };
  const mappings = {
    'Padding': 'padding', 'Gap': 'gap', 'Horizontal gap': 'column-gap', 'Vertical gap': 'row-gap',
    'Padding—Top': 'padding-top', 'Padding—Right': 'padding-right',
    'Padding—Bottom': 'padding-bottom', 'Padding—Left': 'padding-left',
    'Min width': 'min-width', 'Max width': 'max-width', 'Min height': 'min-height', 'Max height': 'max-height',
    'Corner radius': 'border-radius', 'Radius': 'border-radius',
    'Font size': 'font-size', 'Line height': 'line-height', 'Letter spacing': 'letter-spacing',
  };
  for (const { name, value } of fields) {
    source[name] = value;
    if (name === 'Flow') {
      if (value === 'Vertical' || value === 'Horizontal') {
        css.display = 'flex'; css['flex-direction'] = value === 'Vertical' ? 'column' : 'row';
      } else unresolved.push({ property: 'flow', value, reason: 'Unrecognized layout flow' });
    } else if (name === 'Width' || name === 'Height') {
      const axis = name.toLowerCase(), dynamic = /^(Fill|Hug)(?:\s*\((.+)\))?$/.exec(value);
      if (dynamic) {
        sizing[axis] = { mode: dynamic[1].toLowerCase(), measured: dynamic[2] ? length(dynamic[2]) : null };
        hints.push({ property: axis, value, reason: dynamic[1] === 'Fill'
          ? 'Fill is parent-dependent. Use flex growth on the parent main axis or stretch on its cross axis; do not hardcode the measured size.'
          : 'Hug sizes to content. Choose auto/fit-content based on surrounding layout; measured size is not a fixed CSS dimension.' });
      } else {
        const fixed = /^Fixed\s*\((.+)\)$/.exec(value);
        const resolved = length(fixed ? fixed[1] : value);
        sizing[axis] = { mode: resolved ? 'fixed' : 'unknown', measured: resolved };
        if (resolved) css[axis] = resolved;
        else unresolved.push({ property: axis, value, reason: 'No numeric CSS dimension exposed' });
      }
    } else if ((name === 'Justify' || name === 'Align') && /^(flex-start|flex-end|start|end|center|space-between|space-around|space-evenly|stretch|baseline)$/.test(value)) {
      css[name === 'Justify' ? 'justify-content' : 'align-items'] = value;
    } else if (name === 'Font weight' && /^(?:[1-9]00)$/.test(value)) {
      css['font-weight'] = value;
    } else if (mappings[name]) {
      const property = mappings[name], resolved = length(value);
      if (resolved) css[property] = resolved;
      else if (name === 'Gap' && value === 'Auto') css['justify-content'] = 'space-between';
      else unresolved.push({ property, value, reason: 'Token or value has no resolved CSS length in Properties' });
    } else {
      // Retain every unknown field rather than silently interpreting new Figma UI.
      unresolved.push({ property: name, value, reason: 'No verified CSS mapping' });
    }
  }
  return { css, cssText: Object.entries(css).map(([key, value]) => `${key}: ${value};`).join('\n'),
    sizing, source, unresolved, hints, complete: false,
    note: 'Only exposed inspector fields are mapped. Missing padding/alignment is unknown, not zero/default. Resolve tokens from project styles; never invent their numeric values.' };
}

export function enrichContext(context) {
  const result = { ...context, layout: parseLayout(context.properties) };
  if (context.nodes) result.nodes = context.nodes.map(node => ({ ...node, layout: parseLayout(node.properties) }));
  return result;
}
