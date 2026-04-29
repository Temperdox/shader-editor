/* Preview mode — fade the editor to black, swap to a dossier-style card that
 * renders the current graph's shader on its face, and fade back.
 *
 * Implementation notes
 * --------------------
 * - We create one WebGL context on the preview canvas the first time preview
 *   is opened, and cache it. Each enter recompiles the current graph (so
 *   changes made in the editor show up) and resumes the render loop.
 * - On exit the render loop is cancelled, but the GL context is kept alive
 *   so re-entering doesn't pay the context-creation cost again.
 * - Tilt/sheen/rim/shade math is ported from index.html's card — simplified
 *   (no flip, no lift) since the preview is one-directional.
 */

const PREVIEW = (() => {
  const FADE_MS = 520;  // must match `transition: opacity .5s` in preview.css

  // --- DOM refs ---
  const fadeLayer     = $('#fadeLayer');
  const previewRoot   = $('#previewRoot');
  const previewBtn    = $('#previewShaderBtn');
  const backBtn       = $('#previewBackBtn');
  const faceCanvas    = $('#previewFaceShader');
  const rimGradient   = $('#previewRimLight');
  const stage         = $('#previewStage');

  // --- tilt / lighting state ---
  const MAX_TILT  = 28;
  const MAX_SHIFT = 22;
  const BEVEL = 38 * Math.PI / 180;
  const cb = Math.cos(BEVEL), sb = Math.sin(BEVEL);
  const EDGES = {
    top:    [ 0, -cb,  sb],
    bottom: [ 0,  cb,  sb],
    left:   [-cb, 0,   sb],
    right:  [ cb, 0,   sb],
  };

  let targetRx = 0, targetRy = 0;
  let curRx    = 0, curRy    = 0;
  let mouseNX  = 0, mouseNY  = 0;  // normalized relative to stage (-1..1)
  let curMX    = 0, curMY    = 0;  // smoothed
  let shaderMX = 0.5, shaderMY = 0.5;  // normalized relative to card face (for u_mouse)
  let hovering = false;

  // --- WebGL state ---
  let gl = null;
  let program = null;
  let posBuf, uvBuf, idxBuf, indexCount = 0;
  let uTime, uMouse, uRes, uSimLight, uShadows, uReflections, uPreviewMode, uCardTilt, uNoise;
  let startTime = 0;
  let rafId = null;
  let tickRafId = null;
  let active = false;
  // Preview has its own GL context, so it needs its own pre-baked noise
  // atlas and its own cache-pass FBOs (textures aren't shareable across
  // contexts). Same NOISE_UNIT / PASS_SLOT_BASE convention as renderer.js
  // for code parity. See plan A (textured snoise) and plan B (FBO pass cache).
  let noiseBake = null;
  let passes = [];
  const PREVIEW_NOISE_UNIT     = 15;
  const PREVIEW_PASS_SLOT_BASE = 16;
  let texRegistry = null;        // lazy-created on first ensureGL()
  let textureBindings = [];      // { nodeId, uniformName, slot, location }
  let bloom = null;              // lazy-created bloom pipeline (shared across re-entries)

  // Cached backbuffer dimensions — updated only by the ResizeObserver, never
  // inside the render loop. Reading `getBoundingClientRect()` on a canvas
  // that lives under an actively-tilting 3D subtree produced a different
  // sub-pixel size every frame, so the old per-frame `canvas.width = ...`
  // guard kept reallocating the WebGL backbuffer (costly driver work +
  // compositor slow-path). The observer only fires on genuine CSS layout
  // changes, so the backbuffer is allocated exactly once per real resize.
  let sizeObserver = null;
  let cachedBufW = 0, cachedBufH = 0;

  // Caches for the last value we actually wrote to each CSS custom property
  // and SVG attribute. `toFixed(3)` quantizes the value so once the exponential
  // smoothing converges below 0.0005 the strings match and we stop issuing
  // style mutations entirely — that collapses the hundreds of per-layer
  // paints the trace showed (glow / sheen / rim / sss / shade) down to nearly
  // zero once the card settles.
  const lastVar  = new Map();
  const lastAttr = new Map();
  function setVar(name, value){
    if (lastVar.get(name) === value) return;
    lastVar.set(name, value);
    previewRoot.style.setProperty(name, value);
  }
  function setAttr(el, name, value){
    // key includes element identity so two gradients with the same attr don't collide
    const key = el === rimGradient ? '__rim__' + name : name;
    if (lastAttr.get(key) === value) return;
    lastAttr.set(key, value);
    el.setAttribute(name, value);
  }
  function resetLastVarCache(){
    lastVar.clear();
    lastAttr.clear();
  }

  // Same VS as renderer.js — pass-through positions, with a noise-derived
  // v_surfaceNormal varying available to the World Normal node.
  const VS_SRC = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    varying vec3 v_surfaceNormal;

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
      float e = 0.04;
      float hC = _vsHeight(a_position);
      float hR = _vsHeight(a_position + vec2(e, 0.0));
      float hU = _vsHeight(a_position + vec2(0.0, e));
      v_surfaceNormal = normalize(vec3((hC - hR) / e, (hC - hU) / e, 1.0));
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  function compileShader(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      console.error('[preview] shader compile error:\n' + gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  /* Lazy-init WebGL on the preview canvas. Runs once; subsequent enters
     just recompile the program against the updated graph source. */
  function ensureGL(){
    if (gl) return true;
    // alpha:false — output shader writes specular into gl_FragColor.a, which
    // we don't want leaking into the page composite. Matches renderer.js.
    gl = faceCanvas.getContext('webgl',              { antialias: true, preserveDrawingBuffer: false, alpha: false })
      || faceCanvas.getContext('experimental-webgl', { antialias: true, preserveDrawingBuffer: false, alpha: false });
    if (!gl){
      toast('WebGL unavailable for preview', 'err');
      return false;
    }
    // Enable dFdx/dFdy support (see renderer.js for details).
    gl.getExtension('OES_standard_derivatives');
    // Grid mesh — same as renderer.js so v_surfaceNormal is populated in
    // preview too. 64×64 subdivisions.
    const GRID = 64;
    const nVerts = (GRID + 1) * (GRID + 1);
    const positions = new Float32Array(nVerts * 2);
    const uvs       = new Float32Array(nVerts * 2);
    {
      let p = 0;
      for (let y = 0; y <= GRID; y++){
        for (let x = 0; x <= GRID; x++){
          const u = x / GRID, v = y / GRID;
          positions[p] = u*2-1; positions[p+1] = v*2-1;
          uvs[p] = u;           uvs[p+1] = v;
          p += 2;
        }
      }
    }
    const indices = new Uint16Array(GRID * GRID * 6);
    {
      let i = 0;
      for (let y = 0; y < GRID; y++){
        for (let x = 0; x < GRID; x++){
          const a = y * (GRID + 1) + x;
          const b = a + 1;
          const c = a + (GRID + 1);
          const d = c + 1;
          indices[i++] = a; indices[i++] = b; indices[i++] = c;
          indices[i++] = b; indices[i++] = d; indices[i++] = c;
        }
      }
    }
    posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    indexCount = indices.length;

    // Preview has its own GL context, so it needs its own texture registry
    // (GL objects aren't shareable across contexts). Sources are shared
    // through the global imageCache so you don't re-download on re-entry.
    texRegistry = createTextureRegistry(gl);
    // Dedicated bloom pipeline for this context too — same reason.
    bloom = createBloomPipeline(gl);
    // Bake the noise atlas for this context (plan A). Without this, every
    // shader that uses the textured snoise() helper renders garbage in
    // preview because u_noise reads from an unbound texture unit.
    if (typeof buildNoiseTexture === 'function'){
      noiseBake = buildNoiseTexture(gl, 512, 8);
    }
    return true;
  }

  // ---- Plan B: pass FBO helpers (preview-context copies) ----
  function createPassFBO(w, h){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE){
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error('preview pass FBO incomplete: 0x' + status.toString(16));
    }
    return { tex, fbo, w, h };
  }
  function disposePass(p){
    if (!p) return;
    if (p.program) gl.deleteProgram(p.program);
    if (p.fbo)     gl.deleteFramebuffer(p.fbo);
    if (p.tex)     gl.deleteTexture(p.tex);
  }
  function resizePreviewPassFBOs(w, h){
    for (const p of passes){
      if (p.fbW === w && p.fbH === h) continue;
      gl.deleteFramebuffer(p.fbo);
      gl.deleteTexture(p.tex);
      const fb = createPassFBO(w, h);
      p.fbo = fb.fbo; p.tex = fb.tex; p.fbW = w; p.fbH = h;
    }
  }

  function buildProgram(fsSource, bindings, passSpecs){
    const vs = compileShader(gl.VERTEX_SHADER, VS_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      console.error('[preview] link error:', gl.getProgramInfoLog(prog));
      return false;
    }
    if (program) gl.deleteProgram(program);
    program = prog;
    gl.useProgram(program);

    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const aUv = gl.getAttribLocation(program, 'a_uv');
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

    uTime        = gl.getUniformLocation(program, 'u_time');
    uMouse       = gl.getUniformLocation(program, 'u_mouse');
    uRes         = gl.getUniformLocation(program, 'u_resolution');
    uSimLight    = gl.getUniformLocation(program, 'u_simLight');
    uShadows     = gl.getUniformLocation(program, 'u_shadows');
    uReflections = gl.getUniformLocation(program, 'u_reflections');
    uPreviewMode = gl.getUniformLocation(program, 'u_previewMode');
    uCardTilt    = gl.getUniformLocation(program, 'u_cardTilt');
    uNoise       = gl.getUniformLocation(program, 'u_noise');
    if (uNoise != null) gl.uniform1i(uNoise, PREVIEW_NOISE_UNIT);

    // Same texture binding strategy as renderer.js — one uniform1i per slot
    // at link time, then just rebind the underlying texture in `frame()`.
    textureBindings = (bindings || []).map((b, i) => ({
      ...b,
      slot: i,
      location: gl.getUniformLocation(program, b.uniformName),
    }));
    for (const b of textureBindings){
      if (b.location != null) gl.uniform1i(b.location, b.slot);
    }

    // ---- compile each cache-pass shader for the preview context ----
    // Tear down old passes first.
    for (const p of passes) disposePass(p);
    passes = [];
    for (const ps of (passSpecs || [])){
      const pVs   = compileShader(gl.VERTEX_SHADER, VS_SRC);
      const pFs   = compileShader(gl.FRAGMENT_SHADER, ps.fs);
      if (!pVs || !pFs){ console.error('[preview] pass shader compile failed (idx=' + ps.index + ')'); continue; }
      const pProg = gl.createProgram();
      gl.attachShader(pProg, pVs);
      gl.attachShader(pProg, pFs);
      gl.linkProgram(pProg);
      if (!gl.getProgramParameter(pProg, gl.LINK_STATUS)){
        console.error('[preview] pass link error (idx=' + ps.index + '):', gl.getProgramInfoLog(pProg));
        continue;
      }
      gl.useProgram(pProg);
      const pUTime        = gl.getUniformLocation(pProg, 'u_time');
      const pUMouse       = gl.getUniformLocation(pProg, 'u_mouse');
      const pURes         = gl.getUniformLocation(pProg, 'u_resolution');
      const pUSimLight    = gl.getUniformLocation(pProg, 'u_simLight');
      const pUShadows     = gl.getUniformLocation(pProg, 'u_shadows');
      const pUReflections = gl.getUniformLocation(pProg, 'u_reflections');
      const pUPreviewMode = gl.getUniformLocation(pProg, 'u_previewMode');
      const pUCardTilt    = gl.getUniformLocation(pProg, 'u_cardTilt');
      const pUNoise       = gl.getUniformLocation(pProg, 'u_noise');
      if (pUNoise != null) gl.uniform1i(pUNoise, PREVIEW_NOISE_UNIT);

      const passImageBindings = (ps.textureBindings || []).map((b, j) => ({
        ...b, slot: j, location: gl.getUniformLocation(pProg, b.uniformName),
      }));
      for (const b of passImageBindings){
        if (b.location != null) gl.uniform1i(b.location, b.slot);
      }
      const upstreamSlots = (ps.upstreamPassIndices || []).map(upIdx => ({
        srcPassIdx: upIdx,
        slot: PREVIEW_PASS_SLOT_BASE + upIdx,
        location: gl.getUniformLocation(pProg, 'u_pass_' + upIdx),
      }));
      for (const u of upstreamSlots){
        if (u.location != null) gl.uniform1i(u.location, u.slot);
      }
      const fb = createPassFBO(faceCanvas.width, faceCanvas.height);
      passes.push({
        index: ps.index,
        program: pProg,
        fbo: fb.fbo, tex: fb.tex, fbW: fb.w, fbH: fb.h,
        uTime: pUTime, uMouse: pUMouse, uRes: pURes,
        uSimLight: pUSimLight, uShadows: pUShadows, uReflections: pUReflections,
        uPreviewMode: pUPreviewMode, uCardTilt: pUCardTilt,
        uNoise: pUNoise,
        imageBindings: passImageBindings,
        upstreamSlots,
      });
    }

    // Resolve MAIN program's pass-input sampler locations.
    gl.useProgram(program);
    for (const p of passes){
      const slot = PREVIEW_PASS_SLOT_BASE + p.index;
      const loc  = gl.getUniformLocation(program, 'u_pass_' + p.index);
      p.uMainSamplerLoc = loc;
      if (loc != null) gl.uniform1i(loc, slot);
    }
    return true;
  }

  /* Reads `.face`'s CSS layout box (not the transformed bounding box) and
     reallocates the WebGL backbuffer only if the integer pixel size actually
     changed. Safe to call multiple times per resize event — no-op when the
     cached size already matches. */
  function resizeCanvasFromLayout(){
    if (!gl) return;
    const face = faceCanvas.parentElement;
    if (!face) return;
    // clientWidth/Height return the CSS layout box and ignore transforms,
    // so a tilting card no longer produces ever-changing values here.
    const cssW = face.clientWidth;
    const cssH = face.clientHeight;
    // When preview is closed the container is display:none and clientWidth
    // reports 0 — don't churn the backbuffer in that case.
    if (cssW === 0 || cssH === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    if (w === cachedBufW && h === cachedBufH) return;
    cachedBufW = w;
    cachedBufH = h;
    faceCanvas.width  = w;
    faceCanvas.height = h;
    gl.viewport(0, 0, w, h);
    // Pass FBOs must follow the canvas size or v_uv-based sampling drifts.
    resizePreviewPassFBOs(w, h);
  }

  /* Installs the ResizeObserver on `.face` once. Observer fires only on
     genuine CSS box changes (window resize, stage going from hidden to
     visible on preview-enter, DPR-change via monitor hop, etc.). */
  function ensureSizeObserver(){
    if (sizeObserver) return;
    const face = faceCanvas.parentElement;
    if (!face || typeof ResizeObserver === 'undefined'){
      return;  // one-shot sizing on enter will cover the no-observer case
    }
    sizeObserver = new ResizeObserver(() => resizeCanvasFromLayout());
    sizeObserver.observe(face);
  }

  function frame(){
    if (!active) return;
    if (gl && program){
      // Same bloom branch as the editor renderer — read Output node's
      // bloom params each frame and route through either the multi-pass
      // pipeline or direct-to-canvas.
      const outNode = state.nodes.find(n => n.type === 'output');
      const bloomOn = outNode && outNode.params && outNode.params.bloom === 'on';
      const bp = (outNode && outNode.params) || {};

      // Hoisted dynamic uniforms — same values for all passes + main draw.
      const tNow = (performance.now() - startTime) / 1000;
      const simOn = document.body.classList.contains('sim-lighting-on');
      const aspect = faceCanvas.width / faceCanvas.height;
      const slx = simOn ? (shaderMX - 0.5) * aspect : 0.0;
      // Y inverted — matches the editor's u_simLight convention so the
      // lit highlight reads consistently across both modes.
      const sly = simOn ? -(shaderMY - 0.5)         : 0.0;
      const slz = simOn ? 0.45                       : 100.0;

      // ---- render every cache pass into its FBO before the main draw ----
      for (const p of passes){
        gl.bindFramebuffer(gl.FRAMEBUFFER, p.fbo);
        gl.viewport(0, 0, p.fbW, p.fbH);
        gl.useProgram(p.program);
        if (p.uTime)     gl.uniform1f(p.uTime, tNow);
        if (p.uMouse)    gl.uniform2f(p.uMouse, shaderMX, shaderMY);
        if (p.uRes)      gl.uniform2f(p.uRes, p.fbW, p.fbH);
        if (p.uSimLight) gl.uniform3f(p.uSimLight, slx, sly, slz);
        if (p.uShadows)     gl.uniform1f(p.uShadows, 1.0); // shadows always on in preview
        // Reflections follow the body class (driven by either the editor's
        // Reflections fab or the preview's own Reflections fab).
        if (p.uReflections) gl.uniform1f(p.uReflections, document.body.classList.contains('reflections-on') ? 1.0 : 0.0);
        // Preview-specific: signal preview mode so the Environment node
        // flips matcap V (preview convention) and feed the live card tilt
        // (in radians) so metallic reflections parallax with rotation.
        if (p.uPreviewMode) gl.uniform1f(p.uPreviewMode, 1.0);
        if (p.uCardTilt)    gl.uniform2f(p.uCardTilt, curRx * Math.PI / 180, curRy * Math.PI / 180);
        if (p.uNoise != null && noiseBake){
          gl.activeTexture(gl.TEXTURE0 + PREVIEW_NOISE_UNIT);
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, faceCanvas.width, faceCanvas.height);

      const drawScene = () => {
        gl.useProgram(program);
        gl.uniform1f(uTime, (performance.now() - startTime) / 1000);
        gl.uniform2f(uMouse, shaderMX, shaderMY);
        gl.uniform2f(uRes, faceCanvas.width, faceCanvas.height);
        // Point-light position in centered-UV space. shaderMX is INVERTED
        // for the preview card's diametric convention (cursor on right →
        // highlight on left). See renderer.js for the full rationale.
        const simOn = document.body.classList.contains('sim-lighting-on');
        if (simOn){
          const aspect = faceCanvas.width / faceCanvas.height;
          const lx = (shaderMX - 0.5) * aspect;
          // Y inverted — see the per-pass slx/sly block above for the same
          // convention so the main draw matches.
          const ly = -(shaderMY - 0.5);
          const lz = 0.45;
          if (uSimLight) gl.uniform3f(uSimLight, lx, ly, lz);
        } else {
          if (uSimLight) gl.uniform3f(uSimLight, 0.0, 0.0, 100.0);
        }
        // Shadows are ALWAYS enabled in preview mode — the editor toggle
        // (sim-lighting-on / shadows-on) doesn't apply here. The user said
        // they want shadows always-on whenever the preview card is shown.
        if (uShadows) gl.uniform1f(uShadows, 1.0);
        // Reflections — driven by `body.reflections-on` (toggled by either
        // the editor's #reflectionsBtn or the preview's #previewReflectionsBtn).
        if (uReflections) gl.uniform1f(uReflections, document.body.classList.contains('reflections-on') ? 1.0 : 0.0);
        // Preview signal + live card tilt for matcap parallax. These read as
        // 0 / vec2(0) in editor mode (renderer.js writes those), so the same
        // Environment node compiles correctly for both contexts.
        if (uPreviewMode) gl.uniform1f(uPreviewMode, 1.0);
        if (uCardTilt)    gl.uniform2f(uCardTilt, curRx * Math.PI / 180, curRy * Math.PI / 180);
        // Bind the noise atlas (plan A) and each cache-pass FBO (plan B).
        // Without these, every snoise() call and every pass-sampler reads
        // garbage in the preview context, which is what made Fuzzy Blob
        // render completely differently from the editor background.
        if (uNoise != null && noiseBake){
          gl.activeTexture(gl.TEXTURE0 + PREVIEW_NOISE_UNIT);
          gl.bindTexture(gl.TEXTURE_2D, noiseBake.texture);
        }
        for (const b of textureBindings){
          gl.activeTexture(gl.TEXTURE0 + b.slot);
          gl.bindTexture(gl.TEXTURE_2D, texRegistry.getTexture(b.nodeId));
        }
        for (const p of passes){
          gl.activeTexture(gl.TEXTURE0 + (PREVIEW_PASS_SLOT_BASE + p.index));
          gl.bindTexture(gl.TEXTURE_2D, p.tex);
        }
        // re-bind the program's attribs + index buffer — bloom passes use
        // their own quad buffers
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

      if (bloomOn && bloom){
        bloom.renderToScene(faceCanvas.width, faceCanvas.height, drawScene);
        bloom.applyBloomToScreen({
          threshold: bp.bloomThreshold,
          radius:    bp.bloomRadius,
          intensity: bp.bloomIntensity,
        });
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, faceCanvas.width, faceCanvas.height);
        drawScene();
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  /* ---- tilt / lighting math (ported from index.html) ---- */
  function rotateVec(v, rx, ry){
    let [x, y, z] = v;
    const cY = Math.cos(ry), sY = Math.sin(ry);
    const x1 =  cY * x + sY * z;
    const y1 =  y;
    const z1 = -sY * x + cY * z;
    const cX = Math.cos(rx), sX = Math.sin(rx);
    return [x1, cX * y1 - sX * z1, sX * y1 + cX * z1];
  }
  function dot3(a, b){ return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

  function onPointerMove(e){
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top  + r.height / 2;
    const padX = r.width * 0.6;
    const padY = r.height * 0.6;
    const nx = Math.max(-1, Math.min(1, (e.clientX - cx) / (r.width  / 2 + padX)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - cy) / (r.height / 2 + padY)));
    // Restored to the dossier original: X leans AWAY, Y leans TOWARD the
    // cursor. The card's natural-feeling "toward cursor on Y" tilt is what
    // gives the avatar and text their expected parallax pop-out. The Y
    // lighting asymmetry is fixed below by flipping the Y face-shade
    // formulas (see applyLighting), not by inverting the tilt.
    targetRy = -nx * MAX_TILT;
    targetRx =  ny * MAX_TILT;
    mouseNX  = nx;
    mouseNY  = ny;
    hovering = true;

    // shader u_mouse — inverted-x so the shader hotspot lands diametrically
    // opposite the cursor (matching the sheen's convention).
    const card = faceCanvas.getBoundingClientRect();
    // Diametric mapping on BOTH axes: u_mouse lands on the opposite side of
    // the card face from the cursor, so the shader's mouse-driven glow reads
    // as a "virtual light source" reflected across the surface (cursor at
    // top → glow at bottom, cursor at left → glow at right). This matches
    // the dossier card's sheen/rim convention and the original index.html.
    //
    // WebGL subtlety: v_uv.y = 0 sits at the BOTTOM of the rendered canvas
    // (GL's lower-left origin), so feeding clientY/height straight through
    // already inverts relative to the screen — no explicit (1 - …) needed
    // on the Y axis. The X axis, by contrast, needs the (1 - …) flip because
    // v_uv.x grows left → right just like the cursor, so without the flip
    // the glow would follow the cursor on X.
    shaderMX = Math.max(0, Math.min(1, 1 - (e.clientX - card.left) / card.width));
    shaderMY = Math.max(0, Math.min(1,     (e.clientY - card.top)  / card.height));
  }
  function onPointerLeave(){
    hovering = false;
    targetRx = 0; targetRy = 0;
    mouseNX  = 0; mouseNY  = 0;
  }

  function applyLighting(){
    const rxR = curRx * Math.PI / 180;
    const ryR = curRy * Math.PI / 180;

    curMX += (mouseNX - curMX) * 0.12;
    curMY += (mouseNY - curMY) * 0.12;

    // virtual light direction — opposite cursor, with a small +Z bias so edges
    // keep a baseline shine at rest.
    const lvx = -curMX, lvy = -curMY, lvz = 0.85;
    const lvm = Math.hypot(lvx, lvy, lvz) || 1;
    const light = [lvx / lvm, lvy / lvm, lvz / lvm];

    for (const key in EDGES){
      const wn = rotateVec(EDGES[key], rxR, ryR);
      const lit = Math.max(0, dot3(wn, light));
      const shine = 0.18 + 0.82 * Math.pow(lit, 2.0);
      setVar(`--shine-${key}`, shine.toFixed(3));
    }

    // receding-side face shade — darkens whichever edge is tilted away
    const K = 0.55;
    // Y shade is intentionally inverted relative to the dossier original.
    // The dossier had both shade axes darken the RECEDING side (physical
    // depth cue). But combined with the card's "lean TOWARD cursor on Y"
    // tilt, that made the cursor side brighter → co-directional Y lighting.
    // Flipping Y's sign here darkens the SIDE TOWARD the cursor, which is
    // consistent with a "virtual light source opposite the cursor" model —
    // the near (cursor-side) surface is actually farther from that virtual
    // light, so reads darker. X keeps the original sign because its tilt
    // already leans AWAY from the cursor, and the physical convention
    // happens to produce the desired diametric result there.
    setVar('--shade-top-a',   (Math.max(0, -curRx / MAX_TILT) * K).toFixed(3));
    setVar('--shade-bot-a',   (Math.max(0,  curRx / MAX_TILT) * K).toFixed(3));
    setVar('--shade-left-a',  (Math.max(0,  curRy / MAX_TILT) * K).toFixed(3));
    setVar('--shade-right-a', (Math.max(0, -curRy / MAX_TILT) * K).toFixed(3));

    // sheen hotspot (diametrically opposite cursor) + rim gradient re-target
    const sxStr = (50 - curMX * 55).toFixed(2) + '%';
    const syStr = (50 - curMY * 55).toFixed(2) + '%';
    setVar('--sx', sxStr);
    setVar('--sy', syStr);
    if (rimGradient){
      setAttr(rimGradient, 'cx', sxStr);
      setAttr(rimGradient, 'cy', syStr);
    }

    // counter-translate — card slides slightly toward the cursor
    setVar('--tx', (curMX * MAX_SHIFT).toFixed(2) + 'px');
    setVar('--ty', (curMY * MAX_SHIFT).toFixed(2) + 'px');
  }

  function tick(){
    if (!active) return;
    const k = 0.12;
    curRx += (targetRx - curRx) * k;
    curRy += (targetRy - curRy) * k;
    setVar('--rx', curRx.toFixed(3) + 'deg');
    setVar('--ry', curRy.toFixed(3) + 'deg');
    applyLighting();
    tickRafId = requestAnimationFrame(tick);
  }

  /* ---- enter / exit ---- */
  function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

  async function enterPreview(){
    if (active) return;
    // 1) fade layer opaque — covers the entire UI during the swap
    fadeLayer.classList.add('visible');
    await wait(FADE_MS);

    // 2) hide editor, show preview, compile the current shader
    document.body.classList.add('preview-mode');
    previewRoot.classList.add('active');
    // each enter starts with card content visible — also resync the toggle
    // label in case the user left it on "Show" last time.
    previewRoot.classList.remove('content-hidden');
    const hideLabel = document.querySelector('#previewHideContentBtn .preview-hide-label');
    if (hideLabel) hideLabel.textContent = 'Hide';
    syncReflectionsBtn();

    if (ensureGL()){
      const res = compileGraph();
      if (res.ok){
        buildProgram(res.fs, res.textureBindings, res.passes);
      } else {
        toast('shader compile error: ' + res.error, 'err');
      }
    }

    startTime = performance.now();
    active = true;

    // reset input state so the card starts flat
    targetRx = targetRy = curRx = curRy = 0;
    mouseNX  = mouseNY  = curMX = curMY = 0;
    shaderMX = shaderMY = 0.5;
    // clear the setVar/setAttr cache so the first tick after enter writes
    // the initial values instead of being suppressed as "unchanged".
    resetLastVarCache();

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('mouseleave', onPointerLeave);

    // give the DOM a frame to lay out, then wire up the size observer and
    // do one synchronous size read so the first drawArrays targets a
    // correctly-sized backbuffer.
    await wait(20);
    ensureSizeObserver();
    resizeCanvasFromLayout();
    requestAnimationFrame(frame);
    requestAnimationFrame(tick);

    // 3) fade back in
    fadeLayer.classList.remove('visible');
  }

  async function exitPreview(){
    if (!active) return;
    // If a preview-targeted recording is still running, stop it first — once
    // we exit, the rAF loop halts and the face canvas freezes, so the rest
    // of the captured stream would just be a still frame.
    const previewSaveBtn = document.getElementById('previewSaveVideoBtn');
    if (window.SAVE_VIDEO && window.SAVE_VIDEO.isRecording()
        && previewSaveBtn && previewSaveBtn.classList.contains('recording')){
      window.SAVE_VIDEO.stop();  // onStop hook also cleans the display stream
    } else {
      cleanupDisplayCapture();
    }
    fadeLayer.classList.add('visible');
    await wait(FADE_MS);

    active = false;
    if (rafId)     { cancelAnimationFrame(rafId);     rafId = null; }
    if (tickRafId) { cancelAnimationFrame(tickRafId); tickRafId = null; }

    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('mouseleave', onPointerLeave);

    previewRoot.classList.remove('active');
    document.body.classList.remove('preview-mode');

    await wait(20);
    fadeLayer.classList.remove('visible');
  }

  // Escape key exits preview
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) exitPreview();
  });

  if (previewBtn) previewBtn.addEventListener('click', enterPreview);
  if (backBtn)    backBtn.addEventListener('click',    exitPreview);

  const hideContentBtn = $('#previewHideContentBtn');
  if (hideContentBtn){
    hideContentBtn.addEventListener('click', () => {
      const hidden = previewRoot.classList.toggle('content-hidden');
      const label = hideContentBtn.querySelector('.preview-hide-label');
      if (label) label.textContent = hidden ? 'Show' : 'Hide';
    });
  }

  // Reflections — toggles the same body.reflections-on class the editor's
  // #reflectionsBtn toggles, so both buttons agree on a single source of
  // truth. Label/active state is synced on preview enter.
  const reflectionsBtn = $('#previewReflectionsBtn');
  function syncReflectionsBtn(){
    if (!reflectionsBtn) return;
    const on = document.body.classList.contains('reflections-on');
    const label = reflectionsBtn.querySelector('.preview-reflections-label');
    if (label) label.textContent = on ? 'On' : 'Reflections';
    reflectionsBtn.classList.toggle('active', on);
  }
  if (reflectionsBtn){
    reflectionsBtn.addEventListener('click', () => {
      document.body.classList.toggle('reflections-on');
      syncReflectionsBtn();
    });
  }

  // ---- Save Video — composited capture (card + glow + 3D tilt) ----
  // Recording the bare WebGL face would lose the tilt, glow, sheen, and rim
  // — the parts that make the preview look like more than a flat shader. To
  // preserve them we capture the browser tab via getDisplayMedia, crop each
  // frame to the stage area + a black-background margin, and feed that to
  // the existing recording engine through an offscreen 2D canvas.
  let displayStream    = null;
  let displayVideo     = null;
  let compositeCanvas  = null;
  let compositeCtx     = null;
  let compositeRafId   = 0;
  let captureRequestPending = false;
  // Black-background padding around the stage so the 3D card doesn't get
  // clipped at extreme tilts and the glow has room to breathe. CSS px.
  const CAPTURE_PAD = 80;

  function readCaptureRectCSS(){
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const left = Math.max(0, r.left - CAPTURE_PAD);
    const top  = Math.max(0, r.top  - CAPTURE_PAD);
    const width  = Math.min(window.innerWidth  - left, r.width  + CAPTURE_PAD * 2);
    const height = Math.min(window.innerHeight - top,  r.height + CAPTURE_PAD * 2);
    return { left, top, width, height };
  }

  function cleanupDisplayCapture(){
    if (compositeRafId){ cancelAnimationFrame(compositeRafId); compositeRafId = 0; }
    if (displayStream){
      try { for (const t of displayStream.getTracks()) t.stop(); } catch {}
      displayStream = null;
    }
    if (displayVideo){
      try { displayVideo.srcObject = null; } catch {}
      displayVideo = null;
    }
    compositeCanvas = null;
    compositeCtx    = null;
  }

  async function ensureDisplayCapture(){
    if (displayStream && displayStream.active && compositeCanvas) return true;
    if (captureRequestPending) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
      toast('Tab capture not supported in this browser', 'err');
      return false;
    }
    captureRequestPending = true;
    try {
      // `preferCurrentTab` is a Chromium-only hint that pre-selects the tab
      // in the picker; harmless on browsers that ignore it.
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching:   'exclude',
      });
    } catch (err){
      console.warn('[preview] tab capture denied/cancelled:', err);
      toast('Tab capture permission denied', 'err');
      captureRequestPending = false;
      return false;
    }
    captureRequestPending = false;

    displayVideo = document.createElement('video');
    displayVideo.muted        = true;
    displayVideo.playsInline  = true;
    displayVideo.autoplay     = true;
    displayVideo.srcObject    = displayStream;
    // Wait for the first metadata so videoWidth/Height are valid, then for
    // playback to start so drawImage() actually has pixels to read.
    await new Promise((resolve) => {
      const ready = () => {
        if (displayVideo.readyState >= 2 /* HAVE_CURRENT_DATA */) resolve();
      };
      displayVideo.addEventListener('loadeddata', resolve, { once: true });
      ready();
    });
    try { await displayVideo.play(); } catch {}

    // If the user stops sharing from the browser controls, end any in-flight
    // recording cleanly and free our state so the next click re-prompts.
    const track = displayStream.getVideoTracks()[0];
    if (track){
      track.addEventListener('ended', () => {
        if (window.SAVE_VIDEO && window.SAVE_VIDEO.isRecording()){
          window.SAVE_VIDEO.stop();
        }
        cleanupDisplayCapture();
      });
    }

    // Allocate the offscreen composite canvas at the captured pixel scale so
    // we don't lose resolution on the way through.
    const cssRect = readCaptureRectCSS();
    if (!cssRect){ cleanupDisplayCapture(); return false; }
    const sx = displayVideo.videoWidth  / window.innerWidth;
    const sy = displayVideo.videoHeight / window.innerHeight;
    const compW = Math.max(2, Math.round(cssRect.width  * sx));
    const compH = Math.max(2, Math.round(cssRect.height * sy));
    compositeCanvas = document.createElement('canvas');
    compositeCanvas.width  = compW;
    compositeCanvas.height = compH;
    compositeCtx = compositeCanvas.getContext('2d');

    // rAF copy loop. Recomputes the stage rect each frame so a window resize
    // or stage layout shift doesn't drift out of the captured region.
    const draw = () => {
      if (!displayVideo || !compositeCtx){ compositeRafId = 0; return; }
      const r = readCaptureRectCSS();
      if (r){
        const fx = displayVideo.videoWidth  / window.innerWidth;
        const fy = displayVideo.videoHeight / window.innerHeight;
        try {
          compositeCtx.drawImage(
            displayVideo,
            r.left * fx, r.top * fy, r.width * fx, r.height * fy,
            0, 0, compositeCanvas.width, compositeCanvas.height,
          );
        } catch {}
      }
      compositeRafId = requestAnimationFrame(draw);
    };
    compositeRafId = requestAnimationFrame(draw);
    return true;
  }

  const saveVideoBtn = $('#previewSaveVideoBtn');
  if (saveVideoBtn){
    const saveVideoLabel = saveVideoBtn.querySelector('.preview-save-video-label');
    saveVideoBtn.addEventListener('click', async () => {
      if (!window.SAVE_VIDEO){
        toast('recording engine not ready', 'err');
        return;
      }
      if (window.SAVE_VIDEO.isRecording()){
        window.SAVE_VIDEO.stop();
        return;
      }
      // getDisplayMedia must be invoked from a user gesture — that's the
      // current click. The await suspends, but the gesture is already
      // consumed by the time the prompt resolves, so subsequent calls
      // (open the modal) don't need it.
      const ok = await ensureDisplayCapture();
      if (!ok) return;
      window.SAVE_VIDEO.setTarget({
        getCanvas: () => compositeCanvas,
        button:    saveVideoBtn,
        labelEl:   saveVideoLabel,
        idleLabel: 'Save Video',
        // Tear down the captured stream when the user cancels the modal or
        // the recorder finishes — otherwise the tab keeps showing the
        // "sharing" indicator and the rAF copy loop keeps running.
        onCancel:  cleanupDisplayCapture,
        onStop:    cleanupDisplayCapture,
      });
      window.SAVE_VIDEO.open();
    });
  }

  return { enterPreview, exitPreview };
})();
