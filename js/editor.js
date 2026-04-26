/* Editor — renders nodes + connections into the viewport and wires up the
   per-node interactions (drag, sockets, selection). Pan/zoom/context-menu
   live in interactions.js. */

const viewportEl     = $('#viewport');
const connectionsEl  = $('#connections');
const graphEl        = $('#graph');
const zoomPill       = $('#zoomPill');

function updateViewportTransform(){
  const { tx, ty, scale } = state.view;
  viewportEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomPill.textContent = `${Math.round(scale * 100)}%`;

  // shift the graph-grid background to parallax with the viewport
  const g = $('#graphGrid');
  const s22  = 22 * scale;
  const s110 = 110 * scale;
  g.style.backgroundSize = `${s22}px ${s22}px, ${s22}px ${s22}px, ${s110}px ${s110}px, ${s110}px ${s110}px`;
  g.style.backgroundPosition = `${tx}px ${ty}px, ${tx}px ${ty}px, ${tx}px ${ty}px, ${tx}px ${ty}px`;
}

function renderAll(){
  // drop any existing node DOM but keep the SVG connection layer intact
  $$('.node', viewportEl).forEach(el => el.remove());
  for (const node of state.nodes){
    viewportEl.appendChild(renderNode(node));
  }
  renderConnections();
}

function renderNode(node){
  const def = NODE_TYPES[node.type];
  const el = document.createElement('div');
  el.className = 'node';
  el.dataset.id = node.id;
  el.style.left = node.x + 'px';
  el.style.top  = node.y + 'px';
  if (state.selected.has(node.id)) el.classList.add('selected');

  const header = document.createElement('div');
  header.className = 'node-header';
  header.innerHTML = `
    <div class="node-title">${escapeHTML(def.title)}</div>
    <div class="node-header-meta">
      <div class="node-cat">${escapeHTML(def.category)}</div>
      <button class="node-info-btn" type="button" title="Module info" aria-label="Module info"></button>
    </div>
  `;
  // Info button: open the per-node info modal. Stop propagation so the click
  // doesn't trigger node selection or start a header drag.
  const infoBtn = header.querySelector('.node-info-btn');
  infoBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  infoBtn.addEventListener('mousedown',   (e) => e.stopPropagation());
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (typeof openNodeInfoModal === 'function') openNodeInfoModal(node);
  });
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'node-body';
  el.appendChild(body);

  const inputs  = getNodeInputs(node);
  const outputs = getNodeOutputs(node);
  const params  = def.params  || [];

  // Flag module renders a totally custom body (internal sockets + wires),
  // not the standard param / input / output rows. Short-circuit here and
  // let renderFlagBody do the work.
  if (def.customBody === 'flag'){
    renderFlagBody(node, el, body);
    attachNodeDrag(el, node);
    attachSocketHandlers(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const multi = e.shiftKey || e.ctrlKey || e.metaKey;
      if (multi){
        if (state.selected.has(node.id)) state.selected.delete(node.id);
        else                              state.selected.add(node.id);
      } else if (!state.selected.has(node.id)){
        state.selected.clear();
        state.selected.add(node.id);
      }
      refreshSelectionClasses();
    });
    return el;
  }

  // Layer Stack — dynamic input rows + per-layer opacity/mode controls.
  if (def.customBody === 'layerStack'){
    renderLayerStackBody(node, el, body);
    attachNodeDrag(el, node);
    attachSocketHandlers(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const multi = e.shiftKey || e.ctrlKey || e.metaKey;
      if (multi){
        if (state.selected.has(node.id)) state.selected.delete(node.id);
        else                              state.selected.add(node.id);
      } else if (!state.selected.has(node.id)){
        state.selected.clear();
        state.selected.add(node.id);
      }
      refreshSelectionClasses();
    });
    return el;
  }

  // param rows (numbers, colors, vec2, selects, segmented toggles, images).
  // Each param can opt into conditional display via `visibleWhen(params)` —
  // used by heightMap / normalMap to show procedural params in dynamic mode
  // and the image uploader in static mode.
  for (const p of params){
    if (typeof p.visibleWhen === 'function' && !p.visibleWhen(node.params)) continue;
    body.appendChild(renderParamRow(node, p));
  }

  // input rows — socket dot on the left; unconnected float/vec3 inputs get
  // an inline editor on the right so users can set defaults without having
  // to add a separate Float/Color node.
  for (const sock of inputs){
    const row = document.createElement('div');
    row.className = 'node-row';
    // Two flavors of "connected":
    //   `connected` — there is a wire physically rendered to this socket
    //                 → the socket dot stays filled, wire stays visible.
    //   `live`      — the wire actually delivers a value (i.e. the source
    //                 isn't a muted Flag output). Drives whether the inline
    //                 editor shows: when the source is muted, the compiler
    //                 falls back to this socket's default, so the user
    //                 needs to be able to edit that default in place.
    const connected = isSocketConnected(node.id, 'in', sock.name);
    const live      = isInputLive(node.id, sock.name);

    const s = document.createElement('div');
    s.className = 'socket in';
    s.dataset.nodeId   = node.id;
    s.dataset.socket   = sock.name;
    s.dataset.dir      = 'in';
    s.dataset.sockType = sock.type;
    if (connected) s.classList.add('connected');
    if (connected && !live) s.classList.add('muted');
    row.appendChild(s);

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = `${sock.name} (${sock.type})`;
    row.appendChild(label);

    // Inline editor when no LIVE connection (so muted Flag uplinks still
    // expose the editor — the user can tune the fall-back value while the
    // wire stays visible). Sockets can opt out with `noInline:true`.
    if (!live && !sock.noInline){
      const inline = makeInlineSocketInput(node, sock);
      if (inline) row.appendChild(inline);
    }
    body.appendChild(row);
  }

  // output rows — socket dot on the right
  for (const sock of outputs){
    const row = document.createElement('div');
    row.className = 'node-row';

    const label = document.createElement('div');
    label.className = 'row-label right';
    label.textContent = `${sock.name} (${sock.type})`;
    row.appendChild(label);

    const s = document.createElement('div');
    s.className = 'socket out';
    s.dataset.nodeId   = node.id;
    s.dataset.socket   = sock.name;
    s.dataset.dir      = 'out';
    s.dataset.sockType = sock.type;
    if (isSocketConnected(node.id, 'out', sock.name)) s.classList.add('connected');
    row.appendChild(s);

    body.appendChild(row);
  }

  // preview thumbnail (currently used by UV / Centered UV to visualize their output)
  if (def.preview){
    body.appendChild(renderPreviewBox(def.preview));
  }

  attachNodeDrag(el, node);
  attachSocketHandlers(el);

  // Selection handling:
  //   - Plain click:       replace selection with this node
  //   - Shift/Ctrl + click: toggle this node in/out of the existing selection
  //   - Click on a node that's already selected: keep selection as-is (so
  //     the user can drag the whole multi-selection without losing it)
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    if (multi){
      if (state.selected.has(node.id)) state.selected.delete(node.id);
      else                              state.selected.add(node.id);
    } else if (!state.selected.has(node.id)){
      state.selected.clear();
      state.selected.add(node.id);
    }
    refreshSelectionClasses();
  });

  return el;
}

/* Re-applies `.selected` to every visible node DOM based on the current
   `state.selected` Set. Called after any selection change. Cheap — runs
   through ~30 nodes setting classList. */
function refreshSelectionClasses(){
  for (const n of viewportEl.querySelectorAll('.node')){
    n.classList.toggle('selected', state.selected.has(n.dataset.id));
  }
}

