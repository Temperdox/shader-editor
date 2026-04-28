/* Compiler — graph → GLSL fragment shader(s).
 *
 * Walks backward from the Fragment Output node in postorder to get a
 * topological ordering. Then PARTITIONS the graph into passes:
 *   - Any node whose type has `passCache: 'live'` becomes a pass root.
 *   - Each pass renders the subgraph terminating at that root into an
 *     off-screen RGBA8 framebuffer. The renderer caches the FBO and
 *     samples it in the main pass. Pass roots that are reachable in
 *     OTHER passes are sampled from the upstream pass's FBO (so passes
 *     can chain).
 * The main-pass shader then references each pass-root output via a
 * single `texture2D(u_pass_N, v_uv)` decode instead of inlining the
 * full subgraph — turning ~12-30 snoise calls into one texture fetch.
 *
 * Encoding for pass FBO contents (RGBA8):
 *   float → vec4(v*0.5+0.5, 0, 0, 1)
 *   vec2  → vec4(v*0.5+0.5, 0, 1)
 *   vec3  → vec4(v*0.5+0.5, 1)
 * Decoded with the inverse `(t * 2.0 - 1.0)`. Quantization step ≈ 1/256.
 *
 * If no node has `passCache` set the compiler emits a single program
 * (the original fast path), so existing graphs are unaffected.
 */

/* True when a connection's source is a Flag-variant output that's currently
 * "muted" — meaning the output should NOT push a value to whatever's
 * downstream. See node-types.js Flag.generate for the runtime semantics;
 * the compiler treats muted-Flag wires as if they didn't exist so the
 * downstream socket falls back to its declared default. */
function isFlagOutputMuted(srcNode, socketName){
  if (!srcNode) return false;
  const t = srcNode.type;
  if (t !== 'flag' && t !== 'flagFloat' && t !== 'flagVec2') return false;
  const m = /^out(\d+)$/.exec(socketName);
  if (!m) return false;
  const j = parseInt(m[1], 10);
  const params = srcNode.params || {};
  const enabled      = Array.isArray(params.enabled)      ? params.enabled      : [];
  const inputEnabled = Array.isArray(params.inputEnabled) ? params.inputEnabled : [];
  const wires        = Array.isArray(params.wires)        ? params.wires        : [];
  if (enabled[j] === false) return true;
  const feeds = wires.filter(w => w.to === j);
  if (feeds.length === 0) return true;
  return !feeds.some(w => inputEnabled[w.from] !== false);
}

/* Pass-FBO encoding/decoding helpers — emitted in every shader that
 * either writes a pass output or reads one. Kept tiny to avoid bloat. */
const PASS_CODEC_HELPERS = `
vec4 _packPassFloat(float v){ return vec4(v * 0.5 + 0.5, 0.0, 0.0, 1.0); }
vec4 _packPassVec2 (vec2  v){ return vec4(v * 0.5 + 0.5, 0.0, 1.0); }
vec4 _packPassVec3 (vec3  v){ return vec4(v * 0.5 + 0.5, 1.0); }
float _unpackPassFloat(vec4 t){ return t.r * 2.0 - 1.0; }
vec2  _unpackPassVec2 (vec4 t){ return t.rg * 2.0 - 1.0; }
vec3  _unpackPassVec3 (vec4 t){ return t.rgb * 2.0 - 1.0; }
`;

const HELPER_RANK = {
  snoise:         0,
  fbm:            1,
  marble:         2,
  heightField:    2,
  ridgedFbm:      1,
  rngHash3:       0,
  voronoi2:       0,
  hsv2rgb:        0,
  rgb2hsv:        0,
  palette:        0,
  rotateVec3:     0,
  sdfHexagon:     0,
  sdfTriangle:    0,
  sdfCrystal:     1,
  sdfNormal3D:    0,
  heightToNormal: 0,
};

/* Emit GLSL statements for a list of ordered node IDs. Used both for the
 * main pass and for each cache pass — the caller controls input override
 * (so pass roots from outside the current shader can be replaced with
 * texture samples). Collects helpers/extensions/textures/inline functions
 * encountered along the way. Returns { body, outputRefs, ... } or
 * { error: '...' } on a node-level generate failure. */
