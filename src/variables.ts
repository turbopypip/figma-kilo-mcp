import { open } from 'node:fs/promises';
import path from 'node:path';

export function variablesPath(input: string, platform = process.platform): string {
  const value = input.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (platform !== 'win32' && path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))
    throw new Error('Windows variablesFile must be read by MCP running on Windows. Provide a local path on this machine.');
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)) throw new Error('variablesFile must be an absolute local path.');
  if (!/\.(scss|css)$/i.test(value)) throw new Error('variablesFile must be a .scss or .css file.');
  return value;
}

// Read declarations, never execute Sass or load imports. Duplicate definitions are excluded
// because selecting a theme/mode from a source file would require runtime context.
export function parseVariables(source: string): Map<string, string> {
  const declarations = new Map<string, string[]>();
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const roots: string[] = [];
  const remainder = cleaned.replace(/:root\s*\{([^{}]*)\}/g, (_, body: string) => { roots.push(body); return ''; });
  if (remainder.trim()) throw new Error('variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.');
  for (const match of roots.join('\n').matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)\s*;/g)) {
    const values = declarations.get(match[1]) || [];
    values.push(match[2].trim()); declarations.set(match[1], values);
  }
  const resolve = (name: string, seen = new Set<string>()): string | undefined => {
    const values = declarations.get(name);
    if (!values || values.length !== 1 || seen.has(name)) return;
    seen.add(name);
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(values[0]);
    return alias ? resolve(alias[1], seen) : values[0];
  };
  const result = new Map<string, string>();
  for (const name of declarations.keys()) { const value = resolve(name); if (value) result.set(name, value); }
  return result;
}

export async function loadVariables(input: string): Promise<Map<string, string>> {
  const handle = await open(variablesPath(input), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('variablesFile must be a regular file up to 2 MiB.');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2 * 1024 * 1024) throw new Error('variablesFile exceeds 2 MiB.');
    return parseVariables(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

const category = (property: string): RegExp | undefined => {
  if (/^(padding|margin)(-|$)|^(gap|row-gap|column-gap)$/.test(property)) return /^--mimir-space-/;
  if (/^border(-.*)?-radius$/.test(property)) return /^--mimir-control-(?:input-)?radius(?:-|$)/;
  if (property === 'font-size') return /^--mimir-size-text-/;
  if (property === 'font-weight') return /^--mimir-font-weight-text-/;
  if (property === 'line-height') return /^--mimir-line-height-text-/;
  if (property === 'font-family') return /^--mimir-font-/;
  return undefined;
};
const normalize = (value: string) => {
  const number = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|%)?$/.exec(value.trim());
  return number ? `${Number(number[1])}${number[2] || ''}` : value.trim();
};
type ObjectValue = Record<string, any>;
export function mapContextVariables(value: unknown, variables?: Map<string, string>, requestedFile?: string): unknown {
  if (!value || typeof value !== 'object') return value;
  const context = value as ObjectValue;
  const mapLayout = (layout: ObjectValue | undefined) => {
    if (!layout?.css) return layout;
    const css = { ...layout.css }, resolvedValues = { ...layout.css }, variableMatching = [];
    if (variables) for (const [property, actual] of Object.entries<string>(resolvedValues)) {
      const group = category(property);
      if (!group) continue;
      const candidates = [...variables].filter(([name, candidate]) => group.test(name) && normalize(candidate) === normalize(actual)).map(([name]) => name);
      if (candidates.length === 1) css[property] = `var(${candidates[0]})`;
      variableMatching.push({ property, value: actual, candidates, status: candidates.length === 1 ? 'matched' : candidates.length ? 'ambiguous' : 'not-found' });
    }
    return { ...layout, css, cssText: Object.entries(css).map(([key, val]) => `${key}: ${val};`).join('\n'), resolvedValues, variableMatching };
  };
  return { ...context, layout: mapLayout(context.layout),
    ...(context.nodes ? { nodes: context.nodes.map((node: ObjectValue) => ({ ...node, layout: mapLayout(node.layout) })) } : {}),
    ...(requestedFile && context.traversal?.nextRequest ? { traversal: { ...context.traversal, nextRequest: { ...context.traversal.nextRequest, variablesFile: requestedFile } } } : {}) };
}