/* Renders the coordinate-encoded thumbnail under the UV / Centered UV nodes.
   `kind` picks the encoding:
     'uv'         → (u, v, 0) — origin at bottom-left, brightest at top-right
     'centeredUV' → (|cu|, |cv|, 0) — origin at center, bright at edges
   Painting uses a 140px ImageData loop once per render; cost is negligible
   since the previews render only when a node DOM is (re)built. */
function renderPreviewBox(kind){
  const wrap = document.createElement('div');
  wrap.className = 'node-preview';
  const canvas = document.createElement('canvas');
  canvas.width = 140; canvas.height = 140;
  wrap.appendChild(canvas);
  paintPreviewCanvas(canvas, kind);
  return wrap;
}

function paintPreviewCanvas(canvas, kind){
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++){
    // flip Y so the bottom of the image is v=0 (matches our shader convention)
    const v = 1 - y / (h - 1);
    for (let x = 0; x < w; x++){
      const u = x / (w - 1);
      let r = 0, g = 0, b = 0;
      if (kind === 'uv'){
        r = u * 255; g = v * 255;
      } else if (kind === 'centeredUV'){
        const cu = u - 0.5, cv = v - 0.5;
        r = Math.min(255, Math.abs(cu) * 2 * 255);
        g = Math.min(255, Math.abs(cv) * 2 * 255);
      }
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* Inline editor for an unconnected socket — float → themed number field,
   vec3 → color swatch. Returns null for types without a supported editor
   (e.g. vec2) so those rows just show the socket + label. */
function makeInlineSocketInput(node, sock){
  if (sock.type === 'float'){
    const current = node.defaults[sock.name] ?? sock.default ?? 0;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'val narrow';
    input.step = 0.01;
    input.value = current;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      node.defaults[sock.name] = isFinite(v) ? v : 0;
      scheduleRecompile();
    });
    input.addEventListener('pointerdown', e => e.stopPropagation());
    const wrap = wrapWithSpinner(input);
    wrap.classList.add('val-inline');
    return wrap;
  }
  if (sock.type === 'vec3'){
    const rgb = node.defaults[sock.name] ?? sock.default ?? [0, 0, 0];
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'val val-color val-inline';
    picker.value = rgbToHex(rgb[0], rgb[1], rgb[2]);
    picker.addEventListener('input', () => {
      node.defaults[sock.name] = hexToRgb(picker.value);
      scheduleRecompile();
    });
    picker.addEventListener('pointerdown', e => e.stopPropagation());
    return picker;
  }
  return null;
}

function renderParamRow(node, param){
  const row = document.createElement('div');
  row.className = 'node-row';

  const label = document.createElement('div');
  label.className = 'row-label';
  label.textContent = param.name;
  row.appendChild(label);

  const wrap = document.createElement('div');
  wrap.className = 'row-label right';

  if (param.kind === 'number'){
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'val';
    input.value = node.params[param.name];
    if (param.step !== undefined) input.step = param.step;
    if (param.min  !== undefined) input.min  = param.min;
    if (param.max  !== undefined) input.max  = param.max;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      node.params[param.name] = isFinite(v) ? v : 0;
      scheduleRecompile();
    });
    // one history snapshot per commit (blur / enter), not per keystroke
    input.addEventListener('change', () => pushHistory());
    // prevent header-drag from starting when the user interacts with the input
    input.addEventListener('pointerdown', e => e.stopPropagation());
    wrap.appendChild(wrapWithSpinner(input));
  }
  else if (param.kind === 'color'){
    const [r, g, b] = node.params[param.name];
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'val val-color';
    picker.value = rgbToHex(r, g, b);
    picker.addEventListener('input', () => {
      const [nr, ng, nb] = hexToRgb(picker.value);
      node.params[param.name] = [nr, ng, nb];
      scheduleRecompile();
    });
    picker.addEventListener('change', () => pushHistory());
    picker.addEventListener('pointerdown', e => e.stopPropagation());
    wrap.appendChild(picker);
  }
  else if (param.kind === 'vec2'){
    const [x, y] = node.params[param.name];
    const ix = document.createElement('input');
    ix.type = 'number'; ix.className = 'val narrow'; ix.step = param.step ?? 0.01;
    ix.value = x;
    const iy = document.createElement('input');
    iy.type = 'number'; iy.className = 'val narrow'; iy.step = param.step ?? 0.01;
    iy.value = y;
    ix.addEventListener('input', () => {
      node.params[param.name][0] = parseFloat(ix.value) || 0;
      scheduleRecompile();
    });
    iy.addEventListener('input', () => {
      node.params[param.name][1] = parseFloat(iy.value) || 0;
      scheduleRecompile();
    });
    ix.addEventListener('change', () => pushHistory());
    iy.addEventListener('change', () => pushHistory());
    ix.addEventListener('pointerdown', e => e.stopPropagation());
    iy.addEventListener('pointerdown', e => e.stopPropagation());
    const wx = wrapWithSpinner(ix);
    const wy = wrapWithSpinner(iy);
    wy.style.marginLeft = '4px';
    wrap.appendChild(wx);
    wrap.appendChild(wy);
  }
  else if (param.kind === 'select'){
    const sel = document.createElement('select');
    sel.className = 'val-select';
    for (const opt of param.options){
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    }
    sel.value = node.params[param.name];
    sel.addEventListener('change', () => {
      node.params[param.name] = sel.value;
      scheduleRecompile();
      pushHistory();
    });
    sel.addEventListener('pointerdown', e => e.stopPropagation());
    wrap.appendChild(sel);
  }
  else if (param.kind === 'segmented'){
    // two-or-more pill buttons rendered as a single control. Changing the
    // selection triggers a full re-render because other params' visibility
    // may change (dynamic/static on heightMap, for example).
    const group = document.createElement('div');
    group.className = 'val-segmented';
    for (const opt of param.options){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg-btn' + (node.params[param.name] === opt ? ' active' : '');
      btn.textContent = opt;
      btn.addEventListener('pointerdown', e => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (node.params[param.name] === opt) return;
        node.params[param.name] = opt;
        renderAll();            // param visibility may have changed
        scheduleRecompile();
        pushHistory();
      });
      group.appendChild(btn);
    }
    wrap.appendChild(group);
  }
  else if (param.kind === 'image'){
    // Composite control — hidden file input + upload button + URL text field.
    // File uploads become data URLs so saved graphs are self-contained.
    const box = document.createElement('div');
    box.className = 'val-image';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'val val-image-url';
    urlInput.placeholder = 'URL or upload…';
    // For data: URLs we render a truncated placeholder to keep the node narrow;
    // the real value is still in node.params.
    urlInput.value = node.params[param.name] || '';
    urlInput.addEventListener('input', () => {
      node.params[param.name] = urlInput.value;
      loadImageForNode(node.id, urlInput.value);
    });
    urlInput.addEventListener('pointerdown', e => e.stopPropagation());

    const upload = document.createElement('button');
    upload.type = 'button';
    upload.className = 'val-image-upload';
    upload.title = 'Upload image';
    upload.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V3"/><polyline points="5 6 8 3 11 6"/><path d="M3 12v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1"/></svg>`;
    upload.addEventListener('pointerdown', e => e.stopPropagation());

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.display = 'none';

    upload.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        node.params[param.name] = dataUrl;
        // Reflect in the URL input — data URLs are huge, so don't overwrite
        // the display with the whole thing. Show the filename instead.
        urlInput.value = `file: ${f.name}`;
        loadImageForNode(node.id, dataUrl);
      };
      reader.readAsDataURL(f);
    });

    box.appendChild(urlInput);
    box.appendChild(upload);
    box.appendChild(file);

    // If the stored value is already a data URL, display a friendly label
    // rather than the base64 blob.
    if ((node.params[param.name] || '').startsWith('data:')){
      urlInput.value = 'file: (embedded)';
    }

    wrap.appendChild(box);
  }

  row.appendChild(wrap);
  return row;
}

