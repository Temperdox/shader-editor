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

  // Pre-bake the noise texture used by the textured snoise() helper.
  // ~256KB upload, ~50ms one-shot CPU cost. Bound to a fixed unit each
  // frame; uniform location resolved per recompile.
  // Slot 15 = the noise sampler. Per-node image textures use slots 0..N
  // (textureBindings); 15 is high enough to never collide.
  const NOISE_UNIT = 15;
  const noiseBake = (typeof buildNoiseTexture === 'function')
    ? buildNoiseTexture(gl, 512, 8)
    : null;
  let uNoise = null;

  // Vertex shader: pass-through XY for the fullscreen mesh, plus a built-in
  // noise-based normal field exposed via `v_surfaceNormal`. The fragment
  // shader can read this through the `World Normal` node for shaders that
  // want a procedural 3D-feeling normal (Lambert / Fresnel / etc.). Vertex
  // POSITIONS are never displaced — keeping the mesh flat means existing
  // shaders aren't visually distorted by the test-surface mechanism.
  const VS = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    varying vec3 v_surfaceNormal;

    // Cheap value noise for the test height field (used only for normals).
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
      return _vsNoise(p * 6.0) * 0.35 + _vsNoise(p * 14.0) * 0.18;
    }

    void main(){
      v_uv = a_uv;
      // Analytical normal via finite differences of the noise heightfield.
      float e = 0.04;
      float hC = _vsHeight(a_position);
      float hR = _vsHeight(a_position + vec2(e, 0.0));
      float hU = _vsHeight(a_position + vec2(0.0, e));
      v_surfaceNormal = normalize(vec3((hC - hR) / e, (hC - hU) / e, 1.0));
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  let program = null;
  let uTime, uMouse, uRes, uSimLight, uShadows;
  let mx = 0.5, my = 0.5;

  // Texture registry bound to this GL context. One per renderer so each
  // WebGL context owns its own GPU-side texture objects.
  const texRegistry = createTextureRegistry(gl);
  // Populated from compileGraph() result; each entry maps a sampler2D
  // uniform to a node id whose image we bind on the active texture slot.
  let textureBindings = [];

  // ---- Plan B: cache passes ----
  // Each entry: { program, fs, fbo, tex, fbW, fbH, common uniforms,
  //   imageBindings: [{nodeId, uniformName, slot, location}],
  //   upstreamSlots: [{srcPassIdx, slot, location}],
  //   uMainSamplerLoc — set on the MAIN program for this pass's sampler }
  let passes = [];
  // Slot 16+ reserved for pass FBO textures; 0..7 for image textures;
  // slot 15 for the noise atlas (set above). 16+N is safely under the
  // typical 16-sampler limit for v1's 3 max passes.
  const PASS_SLOT_BASE = 16;

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
      // Dump the source to console so the user can see exactly what failed.
      const tag = type === gl.VERTEX_SHADER ? 'VS' : 'FS';
      const numbered = src.split('\n').map((l, i) => String(i + 1).padStart(3, ' ') + ': ' + l).join('\n');
      console.error(`[${tag} compile error]\n${log}\n--- source ---\n${numbered}`);
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

  // Allocate an RGBA8 FBO + texture for one pass. Linear filter so the
  // main shader sampling the pass output gets smooth interpolation; CLAMP
  // wrap because v_uv is always in [0,1] for full-screen passes.
  function createPassFBO(w, h){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE){
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error('pass FBO incomplete: 0x' + status.toString(16));
    }
    return { tex, fbo, w, h };
  }

  function disposePass(p){
    if (!p) return;
    if (p.program) gl.deleteProgram(p.program);
    if (p.fbo)     gl.deleteFramebuffer(p.fbo);
    if (p.tex)     gl.deleteTexture(p.tex);
  }

  // Re-allocate every pass's FBO at a new (canvas) size — called from resize.
  function resizePassFBOs(w, h){
    for (const p of passes){
      if (p.fbW === w && p.fbH === h) continue;
      gl.deleteFramebuffer(p.fbo);
      gl.deleteTexture(p.tex);
      const fb = createPassFBO(w, h);
      p.fbo = fb.fbo; p.tex = fb.tex; p.fbW = w; p.fbH = h;
    }
  }

  function recompile(fsSource, bindings, passSpecs){
    try {
      const vs = compile(gl.VERTEX_SHADER, VS);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const prog = link(vs, fs);
      if (program) gl.deleteProgram(program);
      program = prog;
      gl.useProgram(program);

      // Tear down old passes — programs and FBOs both belong to the
      // previous compile and aren't reused.
      for (const p of passes) disposePass(p);
      passes = [];

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
      uShadows  = gl.getUniformLocation(program, 'u_shadows');
      // Noise sampler — only present when the compiled shader actually
      // references the textured snoise helper. getUniformLocation returns
      // null otherwise; bind code below short-circuits on null.
      uNoise    = gl.getUniformLocation(program, 'u_noise');
      if (uNoise != null) gl.uniform1i(uNoise, NOISE_UNIT);

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

      // ---- compile each cache pass into its own program + FBO ----
      for (const ps of (passSpecs || [])){
        const pVs   = compile(gl.VERTEX_SHADER, VS);
        const pFs   = compile(gl.FRAGMENT_SHADER, ps.fs);
        const pProg = link(pVs, pFs);
        gl.useProgram(pProg);

        const pUTime     = gl.getUniformLocation(pProg, 'u_time');
        const pUMouse    = gl.getUniformLocation(pProg, 'u_mouse');
        const pURes      = gl.getUniformLocation(pProg, 'u_resolution');
        const pUSimLight = gl.getUniformLocation(pProg, 'u_simLight');
        const pUShadows  = gl.getUniformLocation(pProg, 'u_shadows');
        const pUNoise    = gl.getUniformLocation(pProg, 'u_noise');
        if (pUNoise != null) gl.uniform1i(pUNoise, NOISE_UNIT);

        // Pass-internal image textures get their own slot space (0..N).
        const passImageBindings = (ps.textureBindings || []).map((b, j) => ({
          ...b,
          slot: j,
          location: gl.getUniformLocation(pProg, b.uniformName),
        }));
        for (const b of passImageBindings){
          if (b.location != null) gl.uniform1i(b.location, b.slot);
        }

        // Upstream pass-output samplers — bound to PASS_SLOT_BASE + upIdx.
        const upstreamSlots = (ps.upstreamPassIndices || []).map(upIdx => ({
          srcPassIdx: upIdx,
          slot: PASS_SLOT_BASE + upIdx,
          location: gl.getUniformLocation(pProg, 'u_pass_' + upIdx),
        }));
        for (const u of upstreamSlots){
          if (u.location != null) gl.uniform1i(u.location, u.slot);
        }

        const fb = createPassFBO(canvas.width, canvas.height);

        passes.push({
          index: ps.index,
          program: pProg,
          fbo: fb.fbo,
          tex: fb.tex,
          fbW: fb.w,
          fbH: fb.h,
          uTime: pUTime, uMouse: pUMouse, uRes: pURes,
          uSimLight: pUSimLight, uShadows: pUShadows, uNoise: pUNoise,
          imageBindings: passImageBindings,
          upstreamSlots,
        });
      }

      // Resolve MAIN program's pass-input sampler locations now that
      // passes exist. Each MAIN program sampler `u_pass_N` reads the FBO
      // texture of pass N at the corresponding slot.
      gl.useProgram(program);
      for (const p of passes){
        const slot = PASS_SLOT_BASE + p.index;
        const loc  = gl.getUniformLocation(program, 'u_pass_' + p.index);
        p.uMainSamplerLoc = loc;
        if (loc != null) gl.uniform1i(loc, slot);
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
      // Pass FBOs must match canvas size so v_uv-based sampling lines up.
      resizePassFBOs(w, h);
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

        // ---- shared dynamic uniforms (computed once per frame, used by
        // every program — main and all passes) ----
        const tNow = (performance.now() - start) / 1000;
        const simOn = document.body.classList.contains('sim-lighting-on');
        const aspect = canvas.width / canvas.height;
        const slx = simOn ? (mx - 0.5) * aspect : 0.0;
        const sly = simOn ? (my - 0.5)          : 0.0;
        const slz = simOn ? 0.45                : 100.0;
        const shadowsOn = document.body.classList.contains('shadows-on');
        const shadowsVal = shadowsOn ? 1.0 : 0.0;

        // ---- render every cache pass into its FBO ----
        // Passes are in topological order (compiler emits them so), so an
        // upstream pass always runs before any pass that samples it. Each
        // pass renders the same fullscreen mesh as the main pass. Per-frame
        // — no invalidation tracking in v1, but the per-fragment cost of
        // each pass is bounded (only its own subgraph runs).
        for (const p of passes){
          gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbo);
          gl.viewport(0, 0, p.fbW, p.fbH);
          gl.useProgram(p.program);
          if (p.uTime)     gl.uniform1f(p.uTime, tNow);
          if (p.uMouse)    gl.uniform2f(p.uMouse, mx, my);
          if (p.uRes)      gl.uniform2f(p.uRes, p.fbW, p.fbH);
          if (p.uSimLight) gl.uniform3f(p.uSimLight, slx, sly, slz);
          if (p.uShadows)  gl.uniform1f(p.uShadows, shadowsVal);

          if (p.uNoise != null && noiseBake){
            gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
            gl.bindTexture(gl.TEXTURE_2D, noiseBake.texture);
          }
          for (const b of p.imageBindings){
            gl.activeTexture(gl.TEXTURE0 + b.slot);
            gl.bindTexture(gl.TEXTURE_2D, texRegistry.getTexture(b.nodeId));
          }
          for (const u of p.upstreamSlots){
            const src = passes.find(x => x.index === u.srcPassIdx);
            if (src){
              gl.activeTexture(gl.TEXTURE0 + u.slot);
              gl.bindTexture(gl.TEXTURE_2D, src.tex);
            }
          }

          // Re-bind attribs to the pass program — getAttribLocation per
          // program returns its own slots; vertexAttribPointer is bound
          // to whichever location we pull from this program.
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
          const pAPos = gl.getAttribLocation(p.program, 'a_position');
          gl.enableVertexAttribArray(pAPos);
          gl.vertexAttribPointer(pAPos, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
          const pAUv = gl.getAttribLocation(p.program, 'a_uv');
          gl.enableVertexAttribArray(pAUv);
          gl.vertexAttribPointer(pAUv, 2, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
          gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        }
        // Restore the canvas-bound default framebuffer + viewport for the
        // main pass / bloom pipeline that follows.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);

        // shared scene-draw: bind user program, set uniforms + textures,
        // draw the fullscreen triangle pair. Used by both paths.
        const drawScene = () => {
          gl.useProgram(program);
          gl.uniform1f(uTime, (performance.now() - start) / 1000);
          gl.uniform2f(uMouse, mx, my);
          gl.uniform2f(uRes, canvas.width, canvas.height);
          // u_simLight is now a POINT-LIGHT POSITION in centered-UV space
          // (matching Centered UV's coord system: x in ±aspect/2, y in ±0.5).
          // The Sim Light node computes per-fragment direction = normalize(
          // u_simLight - vec3(pos, 0)), so each pixel sees the cursor as a
          // local point-light source rather than a single global direction.
          // Editor mode: tracks mouse VERBATIM (no inversion).
          // Off-state: light parked far above (0, 0, 100) → effectively
          // (0,0,1) direction for any fragment, so the shader reads "still".
          const simOn = document.body.classList.contains('sim-lighting-on');
          if (simOn){
            const aspect = canvas.width / canvas.height;
            const lx = (mx - 0.5) * aspect;
            const ly = (my - 0.5);                  // mx,my already GL-space (Y flipped)
            const lz = 0.45;                         // light height above surface
            if (uSimLight) gl.uniform3f(uSimLight, lx, ly, lz);
          } else {
            if (uSimLight) gl.uniform3f(uSimLight, 0.0, 0.0, 100.0);
          }
          // Shadow toggle — controlled by the bottom-right Shadows button.
          // When off, the Shadow node short-circuits its raymarch loop and
          // returns 1.0 (no shadow). Preview always sets this to 1.0.
          const shadowsOn = document.body.classList.contains('shadows-on');
          if (uShadows) gl.uniform1f(uShadows, shadowsOn ? 1.0 : 0.0);
          // Bind the pre-baked noise atlas to its reserved unit. Cheap;
          // skip if the bake isn't available or the shader doesn't sample
          // it (uNoise == null when the program doesn't reference it).
          if (uNoise != null && noiseBake){
            gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
            gl.bindTexture(gl.TEXTURE_2D, noiseBake.texture);
          }
          for (const b of textureBindings){
            gl.activeTexture(gl.TEXTURE0 + b.slot);
            gl.bindTexture(gl.TEXTURE_2D, texRegistry.getTexture(b.nodeId));
          }
          // Bind each cache-pass FBO texture to its reserved slot so the
          // main shader's `texture2D(u_pass_N, v_uv)` lookups read the
          // freshly-rendered pass output (rendered above this frame).
          for (const p of passes){
            gl.activeTexture(gl.TEXTURE0 + (PASS_SLOT_BASE + p.index));
            gl.bindTexture(gl.TEXTURE_2D, p.tex);
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
    renderer.recompile(res.fs, res.textureBindings, res.passes);
  }, 80);
}

function recompileShader(){
  const res = compileGraph();
  if (!res.ok){
    $('#shaderError').classList.add('visible');
    $('#shaderError').textContent = 'Graph error: ' + res.error;
    return;
  }
  renderer.recompile(res.fs, res.textureBindings, res.passes);
}
