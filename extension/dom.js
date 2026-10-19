// Self-contained: Chrome serializes this function into an isolated content-script world.
// No private Figma runtime, cookies, REST endpoints, or document writes.
export async function figmaAction(method, params, fileKey) {
  try {
    const url = new URL(location.href);
    if (url.origin !== 'https://www.figma.com' || !/^\/(design|file)\//.test(url.pathname) || url.pathname.split('/')[2] !== fileKey)
      throw new Error('The paired Figma file changed. Connect the intended file again.');
    const visible = el => el && el.getClientRects().length > 0;
    const label = el => {
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const copy = el.cloneNode(true);
      copy.querySelectorAll('[aria-hidden="true"]').forEach(hidden => hidden.remove());
      return copy.textContent.replace(/\u200b/g, '').trim();
    };
    const rows = () => [...document.querySelectorAll('[role="row"]')].filter(el => el.querySelector('[data-testid$="-layers-panel-row"]'));
    const rowId = row => row.querySelector('[data-testid$="-layers-panel-row"]').getAttribute('data-testid').replace(/-layers-panel-row$/, '');
    const describe = row => {
      const item = row.querySelector('[data-testid$="-layers-panel-row"]');
      return { id: item.getAttribute('data-testid').replace(/-layers-panel-row$/, ''),
        name: item.innerText.trim().slice(0, 500), type: row.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') || 'UNKNOWN',
        level: Number(row.getAttribute('aria-level')), expanded: row.getAttribute('aria-expanded') === 'true',
        hasChildren: row.hasAttribute('aria-expanded') };
    };
    // Figma also marks descendants aria-selected; only selected-root is an actual selection.
    const selected = () => rows().filter(row => row.getAttribute('data-fpl-selected-root') === 'true');
    const hover = el => {
      const rect = el.getBoundingClientRect();
      const options = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerover', { ...options, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseover', options));
      el.dispatchEvent(new MouseEvent('mousemove', options));
      return options;
    };
    const activate = el => {
      const options = hover(el);
      el.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerType: 'mouse', buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...options, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.click();
    };
    const one = () => {
      const items = selected();
      const count = document.querySelector('[role="application"][aria-label^="Figma Design"]')?.getAttribute('aria-label');
      if (items.length !== 1 || count !== 'Figma Design, 1 item selected')
        throw new Error('Select exactly one visible layer in the Layers panel. The Figma selection count must also be one.');
      return items[0];
    };
    const waitFor = async (predicate, message = 'Figma UI did not become ready. Open Properties and expand the layer in the Layers panel.') => {
      const end = Date.now() + 3500;
      while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 16)); }
      throw new Error(message);
    };
    const button = text => [...document.querySelectorAll('button,[role="button"]')].find(el => visible(el) && label(el) === text);
    const readFields = panel => [...(panel.querySelectorAll?.('button[aria-label]') || [])]
      .filter(el => (el.getAttribute('aria-label') || '').startsWith('Copy ') && el.getAttribute('aria-label').includes(':'))
      .slice(0, 100).map(el => {
        const label = el.getAttribute('aria-label'), colon = label.indexOf(':');
        const pill = el.querySelector?.('[data-testid="inspectionPropertyValue"] [data-testid="variable-pill-root"]');
        const values = pill ? [...pill.querySelectorAll('[data-tooltip]')].map(item => item.getAttribute('data-tooltip').trim()).filter(Boolean) : [];
        const unique = [...new Set(values)];
        return { name: label.slice(5, colon).trim(),
          value: pill ? (unique.length === 1 ? unique[0].slice(0, 1000) : 'unavailable') : label.slice(colon + 1).trim().slice(0, 1000),
          ...(pill ? { valueSource: unique.length === 1 ? 'tooltip-attribute' : 'unavailable' } : {}) };
      });
    // Replace variable labels in the text snapshot too; never expose them as CSS candidates.
    const panelText = panel => {
      let text = panel.innerText;
      for (const pill of panel.querySelectorAll?.('[data-testid="variable-pill-root"]') || []) {
        const values = [...pill.querySelectorAll('[data-tooltip]')].map(el => el.getAttribute('data-tooltip').trim()).filter(Boolean);
        const unique = [...new Set(values)];
        if (pill.innerText) text = text.replaceAll(pill.innerText, unique.length === 1 ? unique[0] : 'unavailable');
      }
      return text;
    };
    const selection = () => ({ adapter: 'chrome-dom', fileKey, nodes: selected().map(describe),
      incomplete: true, limitation: 'Only selected rows currently mounted in the Layers panel are visible to this adapter.' });
    if (method === 'get_selection') return { result: selection() };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const started = Date.now(), deadline = started + (method === 'select_node' ? 2000 : 18_000);
    const checkFile = () => {
      const current = new URL(location.href);
      if (current.origin !== url.origin || current.pathname.split('/')[2] !== fileKey) throw new Error('Paired file changed during traversal.');
    };
    const mounted = id => rows().find(row => rowId(row) === id);
    let scrollElement;
    const scroller = () => {
      if (scrollElement && scrollElement.isConnected !== false) return scrollElement;
      const tree = document.querySelector('[data-testid="objects-panel"]');
      for (let el = tree; el && el !== document.body; el = el.parentElement) {
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { scrollElement = el; return el; }
      }
      return null;
    };
    // Only offsets/IDs, never Figma private state. Cache is bounded and file scoped.
    let cache = globalThis.__figmaKiloLayerOffsets;
    if (!cache || cache.fileKey !== fileKey) cache = globalThis.__figmaKiloLayerOffsets = { fileKey, offsets: new Map() };
    const remember = row => {
      const id = describe(row).id;
      cache.offsets.delete(id); cache.offsets.set(id, scroller()?.scrollTop || 0);
      if (cache.offsets.size > 2000) cache.offsets.delete(cache.offsets.keys().next().value);
    };
    const findRow = async (id, until = deadline) => {
      checkFile();
      if (mounted(id)) return mounted(id);
      const scroll = scroller();
      if (!scroll) return null;
      if (cache.offsets.has(id)) {
        scroll.scrollTop = cache.offsets.get(id); await pause(32);
        if (mounted(id)) return mounted(id);
      }
      // Search already expanded rows. Never expand unrelated document branches.
      scroll.scrollTop = 0; await pause(32);
      for (let step = 0; step < 150 && Date.now() < until; step++) {
        checkFile();
        if (mounted(id)) return mounted(id);
        const before = scroll.scrollTop;
        scroll.scrollTop += Math.max(32, scroll.clientHeight / 2); await pause(32);
        if (scroll.scrollTop === before) break;
      }
      return mounted(id) || null;
    };

    if (['read_export', 'assert_selection', 'download_svg'].includes(method) && (!params.nodeId || describe(one()).id !== params.nodeId))
      throw new Error('Selection changed during export. Retry.');
    if (params.nodeId && !['read_export', 'assert_selection', 'download_svg'].includes(method)) {
      const row = params.mountedOnly ? mounted(params.nodeId) : await findRow(params.nodeId);
      if (!row) throw new Error('Node not found among expanded Layers. First request get_design_context on its parent with autoTraverse=true.');
      if (selected().length !== 1 || describe(one()).id !== params.nodeId) {
        activate(row);
        await waitFor(() => selected().length === 1 && describe(one()).id === params.nodeId);
        // Allow the inspector to render after selection; data is read again below.
        await new Promise(r => setTimeout(r, 200));
      }
    }
    const node = describe(one());
    const assertSelection = () => { if (selected().length !== 1 || describe(one()).id !== node.id) throw new Error('Selection changed during request. Retry.'); };
    if (method === 'assert_selection' || method === 'select_node') return { result: node };
    if (method === 'prepare_svg') {
      const getFormats = () => [...document.querySelectorAll('[data-testid="export-inspection-panel"] [role="combobox"]')].filter(el =>
        (el.getAttribute('aria-label') || el.getAttribute('data-tooltip')) === 'Export file type');
      if (!getFormats().length) {
        const expand = button('Export');
        if (!expand) throw new Error('Export is unavailable in this file.');
        activate(expand);
      }
      const formats = await waitFor(() => { const items = getFormats(); return items.length ? items : null; });
      if (formats.length !== 1) throw new Error('Keep exactly one export setting in the Export panel.');
      if (label(formats[0]) !== 'SVG' && !formats[0].textContent.trim().match(/^SVG(?:SVG)?$/)) {
        activate(formats[0]);
        const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(el => visible(el) && label(el) === 'SVG'));
        activate(option);
      }
      assertSelection(); return { result: node };
    }
    if (method === 'download_svg') {
      const command = button(`Export ${node.name}`);
      if (!command) throw new Error('SVG export button is unavailable.');
      activate(command); return { result: node };
    }
    if (method === 'get_design_context') {
      const propertiesTab = [...document.querySelectorAll('[role="tab"]')].find(el => label(el) === 'Properties');
      if (!propertiesTab) throw new Error('Properties tab is unavailable in this file.');
      if (propertiesTab.getAttribute('aria-selected') !== 'true') {
        propertiesTab.click(); await waitFor(() => propertiesTab.getAttribute('aria-selected') === 'true');
      }
      await waitFor(() => button(node.name));
      if (params.autoTraverse !== false) {
        const depth = Math.min(12, Math.max(0, params.depth ?? 4));
        const maxNodes = Math.min(500, Math.max(1, params.maxNodes ?? 200));
        const nodes = [], reasons = [], pending = [], stack = [];
        const visited = new Set();
        let resuming = Boolean(params.afterNodeId), lastReadId = params.afterNodeId || null;
        let expectedId = node.id, complete = false, textLength = 0, restoreSelection = true;
        const assertExpected = () => {
          checkFile();
          const current = selected();
          const count = document.querySelector('[role="application"][aria-label^="Figma Design"]')?.getAttribute('aria-label');
          if (count !== 'Figma Design, 1 item selected' || (mounted(expectedId) && current.length === 0) || (current.length && (current.length !== 1 || describe(current[0]).id !== expectedId))) {
            restoreSelection = false; throw new Error('Selection changed by user; traversal stopped.');
          }
        };
        const inspectorSignature = () => [...document.querySelectorAll('[data-testid$="inspection-panel"]')]
          .filter(el => visible(el) && !el.getAttribute('data-testid').startsWith('export-'))
          .map(el => el.getAttribute('data-testid') + ':' + el.innerText).join('\n');
        const selectRow = async row => {
          assertExpected();
          const info = describe(row);
          const scroll = scroller(), previousTop = scroll?.scrollTop;
          row.scrollIntoView?.({ block: 'nearest' });
          if (scroll && scroll.scrollTop !== previousTop) await pause(32);
          row = mounted(info.id);
          if (!row) throw new Error('Layer disappeared while scrolling.');
          remember(row);
          if (expectedId !== info.id) {
            const before = inspectorSignature(), selectionStarted = Date.now();
            activate(row); expectedId = info.id;
            await waitFor(() => selected().length === 1 && describe(selected()[0]).id === info.id);
            // Changed properties must settle across several frames. If two layers
            // have identical inspector text, retain the previous conservative delay.
            let signature = null, stableSince = Date.now();
            await waitFor(() => {
              assertExpected();
              if (!button(info.name)) { stableSince = Date.now(); return false; }
              const current = inspectorSignature();
              if (!current) return false;
              if (current !== signature) { signature = current; stableSince = Date.now(); }
              return Date.now() - stableSince >= 48 && (current !== before || Date.now() - selectionStarted >= 150);
            }, 'Inspector did not settle for the selected layer.');
          }
          await waitFor(() => button(info.name));
          assertExpected();
        };
        const nextRow = async id => {
          for (let step = 0; step < 150 && Date.now() < deadline; step++) {
            assertExpected();
            let all = rows(), index = all.findIndex(row => rowId(row) === id);
            if (index < 0) throw new Error('Traversal lost its position in virtualized Layers.');
            if (index + 1 < all.length) return all[index + 1];
            const scroll = scroller();
            if (!scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1) return null;
            // Keep the last visited row in the overlapping viewport to avoid gaps.
            all[index].scrollIntoView?.({ block: 'start' }); await pause(32);
            all = rows(); index = all.findIndex(row => rowId(row) === id);
            if (index >= 0 && index + 1 < all.length) return all[index + 1];
            const before = scroll.scrollTop;
            scroll.scrollTop += Math.max(16, scroll.clientHeight / 2); await pause(32);
            if (scroll.scrollTop === before) return null;
          }
          throw new Error('Traversal time limit reached.');
        };
        let current = mounted(node.id);
        try {
          while (current) {
            assertExpected();
            const info = describe(current);
            if (info.id !== node.id && info.level <= node.level) { complete = true; break; }
            if (visited.has(info.id)) throw new Error('Layers traversal repeated a row; stopped to avoid skipping nodes.');
            visited.add(info.id);
            const relativeDepth = info.level - node.level;
            if (relativeDepth <= depth) {
              while (stack.length && stack.at(-1).level >= info.level) stack.pop();
              const shouldRead = !resuming || info.id === node.id;
              if (shouldRead && (nodes.length >= maxNodes || Date.now() >= deadline || textLength >= 150_000)) {
                reasons.push(nodes.length >= maxNodes ? 'maxNodes limit' : textLength >= 150_000 ? 'context text limit' : 'time limit');
                pending.push({ nodeId: info.id, reason: reasons.at(-1) }); break;
              }
              if (shouldRead) {
              await selectRow(current);
              const panels = [...document.querySelectorAll('[data-testid$="inspection-panel"]')].filter(visible)
                .filter(el => !el.getAttribute('data-testid').startsWith('export-'));
              if (!panels.length) throw new Error('Inspector DOM is unsupported.');
              const properties = [];
              for (const panel of panels) {
                const raw = panelText(panel), available = Math.max(0, 150_000 - textLength);
                const text = raw.slice(0, Math.min(12_000, available)); textLength += text.length;
                if (text.length < raw.length) reasons.push(`Properties text truncated: ${info.id}`);
                properties.push({ section: panel.getAttribute('data-testid'), text, fields: readFields(panel) });
              }
              nodes.push({ ...info, parentId: stack.at(-1)?.id || null, properties });
              if (!resuming) lastReadId = info.id;
              }
              stack.push(info);
              if (info.id === params.afterNodeId) resuming = false;
              if (info.hasChildren && relativeDepth < depth && !info.expanded) {
                const caret = mounted(info.id)?.querySelector('[data-testid="layers-panel-expand-caret"]');
                if (!caret) throw new Error(`Cannot expand layer ${info.id}`);
                caret.click();
                await waitFor(() => mounted(info.id)?.getAttribute('aria-expanded') === 'true');
                // Allow child rows to mount after the expansion attribute changes.
                await pause(32);
              } else if (info.hasChildren && relativeDepth >= depth) {
                pending.push({ nodeId: info.id, reason: 'depth limit' });
              }
            }
            // A collapsed leaf/root has no descendant traversal to perform.
            if (info.id === node.id && (!info.hasChildren || depth === 0)) { complete = true; break; }
            current = await nextRow(info.id);
            if (!current) complete = true;
          }
        } catch (error) {
          reasons.push(error.message || 'Traversal stopped');
          if (current) pending.push({ nodeId: describe(current).id, reason: 'traversal interrupted' });
        }
        let restored = false;
        if (restoreSelection) {
          try {
            assertExpected();
            const root = await findRow(node.id, Date.now() + 2000);
            if (root) { await selectRow(root); restored = true; }
          } catch (error) { reasons.push(`Could not restore root selection: ${error.message}`); }
        }
        if (resuming && complete) throw new Error('Continuation layer was not found in this subtree. Restart without afterNodeId.');
        if (!nodes.length) throw new Error(reasons.join('; ') || 'No layer properties read.');
        const childrenTruncated = !complete || pending.length > 0;
        return { result: { adapter: 'chrome-dom', fileKey, node: nodes[0], properties: nodes[0].properties,
          nodes, visibleDescendants: nodes.slice(1).map(({ properties, ...info }) => info), nodeCount: nodes.length,
          truncated: true, childrenTruncated, traversal: { elapsedMs: Date.now() - started, complete: !childrenTruncated, restoredSelection: restored, pending, reasons,
            nextRequest: !complete && !resuming && lastReadId && restoreSelection ? { nodeId: node.id, autoTraverse: true, depth, maxNodes: Math.max(2, maxNodes), afterNodeId: lastReadId } : null },
          truncations: [...reasons, ...pending.map(item => `${item.reason}: ${item.nodeId}`)],
          unavailable: ['properties not exposed by the inspector', 'absolute geometry', 'text style ranges not shown in inspector', 'variable definitions'],
          guidance: 'nodes contains inspected properties and parentId for each visited layer. If traversal.nextRequest is present, call get_design_context with those exact arguments to continue without rereading previous descendants. For depth-limited pending branches, request their nodeId separately. Discovered IDs are located by scrolling automatically. Do not infer unavailable properties. The design context remains incomplete even when traversal.complete is true.' } };
      }

      if (params.depth > 0 && node.hasChildren && !node.expanded) {
        const caret = one().querySelector('[data-testid="layers-panel-expand-caret"]');
        if (caret) { caret.click(); await waitFor(() => one().getAttribute('aria-expanded') === 'true'); }
      }
      const all = rows().map(describe), index = all.findIndex(row => row.id === node.id);
      const descendants = [];
      for (let i = index + 1; i < all.length && all[i].level > node.level; i++) {
        if (all[i].level - node.level <= params.depth && descendants.length < params.maxNodes - 1) descendants.push(all[i]);
      }
      const panels = [...document.querySelectorAll('[data-testid$="inspection-panel"]')].filter(visible)
        .filter(el => !el.getAttribute('data-testid').startsWith('export-'));
      if (!panels.length) throw new Error('Inspector DOM is unsupported. No context returned; update the browser adapter.');
      const properties = panels.map(el => ({ section: el.getAttribute('data-testid'), text: panelText(el).slice(0, 12000), fields: readFields(el) }));
      assertSelection();
      return { result: { adapter: 'chrome-dom', fileKey, node, properties, visibleDescendants: descendants,
        nodeCount: 1 + descendants.length, truncated: true, childrenTruncated: true,
        truncations: ['DOM is virtualized. Only mounted rows and the selected node inspector were read; descendants have no inspected properties.'],
        unavailable: ['complete hierarchy', 'absolute geometry', 'text style ranges not shown in inspector', 'variable definitions'],
        guidance: 'Select a visible descendant by ID to read its Properties. Expand/scroll Layers manually for unmounted nodes. Do not infer absent properties.' } };
    }
    if (method === 'begin_export') {
      if (params.format !== 'PNG') throw new Error('Unsupported export format');
      await waitFor(() => document.hasFocus(), 'Keep the Figma tab focused during export.');
      const panel = document.querySelector('[data-testid="properties-inspection-panel"]');
      const dimensions = [...(panel?.querySelectorAll('button') || [])].map(el => el.getAttribute('aria-label') || '')
        .filter(label => /^Copy (Width|Height):/.test(label)).map(label => Number(label.split(':')[1].replace(/[^\d.]/g, '')));
      if (params.format === 'PNG' && dimensions.length === 2 && dimensions[0] * dimensions[1] > 16_000_000)
        throw new Error('Layer exceeds 16 megapixels. Select a smaller layer before copying PNG.');
      // Overwrite before reading so existing clipboard contents are never returned to MCP.
      await navigator.clipboard.writeText(params.marker);
      one().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
      const copyAs = await waitFor(() => [...document.querySelectorAll('[role="menu"] [id]')].find(el => label(el) === 'Copy as'));
      hover(copyAs);
      const command = await waitFor(() => [...document.querySelectorAll('[id]')].find(el => el.id.startsWith(`layerMenu-copy-as-${params.format.toLowerCase()}-`) && visible(el)));
      if (command.getAttribute('aria-disabled') === 'true') throw new Error('Figma does not allow copying this layer.');
      activate(command);
      return { result: node };
    }
    if (method === 'read_export') {
      if (params.format !== 'PNG') throw new Error('Clipboard export supports PNG only.');
      // Native copy may briefly move focus to a helper frame.
      if (!document.hasFocus()) return { result: null };
      const items = await navigator.clipboard.read();
      const item = items.find(item => item.types.includes('image/png'));
      if (!item) return { result: null };
      const blob = await item.getType('image/png');
      // Bound decoding memory as well as final output. Native Figma copy itself cannot be cancelled.
      if (blob.size > 12 * 1024 * 1024) throw new Error('Source PNG exceeds 12 MiB. Select a smaller layer.');
      const header = new DataView(await blob.slice(0, 24).arrayBuffer());
      const width = header.getUint32(16), height = header.getUint32(20);
      if (!width || !height || width * height > 16_000_000) throw new Error('Source PNG exceeds 16 megapixels. Select a smaller layer.');
      const bitmap = await createImageBitmap(blob);
      try {
        const scale = Math.min(params.scale || 1, 2048 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/png').split(',')[1];
        if (data.length > 4 * 1024 * 1024) throw new Error('PNG exceeds 3 MiB. Select a smaller layer.');
        assertSelection();
        return { result: { nodeId: node.id, name: node.name, format: 'PNG', data, scale, scaleBasis: 'clipboard' } };
      } finally { bitmap.close(); }
    }
    throw new Error('Unsupported browser operation');
  } catch (error) { return { error: error.message || 'Browser operation failed' }; }
}