/* Wraps a <input type="number"> with themed ▲/▼ chevron buttons. The native
   spinners are hidden by CSS; these call stepUp/stepDown and re-dispatch
   'input' so the node's param listener updates normally. Press-and-hold
   kicks in after ~320ms and auto-repeats every 55ms until release. */
function wrapWithSpinner(input){
  const wrap = document.createElement('span');
  wrap.className = 'val-num-wrap';
  wrap.appendChild(input);

  const spin = document.createElement('span');
  spin.className = 'val-spin';
  spin.appendChild(makeSpinButton('up',   input));
  spin.appendChild(makeSpinButton('down', input));
  wrap.appendChild(spin);
  return wrap;
}

function makeSpinButton(dir, input){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `val-spin-btn ${dir}`;
  btn.setAttribute('aria-label', dir === 'up' ? 'Increase' : 'Decrease');
  btn.innerHTML = dir === 'up'
    ? '<svg viewBox="0 0 10 7" aria-hidden="true"><path d="M1 6 L5 1 L9 6"/></svg>'
    : '<svg viewBox="0 0 10 7" aria-hidden="true"><path d="M1 1 L5 6 L9 1"/></svg>';

  const step = () => {
    try {
      if (dir === 'up') input.stepUp(); else input.stepDown();
    } catch {
      // stepUp/Down can throw if step/min/max aren't set — fall back to
      // adjusting by the step attribute (or 1) manually.
      const s = parseFloat(input.step) || 1;
      const cur = parseFloat(input.value) || 0;
      input.value = String(cur + (dir === 'up' ? s : -s));
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  let holdTimer = null;
  let holdInterval = null;
  const cancelHold = () => {
    clearTimeout(holdTimer);  holdTimer = null;
    clearInterval(holdInterval); holdInterval = null;
    btn.classList.remove('pressing');
  };

  btn.addEventListener('pointerdown', (e) => {
    // prevent focus transfer from the input, and don't start a node drag
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add('pressing');
    step();
    holdTimer = setTimeout(() => { holdInterval = setInterval(step, 55); }, 320);
    // capture so the pointer keeps firing on this button even if the cursor
    // drifts off — guarantees the release handler runs.
    try { btn.setPointerCapture(e.pointerId); } catch {}
  });
  btn.addEventListener('pointerup',     cancelHold);
  btn.addEventListener('pointerleave',  cancelHold);
  btn.addEventListener('pointercancel', cancelHold);
  // swallow the implicit click so we don't double-step
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

  return btn;
}

/* ---------------- connection rendering ----------------
 * Socket DOM is positioned inside node divs (which live in viewport logical
 * space). The SVG overlay shares that space, so for each connection we sample
 * each socket's screen-space rect, undo the viewport transform, and draw a
 * cubic Bezier that elbows horizontally from the socket. */
function socketLogicalCenter(sockEl){
  const sockRect = sockEl.getBoundingClientRect();
  const { tx, ty, scale } = state.view;
  const graphRect = graphEl.getBoundingClientRect();
  const scx = sockRect.left + sockRect.width  / 2;
  const scy = sockRect.top  + sockRect.height / 2;
  return {
    x: (scx - graphRect.left - tx) / scale,
    y: (scy - graphRect.top  - ty) / scale,
  };
}

function curvePath(a, b){
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderConnections(){
  while (connectionsEl.firstChild) connectionsEl.removeChild(connectionsEl.firstChild);
  for (const conn of state.connections){
    const from = socketElement(conn.from.nodeId, 'out', conn.from.socket);
    const to   = socketElement(conn.to.nodeId,   'in',  conn.to.socket);
    if (!from || !to) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.dataset.id = conn.id;
    // Visually dim wires whose source is a muted Flag output — gives the
    // user immediate feedback that the connection isn't currently
    // delivering a value (and that the downstream inline editor is live).
    const srcNode = state.nodes.find(n => n.id === conn.from.nodeId);
    if (isFlagOutputMuted(srcNode, conn.from.socket)) path.classList.add('muted');
    const a = socketLogicalCenter(from);
    const b = socketLogicalCenter(to);
    path.setAttribute('d', curvePath(a, b));
    path.addEventListener('mouseenter', () => path.classList.add('hover'));
    path.addEventListener('mouseleave', () => path.classList.remove('hover'));
    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        { label:'Delete connection', danger:true, fn:() => removeConnection(conn.id) },
      ]);
    });
    // alt+click = quick delete
    path.addEventListener('click', (e) => {
      if (e.altKey) removeConnection(conn.id);
    });
    connectionsEl.appendChild(path);
  }
}

function socketElement(nodeId, dir, name){
  return viewportEl.querySelector(
    `.node[data-id="${nodeId}"] .socket.${dir}[data-socket="${name}"]`
  );
}

function removeConnection(id){
  state.connections = state.connections.filter(c => c.id !== id);
  renderAll();
  scheduleRecompile();
  pushHistory();
}

/* ---------------- node dragging (header grab) ---------------- */
function attachNodeDrag(el, node){
  const header = el.querySelector('.node-header');
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;

    // If the grabbed node is part of a multi-selection, drag the whole
    // group together. Otherwise drag just this one.
    const group = state.selected.has(node.id) && state.selected.size > 1
      ? state.nodes.filter(n => state.selected.has(n.id))
      : [node];
    const origins = new Map(group.map(n => [n.id, { x: n.x, y: n.y }]));
    let moved = false;
    el.classList.add('dragging');

    const onMove = (ev) => {
      let dx = (ev.clientX - startX) / state.view.scale;
      let dy = (ev.clientY - startY) / state.view.scale;
      // Grid snap: snap the LEAD node's new position to the nearest grid
      // cell, then derive the snapped delta. The whole group shifts by the
      // same delta so relative offsets within the selection are preserved.
      if (state.snapToGrid){
        const ref = origins.get(group[0].id);
        const targetX = ref.x + dx;
        const targetY = ref.y + dy;
        const snappedX = Math.round(targetX / GRID_SNAP_PX) * GRID_SNAP_PX;
        const snappedY = Math.round(targetY / GRID_SNAP_PX) * GRID_SNAP_PX;
        dx = snappedX - ref.x;
        dy = snappedY - ref.y;
      }
      if (dx !== 0 || dy !== 0) moved = true;
      for (const g of group){
        const o = origins.get(g.id);
        g.x = o.x + dx;
        g.y = o.y + dy;
        const gEl = viewportEl.querySelector(`.node[data-id="${g.id}"]`);
        if (gEl){
          gEl.style.left = g.x + 'px';
          gEl.style.top  = g.y + 'px';
        }
      }
      renderConnections();
    };
    const onUp = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) pushHistory();   // skip no-op clicks
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ---------------- socket click-drag to connect ---------------- */
function attachSocketHandlers(nodeEl){
  for (const sock of nodeEl.querySelectorAll('.socket')){
    sock.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startWire(sock);
    });
  }
}

