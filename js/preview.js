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
  let posBuf, uvBuf;
  let uTime, uMouse, uRes;
  let startTime = 0;
  let rafId = null;
  let tickRafId = null;
  let active = false;
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

  const VS_SRC = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main(){
      v_uv = a_uv;
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
    gl = faceCanvas.getContext('webgl',              { antialias: true, preserveDrawingBuffer: false })
      || faceCanvas.getContext('experimental-webgl', { antialias: true, preserveDrawingBuffer: false });
    if (!gl){
      toast('WebGL unavailable for preview', 'err');
      return false;
    }
    posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1, -1, 1,
      -1, 1,  1,-1,  1, 1,
    ]), gl.STATIC_DRAW);

    uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0,0, 1,0, 0,1,
      0,1, 1,0, 1,1,
    ]), gl.STATIC_DRAW);

    // Preview has its own GL context, so it needs its own texture registry
    // (GL objects aren't shareable across contexts). Sources are shared
    // through the global imageCache so you don't re-download on re-entry.
    texRegistry = createTextureRegistry(gl);
    // Dedicated bloom pipeline for this context too — same reason.
    bloom = createBloomPipeline(gl);
    return true;
  }

  function buildProgram(fsSource, bindings){
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

    uTime  = gl.getUniformLocation(program, 'u_time');
    uMouse = gl.getUniformLocation(program, 'u_mouse');
    uRes   = gl.getUniformLocation(program, 'u_resolution');

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

      const drawScene = () => {
        gl.useProgram(program);
        gl.uniform1f(uTime, (performance.now() - startTime) / 1000);
        gl.uniform2f(uMouse, shaderMX, shaderMY);
        gl.uniform2f(uRes, faceCanvas.width, faceCanvas.height);
        for (const b of textureBindings){
          gl.activeTexture(gl.TEXTURE0 + b.slot);
          gl.bindTexture(gl.TEXTURE_2D, texRegistry.getTexture(b.nodeId));
        }
        // re-bind the program's attribs — bloom passes use their own quad
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        const aPos = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
        const aUv = gl.getAttribLocation(program, 'a_uv');
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
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

    if (ensureGL()){
      const res = compileGraph();
      if (res.ok){
        buildProgram(res.fs, res.textureBindings);
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

  return { enterPreview, exitPreview };
})();