function emitNodes({ orderedIds, nodeById, edgesByTo, externalRefs, tmpCounterRef }){
  const helpers = new Set();
  const extensions = new Set();
  const textureBindings = [];
  const inlineFunctions = [];
  const body = [];
  const outputRefs = new Map();

  for (const nid of orderedIds){
    const node = nodeById.get(nid);
    if (!node) continue;
    const def = NODE_TYPES[node.type];

    // If this node is supplied as an external ref (e.g. an upstream pass
    // root that's been baked to a texture and decoded already), skip
    // generation and reuse the pre-built refs.
    if (externalRefs && externalRefs.has(nid)){
      outputRefs.set(nid, externalRefs.get(nid));
      continue;
    }

    // Resolve each input socket: connected → upstream ref; otherwise default.
    const inputExprs = {};
    const schemaInputs = getNodeInputs(node);
    if (schemaInputs){
      for (const sock of schemaInputs){
        const conn = (edgesByTo.get(nid) || []).find(e => e.to.socket === sock.name);
        if (conn){
          const srcNode = nodeById.get(conn.from.nodeId);
          if (isFlagOutputMuted(srcNode, conn.from.socket)){
            inputExprs[sock.name] = defaultLiteral(sock, node.defaults[sock.name]);
          } else {
            const upstream = outputRefs.get(conn.from.nodeId);
            const ref = upstream && upstream[conn.from.socket];
            inputExprs[sock.name] = ref ?? defaultLiteral(sock, node.defaults[sock.name]);
          }
        } else {
          inputExprs[sock.name] = defaultLiteral(sock, node.defaults[sock.name]);
        }
      }
    }

    const ctx = {
      node,
      inputs: inputExprs,
      params: node.params,
      tmp: (prefix) => `_${prefix}_${(++tmpCounterRef.value).toString(36)}`,
      isConnected: (socketName) => {
        return (edgesByTo.get(nid) || []).some(e => {
          if (e.to.socket !== socketName) return false;
          const srcNode = nodeById.get(e.from.nodeId);
          return !isFlagOutputMuted(srcNode, e.from.socket);
        });
      },
    };

    let result;
    try {
      result = def.generate(ctx);
    } catch (e){
      return { error: `${def.title}: ${e.message}` };
    }

    if (def.helpers)    for (const h of def.helpers) helpers.add(h);
    if (def.extensions) for (const x of def.extensions) extensions.add(x);

    const schemaOutputs = getNodeOutputs(node);
    if (typeof result === 'string'){
      const firstOut = (schemaOutputs && schemaOutputs[0] && schemaOutputs[0].name) || 'out';
      result = { exprs: { [firstOut]: result } };
    }
    if (Array.isArray(result.helpers))    for (const h of result.helpers) helpers.add(h);
    if (Array.isArray(result.extensions)) for (const x of result.extensions) extensions.add(x);
    if (Array.isArray(result.textures))   for (const tex of result.textures) textureBindings.push({ nodeId: node.id, uniformName: tex.uniformName });
    if (Array.isArray(result.inlineFunctions)) for (const fn of result.inlineFunctions) inlineFunctions.push(fn);

    if (result.setup) body.push(result.setup);

    const refs = {};
    if (schemaOutputs){
      for (const out of schemaOutputs){
        const expr = result.exprs && result.exprs[out.name];
        if (expr === undefined) continue;
        if (/^[a-zA-Z_][\w]*(\.[a-zA-Z]+)?$/.test(expr)){
          refs[out.name] = expr;
        } else {
          const tname = `_o_${node.id}_${out.name}`;
          body.push(`${out.type} ${tname} = ${expr};`);
          refs[out.name] = tname;
        }
      }
    }
    outputRefs.set(nid, refs);
  }

  return { body, outputRefs, helpers, extensions, textureBindings, inlineFunctions };
}

/* Build the prelude (helpers + sampler declarations) shared by all shader
 * variants in a compile. `passInputDecls` lists `uniform sampler2D u_pass_N;`
 * lines for the cache textures this shader will sample.  */
function buildPrelude({ helpers, extensions, textureBindings, inlineFunctions, useAnalytic, passInputDecls }){
  const sortedHelpers = [...helpers]
    .sort((a, b) => (HELPER_RANK[a] ?? 9) - (HELPER_RANK[b] ?? 9))
    .map(k => (k === 'snoise' && useAnalytic) ? SHADER_HELPERS['snoiseAnalytic'] : SHADER_HELPERS[k])
    .join('\n');

  const noiseSamplerDecl = (helpers.has('snoise') && !useAnalytic) ? 'uniform sampler2D u_noise;' : '';
  const samplerDecls = [
    noiseSamplerDecl,
    ...textureBindings.map(b => `uniform sampler2D ${b.uniformName};`),
    ...(passInputDecls || []),
  ].filter(Boolean).join('\n');

  const extDecls = [...extensions].map(x => `#extension ${x} : enable`).join('\n');

  return `${extDecls}
precision mediump float;
uniform float u_time;
uniform vec2  u_mouse;
uniform vec2  u_resolution;
uniform vec3  u_simLight;
uniform float u_shadows;
uniform float u_reflections;
uniform float u_previewMode;
uniform vec2  u_cardTilt;
varying vec3  v_surfaceNormal;
${samplerDecls}
varying vec2  v_uv;

${PASS_CODEC_HELPERS}

${sortedHelpers}

${inlineFunctions.join('\n')}
`;
}

