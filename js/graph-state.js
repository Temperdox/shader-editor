/* Graph state — single source of truth for the editor.
 *
 * Nodes and connections both live in plain arrays so serialization and
 * iteration stay trivial. Node instances store their OWN param values and
 * per-socket default overrides; the static schema lives in NODE_TYPES.
 */

const state = {
  nodes: [],         // { id, type, x, y, params, defaults }
  connections: [],   // { id, from:{nodeId,socket}, to:{nodeId,socket} }
  view: { tx: 0, ty: 0, scale: 1 },
  selected: new Set(), // Set<nodeId> — empty = nothing selected
  snapToGrid: false,   // when true, drag snaps node top-left to GRID_SNAP_PX
  toolMode: 'select',  // 'select' | 'pan' | 'zoom' — set by the left toolbar
};
// Drag snap step. Matches the small (22px) gridlines drawn by .graph-grid
// so snapped nodes visually land on grid intersections.
const GRID_SNAP_PX = 22;

// Clipboard for copy/paste/duplicate. Separate from state so it survives
// template loads and clear-graph. Values are plain serializable objects.
let clipboard = { nodes: [], connections: [] };

// Undo/redo history — coarse-grained snapshots of state.nodes/connections.
const history = { stack: [], index: -1, max: 50, suspended: false };

function _cloneGraph(){
  return {
    nodes: state.nodes.map(n => ({
      id: n.id, type: n.type, x: n.x, y: n.y,
      params:   JSON.parse(JSON.stringify(n.params || {})),
      defaults: JSON.parse(JSON.stringify(n.defaults || {})),
    })),
    connections: state.connections.map(c => ({
      id: c.id,
      from: { ...c.from },
      to:   { ...c.to   },
    })),
  };
}
function _applyGraph(snap){
  state.nodes = snap.nodes.map(n => ({
    id: n.id, type: n.type, x: n.x, y: n.y,
    params:   JSON.parse(JSON.stringify(n.params || {})),
    defaults: JSON.parse(JSON.stringify(n.defaults || {})),
  }));
  state.connections = snap.connections.map(c => ({
    id: c.id,
    from: { ...c.from },
    to:   { ...c.to   },
  }));
  // invalidate selection — ids may not exist in the restored graph
  state.selected.clear();
  // Keep the uid counter ahead of any IDs restored from the snapshot.
  syncUidFromState();
}
function pushHistory(){
  if (history.suspended) return;
  const snap = _cloneGraph();
  // Dedupe: if the new snapshot matches the current top, skip. Avoids
  // "invisible" undos (press Ctrl+Z, nothing seems to happen) caused by
  // mutation paths that end up leaving state identical to the previous
  // snapshot — e.g. a click-without-drag firing the drag onUp handler.
  if (history.index >= 0){
    const prev = history.stack[history.index];
    if (prev && _snapEq(prev, snap)) return;
  }
  // drop any redo future — we branched
  history.stack.length = history.index + 1;
  history.stack.push(snap);
  history.index++;
  if (history.stack.length > history.max){
    history.stack.shift();
    history.index--;
  }
}
function _snapEq(a, b){
  if (a.nodes.length !== b.nodes.length) return false;
  if (a.connections.length !== b.connections.length) return false;
  for (let i = 0; i < a.nodes.length; i++){
    const na = a.nodes[i], nb = b.nodes[i];
    if (na.id !== nb.id || na.type !== nb.type) return false;
    if (na.x !== nb.x || na.y !== nb.y) return false;
    if (JSON.stringify(na.params) !== JSON.stringify(nb.params)) return false;
    if (JSON.stringify(na.defaults) !== JSON.stringify(nb.defaults)) return false;
  }
  for (let i = 0; i < a.connections.length; i++){
    const ca = a.connections[i], cb = b.connections[i];
    if (ca.from.nodeId !== cb.from.nodeId || ca.from.socket !== cb.from.socket) return false;
    if (ca.to.nodeId   !== cb.to.nodeId   || ca.to.socket   !== cb.to.socket)   return false;
  }
  return true;
}
function undo(){
  if (history.index <= 0) return false;
  history.index--;
  _applyGraph(history.stack[history.index]);
  return true;
}
function redo(){
  if (history.index >= history.stack.length - 1) return false;
  history.index++;
  _applyGraph(history.stack[history.index]);
  return true;
}

// Resolve a node's input-socket list. Most node definitions expose `inputs`
// as a fixed array at the schema level; the Flag module exposes it as a
// function of the node instance so the socket count can grow with params.
function getNodeInputs(node){
  if (!node) return [];
  const def = NODE_TYPES[node.type];
  if (!def) return [];
  return (typeof def.inputs === 'function') ? def.inputs(node) : (def.inputs || []);
}
function getNodeOutputs(node){
  if (!node) return [];
  const def = NODE_TYPES[node.type];
  if (!def) return [];
  return (typeof def.outputs === 'function') ? def.outputs(node) : (def.outputs || []);
}

