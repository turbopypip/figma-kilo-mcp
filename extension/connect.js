import { figmaAction } from './dom.js';
import { enrichContext } from './layout.js';
import { parseSelectionLink } from './link.js';
import { installDownloadCapture, readDownloadCapture } from './download.js';

const query = new URLSearchParams(location.search);
const tabId = Number(query.get('tab')), fileKey = query.get('file');
const status = document.getElementById('status');
if (query.get('error') === 'not-file' || !Number.isInteger(tabId) || tabId <= 0 || !fileKey) {
  document.getElementById('connect').hidden = true;
  status.textContent = 'Открой сам макет Figma, а не Recents или список файлов. На вкладке с адресом figma.com/design/… нажми значок Figma Kilo Browser Bridge ещё раз.';
}
let socket, busy = false, exportUncertain = false;
const setStatus = text => { status.textContent = text; };
async function invoke(method, params) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: figmaAction, args: [method, params, fileKey] });
  const value = results[0]?.result;
  if (!value || value.error) throw new Error(value?.error || 'No response from the Figma tab. Click the extension icon on that tab again.');
  return method === 'get_design_context' ? enrichContext(value.result) : value.result;
}
async function nativeDownload(func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return results[0]?.result;
}
async function request(method, params, connection) {
  if (!['get_selection', 'get_design_context', 'get_screenshot', 'export_asset'].includes(method)) throw new Error('Unsupported MCP method');
  if (method === 'get_design_context' || params.url) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  }
  if (params.url) {
    const target = parseSelectionLink(params.url, fileKey, params.nodeId);
    let ready = false;
    // Figma may retain its existing selection on same-file URL navigation.
    // Prefer selecting the exact linked ID through Layers when already mounted.
    try { await invoke('select_node', { nodeId: target.nodeId, mountedOnly: true }); ready = true; } catch { /* Try link navigation below. */ }
    if (!ready) {
      const currentTab = await chrome.tabs.get(tabId);
      const currentUrl = new URL(currentTab.url || 'about:blank');
      const sameTarget = currentUrl.origin === 'https://www.figma.com' && currentUrl.pathname.split('/')[2] === fileKey &&
        (currentUrl.searchParams.get('node-id') || '').replaceAll('-', ':') === target.nodeId;
      await chrome.tabs.update(tabId, sameTarget ? { active: true } : { url: target.url, active: true });
      const until = Date.now() + 6000;
      while (Date.now() < until) {
        if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed.');
        try { await invoke('select_node', { nodeId: target.nodeId, mountedOnly: true }); ready = true; break; }
        catch { /* Same-file navigation can briefly unload the document. */ }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!ready) {
        try { await invoke('select_node', { nodeId: target.nodeId }); ready = true; } catch { /* Report the exact limitation. */ }
      }
    }
    if (!ready) throw new Error('Linked node is not available in Layers yet. Retry after the file loads; if its ancestors remain collapsed, request their context first.');
    params = { ...params, nodeId: target.nodeId };
  }
  if (!['get_screenshot', 'export_asset'].includes(method)) return invoke(method, params);
  if (exportUncertain) throw new Error('Previous native copy did not finish reliably. Reload Figma and reopen this connection tab before exporting again.');
  // Clipboard operations require focus. Only the tab explicitly paired by the user is activated.
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  const marker = `figma-kilo-export:${crypto.randomUUID()}`;
  const format = method === 'get_screenshot' ? 'PNG' : params.format;
  if (format === 'SVG') {
    const node = await invoke('prepare_svg', params);
    await nativeDownload(installDownloadCapture, [marker, fileKey]);
    try {
      await invoke('download_svg', { nodeId: node.id });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed; export stopped.');
        const result = await nativeDownload(readDownloadCapture, [marker, fileKey]);
        if (result?.error) throw new Error(result.error);
        if (result?.data) {
          await invoke('assert_selection', { nodeId: node.id });
          return { nodeId: node.id, name: node.name, format: 'SVG', data: result.data };
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('Native SVG export timed out. No SVG was received.');
    } finally { await nativeDownload(readDownloadCapture, [marker, fileKey, true]).catch(() => {}); }
  }
  exportUncertain = true;
  const node = await invoke('begin_export', { ...params, marker, format });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Connection closed; export stopped.');
    const image = await invoke('read_export', { ...params, nodeId: node.id, marker, format });
    if (image) { exportUncertain = false; return image; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Figma copy timed out. Keep the tab focused and check that Copy as is permitted.');
}
document.getElementById('connect').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) { setStatus('Дождись завершения текущего запроса.'); return; }
  socket?.close();
  const port = Number(document.getElementById('port').value);
  const secretField = document.getElementById('secret');
  let secret = secretField.value;
  secretField.value = '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || secret.length < 32 || secret.length > 256 || !Number.isInteger(tabId) || tabId <= 0 || !fileKey) {
    setStatus('Проверь порт, секрет и открой подключение значком расширения на вкладке Figma.'); return;
  }
  const connection = socket = new WebSocket(`ws://127.0.0.1:${port}`);
  setStatus('Подключение…');
  connection.onopen = () => { connection.send(JSON.stringify({ type: 'auth', secret })); secret = ''; };
  connection.onerror = () => { if (connection === socket) setStatus('Не удалось подключиться. Запусти MCP в Kilo CLI и проверь порт.'); };
  connection.onclose = () => { secret = ''; if (connection === socket) setStatus('Отключено. Для повтора введи секрет и подключись.'); };
  connection.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { connection.close(); return; }
    if (msg.type === 'ready') { setStatus('Подключено к Kilo CLI. Оставь эту вкладку открытой.'); return; }
    if (msg.type !== 'request' || typeof msg.id !== 'string' || msg.id.length > 100) return;
    const reply = value => { if (connection === socket && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'response', id: msg.id, ...value })); };
    if (busy) { reply({ error: 'Browser adapter is busy' }); return; }
    busy = true;
    try { reply({ result: await request(msg.method, msg.params || {}, connection) }); }
    catch (error) { reply({ error: error.message || 'Browser adapter failed' }); }
    finally { busy = false; }
  };
});
document.getElementById('disconnect').addEventListener('click', () => socket?.close());
window.addEventListener('pagehide', () => socket?.close());
