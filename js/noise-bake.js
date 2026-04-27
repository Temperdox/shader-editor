/* Noise texture bake — strict-equivalent JS port of the GLSL `snoise` helper
   (Quilez-style 3D simplex), used to pre-fill a 2D texture at renderer init.
   The textured `snoise()` GLSL helper samples this texture instead of running
   ~30 ALU ops per call → ~5–10× speedup on noise-heavy graphs.

   The texture covers `tileSize` units of input space across [0, 1] in UV;
   the shader-side helper does `texture2D(u_noise, p.xy / tileSize)` and
   handles the z dimension with a two-sample lerp at offset positions. */

(() => {
  // ---- _mod289 / _permute / _taylorInvSqrt ----
  const _mod289 = (x) => x - Math.floor(x * (1 / 289)) * 289;
  const _permute = (x) => _mod289(((x * 34) + 1) * x);
  const _taylorInvSqrt = (r) => 1.79284291400159 - 0.85373472095314 * r;

  // Ported one-to-one from the GLSL helper. All vector swizzles are unrolled
  // into scalar locals; arithmetic order preserved so float-precision drift
  // matches the analytic version as closely as possible.
  function snoiseJS(vx, vy, vz){
    const C0 = 1 / 6, C1 = 1 / 3;
    // i = floor(v + dot(v, C.yyy))
    const dotVC = (vx + vy + vz) * C1;
    let ix = Math.floor(vx + dotVC);
    let iy = Math.floor(vy + dotVC);
    let iz = Math.floor(vz + dotVC);
    // x0 = v - i + dot(i, C.xxx)
    const dotIC = (ix + iy + iz) * C0;
    const x0x = vx - ix + dotIC;
    const x0y = vy - iy + dotIC;
    const x0z = vz - iz + dotIC;
    // step(edge, x) → 1 if x >= edge else 0
    const gx = x0x >= x0y ? 1 : 0;
    const gy = x0y >= x0z ? 1 : 0;
    const gz = x0z >= x0x ? 1 : 0;
    const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
    // i1 = min(g.xyz, l.zxy); i2 = max(g.xyz, l.zxy)
    const i1x = Math.min(gx, lz);
    const i1y = Math.min(gy, lx);
    const i1z = Math.min(gz, ly);
    const i2x = Math.max(gx, lz);
    const i2y = Math.max(gy, lx);
    const i2z = Math.max(gz, ly);
    // x1 = x0 - i1 + C.xxx; x2 = x0 - i2 + C.yyy; x3 = x0 - 0.5
    const x1x = x0x - i1x + C0;
    const x1y = x0y - i1y + C0;
    const x1z = x0z - i1z + C0;
    const x2x = x0x - i2x + C1;
    const x2y = x0y - i2y + C1;
    const x2z = x0z - i2z + C1;
    const x3x = x0x - 0.5;
    const x3y = x0y - 0.5;
    const x3z = x0z - 0.5;
    // i = mod289(i)
    ix = _mod289(ix);
    iy = _mod289(iy);
    iz = _mod289(iz);
    // p = permute(permute(permute(
    //     i.z + (0, i1.z, i2.z, 1)) + i.y + (0, i1.y, i2.y, 1)) + i.x + (0, i1.x, i2.x, 1))
    const pz0 = _permute(iz + 0);
    const pz1 = _permute(iz + i1z);
    const pz2 = _permute(iz + i2z);
    const pz3 = _permute(iz + 1);
    const py0 = _permute(pz0 + iy + 0);
    const py1 = _permute(pz1 + iy + i1y);
    const py2 = _permute(pz2 + iy + i2y);
    const py3 = _permute(pz3 + iy + 1);
    const p0  = _permute(py0 + ix + 0);
    const p1  = _permute(py1 + ix + i1x);
    const p2  = _permute(py2 + ix + i2x);
    const p3  = _permute(py3 + ix + 1);
    // ns = (1/7)*D.wyz - D.xzx = (2/7, 0.5/7 - 1, 1/7)
    const n_ = 1 / 7;
    const nsx = n_ * 2;       //  0.2857142857
    const nsy = n_ * 0.5 - 1; // -0.9285714286
    const nsz = n_;           //  0.1428571429
    const nszSq = nsz * nsz;
    // j = p - 49 * floor(p * ns.z * ns.z)
    const j0 = p0 - 49 * Math.floor(p0 * nszSq);
    const j1 = p1 - 49 * Math.floor(p1 * nszSq);
    const j2 = p2 - 49 * Math.floor(p2 * nszSq);
    const j3 = p3 - 49 * Math.floor(p3 * nszSq);
    // x_ = floor(j * ns.z); y_ = floor(j - 7 * x_)
    const xx0 = Math.floor(j0 * nsz);
    const xx1 = Math.floor(j1 * nsz);
    const xx2 = Math.floor(j2 * nsz);
    const xx3 = Math.floor(j3 * nsz);
    const yy0 = Math.floor(j0 - 7 * xx0);
    const yy1 = Math.floor(j1 - 7 * xx1);
    const yy2 = Math.floor(j2 - 7 * xx2);
    const yy3 = Math.floor(j3 - 7 * xx3);
    // x = x_ * ns.x + ns.yyyy; y = y_ * ns.x + ns.yyyy
    const xa = xx0 * nsx + nsy;
    const xb = xx1 * nsx + nsy;
    const xc = xx2 * nsx + nsy;
    const xd = xx3 * nsx + nsy;
    const ya = yy0 * nsx + nsy;
    const yb = yy1 * nsx + nsy;
    const yc = yy2 * nsx + nsy;
    const yd = yy3 * nsx + nsy;
    // h = 1 - |x| - |y|
    const ha = 1 - Math.abs(xa) - Math.abs(ya);
    const hb = 1 - Math.abs(xb) - Math.abs(yb);
    const hc = 1 - Math.abs(xc) - Math.abs(yc);
    const hd = 1 - Math.abs(xd) - Math.abs(yd);
    // s0 = floor(b0)*2 + 1; s1 = floor(b1)*2 + 1
    // (b0 = vec4(x.xy, y.xy); b1 = vec4(x.zw, y.zw))
    const s0a = Math.floor(xa) * 2 + 1;
    const s0b = Math.floor(xb) * 2 + 1;
    const s0c = Math.floor(ya) * 2 + 1;
    const s0d = Math.floor(yb) * 2 + 1;
    const s1a = Math.floor(xc) * 2 + 1;
    const s1b = Math.floor(xd) * 2 + 1;
    const s1c = Math.floor(yc) * 2 + 1;
    const s1d = Math.floor(yd) * 2 + 1;
    // sh = -step(h, 0) → -1 if h <= 0 else 0
    const sha = ha <= 0 ? -1 : 0;
    const shb = hb <= 0 ? -1 : 0;
    const shc = hc <= 0 ? -1 : 0;
    const shd = hd <= 0 ? -1 : 0;
    // a0 = b0.xzyw + s0.xzyw * sh.xxyy
    // a1 = b1.xzyw + s1.xzyw * sh.zzww
    let p0x = xa + s0a * sha, p0y = ya + s0c * sha, p0z = ha;
    let p1x = xb + s0b * shb, p1y = yb + s0d * shb, p1z = hb;
    let p2x = xc + s1a * shc, p2y = yc + s1c * shc, p2z = hc;
    let p3x = xd + s1b * shd, p3y = yd + s1d * shd, p3z = hd;
    // norm = taylorInvSqrt(vec4(dot(pi, pi)))
    const norm0 = _taylorInvSqrt(p0x*p0x + p0y*p0y + p0z*p0z);
    const norm1 = _taylorInvSqrt(p1x*p1x + p1y*p1y + p1z*p1z);
    const norm2 = _taylorInvSqrt(p2x*p2x + p2y*p2y + p2z*p2z);
    const norm3 = _taylorInvSqrt(p3x*p3x + p3y*p3y + p3z*p3z);
    p0x *= norm0; p0y *= norm0; p0z *= norm0;
    p1x *= norm1; p1y *= norm1; p1z *= norm1;
    p2x *= norm2; p2y *= norm2; p2z *= norm2;
    p3x *= norm3; p3y *= norm3; p3z *= norm3;
    // m = max(0.6 - dot(xi, xi), 0); m *= m; return 42 * dot(m*m, dot(pi, xi))
    let m0 = Math.max(0.6 - (x0x*x0x + x0y*x0y + x0z*x0z), 0);
    let m1 = Math.max(0.6 - (x1x*x1x + x1y*x1y + x1z*x1z), 0);
    let m2 = Math.max(0.6 - (x2x*x2x + x2y*x2y + x2z*x2z), 0);
    let m3 = Math.max(0.6 - (x3x*x3x + x3y*x3y + x3z*x3z), 0);
    m0 = m0 * m0; m1 = m1 * m1; m2 = m2 * m2; m3 = m3 * m3;
    return 42 * (
      m0 * m0 * (p0x*x0x + p0y*x0y + p0z*x0z) +
      m1 * m1 * (p1x*x1x + p1y*x1y + p1z*x1z) +
      m2 * m2 * (p2x*x2x + p2y*x2y + p2z*x2z) +
      m3 * m3 * (p3x*x3x + p3y*x3y + p3z*x3z)
    );
  }

  // Texture is `N x N` RGBA8. Each texel (i, j) stores snoise at
  // `(i/N * tileSize, j/N * tileSize, 0)`. Stored unorm in [0, 255]
  // representing analytic noise [-1, 1] via `(n + 1) * 0.5`. The shader
  // helper decodes back with `texelR * 2.0 - 1.0`.
  function buildNoiseTextureData(N, tileSize){
    const data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++){
      for (let i = 0; i < N; i++){
        const x = (i / N) * tileSize;
        const y = (j / N) * tileSize;
        const n = snoiseJS(x, y, 0);
        // clamp + encode + round-half-up
        const u8 = Math.max(0, Math.min(255, Math.floor((n * 0.5 + 0.5) * 255 + 0.5)));
        const idx = (j * N + i) * 4;
        data[idx + 0] = u8;
        data[idx + 1] = u8;
        data[idx + 2] = u8;
        data[idx + 3] = 255;
      }
    }
    return data;
  }

  // Renderer-facing entry point. Builds and uploads the noise texture, returns
  // { texture, size, tileSize } for the renderer to bind each frame.
  function buildNoiseTexture(gl, N = 512, tileSize = 8){
    const t0 = performance.now();
    const data = buildNoiseTextureData(N, tileSize);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // MIRRORED_REPEAT instead of REPEAT — the baked snoise field isn't
    // periodic at the texture edges (analytic snoise is aperiodic), so
    // plain REPEAT shows a visible seam line every `tileSize` units of
    // input space. Mirroring reflects each tile at its boundary so the
    // seam reads the same texel from both sides → no discontinuity.
    // Effective period doubles to 2*tileSize; the mirror symmetry isn't
    // visible in noise-like content.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    console.log(`[noise-bake] ${N}x${N} (tile=${tileSize}) in ${(performance.now()-t0).toFixed(1)}ms`);
    return { texture: tex, size: N, tileSize };
  }

  // Expose on window so renderer/compiler can reach it. The shader-side
  // helper hardcodes tileSize=8.0 to match — keep these in sync.
  window.NOISE_TILE_SIZE = 8;
  window.buildNoiseTexture = buildNoiseTexture;
  window.snoiseJS = snoiseJS; // exported for unit-testing if ever needed
})();
