/* FBO-based bloom post-processing pipeline.
 *
 * Each caller (editor background renderer + preview card renderer) creates
 * its own pipeline bound to its own WebGL context via `createBloomPipeline(gl)`.
 * Usage pattern:
 *
 *     const bloom = createBloomPipeline(gl);
 *     ...
 *     if (bloomEnabled){
 *       bloom.renderToScene(canvasWidth, canvasHeight, () => {
 *         // draw the user's shader to the scene FBO
 *         gl.useProgram(userProgram);
 *         gl.uniform...(); gl.bindTexture...(); gl.drawArrays(...);
 *       });
 *       bloom.applyBloomToScreen({ threshold, radius, intensity });
 *     }
 *
 * Three-pass pipeline:
 *   1. render the user's scene to `sceneFBO`
 *   2. horizontal gaussian blur + luminance threshold → `bloomFBO`
 *   3. vertical gaussian blur of `bloomFBO` + additive composite with
 *      `sceneFBO` → default framebuffer (screen)
 *
 * Gaussian is 9-tap separable (4.9/5.0 quality; full-gaussian separable
 * is the textbook way and ends up being cheaper than a single giant 2D
 * kernel by a long way — (9+9) taps versus 81).
 */

function createBloomPipeline(gl){
  // ---- state (all owned by this pipeline instance) ----
  let sceneFBO = null, sceneTex = null;
  let bloomFBO = null, bloomTex = null;
  let fboW = 0, fboH = 0;

  let progH = null, progV = null;
  const locH = {};  // uniform locations for horizontal-blur program
  const locV = {};  // uniform locations for vertical-blur + composite

  // ---- fullscreen quad — one buffer shared by the bloom pipeline ----
  // (the user's renderer has its own quad buffers; this is separate so
  // bloom passes don't disturb state.)
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1, -1, 1,
    -1, 1,  1,-1,  1, 1,
  ]), gl.STATIC_DRAW);

  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0,0, 1,0, 0,1,
    0,1, 1,0, 1,1,
  ]), gl.STATIC_DRAW);

  const VS = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main(){
      v_uv = a_uv;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Horizontal blur + specular/luma threshold. Nine taps along X at the given
  // radius. Threshold is applied AT SAMPLE TIME so we never blur matte or dark
  // pixels — just the bright, shiny ones.
  //
  // The mask combines luminance and the specular map stored in alpha: a pixel
  // only contributes to bloom if it's both BRIGHT and SHINY. A matte white
  // wall (high lum, low spec) stays unlit; a dark mirror (low lum, high spec)
  // also stays unlit; a bright specular highlight (high both) glows. The
  // Output node writes specular into .a — when unconnected it defaults to
  // 1.0, which recovers the original "bloom whatever is bright" behavior.
  const FS_H = `
    precision mediump float;
    uniform sampler2D u_src;
    uniform vec2  u_texelSize;
    uniform float u_threshold;
    uniform float u_radius;
    varying vec2 v_uv;

    void main(){
      vec3 color = vec3(0.0);
      float tw = 0.0;
      for (int i = -4; i <= 4; i++){
        float w = exp(-0.3 * float(i*i));
        vec2 uv = v_uv + vec2(float(i), 0.0) * u_texelSize * u_radius;
        vec4 s    = texture2D(u_src, uv);
        float lum = dot(s.rgb, vec3(0.299, 0.587, 0.114));
        float spec = s.a;
        float mask = smoothstep(u_threshold, u_threshold + 0.1, lum * spec);
        color += s.rgb * mask * w;
        tw    += w;
      }
      gl_FragColor = vec4(color / tw, 1.0);
    }
  `;

  // Vertical blur + additive composite onto the original scene.
  const FS_V = `
    precision mediump float;
    uniform sampler2D u_bloom;
    uniform sampler2D u_scene;
    uniform vec2  u_texelSize;
    uniform float u_radius;
    uniform float u_intensity;
    varying vec2 v_uv;

    void main(){
      vec3 bloom = vec3(0.0);
      float tw = 0.0;
      for (int i = -4; i <= 4; i++){
        float w = exp(-0.3 * float(i*i));
        vec2 uv = v_uv + vec2(0.0, float(i)) * u_texelSize * u_radius;
        bloom += texture2D(u_bloom, uv).rgb * w;
        tw    += w;
      }
      bloom /= tw;
      vec3 scene = texture2D(u_scene, v_uv).rgb;
      gl_FragColor = vec4(scene + bloom * u_intensity, 1.0);
    }
  `;

  function compileShader(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      console.error('[bloom]', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function linkProgram(fsSrc, locs){
    const vs = compileShader(gl.VERTEX_SHADER, VS);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
      console.error('[bloom] link error:', gl.getProgramInfoLog(p));
      return null;
    }
    // cache uniform locations per-program
    locs.aPos       = gl.getAttribLocation(p, 'a_position');
    locs.aUv        = gl.getAttribLocation(p, 'a_uv');
    locs.uTexelSize = gl.getUniformLocation(p, 'u_texelSize');
    locs.uRadius    = gl.getUniformLocation(p, 'u_radius');
    locs.uSrc       = gl.getUniformLocation(p, 'u_src');
    locs.uThreshold = gl.getUniformLocation(p, 'u_threshold');
    locs.uBloom     = gl.getUniformLocation(p, 'u_bloom');
    locs.uScene     = gl.getUniformLocation(p, 'u_scene');
    locs.uIntensity = gl.getUniformLocation(p, 'u_intensity');
    return p;
  }

  progH = linkProgram(FS_H, locH);
  progV = linkProgram(FS_V, locV);

  function ensureFBOs(w, h){
    if (w === fboW && h === fboH && sceneFBO) return;

    // Dispose previous to avoid GPU leaks on resize
    if (sceneTex) gl.deleteTexture(sceneTex);
    if (sceneFBO) gl.deleteFramebuffer(sceneFBO);
    if (bloomTex) gl.deleteTexture(bloomTex);
    if (bloomFBO) gl.deleteFramebuffer(bloomFBO);

    const mkTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const mkFBO = (tex) => {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return f;
    };

    sceneTex = mkTex();
    sceneFBO = mkFBO(sceneTex);
    bloomTex = mkTex();
    bloomFBO = mkFBO(bloomTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fboW = w;
    fboH = h;
  }

  // Runs the caller's draw callback with the scene FBO bound as the render
  // target. After it returns, sceneTex contains the rendered scene.
  function renderToScene(w, h, drawSceneFn){
    ensureFBOs(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFBO);
    gl.viewport(0, 0, w, h);
    drawSceneFn();
  }

  function drawQuad(locs){
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(locs.aPos);
    gl.vertexAttribPointer(locs.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.enableVertexAttribArray(locs.aUv);
    gl.vertexAttribPointer(locs.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Runs passes 2 + 3 of the bloom chain. Must be called after `renderToScene`.
  // `outputFBO` defaults to null = draw to the default framebuffer (screen).
  function applyBloomToScreen(params, outputFBO){
    if (!progH || !progV) return;
    const tx = 1.0 / Math.max(fboW, 1);
    const ty = 1.0 / Math.max(fboH, 1);

    // ---- Pass 2: H-blur + threshold, sceneTex → bloomFBO ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFBO);
    gl.viewport(0, 0, fboW, fboH);
    gl.useProgram(progH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(locH.uSrc, 0);
    gl.uniform2f(locH.uTexelSize, tx, ty);
    gl.uniform1f(locH.uRadius,    params.radius    ?? 2.0);
    gl.uniform1f(locH.uThreshold, params.threshold ?? 0.6);
    drawQuad(locH);

    // ---- Pass 3: V-blur + additive composite, bloomTex+sceneTex → screen ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO ?? null);
    gl.viewport(0, 0, fboW, fboH);
    gl.useProgram(progV);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bloomTex);
    gl.uniform1i(locV.uBloom, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(locV.uScene, 1);
    gl.uniform2f(locV.uTexelSize, tx, ty);
    gl.uniform1f(locV.uRadius,    params.radius    ?? 2.0);
    gl.uniform1f(locV.uIntensity, params.intensity ?? 1.0);
    drawQuad(locV);
  }

  function dispose(){
    if (sceneTex) gl.deleteTexture(sceneTex);
    if (sceneFBO) gl.deleteFramebuffer(sceneFBO);
    if (bloomTex) gl.deleteTexture(bloomTex);
    if (bloomFBO) gl.deleteFramebuffer(bloomFBO);
    if (progH) gl.deleteProgram(progH);
    if (progV) gl.deleteProgram(progV);
    gl.deleteBuffer(posBuf);
    gl.deleteBuffer(uvBuf);
  }

  return { renderToScene, applyBloomToScreen, dispose };
}
