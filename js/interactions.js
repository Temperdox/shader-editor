/* Global-level interactions: pan/zoom, right-click context menu, add-module picker. */

/* ---------------- pan / zoom ----------------
 * Middle mouse pans (always available, regardless of tool mode). Wheel zooms
 * toward the cursor. Left mouse behavior depends on state.toolMode:
 *   - 'select' (default): on empty space → marquee select; on node → drag/select
 *   - 'pan'   : on empty space → drag the view (alternate path for users
 *               whose mouse has no middle button)
 *   - 'zoom'  : on empty space → click-to-zoom-in (Shift+click → zoom out) */
(() => {
  let panDown = false;
  let startX = 0, startY = 0, startTX = 0, startTY = 0;

  // Helper used by both middle-click and tool=pan left-click paths.
  function beginPan(e){
    panDown = true;
    startX = e.clientX; startY = e.clientY;
    startTX = state.view.tx; startTY = state.view.ty;
    graphEl.classList.add('panning');
    e.preventDefault();
  }

  // Zoom around a screen-space point, keeping that point's world coord fixed.
  function zoomAt(cx, cy, factor){
    const rect = graphEl.getBoundingClientRect();
    const px = cx - rect.left, py = cy - rect.top;
    const newScale = clamp(state.view.scale * factor, 0.2, 3.5);
    const realFactor = newScale / state.view.scale;
    state.view.tx = px - (px - state.view.tx) * realFactor;
    state.view.ty = py - (py - state.view.ty) * realFactor;
    state.view.scale = newScale;
    updateViewportTransform();
  }

  graphEl.addEventListener('pointerdown', (e) => {
    if (e.button === 1){
      beginPan(e);
      return;
    }
    if (e.button !== 0) return;

    const onEmpty =
      e.target === graphEl ||
      e.target === viewportEl ||
      e.target === connectionsEl ||
      e.target.classList?.contains('graph-grid') ||
      e.target === connectionsEl?.ownerSVGElement;

    // Tool-mode-specific behaviors take precedence on empty space; over a
    // node/socket we always defer to the node's own handlers.
    if (onEmpty){
      if (state.toolMode === 'pan'){
        beginPan(e);
        return;
      }
      if (state.toolMode === 'zoom'){
        zoomAt(e.clientX, e.clientY, e.shiftKey ? 1 / 1.5 : 1.5);
        e.preventDefault();
        return;
      }
      // select mode (default)
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey){
        state.selected.clear();
        refreshSelectionClasses();
      }
      startMarquee(e);
      e.preventDefault();
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!panDown) return;
    state.view.tx = startTX + (e.clientX - startX);
    state.view.ty = startTY + (e.clientY - startY);
    updateViewportTransform();
  });
  window.addEventListener('pointerup', (e) => {
    if (panDown && (e.button === 0 || e.button === 1)){
      panDown = false;
      graphEl.classList.remove('panning');
    }
  });

  graphEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  // Shift toggles zoom-out cursor while in zoom mode for visual feedback.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && state.toolMode === 'zoom'){
      graphEl.classList.add('zoom-out');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift'){
      graphEl.classList.remove('zoom-out');
    }
  });
})();

/* ---------------- context menu ---------------- */
const ctxEl = $('#ctx');
let ctxOpen = false;

