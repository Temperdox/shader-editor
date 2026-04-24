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
  const textureBindings = [];    // [{ nodeId, uniformName }] — sampler2D needed by the compiled program
  const body = [];
  let tmpCounter = 0;

  for (const nid of order){
    const node = nodeById.get(nid);
    if (!node) continue;
    const def = NODE_TYPES[node.type];

    // resolve each input: connected → upstream ref; otherwise default literal
    const inputExprs = {};
    if (def.inputs){
      for (const sock of def.inputs){
        const conn = (edgesByTo.get(nid) || []).find(e => e.to.socket === sock.name);
        if (conn){
          const upstream = outputRefs.get(conn.from.nodeId);
          const ref = upstream && upstream[conn.from.socket];
          // stale connections (e.g. upstream output removed) fall back gracefully
          inputExprs[sock.name] = ref ?? defaultLiteral(sock, node.defaults[sock.name]);
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

    // single-expression shorthand
    if (typeof result === 'string'){
      const firstOut = (def.outputs && def.outputs[0] && def.outputs[0].name) || 'out';
      result = { exprs: { [firstOut]: result } };
    }

    // dynamic helpers chosen at generate() time (e.g. a node that only needs
    // snoise in one of its modes)
    if (Array.isArray(result.helpers)){
      for (const h of result.helpers) helpers.add(h);
    }

    // sampler2D uniforms this node needs. Compiler emits the declarations in
    // the prelude; the renderer binds textures to the corresponding slots.
    if (Array.isArray(result.textures)){
      for (const tex of result.textures){
        textureBindings.push({ nodeId: node.id, uniformName: tex.uniformName });
      }
    }

    if (result.setup) body.push(result.setup);

    // Materialize each output to a named temp so downstream references are
    // linear (and so an expression feeding two consumers is only computed
    // once in the emitted GLSL).
    const refs = {};
    if (def.outputs){
      for (const out of def.outputs){
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
  // (snoise → fbm → {marble, heightField} — the latter two both depend on fbm)
  const HELPER_RANK = { snoise: 0, fbm: 1, marble: 2, heightField: 2 };
  const preludeHelpers = [...helpers]
    .sort((a, b) => (HELPER_RANK[a] ?? 9) - (HELPER_RANK[b] ?? 9))
    .map(k => SHADER_HELPERS[k])
    .join('\n');

  const samplerDecls = textureBindings
    .map(b => `uniform sampler2D ${b.uniformName};`)
    .join('\n');

  const fs = `
precision mediump float;
uniform float u_time;
uniform vec2  u_mouse;
uniform vec2  u_resolution;
${samplerDecls}
varying vec2  v_uv;

${preludeHelpers}

void main(){
${body.map(line => '  ' + line).join('\n')}
}
`;

  return { ok: true, fs, textureBindings };
}