/* Click-drag entry point. Direction-specific behavior:
   - INPUT already connected → pick up the existing wire (detach) and drag
     from the upstream output. Drop-on-empty deletes, drop-on-compatible
     input rewires. An input can only have one upstream, so "click the
     existing wire" is unambiguous.
   - OUTPUT (connected or not) → ALWAYS start a new wire. Outputs fan out
     to any number of downstream inputs, so clicking a connected output
     should never disconnect its existing consumers — the user is adding
     another consumer. To delete a specific wire, right-click it (context
     menu → Delete connection) or alt+click the wire.
   - INPUT not connected → start a new wire. */
function startWire(sockEl){
  const isInput = sockEl.dataset.dir === 'in';
  const nodeId  = sockEl.dataset.nodeId;
  const socket  = sockEl.dataset.socket;

  if (isInput){
    const existing = state.connections.filter(c =>
      c.to.nodeId === nodeId && c.to.socket === socket
    );
    if (existing.length > 0){
      const conn = existing[existing.length - 1];
      state.connections = state.connections.filter(c => c.id !== conn.id);

      renderAll();
      scheduleRecompile();

      const anchorSockEl = socketElement(conn.from.nodeId, 'out', conn.from.socket);
      if (anchorSockEl){
        startWireDragFrom(anchorSockEl);
      }
      return;
    }
  }

  // fresh wire — either an unconnected input, or any output (outputs never
  // detach on drag; they fan out to additional inputs)
  startWireDragFrom(sockEl);
}

/* The actual pointermove/up loop. Takes a socket element to anchor the
   preview curve, and lets the user drop on any valid counterpart. */