function openContextMenu(x, y, items){
  ctxEl.innerHTML = '';
  for (const it of items){
    if (it.sep){
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      ctxEl.appendChild(s);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.innerHTML = `<span>${escapeHTML(it.label)}</span>${
      it.kbd ? `<span class="ctx-kbd">${escapeHTML(it.kbd)}</span>` : ''
    }`;
    el.addEventListener('click', () => { closeContextMenu(); it.fn(); });
    ctxEl.appendChild(el);
  }
  // position, then clamp so the menu stays on screen
  ctxEl.style.left = '0px';
  ctxEl.style.top  = '0px';
  ctxEl.classList.add('open');
  const r = ctxEl.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth  - r.width  - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  ctxEl.style.left = px + 'px';
  ctxEl.style.top  = py + 'px';
  ctxOpen = true;
}
function closeContextMenu(){
  ctxEl.classList.remove('open');
  ctxOpen = false;
}
// Close on any press outside the menu. Capture phase ensures we fire before
// any node/socket/header pointerdown handler that calls stopPropagation. We
// listen for both pointerdown (modern path, also covers touch) and mousedown
// (so middle-click and edge cases still dismiss).
function _closeMenuIfOutside(e){
  if (ctxOpen && !ctxEl.contains(e.target)) closeContextMenu();
}
document.addEventListener('pointerdown', _closeMenuIfOutside, true);
document.addEventListener('mousedown',   _closeMenuIfOutside, true);
// Right-clicking elsewhere should also dismiss the current menu before the
// new contextmenu handler opens a fresh one. mousedown/pointerdown above
// usually catch this, but contextmenu in capture is a belt-and-braces guard
// for browsers that don't fire pointerdown for the right button.
document.addEventListener('contextmenu', _closeMenuIfOutside, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){
    closeContextMenu();
    closePicker();
    return;
  }

  // Ignore shortcuts while the user is typing into an input/textarea/select —
  // otherwise Ctrl+C etc. would interfere with normal text editing.
  const t = e.target;
  const typing =
    t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) return;

  const mod = e.ctrlKey || e.metaKey;

  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')){
    e.preventDefault();
    doUndo();
    return;
  }
  if (mod && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))){
    e.preventDefault();
    doRedo();
    return;
  }
  if (mod && (e.key === 'c' || e.key === 'C')){
    e.preventDefault();
    copySelection();
    return;
  }
  if (mod && (e.key === 'v' || e.key === 'V')){
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (mod && (e.key === 'd' || e.key === 'D')){
    e.preventDefault();
    duplicateSelection();
    return;
  }
  if (mod && (e.key === 's' || e.key === 'S')){
    e.preventDefault();
    if (typeof openSaveModal === 'function') openSaveModal();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace'){
    if (!state.selected.size) return;
    e.preventDefault();
    deleteSelection();
    return;
  }
});

// right-click in the graph — menu differs depending on whether the click
// landed on a node or on empty space.
graphEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const nodeEl = e.target.closest('.node');
  if (nodeEl){
    const node = state.nodes.find(n => n.id === nodeEl.dataset.id);
    if (node) openNodeContextMenu(e.clientX, e.clientY, node);
  } else {
    openEmptyContextMenu(e.clientX, e.clientY);
  }
});

function openEmptyContextMenu(x, y){
  // record the world coords where the user right-clicked so "Add new module…"
  // can drop the created node right under the cursor.
  const { tx, ty, scale } = state.view;
  const graphRect = graphEl.getBoundingClientRect();
  const worldX = (x - graphRect.left - tx) / scale;
  const worldY = (y - graphRect.top  - ty) / scale;
  const canPaste = !!(clipboard.nodes && clipboard.nodes.length);
  openContextMenu(x, y, [
    { label:'Recenter to origin', fn:() => recenterView() },
    { label:'Add new module…',    fn:() => openPicker({ x: worldX, y: worldY }) },
    { sep:true },
    ...(canPaste ? [{ label:'Paste modules', kbd:'Ctrl+V', fn:() => pasteClipboard() }] : []),
    { sep:true },
    { label:'Clear graph',        fn:() => clearGraph() },
    { label:'Reset graph',        danger:true, fn:() => resetGraph() },
  ]);
}

function openNodeContextMenu(x, y, node){
  const isOutput = node.type === 'output';
  // If the clicked node wasn't in the current selection, right-click
  // should act on JUST that node — replace selection with it.
  if (!state.selected.has(node.id)){
    state.selected.clear();
    state.selected.add(node.id);
    refreshSelectionClasses();
  }
  const multi = state.selected.size > 1;
  const items = [
    { label: multi ? 'Copy modules'    : 'Copy module',    kbd:'Ctrl+C', fn:() => copySelection() },
    { label: multi ? 'Paste modules'   : 'Paste module',   kbd:'Ctrl+V', fn:() => pasteClipboard() },
    { label: multi ? 'Duplicate modules' : 'Duplicate module', kbd:'Ctrl+D', fn:() => duplicateSelection() },
    { sep:true },
    { label:'Disconnect all inputs',    fn:() => disconnectNode(node, 'in')  },
    { label:'Disconnect all outputs',   fn:() => disconnectNode(node, 'out') },
    { sep:true },
    { label:'Reset values to default',  fn:() => resetNodeParams(node) },
  ];
  if (!isOutput){
    items.push({ sep:true });
    items.push({ label: multi ? 'Delete modules' : 'Delete module', danger:true, kbd:'Del', fn:() => deleteSelection() });
  }
  openContextMenu(x, y, items);
}