function makeNode(type, x, y){
  const def = NODE_TYPES[type];
  if (!def) throw new Error(`unknown node type ${type}`);

  // deep-copy params so array defaults (colors, vec2) don't alias across instances
  const params = {};
  if (def.params){
    for (const p of def.params){
      params[p.name] = Array.isArray(p.default) ? [...p.default] : p.default;
    }
  }

  const tempNode = { id: null, type, x, y, params, defaults: {} };

  // socket default overrides (rarely used; placeholder for future UI to set
  // per-socket constants without needing an explicit const node upstream).
  // Resolve dynamic inputs now (Flag's inputs depend on params).
  const defaults = {};
  const schemaInputs = (typeof def.inputs === 'function') ? def.inputs(tempNode) : def.inputs;
  if (schemaInputs){
    for (const sock of schemaInputs){
      if (sock.default !== undefined){
        defaults[sock.name] = Array.isArray(sock.default) ? [...sock.default] : sock.default;
      }
    }
  }

  // Belt-and-suspenders: reject a uid that collides with a node already in
  // state. If syncUidFromState was skipped somewhere, this keeps the graph
  // consistent by spinning uid() until we find an unused ID.
  let id = uid('n');
  while (state.nodes.some(n => n.id === id)) id = uid('n');

  return { id, type, x, y, params, defaults };
}

/* ---- default preset ----
 * Replicates the dossier site's marble/gold shader using composite nodes
 * (Marble Pattern, Veins, Vignette) so it's easy to tweak visually without
 * wiring up the full FBM/snoise primitive graph. */
function seedDefaultGraph(){
  state.nodes = [];
  state.connections = [];

  const n = (type, x, y, params = {}) => {
    const node = makeNode(type, x, y);
    Object.assign(node.params, params);
    state.nodes.push(node);
    return node;
  };
  const c = (from, fsock, to, tsock) => {
    state.connections.push({
      id: uid('c'),
      from:{ nodeId: from.id, socket: fsock },
      to:  { nodeId: to.id,   socket: tsock },
    });
  };

  const cuv    = n('centeredUV', -820,  -40);
  const time   = n('time',       -820,  210);
  const marble = n('marble',     -480,   80, { scale: 2.0 });
  const veins  = n('veins',      -480,  280, { frequency: 4.0, sharpness: 2.5 });

  const base   = n('color',      -160, -120, { rgb: [0.04, 0.03, 0.012] });
  const gold   = n('color',      -160,   60, { rgb: [0.78, 0.58, 0.20] });
  const deep   = n('color',      -160,  240, { rgb: [0.42, 0.30, 0.09] });

  const baseMix = n('mix',        180,  -30);
  const goldMix = n('mix',        500,   60);
  const deepMix = n('mix',        820,  120);

  const vig    = n('vignette',   1140,   90, { strength: 1.15 });
  const uvIn   = n('uv',         1140,  260);

  const out    = n('output',     1440,  100);

  c(cuv,  'p',       marble, 'p');
  c(time, 'out',     marble, 'time');
  c(cuv,  'p',       veins,  'p');
  c(time, 'out',     veins,  'time');

  c(base,  'out',    baseMix, 'a');
  c(gold,  'out',    baseMix, 'b');
  c(veins, 'out',    baseMix, 't');

  c(baseMix, 'out',      goldMix, 'a');
  c(deep,    'out',      goldMix, 'b');
  c(marble,  'pattern',  goldMix, 't');

  c(goldMix, 'out',  deepMix, 'a');
  c(gold,    'out',  deepMix, 'b');
  c(veins,   'out',  deepMix, 't');

  c(deepMix, 'out',  vig, 'color');
  c(uvIn,    'out',  vig, 'uv');

  c(vig, 'out',      out, 'color');
}

function isSocketConnected(nodeId, dir, socket){
  for (const c of state.connections){
    if (dir === 'in'  && c.to.nodeId   === nodeId && c.to.socket   === socket) return true;
    if (dir === 'out' && c.from.nodeId === nodeId && c.from.socket === socket) return true;
  }
  return false;
}

/* Mirror of compiler.js's isFlagOutputMuted — duplicated here so editor /
 * graph-state code can reason about muted Flag outputs without depending on
 * the compiler module. Returns true when the source is any Flag variant and
 * its output is currently emitting "nothing" (output toggle off, or every
 * feeding input toggle off, or no internal wires). */
function isFlagOutputMuted(srcNode, socketName){
  if (!srcNode) return false;
  const t = srcNode.type;
  if (t !== 'flag' && t !== 'flagFloat' && t !== 'flagVec2') return false;
  const m = /^out(\d+)$/.exec(socketName);
  if (!m) return false;
  const j = parseInt(m[1], 10);
  const p = srcNode.params || {};
  const enabled      = Array.isArray(p.enabled)      ? p.enabled      : [];
  const inputEnabled = Array.isArray(p.inputEnabled) ? p.inputEnabled : [];
  const wires        = Array.isArray(p.wires)        ? p.wires        : [];
  if (enabled[j] === false) return true;
  const feeds = wires.filter(w => w.to === j);
  if (feeds.length === 0) return true;
  return !feeds.some(w => inputEnabled[w.from] !== false);
}

/* Same as isSocketConnected but a connection whose source is a muted Flag
 * output counts as "not connected." Used by node bodies to decide whether
 * to show the inline value editor — when the upstream Flag is muted, the
 * downstream socket falls back to its default at compile time, so the user
 * needs to be able to edit that default in place. The socket dot itself
 * still uses isSocketConnected so the rendered wire stays visually present. */
function isInputLive(nodeId, socketName){
  for (const c of state.connections){
    if (c.to.nodeId !== nodeId || c.to.socket !== socketName) continue;
    const src = state.nodes.find(n => n.id === c.from.nodeId);
    if (!isFlagOutputMuted(src, c.from.socket)) return true;
  }
  return false;
}
