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
  if (state.selected === node.id) el.classList.add('selected');

  const header = document.createElement('div');
  header.className = 'node-header';
  header.innerHTML = `
    <div class="node-title">${escapeHTML(def.title)}</div>
    <div class="node-cat">${escapeHTML(def.category)}</div>
  `;
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'node-body';
  el.appendChild(body);

  const inputs  = def.inputs  || [];
  const outputs = def.outputs || [];
  const params  = def.params  || [];

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
    const connected = isSocketConnected(node.id, 'in', sock.name);

    const s = document.createElement('div');
    s.className = 'socket in';
    s.dataset.nodeId   = node.id;
    s.dataset.socket   = sock.name;
    s.dataset.dir      = 'in';
    s.dataset.sockType = sock.type;
    if (connected) s.classList.add('connected');
    row.appendChild(s);

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = `${sock.name} (${sock.type})`;
    row.appendChild(label);

    // Unconnected float/vec3 inputs normally get an inline editor beside the
    // label. Sockets can opt out with `noInline:true` when another UI already
    // controls their value — e.g. the Color node's r/g/b inputs, whose
    // static values come from the `rgb` color-picker param instead.
    if (!connected && !sock.noInline){
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

  el.addEventListener('mousedown', (e) => {
    if (e.button === 0){
      state.selected = node.id;
      $$('.node', viewportEl).forEach(n => n.classList.toggle('selected', n.dataset.id === node.id));
    }
  });

  return el;
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
}

/* ---------------- node dragging (header grab) ---------------- */
function attachNodeDrag(el, node){
  const header = el.querySelector('.node-header');
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const ox = node.x, oy = node.y;
    el.classList.add('dragging');
    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / state.view.scale;
      const dy = (ev.clientY - startY) / state.view.scale;
      node.x = ox + dx;
      node.y = oy + dy;
      el.style.left = node.x + 'px';
      el.style.top  = node.y + 'px';
      renderConnections();
    };
    const onUp = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
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
}

function resetNodeParams(node){
  const def = NODE_TYPES[node.type];
  if (!def.params) return;
  for (const p of def.params){
    node.params[p.name] = Array.isArray(p.default) ? [...p.default] : p.default;
  }
  renderAll();
  scheduleRecompile();
}

function deleteNode(node){
  state.nodes = state.nodes.filter(n => n.id !== node.id);
  state.connections = state.connections.filter(c =>
    c.from.nodeId !== node.id && c.to.nodeId !== node.id
  );
  renderAll();
  scheduleRecompile();
}

function resetGraph(){
  seedDefaultGraph();
  renderAll();
  recenterView();
  recompileShader();
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