/* ---------------- add-module picker ---------------- */
const pickerEl     = $('#picker');
const pickerBack   = $('#pickerBack');
const pickerBody   = $('#pickerBody');
const pickerSearch = $('#pickerSearch');
let pickerPlaceAt  = null;  // world coords to drop the next picked node at

function openPicker(placeAt){
  pickerPlaceAt = placeAt || null;
  renderPicker('');
  pickerSearch.value = '';
  pickerEl.classList.add('open');
  pickerBack.classList.add('open');
  setTimeout(() => pickerSearch.focus(), 30);
}
function closePicker(){
  pickerEl.classList.remove('open');
  pickerBack.classList.remove('open');
}
pickerBack.addEventListener('click', closePicker);
pickerSearch.addEventListener('input', () => renderPicker(pickerSearch.value));
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter'){
    const first = pickerBody.querySelector('.picker-item');
    if (first) first.click();
  }
});

function renderPicker(q){
  const query = q.trim().toLowerCase();
  pickerBody.innerHTML = '';
  const byCat = {};
  for (const [type, def] of Object.entries(NODE_TYPES)){
    if (type === 'output') continue;   // only one output per graph
    const match = !query
      || def.title.toLowerCase().includes(query)
      || def.category.toLowerCase().includes(query)
      || (def.desc || '').toLowerCase().includes(query)
      || type.toLowerCase().includes(query);
    if (!match) continue;
    (byCat[def.category] ||= []).push({ type, def });
  }
  const catOrder = ['Input', 'Math', 'Vector', 'Pattern', 'Effect', 'Module'];
  const cats = Object.keys(byCat).sort((a, b) => {
    const ai = catOrder.indexOf(a), bi = catOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  for (const cat of cats){
    const group = document.createElement('div');
    group.className = 'picker-group';
    const title = document.createElement('div');
    title.className = 'picker-group-title';
    title.textContent = cat;
    group.appendChild(title);
    const items = document.createElement('div');
    items.className = 'picker-items';
    for (const { type, def } of byCat[cat]){
      const it = document.createElement('div');
      it.className = 'picker-item';
      it.innerHTML = `
        <div class="pi-title">${escapeHTML(def.title)}</div>
        <div class="pi-desc">${escapeHTML(def.desc || type)}</div>
      `;
      it.addEventListener('click', () => addNodeFromPicker(type));
      items.appendChild(it);
    }
    group.appendChild(items);
    pickerBody.appendChild(group);
  }
  if (!pickerBody.childNodes.length){
    const empty = document.createElement('div');
    empty.style.padding = '24px';
    empty.style.color = 'var(--ink-faint)';
    empty.style.textAlign = 'center';
    empty.textContent = 'no matches';
    pickerBody.appendChild(empty);
  }
}

function addNodeFromPicker(type){
  let x, y;
  if (pickerPlaceAt){
    x = pickerPlaceAt.x;
    y = pickerPlaceAt.y;
  } else {
    // no cursor anchor → place near the current viewport center
    const rect = graphEl.getBoundingClientRect();
    const { tx, ty, scale } = state.view;
    x = (rect.width  / 2 - tx) / scale - 100;
    y = (rect.height / 2 - ty) / scale - 40;
  }
  const node = makeNode(type, x, y);
  state.nodes.push(node);
  state.selected.clear();
  state.selected.add(node.id);
  renderAll();
  scheduleRecompile();
  pushHistory();
  closePicker();
}