/* Walk back from `rootId` collecting every ancestor that's NOT itself in
 * the `excludePassRoots` set. Pass roots in that set become "external"
 * inputs to this pass — sampled from their FBOs, not recomputed. */
function collectPassSubgraph(rootId, edgesByTo, excludePassRoots, nodeById){
  const visited = new Set();
  const ordered = [];
  const visiting = new Set();
  function visit(id){
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle — already detected in the main pass
    visiting.add(id);
    // Don't recurse INTO other pass roots — they're sampled, not included.
    // The pass's own root IS visited normally.
    if (id !== rootId && excludePassRoots.has(id)){
      visiting.delete(id);
      visited.add(id);
      return;
    }
    const edges = edgesByTo.get(id) || [];
    for (const e of edges) visit(e.from.nodeId);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }
  visit(rootId);
  return ordered;
}

function compileGraph(){
  const output = state.nodes.find(n => n.type === 'output');
  if (!output) return { ok: false, error: 'no Fragment Output node' };

  // ---------- topological order from output ----------
  const edgesByTo = new Map();
  for (const conn of state.connections){
    if (!edgesByTo.has(conn.to.nodeId)) edgesByTo.set(conn.to.nodeId, []);
    edgesByTo.get(conn.to.nodeId).push(conn);
  }
  const visited = new Set();
  const order = [];
  const visiting = new Set();
  let cycleDetected = false;
  function visit(nid){
    if (visited.has(nid)) return;
    if (visiting.has(nid)){ cycleDetected = true; return; }
    visiting.add(nid);
    const edges = edgesByTo.get(nid) || [];
    for (const e of edges) visit(e.from.nodeId);
    visiting.delete(nid);
    visited.add(nid);
    order.push(nid);
  }
  visit(output.id);
  if (cycleDetected) return { ok: false, error: 'cycle detected in graph' };

  const nodeById = new Map(state.nodes.map(n => [n.id, n]));
  const useAnalytic = state.useAnalyticNoise === true;

  // ---------- pass partition ----------
  // Pass roots: nodes whose type opts into FBO caching. The Output node is
  // never a pass root (it writes gl_FragColor in main). Pass roots are
  // emitted in topological order so a downstream pass that depends on an
  // upstream pass renders AFTER the upstream — the renderer respects this
  // by walking the returned `passes` array in order.
  const passRootsSet = new Set();
  const passRootsOrdered = [];
  for (const nid of order){
    const node = nodeById.get(nid);
    if (!node || node.type === 'output') continue;
    const def = NODE_TYPES[node.type];
    if (def && def.passCache === 'live'){
      passRootsSet.add(nid);
      passRootsOrdered.push(nid);
    }
  }

  // tmpCounter shared across all sub-compiles so generated names don't collide
  const tmpCounterRef = { value: 0 };

  // ---------- emit each cache pass ----------
  const passes = [];               // { id, fs, samplerName, outputType, textureBindings }
  const passSamplerName = (i) => `u_pass_${i}`;
  // For each pass root, the GLSL var that the MAIN shader uses to refer
  // to its output (the decoded sample). Built lazily during main emission.

  for (let pi = 0; pi < passRootsOrdered.length; pi++){
    const rootId = passRootsOrdered[pi];
    const rootNode = nodeById.get(rootId);
    const rootDef = NODE_TYPES[rootNode.type];
    const rootOutputs = getNodeOutputs(rootNode);
    if (!rootOutputs || rootOutputs.length === 0){
      return { ok: false, error: `pass root ${rootDef.title} has no outputs` };
    }
    // v1: cache only the first output of each pass root.
    const rootOutSpec = rootOutputs[0];
    const rootOutName = rootOutSpec.name;
    const rootOutType = rootOutSpec.type;

    // Subgraph for this pass = all ancestors of rootId, stopping at OTHER
    // pass roots (which become sampled-from-FBO inputs).
    const subgraphIds = collectPassSubgraph(rootId, edgesByTo, passRootsSet, nodeById);

    // Build externalRefs for upstream pass roots in this subgraph: each
    // gets a decoded-texture-sample expression assigned to a tmp.
    const externalRefs = new Map();
    const upstreamPassDecls = [];
    const upstreamPassSetup = [];
    const upstreamPassIndices = [];
    for (const upid of subgraphIds){
      if (upid === rootId) continue;
      if (!passRootsSet.has(upid)) continue;
      // Find this upstream pass's index
      const upIdx = passRootsOrdered.indexOf(upid);
      if (upIdx < 0 || upIdx >= pi) continue; // shouldn't happen for ancestors
      const upNode = nodeById.get(upid);
      const upOutSpec = getNodeOutputs(upNode)[0];
      const upTypeUnpack = upOutSpec.type === 'float' ? '_unpackPassFloat'
                          : upOutSpec.type === 'vec2'  ? '_unpackPassVec2'
                          : '_unpackPassVec3';
      const tname = `_pi_${upid}_${upOutSpec.name}`;
      upstreamPassDecls.push(`uniform sampler2D ${passSamplerName(upIdx)};`);
      upstreamPassSetup.push(`${upOutSpec.type} ${tname} = ${upTypeUnpack}(texture2D(${passSamplerName(upIdx)}, v_uv));`);
      upstreamPassIndices.push(upIdx);
      externalRefs.set(upid, { [upOutSpec.name]: tname });
    }

    // Emit the subgraph body
    const emit = emitNodes({
      orderedIds: subgraphIds,
      nodeById, edgesByTo,
      externalRefs,
      tmpCounterRef,
    });
    if (emit.error) return { ok: false, error: emit.error };

    // Fetch the root's output ref, encode, write to gl_FragColor
    const rootRefs = emit.outputRefs.get(rootId);
    if (!rootRefs || !(rootOutName in rootRefs)){
      return { ok: false, error: `pass root ${rootDef.title}: missing output ${rootOutName}` };
    }
    const rootRef = rootRefs[rootOutName];
    const packCall = rootOutType === 'float' ? '_packPassFloat'
                    : rootOutType === 'vec2'  ? '_packPassVec2'
                    : '_packPassVec3';

    const prelude = buildPrelude({
      helpers: emit.helpers,
      extensions: emit.extensions,
      textureBindings: emit.textureBindings,
      inlineFunctions: emit.inlineFunctions,
      useAnalytic,
      passInputDecls: upstreamPassDecls,
    });

    const passFs = `${prelude}
void main(){
${[...upstreamPassSetup, ...emit.body].map(l => '  ' + l).join('\n')}
  gl_FragColor = ${packCall}(${rootRef});
}
`;

    passes.push({
      index: pi,
      rootNodeId: rootId,
      fs: passFs,
      samplerName: passSamplerName(pi),
      outputType: rootOutType,
      textureBindings: emit.textureBindings,
      upstreamPassIndices,
    });
  }

  // ---------- emit the main shader ----------
  // Build externalRefs for main: every pass root gets a texture-sample stub.
  const mainExternalRefs = new Map();
  const mainPassInputDecls = [];
  const mainPassInputSetup = [];
  for (let pi = 0; pi < passRootsOrdered.length; pi++){
    const rootId = passRootsOrdered[pi];
    const rootNode = nodeById.get(rootId);
    const rootOutSpec = getNodeOutputs(rootNode)[0];
    const unpackCall = rootOutSpec.type === 'float' ? '_unpackPassFloat'
                       : rootOutSpec.type === 'vec2'  ? '_unpackPassVec2'
                       : '_unpackPassVec3';
    const tname = `_pi_${rootId}_${rootOutSpec.name}`;
    mainPassInputDecls.push(`uniform sampler2D ${passSamplerName(pi)};`);
    mainPassInputSetup.push(`${rootOutSpec.type} ${tname} = ${unpackCall}(texture2D(${passSamplerName(pi)}, v_uv));`);
    mainExternalRefs.set(rootId, { [rootOutSpec.name]: tname });
  }

  const mainEmit = emitNodes({
    orderedIds: order,
    nodeById, edgesByTo,
    externalRefs: mainExternalRefs,
    tmpCounterRef,
  });
  if (mainEmit.error) return { ok: false, error: mainEmit.error };

  const mainPrelude = buildPrelude({
    helpers: mainEmit.helpers,
    extensions: mainEmit.extensions,
    textureBindings: mainEmit.textureBindings,
    inlineFunctions: mainEmit.inlineFunctions,
    useAnalytic,
    passInputDecls: mainPassInputDecls,
  });

  const fs = `${mainPrelude}
void main(){
${[...mainPassInputSetup, ...mainEmit.body].map(l => '  ' + l).join('\n')}
}
`;

  return {
    ok: true,
    fs,
    textureBindings: mainEmit.textureBindings,
    passes,                       // [] when no cacheable nodes are reachable
  };
}