function startWireDragFrom(sockEl){
  const start = socketLogicalCenter(sockEl);
  const path  = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.classList.add('preview');
  connectionsEl.appendChild(path);

  const onMove = (e) => {
    const { tx, ty, scale } = state.view;
    const graphRect = graphEl.getBoundingClientRect();
    const end = {
      x: (e.clientX - graphRect.left - tx) / scale,
      y: (e.clientY - graphRect.top  - ty) / scale,
    };
    const fromOut = sockEl.dataset.dir === 'out';
    path.setAttribute('d', fromOut ? curvePath(start, end) : curvePath(end, start));

    const over = document.elementFromPoint(e.clientX, e.clientY);
    $$('.socket.drop-target').forEach(s => s.classList.remove('drop-target'));
    if (over && over.classList.contains('socket') && validWireTarget(sockEl, over)){
      over.classList.add('drop-target');
    }
  };
  const onUp = (e) => {
    const over = document.elementFromPoint(e.clientX, e.clientY);
    $$('.socket.drop-target').forEach(s => s.classList.remove('drop-target'));
    if (over && over.classList.contains('socket') && validWireTarget(sockEl, over)){
      finalizeWire(sockEl, over);
    }
    if (path.parentNode) path.parentNode.removeChild(path);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// A wire is valid when one endpoint is an input and the other is an output,
// they're on different nodes, and the socket types match.
function validWireTarget(a, b){
  if (!b || a === b) return false;
  if (a.dataset.nodeId === b.dataset.nodeId) return false;
  if (a.dataset.dir === b.dataset.dir) return false;
  if (a.dataset.sockType !== b.dataset.sockType) return false;
  return true;
}

function finalizeWire(a, b){
  const out = a.dataset.dir === 'out' ? a : b;
  const inn = a.dataset.dir === 'in'  ? a : b;

  // each input can only accept one connection; replace any existing one
  state.connections = state.connections.filter(c =>
    !(c.to.nodeId === inn.dataset.nodeId && c.to.socket === inn.dataset.socket)
  );
  state.connections.push({
    id: uid('c'),
    from:{ nodeId: out.dataset.nodeId, socket: out.dataset.socket },
    to:  { nodeId: inn.dataset.nodeId, socket: inn.dataset.socket },
  });
  renderAll();
  scheduleRecompile();
  pushHistory();
}

/* ---------------- node actions (called from the context menu) ---------------- */
function disconnectNode(node, dir){
  if (dir === 'in'){
    state.connections = state.connections.filter(c => c.to.nodeId !== node.id);
  } else {
    state.connections = state.connections.filter(c => c.from.nodeId !== node.id);
  }
  renderAll();
  scheduleRecompile();
  pushHistory();
}

function duplicateNode(node){
  const copy = makeNode(node.type, node.x + 40, node.y + 40);
  // copy over the current param values (deep for array params)
  for (const k of Object.keys(node.params)){
    copy.params[k] = Array.isArray(node.params[k]) ? [...node.params[k]] : node.params[k];
  }
  state.nodes.push(copy);
  renderAll();
  scheduleRecompile();
  pushHistory();
}

function resetNodeParams(node){
  const def = NODE_TYPES[node.type];
  if (!def.params) return;
  for (const p of def.params){
    node.params[p.name] = Array.isArray(p.default) ? [...p.default] : p.default;
  }
  renderAll();
  scheduleRecompile();
  pushHistory();
}

function deleteNode(node){
  state.nodes = state.nodes.filter(n => n.id !== node.id);
  state.connections = state.connections.filter(c =>
    c.from.nodeId !== node.id && c.to.nodeId !== node.id
  );
  renderAll();
  scheduleRecompile();
  pushHistory();
}

function resetGraph(){
  seedDefaultGraph();
  renderAll();
  recenterView();
  recompileShader();
  pushHistory();
}

function recenterView(){
  const rect = graphEl.getBoundingClientRect();
  if (!state.nodes.length){
    state.view.tx = rect.width  / 2;
    state.view.ty = rect.height / 2;
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes){
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + 220);
      maxY = Math.max(maxY, n.y + 120);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    state.view.scale = 1;
    state.view.tx = rect.width  / 2 - cx;
    state.view.ty = rect.height / 2 - cy;
  }
  updateViewportTransform();
}

/* ---------------- marquee / drag-select ----------------
   Left-drag on empty graph space spans a selection rectangle. On mouseup,
   every node whose logical-space AABB intersects the rectangle is added
   to state.selected (or replaces it if shift wasn't held). */
function startMarquee(e){
  const graphRect = graphEl.getBoundingClientRect();
  const x0 = e.clientX, y0 = e.clientY;
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  const rectEl = document.createElement('div');
  rectEl.className = 'marquee';
  graphEl.appendChild(rectEl);

  // snapshot so we can re-evaluate selection on every move
  const preSelected = new Set(state.selected);

  const toGraphXY = (cx, cy) => ({
    x: cx - graphRect.left,
    y: cy - graphRect.top,
  });

  const updateRectDom = (x1, y1, x2, y2) => {
    rectEl.style.left   = Math.min(x1, x2) + 'px';
    rectEl.style.top    = Math.min(y1, y2) + 'px';
    rectEl.style.width  = Math.abs(x2 - x1) + 'px';
    rectEl.style.height = Math.abs(y2 - y1) + 'px';
  };

  // convert graph-space screen coords into logical (viewport-transform) coords
  const toLogical = (gx, gy) => ({
    x: (gx - state.view.tx) / state.view.scale,
    y: (gy - state.view.ty) / state.view.scale,
  });

  const onMove = (ev) => {
    const a = toGraphXY(x0, y0);
    const b = toGraphXY(ev.clientX, ev.clientY);
    updateRectDom(a.x, a.y, b.x, b.y);

    // compute logical-space rectangle and hit-test each node's AABB.
    // nodes are ~210px wide, ~120px tall in logical units — we approximate
    // with that fixed size since we don't track per-node dimensions.
    const la = toLogical(Math.min(a.x, b.x), Math.min(a.y, b.y));
    const lb = toLogical(Math.max(a.x, b.x), Math.max(a.y, b.y));
    const nextSel = new Set(additive ? preSelected : []);
    for (const nd of state.nodes){
      const nx0 = nd.x, ny0 = nd.y, nx1 = nd.x + 210, ny1 = nd.y + 120;
      if (nx1 >= la.x && nx0 <= lb.x && ny1 >= la.y && ny0 <= lb.y){
        nextSel.add(nd.id);
      }
    }
    state.selected = nextSel;
    refreshSelectionClasses();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    rectEl.remove();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/* ---------------- copy / paste / duplicate ----------------
   Semantics per the spec:
   - COPY  (Ctrl+C): snapshot the selected nodes' types + positions only.
                     The pasted copy resets params/defaults to type defaults
                     and brings NO connections.
   - PASTE (Ctrl+V): create fresh nodes of the snapshotted types at a
                     small offset, NOT connected.
   - DUPLICATE (Ctrl+D): clone the selected nodes AND any connections
                         whose endpoints are both inside the selection —
                         preserving their current param / default values.
                         Cross-selection connections are dropped. */
function copySelection(){
  if (!state.selected.size){ toast('nothing selected'); return; }
  // The Output node is singleton — don't copy it. Silently drop it from the
  // selection snapshot so a marquee-over-everything still copies the rest.
  const sel = state.nodes.filter(n => state.selected.has(n.id) && n.type !== 'output');
  if (!sel.length){ toast('cannot copy output', 'err'); return; }
  const originX = Math.min(...sel.map(n => n.x));
  const originY = Math.min(...sel.map(n => n.y));
  clipboard = {
    nodes: sel.map(n => ({ type: n.type, dx: n.x - originX, dy: n.y - originY })),
    connections: [],   // copy explicitly drops connections
  };
  toast(`copied ${sel.length} module${sel.length === 1 ? '' : 's'}`);
}

function pasteClipboard(){
  if (!clipboard.nodes || !clipboard.nodes.length){ toast('clipboard empty'); return; }
  // paste-anchor: top-left of the current viewport + 40px offset
  const rect = graphEl.getBoundingClientRect();
  const anchorX = (rect.width  / 2 - state.view.tx) / state.view.scale - 80;
  const anchorY = (rect.height / 2 - state.view.ty) / state.view.scale - 80;

  const newIds = [];
  for (const entry of clipboard.nodes){
    const fresh = makeNode(entry.type, anchorX + entry.dx, anchorY + entry.dy);
    state.nodes.push(fresh);
    newIds.push(fresh.id);
  }
  // select the newly-pasted batch
  state.selected = new Set(newIds);
  renderAll();
  scheduleRecompile();
  pushHistory();
  toast(`pasted ${newIds.length} module${newIds.length === 1 ? '' : 's'}`);
}

function duplicateSelection(){
  if (!state.selected.size){ toast('nothing selected'); return; }
  // Output is a singleton — exclude it from duplication (same as copy).
  const selNodes = state.nodes.filter(n => state.selected.has(n.id) && n.type !== 'output');
  if (!selNodes.length){ toast('cannot duplicate output', 'err'); return; }
  // id remap: old id → new id (for rewiring internal connections)
  const idMap = new Map();
  const newNodes = selNodes.map(n => {
    const copy = makeNode(n.type, n.x + 40, n.y + 40);
    // preserve params / defaults
    copy.params   = JSON.parse(JSON.stringify(n.params   || {}));
    copy.defaults = JSON.parse(JSON.stringify(n.defaults || {}));
    idMap.set(n.id, copy.id);
    return copy;
  });
  for (const nn of newNodes) state.nodes.push(nn);

  // preserve only connections where BOTH endpoints are in the selection —
  // matches "duplicate" semantics (the group copies intact, not its
  // external interfaces).
  for (const conn of state.connections){
    if (idMap.has(conn.from.nodeId) && idMap.has(conn.to.nodeId)){
      state.connections.push({
        id: uid('c'),
        from: { nodeId: idMap.get(conn.from.nodeId), socket: conn.from.socket },
        to:   { nodeId: idMap.get(conn.to.nodeId),   socket: conn.to.socket   },
      });
    }
  }

  state.selected = new Set(newNodes.map(n => n.id));
  renderAll();
  scheduleRecompile();
  pushHistory();
  toast(`duplicated ${newNodes.length} module${newNodes.length === 1 ? '' : 's'}`);
}

function deleteSelection(){
  if (!state.selected.size) return;
  // Never delete the output node — the graph needs it to compile.
  const deletable = [...state.selected].filter(id => {
    const n = state.nodes.find(x => x.id === id);
    return n && n.type !== 'output';
  });
  if (!deletable.length){ toast('cannot delete output', 'err'); return; }
  const idSet = new Set(deletable);
  state.nodes = state.nodes.filter(n => !idSet.has(n.id));
  state.connections = state.connections.filter(c =>
    !idSet.has(c.from.nodeId) && !idSet.has(c.to.nodeId)
  );
  state.selected.clear();
  renderAll();
  scheduleRecompile();
  pushHistory();
}

/* ---------------- clear graph ---------------- */
function clearGraph(){
  state.nodes = [];
  state.connections = [];
  state.selected.clear();
  // keep an Output node so the graph still compiles (renders black).
  const out = makeNode('output', 0, 0);
  state.nodes.push(out);
  renderAll();
  recenterView();
  recompileShader();
  pushHistory();
  toast('graph cleared');
}

/* ---------------- undo/redo dispatcher ---------------- */
function doUndo(){
  if (undo()){ renderAll(); recompileShader(); toast('undo'); }
}
function doRedo(){
  if (redo()){ renderAll(); recompileShader(); toast('redo'); }
}

/* ================== Flag module rendering ==================
   The Flag node is a patch bay with user-editable internal wires between
   its inputs and outputs. Each input has an external socket (for upstream
   connections from the main graph) + an internal socket that the user can
   wire to output-side internal sockets. Each output similarly has an
   internal socket + an external socket + a passthrough enable checkbox.
   Internal wires live in `node.params.wires` as [{from, to}] pairs and
   are rendered as SVG paths inside the node body. */
function renderFlagBody(node, nodeEl, bodyEl){
  bodyEl.classList.add('flag-body');
  const numIn  = node.params.numInputs  || 0;
  const numOut = node.params.numOutputs || 0;
  // Pull the actual socket types from the node spec so Flag (Float) and
  // Flag (Vec2) variants render with the correct sockType — otherwise the
  // wire validator (strict type-equality) refuses to connect floats/vec2s
  // to a flag body that's hardcoded vec3.
  const inputSpec  = getNodeInputs(node);
  const outputSpec = getNodeOutputs(node);

  // Toolbar: +/- buttons for input and output counts.
  const toolbar = document.createElement('div');
  toolbar.className = 'flag-toolbar';
  toolbar.innerHTML = `
    <span class="flag-toolbar-group">
      IN <button type="button" class="flag-tb-btn" data-act="dec-in">−</button>
      <span class="flag-tb-count">${numIn}</span>
      <button type="button" class="flag-tb-btn" data-act="inc-in">+</button>
    </span>
    <span class="flag-toolbar-group">
      OUT <button type="button" class="flag-tb-btn" data-act="dec-out">−</button>
      <span class="flag-tb-count">${numOut}</span>
      <button type="button" class="flag-tb-btn" data-act="inc-out">+</button>
    </span>
  `;
  toolbar.addEventListener('pointerdown', e => e.stopPropagation());
  for (const btn of toolbar.querySelectorAll('.flag-tb-btn')){
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if      (act === 'inc-in')  flagSetInputCount (node, (node.params.numInputs  || 0) + 1);
      else if (act === 'dec-in')  flagSetInputCount (node, (node.params.numInputs  || 0) - 1);
      else if (act === 'inc-out') flagSetOutputCount(node, (node.params.numOutputs || 0) + 1);
      else if (act === 'dec-out') flagSetOutputCount(node, (node.params.numOutputs || 0) - 1);
    });
  }
  bodyEl.appendChild(toolbar);

  // The patch area: two columns, with an SVG wire overlay positioned on top.
  const zone = document.createElement('div');
  zone.className = 'flag-zone';
  bodyEl.appendChild(zone);

  const leftCol = document.createElement('div');
  leftCol.className = 'flag-col flag-col-in';
  zone.appendChild(leftCol);

  const rightCol = document.createElement('div');
  rightCol.className = 'flag-col flag-col-out';
  zone.appendChild(rightCol);

  // Input rows: external socket on the left edge, then label, then a
  // per-input passthrough checkbox (silences the input lane), then the
  // internal socket (acts as an OUT for internal wiring — the input proxy
  // emits).
  const inputEnabled = Array.isArray(node.params.inputEnabled) ? node.params.inputEnabled : [];
  for (let i = 0; i < numIn; i++){
    const row = document.createElement('div');
    row.className = 'flag-row flag-row-in';

    const ext = document.createElement('div');
    ext.className = 'socket in';
    ext.dataset.nodeId   = node.id;
    ext.dataset.socket   = `in${i}`;
    ext.dataset.dir      = 'in';
    ext.dataset.sockType = (inputSpec[i] && inputSpec[i].type) || 'vec3';
    if (isSocketConnected(node.id, 'in', `in${i}`)) ext.classList.add('connected');
    row.appendChild(ext);

    // Label text reflects the upstream node's title (e.g. "Vignette") when
    // connected, or falls back to the generic "inN". Re-rendered on every
    // connect/disconnect because renderAll rebuilds the whole body.
    const lbl = document.createElement('span');
    lbl.className = 'flag-label';
    lbl.textContent = flagSocketLabel(node.id, `in${i}`, `in${i}`);
    row.appendChild(lbl);

    // Per-input passthrough toggle: when off, this input contributes
    // vec3(0) to every output it's wired to (instead of its actual value).
    const chk = document.createElement('label');
    chk.className = 'flag-pt';
    chk.title = 'Input enable';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = inputEnabled[i] !== false;
    cb.addEventListener('pointerdown', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      const arr = Array.isArray(node.params.inputEnabled) ? [...node.params.inputEnabled] : [];
      while (arr.length < numIn) arr.push(true);
      arr[i] = cb.checked;
      node.params.inputEnabled = arr;
      // Re-render all nodes so downstream consumers update their inline-editor
      // visibility and wire styling to reflect the new muted/live state.
      renderAll();
      scheduleRecompile();
      pushHistory();
    });
    chk.appendChild(cb);
    row.appendChild(chk);

    const inner = document.createElement('div');
    inner.className = 'socket-internal internal-out';
    inner.dataset.nodeId = node.id;
    inner.dataset.side   = 'in';    // belongs to an INPUT proxy
    inner.dataset.index  = String(i);
    row.appendChild(inner);

    leftCol.appendChild(row);
  }

  // Output rows: internal socket (acts as IN for internal wiring — the output
  // proxy receives), passthrough checkbox, label, external socket.
  const enabled = Array.isArray(node.params.enabled) ? node.params.enabled : [];
  for (let j = 0; j < numOut; j++){
    const row = document.createElement('div');
    row.className = 'flag-row flag-row-out';

    const inner = document.createElement('div');
    inner.className = 'socket-internal internal-in';
    inner.dataset.nodeId = node.id;
    inner.dataset.side   = 'out';   // belongs to an OUTPUT proxy
    inner.dataset.index  = String(j);
    row.appendChild(inner);

    const chk = document.createElement('label');
    chk.className = 'flag-pt';
    chk.title = 'Passthrough enable';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabled[j] !== false;
    cb.addEventListener('pointerdown', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      const arr = Array.isArray(node.params.enabled) ? [...node.params.enabled] : [];
      while (arr.length < numOut) arr.push(true);
      arr[j] = cb.checked;
      node.params.enabled = arr;
      // Re-render all nodes so downstream consumers update their inline-editor
      // visibility and wire styling to reflect the new muted/live state.
      renderAll();
      scheduleRecompile();
      pushHistory();
    });
    chk.appendChild(cb);
    row.appendChild(chk);

    const lbl = document.createElement('span');
    lbl.className = 'flag-label';
    // Output label reflects the downstream consumer (the first one if there
    // are multiple), e.g. "Output" or "Mix". Falls back to "outN".
    lbl.textContent = flagOutputLabel(node.id, `out${j}`, `out${j}`);
    row.appendChild(lbl);

    const ext = document.createElement('div');
    ext.className = 'socket out';
    ext.dataset.nodeId   = node.id;
    ext.dataset.socket   = `out${j}`;
    ext.dataset.dir      = 'out';
    ext.dataset.sockType = (outputSpec[j] && outputSpec[j].type) || 'vec3';
    if (isSocketConnected(node.id, 'out', `out${j}`)) ext.classList.add('connected');
    row.appendChild(ext);

    rightCol.appendChild(row);
  }

  // SVG overlay for internal wires. Rendered AFTER layout so we can read
  // actual element positions via offsetTop/offsetLeft.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('flag-wires');
  zone.appendChild(svg);

  // Attach internal-wire drag handlers to each internal socket.
  for (const inner of zone.querySelectorAll('.socket-internal')){
    inner.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startFlagInternalWire(node, inner, zone, svg);
    });
  }

  // Defer the wire draw until the DOM has a layout. requestAnimationFrame
  // is enough — by then the node is sized and offsetTop is meaningful.
  requestAnimationFrame(() => drawFlagWires(node, zone, svg));
}

