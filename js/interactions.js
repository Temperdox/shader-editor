/* Global-level interactions: pan/zoom, right-click context menu, add-module picker. */

/* ---------------- pan / zoom ----------------
 * Middle mouse pans (records the down position + current view translate, then
 * re-derives on move). Wheel zooms toward the cursor by keeping the logical
 * point under the mouse fixed before/after the scale change. */
(() => {
  let middleDown = false;
  let startX = 0, startY = 0, startTX = 0, startTY = 0;

  graphEl.addEventListener('pointerdown', (e) => {
    if (e.button === 1){
      middleDown = true;
      startX = e.clientX; startY = e.clientY;
      startTX = state.view.tx; startTY = state.view.ty;
      graphEl.classList.add('panning');
      e.preventDefault();
    }
  });
  window.addEventListener('pointermove', (e) => {
    if (!middleDown) return;
    state.view.tx = startTX + (e.clientX - startX);
    state.view.ty = startTY + (e.clientY - startY);
    updateViewportTransform();
  });
  window.addEventListener('pointerup', (e) => {
    if (e.button === 1){
      middleDown = false;
      graphEl.classList.remove('panning');
    }
  });

  graphEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = graphEl.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = clamp(state.view.scale * factor, 0.2, 3.5);
    const realFactor = newScale / state.view.scale;
    // keep the world point under (cx, cy) stationary after zoom
    state.view.tx = cx - (cx - state.view.tx) * realFactor;
    state.view.ty = cy - (cy - state.view.ty) * realFactor;
    state.view.scale = newScale;
    updateViewportTransform();
  }, { passive: false });
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
window.addEventListener('mousedown', (e) => {
  if (ctxOpen && !ctxEl.contains(e.target)) closeContextMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){
    closeContextMenu();
    closePicker();
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
  openContextMenu(x, y, [
    { label:'Recenter to origin', fn:() => recenterView() },
    { label:'Add new module…',    fn:() => openPicker({ x: worldX, y: worldY }) },
    { sep:true },
    { label:'Reset graph',        danger:true, fn:() => resetGraph() },
  ]);
}

function openNodeContextMenu(x, y, node){
  const isOutput = node.type === 'output';
  const items = [
    { label:'Disconnect all inputs',    fn:() => disconnectNode(node, 'in')  },
    { label:'Disconnect all outputs',   fn:() => disconnectNode(node, 'out') },
    { sep:true },
    { label:'Duplicate module',         fn:() => duplicateNode(node) },
    { label:'Reset values to default',  fn:() => resetNodeParams(node) },
  ];
  if (!isOutput){
    items.push({ sep:true });
    items.push({ label:'Delete module', danger:true, fn:() => deleteNode(node) });
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
  const catOrder = ['Input', 'Math', 'Vector', 'Pattern', 'Effect'];
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
  state.selected = node.id;
  renderAll();
  scheduleRecompile();
  closePicker();
}
