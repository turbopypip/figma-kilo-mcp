export function parseSelectionLink(value, pairedFileKey, nodeId) {
  const url = new URL(value);
  const match = /^\/(design|file)\/([a-zA-Z0-9]+)(?:\/|$)/.exec(url.pathname);
  if (url.origin !== 'https://www.figma.com' || !match || url.username || url.password)
    throw new Error('Use an https://www.figma.com/design/... selection link.');
  if (match[2] !== pairedFileKey) throw new Error('Link points to another file. Open that file and pair the extension there first.');
  const selected = (url.searchParams.get('node-id') || '').replaceAll('-', ':');
  if (!/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/.test(selected) || selected.length > 100)
    throw new Error('Figma link must contain a valid node-id. Use Copy link to selection.');
  if (nodeId && nodeId !== selected) throw new Error('nodeId and selection link refer to different layers.');
  // Keep the provided file route, discard tracking/share UI parameters.
  url.search = ''; url.hash = ''; url.searchParams.set('node-id', selected.replaceAll(':', '-'));
  return { url: url.href, nodeId: selected };
}