function flagSetInputCount(node, target){
  target = Math.max(0, Math.min(8, Math.floor(target)));
  const prev = node.params.numInputs || 0;
  if (target === prev) return;
  node.params.numInputs = target;
  // If shrinking, strip any external connections + internal wires that
  // reference now-gone inputs.
  if (target < prev){
    const dropped = new Set();
    for (let i = target; i < prev; i++) dropped.add(`in${i}`);
    state.connections = state.connections.filter(c => !(c.to.nodeId === node.id && dropped.has(c.to.socket)));
    node.params.wires = (node.params.wires || []).filter(w => w.from < target);
  }
  // Resize the per-input enable array (extend with `true` defaults, trim
  // when shrinking).
  const ie = Array.isArray(node.params.inputEnabled) ? [...node.params.inputEnabled] : [];
  while (ie.length < target) ie.push(true);
  ie.length = target;
  node.params.inputEnabled = ie;

  renderAll();
  scheduleRecompile();
  pushHistory();
}
function flagSetOutputCount(node, target){
  target = Math.max(0, Math.min(8, Math.floor(target)));
  const prev = node.params.numOutputs || 0;
  if (target === prev) return;
  node.params.numOutputs = target;
  if (target < prev){
    const dropped = new Set();
    for (let j = target; j < prev; j++) dropped.add(`out${j}`);
    state.connections = state.connections.filter(c => !(c.from.nodeId === node.id && dropped.has(c.from.socket)));
    node.params.wires = (node.params.wires || []).filter(w => w.to < target);
  }
  // extend the enabled array with defaults
  const en = Array.isArray(node.params.enabled) ? [...node.params.enabled] : [];
  while (en.length < target) en.push(true);
  en.length = target;
  node.params.enabled = en;
  renderAll();
  scheduleRecompile();
  pushHistory();
}

