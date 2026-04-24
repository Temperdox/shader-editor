/* WebGL renderer — single full-screen quad, recompiled whenever the graph
   changes. `preserveDrawingBuffer: true` is required so Save PNG can read the
   current frame out of the canvas; without it the buffer is cleared before
   toBlob returns (and you get a blank image). */
const renderer = (() => {
  const canvas = $('#bgShader');
  // alpha:false → canvas is composited opaque. The output shader now writes
  // gl_FragColor.a = specular as a bloom mask, and we don't want that alpha
  // to leak into the page when we draw direct-to-screen.
  const opts = { preserveDrawingBuffer: true, antialias: true, alpha: false };
  const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  if (!gl){
    toast('WebGL unavailable', 'err');
    return { recompile: () => ({ ok: false }), canvas, gl: null };
  }
  // WebGL1 gates dFdx/dFdy behind OES_standard_derivatives. The compiler emits
  // `#extension GL_OES_standard_derivatives : enable` when SDF Normal (or any
  // other derivative-using node) is in the graph, but the extension ALSO has
  // to be activated JS-side before shader compile or the browser won't expose
  // the symbol. Silently no-op if the GPU doesn't support it — the shader
  // compile will then error with a clearer message.
  gl.getExtension('OES_standard_derivatives');

  // Vertex shader: in flat mode (u_surface = 0) it behaves like the old
  // fullscreen-quad pass-through and v_surfaceNormal is (0, 0, 1). When
  // u_surface > 0 we compute a noise-based height field and output the
  // analytical normal so the fragment shader gets smoothly-interpolated
  // 3D normals across the grid — a test bed for lighting / Fresnel /
  // iridescence that's impossible to get from a flat single quad.
  //
  // Position stays in clip space (no actual Z displacement) so all existing
  // shader graphs still render full-screen; only the NORMAL varies. That's
  // enough for Fresnel / Lambert / specular bloom to react meaningfully.
  const VS = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    uniform float u_surface;
    varying vec2 v_uv;
    varying vec3 v_surfaceNormal;

    // Value-noise with smooth bilinear interpolation — good enough for a
    // height field and cheap in the VS. Uses a hash of integer cell coords.
    float _vsHash(vec2 p){
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float _vsNoise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f*f*(3.0 - 2.0*f);
      float a = _vsHash(i);
      float b = _vsHash(i + vec2(1.0, 0.0));
      float c = _vsHash(i + vec2(0.0, 1.0));
      float d = _vsHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
    }
    float _vsHeight(vec2 p){
      return (_vsNoise(p * 3.0) * 0.6 + _vsNoise(p * 7.0) * 0.3) * u_surface;
    }

    void main(){
      v_uv = a_uv;
      // Analytical normal via finite differences. eps ~ 2 grid cells keeps
      // the gradient smooth even at the lowest tessellation, and keeps the
      // VS cost low (just 3 noise calls per vertex).
      float e = 0.04;
      float hC = _vsHeight(a_position);
      float hR = _vsHeight(a_position + vec2(e, 0.0));
      float hU = _vsHeight(a_position + vec2(0.0, e));
      v_surfaceNormal = normalize(vec3((hC - hR) / e, (hC - hU) / e, 1.0));
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  let program = null;
  let uTime, uMouse, uRes, uSimLight, uSurface;
  let mx = 0.5, my = 0.5;

  // Texture registry bound to this GL context. One per renderer so each
  // WebGL context owns its own GPU-side texture objects.
  const texRegistry = createTextureRegistry(gl);
  // Populated from compileGraph() result; each entry maps a sampler2D
  // uniform to a node id whose image we bind on the active texture slot.
  let textureBindings = [];

  // Bloom pipeline — lazily used when the Output node's `bloom` param
  // is on. Created once for this context; FBOs internally (re)allocate
  // on viewport resize.
  const bloom = createBloomPipeline(gl);

  // Tessellated fullscreen grid. A 64×64 quad subdivision gives ~8k triangles
  // — plenty for smooth per-vertex normal interpolation, negligible cost on
  // any GPU. In flat/u_surface=0 mode the VS treats every vertex identically
  // to the old 2-triangle quad, so existing shaders are unaffected.
  const GRID = 64;
  const mesh = buildGridMesh(GRID);
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const indexCount = mesh.indices.length;

  function buildGridMesh(n){
    const verts = (n + 1) * (n + 1);
    const positions = new Float32Array(verts * 2);
    const uvs       = new Float32Array(verts * 2);
    let p = 0;
    for (let y = 0; y <= n; y++){
      for (let x = 0; x <= n; x++){
        const u = x / n;
        const v = y / n;
        positions[p]   = u * 2 - 1;       // −1..1
        positions[p+1] = v * 2 - 1;
        uvs[p]   = u;
        uvs[p+1] = v;
        p += 2;
      }
    }
    // Two triangles per quad. Use Uint16Array — 65×65 = 4225 verts fits.
    const indices = new Uint16Array(n * n * 6);
    let i = 0;
    for (let y = 0; y < n; y++){
      for (let x = 0; x < n; x++){
        const a = y * (n + 1) + x;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices[i++] = a; indices[i++] = b; indices[i++] = c;
        indices[i++] = b; indices[i++] = d; indices[i++] = c;
      }
    }
    return { positions, uvs, indices };
  }

  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  }
  function link(vs, fs){
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      throw new Error(gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  function recompile(fsSource, bindings){
    try {
      const vs = compile(gl.VERTEX_SHADER, VS);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const prog = link(vs, fs);
      if (program) gl.deleteProgram(program);
      program = prog;
      gl.useProgram(program);

      // rebind attribs + index buffer for the new program
      const aPos = gl.getAttribLocation(program, 'a_position');
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      const aUv = gl.getAttribLocation(program, 'a_uv');
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

      uTime     = gl.getUniformLocation(program, 'u_time');
      uMouse    = gl.getUniformLocation(program, 'u_mouse');
      uRes      = gl.getUniformLocation(program, 'u_resolution');
      uSimLight = gl.getUniformLocation(program, 'u_simLight');
      uSurface  = gl.getUniformLocation(program, 'u_surface');

      // Resolve each sampler2D uniform location and lock it to a texture slot.
      // uniform1i only needs to be set once per program — the frame loop just
      // rebinds the backing texture on the right slot.
      textureBindings = (bindings || []).map((b, i) => ({
        ...b,
        slot: i,
        location: gl.getUniformLocation(program, b.uniformName),
      }));
      for (const b of textureBindings){
        if (b.location != null) gl.uniform1i(b.location, b.slot);
      }

      $('#shaderError').classList.remove('visible');
      $('#shaderError').textContent = '';
      return { ok: true };
    } catch (e){
      $('#shaderError').classList.add('visible');
      $('#shaderError').textContent = 'Shader error:\n' + e.message;
      return { ok: false, error: e.message };
    }
  }

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(window.innerWidth  * dpr));
    const h = Math.max(2, Math.round(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  window.addEventListener('pointermove', (e) => {
    mx = clamp(e.clientX / window.innerWidth, 0, 1);
    // flip Y so the shader's +Y points up (CSS has +Y down)
    my = clamp(1 - e.clientY / window.innerHeight, 0, 1);
  }, { passive: true });

  const start = performance.now();
  function frame(){
    // Skip the draw entirely while preview mode is showing (its own canvas
    // is animating) or when the tab is hidden. rAF is still scheduled so we
    // resume instantly when either condition flips — no restart handshake
    // needed. Saves ~23 s of wasted GPU work over a typical preview session.
    const hidden = document.hidden || document.body.classList.contains('preview-mode');
    if (!hidden){
      resize();
      if (program){
        // Read bloom config directly from the Output node each frame.
        // Toggling bloom on/off doesn't require a shader recompile — it
        // just switches the render pipeline between direct-to-screen and
        // the 3-pass FBO chain below.
        const outNode = state.nodes.find(n => n.type === 'output');
        const bloomOn = outNode && outNode.params && outNode.params.bloom === 'on';
        const bp = outNode && outNode.params || {};

        // shared scene-draw: bind user program, set uniforms + textures,
        // draw the fullscreen triangle pair. Used by both paths.
        const drawScene = () => {
          gl.useProgram(program);
          gl.uniform1f(uTime, (performance.now() - start) / 1000);
          gl.uniform2f(uMouse, mx, my);
          gl.uniform2f(uRes, canvas.width, canvas.height);
          // Sim-lighting uniform — see index.html #simLightBtn. When the body
          // class is set, the virtual light direction follows the cursor;
          // otherwise it's (0, 0, 1) so the shader looks "still".
          const simOn = document.body.classList.contains('sim-lighting-on');
          if (simOn){
            const lx = (mx - 0.5) * 2.0;
            const ly = (my - 0.5) * 2.0;
            const lz = 0.8;
            const len = Math.hypot(lx, ly, lz) || 1;
            if (uSimLight) gl.uniform3f(uSimLight, lx/len, ly/len, lz/len);
          } else {
            if (uSimLight) gl.uniform3f(uSimLight, 0.0, 0.0, 1.0);
          }
          // Surface mode — the VS applies a noise-height-derived normal to
          // every vertex when on. Fragment shaders reading v_surfaceNormal
          // (via the World Normal node) see real 3D variation; flat shaders
          // are unaffected because v_surfaceNormal defaults to (0,0,1).
          const surfaceOn = document.body.classList.contains('surface-on');
          if (uSurface) gl.uniform1f(uSurface, surfaceOn ? 1.0 : 0.0);
          for (const b of textureBindings){
            gl.activeTexture(gl.TEXTURE0 + b.slot);
            gl.bindTexture(gl.TEXTURE_2D, texRegistry.getTexture(b.nodeId));
          }
          // re-bind the user program's vertex attribs + index buffer in case
          // bloom passes (which use their own quad buffers) left them dangling
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
          const aPos = gl.getAttribLocation(program, 'a_position');
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
          const aUv = gl.getAttribLocation(program, 'a_uv');
          gl.enableVertexAttribArray(aUv);
          gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
          gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        };

        if (bloomOn){
          // 3-pass: scene → FBO, H-blur+threshold, V-blur+composite → screen
          bloom.renderToScene(canvas.width, canvas.height, drawScene);
          bloom.applyBloomToScreen({
            threshold: bp.bloomThreshold,
            radius:    bp.bloomRadius,
            intensity: bp.bloomIntensity,
          });
        } else {
          // direct-to-screen (existing fast path)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, canvas.width, canvas.height);
          drawScene();
        }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { recompile, canvas, gl };
})();

// Debounced entry point — call whenever the graph changes.
let _recompileTimer = null;
function scheduleRecompile(){
  clearTimeout(_recompileTimer);
  _recompileTimer = setTimeout(() => {
    const res = compileGraph();
    if (!res.ok){
      $('#shaderError').classList.add('visible');
      $('#shaderError').textContent = 'Graph error: ' + res.error;
      return;
    }
    renderer.recompile(res.fs, res.textureBindings);
  }, 80);
}

function recompileShader(){
  const res = compileGraph();
  if (!res.ok){
    $('#shaderError').classList.add('visible');
    $('#shaderError').textContent = 'Graph error: ' + res.error;
    return;
  }
  renderer.recompile(res.fs, res.textureBindings);
}
