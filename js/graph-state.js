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
};

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
}
function pushHistory(){
  if (history.suspended) return;
  // drop any redo future — we branched
  history.stack.length = history.index + 1;
  history.stack.push(_cloneGraph());
  history.index++;
  if (history.stack.length > history.max){
    history.stack.shift();
    history.index--;
  }
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

  // socket default overrides (rarely used; placeholder for future UI to set
  // per-socket constants without needing an explicit const node upstream).
  const defaults = {};
  if (def.inputs){
    for (const sock of def.inputs){
      if (sock.default !== undefined){
        defaults[sock.name] = Array.isArray(sock.default) ? [...sock.default] : sock.default;
      }
    }
  }

  return { id: uid('n'), type, x, y, params, defaults };
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