/* Looks up the upstream node feeding a Flag's input socket and returns its
   `def.title` (e.g. "Vignette"). Used to label Flag input rows with the
   actual connected source instead of a generic "inN". Falls back to the
   provided default when nothing's wired. */
function flagSocketLabel(nodeId, socketName, fallback){
  const conn = state.connections.find(c =>
    c.to.nodeId === nodeId && c.to.socket === socketName);
  if (!conn) return fallback;
  const upstream = state.nodes.find(n => n.id === conn.from.nodeId);
  if (!upstream) return fallback;
  const def = NODE_TYPES[upstream.type];
  return (def && def.title) || fallback;
}
/* Same idea but for outputs: pick the first downstream consumer and label
   the row with its title. */
function flagOutputLabel(nodeId, socketName, fallback){
  const conn = state.connections.find(c =>
    c.from.nodeId === nodeId && c.from.socket === socketName);
  if (!conn) return fallback;
  const downstream = state.nodes.find(n => n.id === conn.to.nodeId);
  if (!downstream) return fallback;
  const def = NODE_TYPES[downstream.type];
  return (def && def.title) || fallback;
}

/* Socket centre in zone-local pixel coords, walked via offsetParent chain so
   the result is in NATURAL (pre-viewport-transform) pixels — matching the
   SVG's coordinate space. BoundingClientRect would include the viewport's
   CSS transform scale and come out wrong at non-1.0 zoom. */
function flagInternalSocketXY(sockEl, zoneEl){
  let x = 0, y = 0;
  let el = sockEl;
  while (el && el !== zoneEl){
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent;
  }
  return { x: x + sockEl.offsetWidth / 2, y: y + sockEl.offsetHeight / 2 };
}

function flagCurve(a, b){
  const dx = Math.max(20, Math.abs(b.x - a.x) * 0.4);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function drawFlagWires(node, zone, svg){
  // size the SVG to the zone
  svg.setAttribute('width', zone.clientWidth);
  svg.setAttribute('height', zone.clientHeight);
  svg.innerHTML = '';
  const wires = Array.isArray(node.params.wires) ? node.params.wires : [];
  for (const w of wires){
    const src = zone.querySelector(`.socket-internal.internal-out[data-index="${w.from}"]`);
    const dst = zone.querySelector(`.socket-internal.internal-in[data-index="${w.to}"]`);
    if (!src || !dst) continue;
    const a = flagInternalSocketXY(src, zone);
    const b = flagInternalSocketXY(dst, zone);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', flagCurve(a, b));
    path.classList.add('flag-wire');
    path.dataset.from = String(w.from);
    path.dataset.to   = String(w.to);
    // Right-click (or alt-click) on a wire deletes it.
    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.params.wires = wires.filter(x => !(x.from === w.from && x.to === w.to));
      renderAll();
      scheduleRecompile();
      pushHistory();
    });
    svg.appendChild(path);
  }
}

/* Internal-wire drag. Both ends of a candidate wire are internal sockets
   on the SAME flag node. Direction is inferred: if the user started on an
   input-side (internal-out) socket we need to drop on an output-side
   (internal-in), and vice versa. */
function startFlagInternalWire(node, startSock, zone, svg){
  const startSide = startSock.dataset.side;   // 'in' (proxy-output) | 'out' (proxy-input)
  const start = flagInternalSocketXY(startSock, zone);

  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  preview.classList.add('flag-wire', 'preview');
  svg.appendChild(preview);

  const onMove = (e) => {
    // Convert from cursor page pixels back into natural SVG pixels. The
    // viewport CSS-scales the whole graph, so the client-side delta has to
    // be divided by state.view.scale to match the offset-based source coords.
    const r = zone.getBoundingClientRect();
    const sc = state.view.scale || 1;
    const end = { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
    preview.setAttribute('d', startSide === 'in' ? flagCurve(start, end) : flagCurve(end, start));

    // highlight a valid drop target
    zone.querySelectorAll('.socket-internal.drop-target').forEach(s => s.classList.remove('drop-target'));
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (over && over.classList.contains('socket-internal') &&
        over.dataset.nodeId === node.id && over.dataset.side !== startSide){
      over.classList.add('drop-target');
    }
  };
  const onUp = (e) => {
    const over = document.elementFromPoint(e.clientX, e.clientY);
    zone.querySelectorAll('.socket-internal.drop-target').forEach(s => s.classList.remove('drop-target'));
    if (over && over.classList.contains('socket-internal') &&
        over.dataset.nodeId === node.id && over.dataset.side !== startSide){
      const fromIdx = startSide === 'in'
        ? Number(startSock.dataset.index)
        : Number(over.dataset.index);
      const toIdx = startSide === 'in'
        ? Number(over.dataset.index)
        : Number(startSock.dataset.index);
      const wires = Array.isArray(node.params.wires) ? [...node.params.wires] : [];
      if (!wires.some(w => w.from === fromIdx && w.to === toIdx)){
        wires.push({ from: fromIdx, to: toIdx });
        node.params.wires = wires;
        renderAll();
        scheduleRecompile();
        pushHistory();
      }
    }
    if (preview.parentNode) preview.parentNode.removeChild(preview);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
}

/* ================== Layer Stack rendering ==================
   A material compositor: one base input + N layer inputs, each layer
   carrying its own opacity slider and blend-mode dropdown right on the
   node body. Output is a single composited vec3.
   layerStack params:
     numLayers : int    — number of stacked layers (1..6)
     opacity   : float[] per-layer 0..1
     modes     : string[] per-layer blend mode
*/
const LAYER_BLEND_MODES = ['normal', 'multiply', 'screen', 'add', 'darken', 'lighten', 'difference'];

function renderLayerStackBody(node, nodeEl, bodyEl){
  bodyEl.classList.add('layer-stack-body');
  const numL = node.params.numLayers || 0;

  // toolbar — +/- layer count
  const toolbar = document.createElement('div');
  toolbar.className = 'flag-toolbar';
  toolbar.innerHTML = `
    <span class="flag-toolbar-group">
      LAYERS
      <button type="button" class="flag-tb-btn" data-act="dec">−</button>
      <span class="flag-tb-count">${numL}</span>
      <button type="button" class="flag-tb-btn" data-act="inc">+</button>
    </span>
  `;
  toolbar.addEventListener('pointerdown', e => e.stopPropagation());
  for (const btn of toolbar.querySelectorAll('.flag-tb-btn')){
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if      (act === 'inc') layerStackSetCount(node, (node.params.numLayers || 0) + 1);
      else if (act === 'dec') layerStackSetCount(node, (node.params.numLayers || 0) - 1);
    });
  }
  bodyEl.appendChild(toolbar);

  // Base input row — always present
  bodyEl.appendChild(makeLayerStackRow(node, 'base', 'base', 'vec3', null));

  // Layer rows
  const opacity = Array.isArray(node.params.opacity) ? node.params.opacity : [];
  const modes   = Array.isArray(node.params.modes)   ? node.params.modes   : [];
  for (let i = 0; i < numL; i++){
    bodyEl.appendChild(makeLayerStackRow(node, `layer${i}`, `layer ${i}`, 'vec3', {
      index: i,
      opacity: opacity[i] != null ? opacity[i] : 1.0,
      mode:    modes[i] || 'normal',
    }));
  }

  // Output row
  const outRow = document.createElement('div');
  outRow.className = 'node-row';
  const outLabel = document.createElement('div');
  outLabel.className = 'row-label right';
  outLabel.textContent = 'out (vec3)';
  outRow.appendChild(outLabel);
  const outSock = document.createElement('div');
  outSock.className = 'socket out';
  outSock.dataset.nodeId   = node.id;
  outSock.dataset.socket   = 'out';
  outSock.dataset.dir      = 'out';
  outSock.dataset.sockType = 'vec3';
  if (isSocketConnected(node.id, 'out', 'out')) outSock.classList.add('connected');
  outRow.appendChild(outSock);
  bodyEl.appendChild(outRow);
}

