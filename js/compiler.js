/* Compiler — graph → GLSL fragment shader.
 *
 * Walks backward from the Fragment Output node in postorder to get a topological
 * ordering, resolves each input socket to either the upstream temp variable
 * or a default literal, and emits one GLSL statement per node. Helpers
 * (snoise/fbm/marble) are only emitted if a reachable node references them.
 *
 * The single-output shorthand: a node's generate() may return a bare string,
 * which is treated as { exprs: { <firstOutput>: string } }.
 */

/* True when a connection's source is a Flag-variant output that's currently
 * "muted" — meaning the output should NOT push a value to whatever's
 * downstream. Two muted states:
 *   1) the OUTPUT-side toggle is off (params.enabled[j] === false)
 *   2) every internal wire feeding that output is gated off via the
 *      INPUT-side toggle (params.inputEnabled[w.from] === false)
 * In either case the compiler treats the wire as if it didn't exist, so the
 * downstream socket falls back to its declared default literal — preventing
 * the Flag from "overriding" downstream until re-enabled. */
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
  if (feeds.length === 0) return true; // nothing internally wired
  return !feeds.some(w => inputEnabled[w.from] !== false);
}

function compileGraph(){
  const output = state.nodes.find(n => n.type === 'output');
  if (!output) return { ok: false, error: 'no Fragment Output node' };

  // reverse-adjacency index: nodeId → connections landing on its inputs
  const edgesByTo = new Map();
  for (const conn of state.connections){
    if (!edgesByTo.has(conn.to.nodeId)) edgesByTo.set(conn.to.nodeId, []);
    edgesByTo.get(conn.to.nodeId).push(conn);
  }

  // DFS postorder from output → topological sort, with cycle detection
  const visited = new Set();
  const order = [];
  const visiting = new Set();
  let cycleDetected = false;

  function visit(nodeId){
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)){ cycleDetected = true; return; }
    visiting.add(nodeId);
    const edges = edgesByTo.get(nodeId) || [];
    for (const e of edges) visit(e.from.nodeId);
    visiting.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }
  visit(output.id);

  if (cycleDetected) return { ok: false, error: 'cycle detected in graph' };

  const nodeById = new Map(state.nodes.map(n => [n.id, n]));
  const outputRefs = new Map();  // nodeId → { socketName: glslVarName }
  const helpers = new Set();
  const extensions = new Set();  // GLSL #extension directives needed (e.g. GL_OES_standard_derivatives)
  const textureBindings = [];    // [{ nodeId, uniformName }] — sampler2D needed by the compiled program
  const inlineFunctions = [];    // per-node GLSL function definitions emitted to file scope (after helpers)
  const body = [];
  let tmpCounter = 0;

  for (const nid of order){
    const node = nodeById.get(nid);
    if (!node) continue;
    const def = NODE_TYPES[node.type];

    // resolve each input: connected → upstream ref; otherwise default literal.
    // Nodes with dynamic socket schemas (Flag) expose `inputs` as a function.
    const inputExprs = {};
    const schemaInputs = getNodeInputs(node);
    if (schemaInputs){
      for (const sock of schemaInputs){
        const conn = (edgesByTo.get(nid) || []).find(e => e.to.socket === sock.name);
        if (conn){
          const srcNode = nodeById.get(conn.from.nodeId);
          // Muted Flag outputs behave as no-connection so this socket falls
          // back to its default literal instead of being overridden by 0.
          if (isFlagOutputMuted(srcNode, conn.from.socket)){
            inputExprs[sock.name] = defaultLiteral(sock, node.defaults[sock.name]);
          } else {
            const upstream = outputRefs.get(conn.from.nodeId);
            const ref = upstream && upstream[conn.from.socket];
            // stale connections (e.g. upstream output removed) fall back gracefully
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
      tmp:(prefix) => `_${prefix}_${(++tmpCounter).toString(36)}`,
      // Let generate() distinguish "input has an upstream wire" from "input
      // is unconnected and falling back to its default literal." Only a few
      // nodes need this — the Color node uses it so unconnected channels
      // fall back to the color-picker param instead of the socket's default.
      isConnected: (socketName) => {
        return (edgesByTo.get(nid) || []).some(e => {
          if (e.to.socket !== socketName) return false;
          // A muted Flag source counts as "not connected" here too, so
          // nodes like Color (which switches between socket overrides and
          // its picker param based on isConnected) behave consistently.
          const srcNode = nodeById.get(e.from.nodeId);
          return !isFlagOutputMuted(srcNode, e.from.socket);
        });
      },
    };

    let result;
    try {
      result = def.generate(ctx);
    } catch (e){
      return { ok: false, error: `${def.title}: ${e.message}` };
    }

    // static helpers from the node definition
    if (def.helpers){
      for (const h of def.helpers) helpers.add(h);
    }
    if (def.extensions){
      for (const x of def.extensions) extensions.add(x);
    }

    // single-expression shorthand
    const schemaOutputs = getNodeOutputs(node);
    if (typeof result === 'string'){
      const firstOut = (schemaOutputs && schemaOutputs[0] && schemaOutputs[0].name) || 'out';
      result = { exprs: { [firstOut]: result } };
    }

    // dynamic helpers chosen at generate() time (e.g. a node that only needs
    // snoise in one of its modes)
    if (Array.isArray(result.helpers)){
      for (const h of result.helpers) helpers.add(h);
    }
    if (Array.isArray(result.extensions)){
      for (const x of result.extensions) extensions.add(x);
    }

    // sampler2D uniforms this node needs. Compiler emits the declarations in
    // the prelude; the renderer binds textures to the corresponding slots.
    if (Array.isArray(result.textures)){
      for (const tex of result.textures){
        textureBindings.push({ nodeId: node.id, uniformName: tex.uniformName });
      }
    }

    // Per-node helper functions. Unlike `helpers` (global, named utilities
    // like snoise/fbm), these are bespoke functions defined for THIS node
    // instance — typically with a name suffixed by node.id to stay unique
    // across multiple instances. Emitted to file scope, after the global
    // helpers and before main(), so the node's setup can call them.
    if (Array.isArray(result.inlineFunctions)){
      for (const fn of result.inlineFunctions) inlineFunctions.push(fn);
    }

    if (result.setup) body.push(result.setup);

    // Materialize each output to a named temp so downstream references are
    // linear (and so an expression feeding two consumers is only computed
    // once in the emitted GLSL).
    const refs = {};
    if (schemaOutputs){
      for (const out of schemaOutputs){
        const expr = result.exprs && result.exprs[out.name];
        if (expr === undefined) continue;
        // If the expression is a bare identifier (like `u_time` or `x.y`),
        // skip the temp and reference it directly.
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

  // helper blocks, ordered so dependencies come first
  // (snoise → fbm → {marble, heightField}; the rest are standalone.)
  const HELPER_RANK = {
    snoise:      0,
    fbm:         1,
    marble:      2,
    heightField: 2,
    ridgedFbm:   1,   // depends on snoise, peer of fbm
    rngHash3:    0,
    voronoi2:    0,
    hsv2rgb:     0,
    rgb2hsv:     0,
    palette:     0,
    rotateVec3:  0,
    sdfHexagon:  0,
    sdfTriangle: 0,
    sdfCrystal:  1,   // depends on sdfHexagon + sdfTriangle
    sdfNormal3D: 0,
    heightToNormal: 0,
  };
  const preludeHelpers = [...helpers]
    .sort((a, b) => (HELPER_RANK[a] ?? 9) - (HELPER_RANK[b] ?? 9))
    .map(k => SHADER_HELPERS[k])
    .join('\n');

  const samplerDecls = textureBindings
    .map(b => `uniform sampler2D ${b.uniformName};`)
    .join('\n');

  // #extension directives MUST come before anything else (GLSL ES 1.00 spec).
  const extDecls = [...extensions]
    .map(x => `#extension ${x} : enable`)
    .join('\n');

  const fs = `${extDecls}
precision mediump float;
uniform float u_time;
uniform vec2  u_mouse;
uniform vec2  u_resolution;
// Sim-lighting uniform: vec3 light direction that tracks the cursor when the
// Lighting button is active, or (0, 0, 1) when off. See renderer.js.
uniform vec3  u_simLight;
// Shadow toggle — driven by the Shadows button in the editor (always 1.0
// in preview mode). Read by the Shadow node to skip the raymarch loop and
// return 1.0 (no shadow) when 0.0.
uniform float u_shadows;
// Test-surface varying: the VS computes a procedural 3D normal from a noise
// height field and passes it here. Reads (0, 0, 1) when the Surface button
// is off. See renderer.js's vertex shader.
varying vec3  v_surfaceNormal;
${samplerDecls}
varying vec2  v_uv;

${preludeHelpers}

${inlineFunctions.join('\n')}

void main(){
${body.map(line => '  ' + line).join('\n')}
}
`;

  return { ok: true, fs, textureBindings };
}