function makeLayerStackRow(node, sockName, labelText, sockType, layerCtl){
  const row = document.createElement('div');
  row.className = 'node-row layer-stack-row';

  const sock = document.createElement('div');
  sock.className = 'socket in';
  sock.dataset.nodeId   = node.id;
  sock.dataset.socket   = sockName;
  sock.dataset.dir      = 'in';
  sock.dataset.sockType = sockType;
  if (isSocketConnected(node.id, 'in', sockName)) sock.classList.add('connected');
  row.appendChild(sock);

  const label = document.createElement('div');
  label.className = 'row-label';
  label.textContent = labelText;
  row.appendChild(label);

  if (layerCtl){
    // opacity number input
    const opIn = document.createElement('input');
    opIn.type = 'number';
    opIn.className = 'val ls-opacity';
    opIn.min = '0';
    opIn.max = '1';
    opIn.step = '0.05';
    opIn.value = layerCtl.opacity;
    opIn.addEventListener('pointerdown', e => e.stopPropagation());
    opIn.addEventListener('input', () => {
      const v = parseFloat(opIn.value);
      const arr = Array.isArray(node.params.opacity) ? [...node.params.opacity] : [];
      while (arr.length <= layerCtl.index) arr.push(1.0);
      arr[layerCtl.index] = isFinite(v) ? v : 1.0;
      node.params.opacity = arr;
      scheduleRecompile();
    });
    opIn.addEventListener('change', () => pushHistory());
    row.appendChild(opIn);

    // mode dropdown
    const sel = document.createElement('select');
    sel.className = 'val-select ls-mode';
    sel.addEventListener('pointerdown', e => e.stopPropagation());
    for (const m of LAYER_BLEND_MODES){
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    }
    sel.value = layerCtl.mode;
    sel.addEventListener('change', () => {
      const arr = Array.isArray(node.params.modes) ? [...node.params.modes] : [];
      while (arr.length <= layerCtl.index) arr.push('normal');
      arr[layerCtl.index] = sel.value;
      node.params.modes = arr;
      scheduleRecompile();
      pushHistory();
    });
    row.appendChild(sel);
  }

  return row;
}

function layerStackSetCount(node, target){
  target = Math.max(0, Math.min(6, Math.floor(target)));
  const prev = node.params.numLayers || 0;
  if (target === prev) return;
  node.params.numLayers = target;

  // Trim arrays + drop external connections to removed sockets
  if (target < prev){
    const dropped = new Set();
    for (let i = target; i < prev; i++) dropped.add(`layer${i}`);
    state.connections = state.connections.filter(c => !(c.to.nodeId === node.id && dropped.has(c.to.socket)));
  }
  const op = Array.isArray(node.params.opacity) ? [...node.params.opacity] : [];
  const md = Array.isArray(node.params.modes)   ? [...node.params.modes]   : [];
  while (op.length < target) op.push(1.0);
  while (md.length < target) md.push('normal');
  op.length = target;
  md.length = target;
  node.params.opacity = op;
  node.params.modes   = md;

  renderAll();
  scheduleRecompile();
  pushHistory();
}

/* ---------------- node info modal ----------------
 * Opened by clicking the small "i" button in any node header. Renders the
 * node type's description, optional `info` field (use cases / longer doc),
 * and auto-generated tables of inputs, outputs, and parameters.
 *
 * Node types can supply richer documentation by adding an `info` string
 * to their NODE_TYPES entry — anything not present falls back to the
 * built-in `desc` field. Inputs/outputs/params come straight from the
 * node spec via getNodeInputs / getNodeOutputs, so dynamic-schema nodes
 * (Flag, Layer Stack) display their current shape correctly. */
const nodeInfoModal = $('#nodeInfoModal');
const nodeInfoBack  = $('#nodeInfoBack');
const nodeInfoTitle = $('#nodeInfoTitle');
const nodeInfoCat   = $('#nodeInfoCat');
const nodeInfoBody  = $('#nodeInfoBody');
const nodeInfoClose = $('#nodeInfoCloseBtn');

function fmtDefault(v){
  if (v === undefined || v === null) return '';
  if (Array.isArray(v))  return `[${v.map(x => Number(x).toFixed(2)).join(', ')}]`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
function ioRowsHTML(items, includeDefault){
  let html = '<div class="ni-iolist">';
  for (const it of items){
    const def = includeDefault && it.default !== undefined
      ? `<span class="ni-io-def">default: ${escapeHTML(fmtDefault(it.default))}</span>`
      : '<span></span>';
    html += `
      <div class="ni-io">
        <span class="ni-io-name">${escapeHTML(it.name)}</span>
        <span class="ni-io-type">${escapeHTML(it.type || it.kind || '')}</span>
        ${def}
      </div>`;
  }
  html += '</div>';
  return html;
}

function openNodeInfoModal(node){
  if (!nodeInfoModal) return;
  const def = NODE_TYPES[node.type];
  if (!def) return;

  nodeInfoTitle.textContent = def.title || node.type;
  nodeInfoCat.textContent   = (def.category || '').toUpperCase();

  const sections = [];
  // Two description fields by convention:
  //   def.desc — concise one-liner used in the picker / Add Module modal
  //   def.info — verbose explanation used here in the info modal
  // The info modal prefers `info` and falls back to `desc` for nodes that
  // haven't been given a verbose entry yet.
  const longDesc = def.info || def.desc;
  if (longDesc){
    sections.push(`
      <div class="ni-section">
        <div class="ni-section-title">Description</div>
        <div class="ni-section-body">${escapeHTML(longDesc)}</div>
      </div>`);
  }
  // Inputs
  const inputs = getNodeInputs(node);
  if (inputs.length){
    sections.push(`
      <div class="ni-section">
        <div class="ni-section-title">Inputs</div>
        ${ioRowsHTML(inputs, true)}
      </div>`);
  }
  // Outputs
  const outputs = getNodeOutputs(node);
  if (outputs.length){
    sections.push(`
      <div class="ni-section">
        <div class="ni-section-title">Outputs</div>
        ${ioRowsHTML(outputs, false)}
      </div>`);
  }
  // Parameters (skip hidden ones)
  const params = (def.params || []).filter(p => p.kind !== 'hidden');
  if (params.length){
    sections.push(`
      <div class="ni-section">
        <div class="ni-section-title">Parameters</div>
        ${ioRowsHTML(params, true)}
      </div>`);
  }

  nodeInfoBody.innerHTML = sections.join('');
  nodeInfoModal.classList.add('open');
  nodeInfoBack.classList.add('open');
}

function closeNodeInfoModal(){
  if (!nodeInfoModal) return;
  nodeInfoModal.classList.remove('open');
  nodeInfoBack.classList.remove('open');
}

if (nodeInfoBack)  nodeInfoBack.addEventListener('click', closeNodeInfoModal);
if (nodeInfoClose) nodeInfoClose.addEventListener('click', closeNodeInfoModal);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && nodeInfoModal && nodeInfoModal.classList.contains('open')){
    closeNodeInfoModal();
  }
});
