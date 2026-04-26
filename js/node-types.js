/* ---------------- GLSL helper fragments (emitted on demand) ----------------
   The compiler only emits helpers that are actually referenced by the reachable
   node set, so unused blocks never ship to the GPU. */
const SHADER_HELPERS = {
  snoise: `
vec3 _mod289_3(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 _mod289_4(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 _permute(vec4 x){ return _mod289_4(((x*34.0)+1.0)*x); }
vec4 _taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _mod289_3(i);
  vec4 p = _permute(_permute(_permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}`,
  fbm: `
float fbm(vec3 p, float octaves){
  float value = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  int n = int(octaves);
  for (int i = 0; i < 8; i++){
    if (i >= n) break;
    value += amp * snoise(p * freq);
    freq *= 2.1;
    amp *= 0.48;
  }
  return value;
}`,
  marble: `
float marblePattern(vec2 p2, float time, float scale){
  vec3 p = vec3(p2 * scale, time * 0.15);
  float w1 = fbm(p + vec3(1.7, 9.2, 3.4) + time * 0.045, 6.0);
  float w2 = fbm(p + vec3(8.3, 2.8, 5.1) - time * 0.030, 6.0);
  vec3 warped = p + vec3(w1, w2, w1 * 0.5) * 1.5;
  float pattern = fbm(warped, 6.0);
  float veins = sin(p.x * 3.0 + p.y * 2.0 + pattern * 8.0 + time * 0.15);
  veins = abs(veins);
  veins = pow(veins, 0.3);
  return mix(pattern, veins, 0.5);
}`,
  heightField: `
/* Shared height function used by both heightMap and normalMap nodes so the
   two stay in sync — normals = finite differences of this exact surface. */
float heightField(vec2 p, float scale, float time){
  return fbm(vec3(p * scale, time * 0.12), 6.0) * 0.5 + 0.5;
}`,
  rngHash3: `
/* High-quality 3D→1D hash used by the Random node. Replaces the classic
   one-liner \`fract(sin(x) * 43758.54)\` hash, which produces visible
   diagonal banding when seeded with linearly-spaced inputs (e.g. time
   combined with scaled UV via dot products) — sin's periodicity shows up
   as slow-moving lines across the screen. This iq-style hash mixes all
   three components via fract + dot and has no visible artifacts.  */
float rngHash3(vec3 p){
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.zyx + 19.19);
  return fract((p.x + p.y) * p.z);
}`,
  voronoi2: `
/* 2D Voronoi / cellular noise. For each uv we scan the 3×3 integer-cell
   neighborhood, hash-place one point in each cell, and track the closest
   point. Returns .x = distance to nearest point (≥0, small near centers,
   ~0.7 toward cell boundaries) and .y = a random ID hashed from the
   closest cell's integer coords — perfect for coloring each cell. */
vec2 voronoi2(vec2 uv){
  vec2 iuv = floor(uv);
  vec2 fuv = fract(uv);
  float md = 1.0;
  vec2 mc = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 cell = iuv + g;
      vec2 h  = vec2(dot(cell, vec2(127.1, 311.7)), dot(cell, vec2(269.5, 183.3)));
      vec2 pt = fract(sin(h) * 43758.5453);
      float d = length(g + pt - fuv);
      if (d < md){ md = d; mc = cell; }
    }
  }
  float id = fract(sin(dot(mc, vec2(127.1, 311.7))) * 43758.5453);
  return vec2(md, id);
}`,
  hsv2rgb: `
/* HSV → RGB. Hue in [0, 1] (not radians), saturation and value in [0, 1].
   Standard iq formulation — branchless, fast. */
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}`,
  palette: `
/* Inigo Quilez's cosine palette. Five inputs control any cyclic color
   scheme: brightness (a), contrast (b), frequency per channel (c), phase
   per channel (d). Defaults (0.5, 0.5, 1, {0, 0.33, 0.67}) give a rainbow
   as t goes 0→1. See iquilezles.org/articles/palettes. */
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
  return a + b * cos(6.28318 * (c * t + d));
}`,
  ridgedFbm: `
/* Ridged fractal Brownian motion. Takes absolute values of the noise
   samples and inverts them, which turns smooth blobs into sharp ridges
   — exactly the silhouette of mountain ranges, canyon networks, or
   cracked earth. Accumulates octaves the same way fbm() does. */
float ridgedFbm(vec3 p, float octaves){
  float value = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  int n = int(octaves);
  for (int i = 0; i < 8; i++){
    if (i >= n) break;
    float s = snoise(p * freq);
    value += amp * (1.0 - abs(s));
    freq *= 2.1;
    amp *= 0.48;
  }
  return value;
}`,
  rgb2hsv: `
/* RGB → HSV conversion. Inverse of hsv2rgb above. Hue in [0,1]. */
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}`,
  rotateVec3: `
/* Rodrigues' rotation formula — rotate a vec3 around an arbitrary axis
   by an angle in radians. Used by Rotate Vec3 node for lighting /
   normal-map tricks. */
vec3 rotateVec3(vec3 v, vec3 axis, float angle){
  axis = normalize(axis);
  float c = cos(angle);
  float s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}`,
  sdfHexagon: `
/* Signed distance to a regular hexagon (flat-top orientation). Classic iq
   formulation — the reflection trick maps any point into one 30° wedge and
   then measures distance to the wedge's single edge. Negative inside. */
float sdfHexagon(vec2 p, float r){
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);   // (-sqrt(3)/2, 0.5, 1/sqrt(3))
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z*r, k.z*r), r);
  return length(p) * sign(p.y);
}`,
  sdfTriangle: `
/* Signed distance to an equilateral triangle pointing up (apex at +y).
   r is the circumradius — the triangle fits inside a circle of that radius. */
float sdfTriangle(vec2 p, float r){
  const float k = 1.7320508;   // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r/k;
  if (p.x + k*p.y > 0.0) p = vec2(p.x - k*p.y, -k*p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0*r, 0.0);
  return -length(p) * sign(p.y);
}`,
  sdfCrystal: `
/* SDF of a convex pentagon shaped like a standing crystal:
     apex at (0, +h), two upper shoulders at (±w, 0.4h), two lower corners
     at (±w, -h).  w = size.x is the half-width, h = size.y the half-height.
   Computed as a proper polygon SDF (min segment-distance + convex-CCW
   inside-test) so there are no seams or joint notches. */
float sdfCrystal(vec2 p, vec2 size){
  float w = size.x, h = size.y;
  vec2 v0 = vec2( 0.0,      h     );
  vec2 v1 = vec2( w,        h*0.4 );
  vec2 v2 = vec2( w,       -h     );
  vec2 v3 = vec2(-w,       -h     );
  vec2 v4 = vec2(-w,        h*0.4 );

  // squared distance to each edge (as a line segment)
  vec2 pp, e, q;  float t, d;
  pp = p - v0; e = v1 - v0; t = clamp(dot(pp,e)/dot(e,e), 0.0, 1.0); q = pp - e*t;
  d = dot(q, q);
  pp = p - v1; e = v2 - v1; t = clamp(dot(pp,e)/dot(e,e), 0.0, 1.0); q = pp - e*t;
  d = min(d, dot(q, q));
  pp = p - v2; e = v3 - v2; t = clamp(dot(pp,e)/dot(e,e), 0.0, 1.0); q = pp - e*t;
  d = min(d, dot(q, q));
  pp = p - v3; e = v4 - v3; t = clamp(dot(pp,e)/dot(e,e), 0.0, 1.0); q = pp - e*t;
  d = min(d, dot(q, q));
  pp = p - v4; e = v0 - v4; t = clamp(dot(pp,e)/dot(e,e), 0.0, 1.0); q = pp - e*t;
  d = min(d, dot(q, q));

  // inside test: p is inside the convex CCW polygon iff it's to the LEFT
  // of every edge (cross(edge, p - v_i) > 0 for all i).
  float c0 = (v1.x-v0.x)*(p.y-v0.y) - (v1.y-v0.y)*(p.x-v0.x);
  float c1 = (v2.x-v1.x)*(p.y-v1.y) - (v2.y-v1.y)*(p.x-v1.x);
  float c2 = (v3.x-v2.x)*(p.y-v2.y) - (v3.y-v2.y)*(p.x-v2.x);
  float c3 = (v4.x-v3.x)*(p.y-v3.y) - (v4.y-v3.y)*(p.x-v3.x);
  float c4 = (v0.x-v4.x)*(p.y-v4.y) - (v0.y-v4.y)*(p.x-v4.x);
  float inside = step(0.0, min(min(min(min(c0, c1), c2), c3), c4));
  float s = mix(1.0, -1.0, inside);

  return s * sqrt(d);
}`,
  sdfNormal3D: `
/* SDF → fake-3D surface normal. Uses screen-space derivatives to get the
   SDF gradient, then builds a normal that bulges up in +Z at the surface
   center and tilts outward at the edges. \`bulge\` controls how much the
   surface domes upward (higher = more spherical, lower = flatter). The
   result is designed to feed Fresnel / iridescence / lighting nodes. */
vec3 sdfNormal3D(float sd, float bulge){
  vec2 g = vec2(dFdx(sd), dFdy(sd));
  // rescale the gradient so it's ~unit length regardless of sample spacing.
  g = g / max(length(g), 1e-5);
  // height above surface: 1 at the very center (sd << 0), fading to 0 at edge.
  // Using -sd (distance INTO the shape) driven through smoothstep.
  float h = smoothstep(0.0, 0.25, -sd) * max(bulge, 0.0);
  return normalize(vec3(-g.x, -g.y, h + 0.0001));
}`,
};

/* ---------------- node type registry ----------------
 * Each type declares:
 *   category, title, desc
 *   inputs:  [{name, type:'float'|'vec2'|'vec3', default?}]
 *   outputs: [{name, type}]
 *   params:  [{name, kind:'number'|'color'|'vec2'|'select', default, min?, max?, step?, options?}]
 *   helpers: ['snoise','fbm','marble']  helper blocks to include when reachable
 *   generate(ctx): returns either a raw expression string (single output
 *                  shorthand), or an object { setup?: 'stmts;', exprs: { socket: 'expr' } }.
 *     ctx = { node, inputs, params, tmp(name) }
 *
 * The compiler resolves input expressions (upstream temp var OR default literal),
 * emits `setup` statements verbatim, then creates one temp per output so
 * consumers can reference them by variable name.
 * ---------------------------------------------------- */
const NODE_TYPES = {
  /* ---- inputs ---- */
  time: {
    category:'Input', title:'Time', desc:'u_time uniform (seconds) × scale',
    inputs:[], outputs:[{name:'out', type:'float'}],
    params:[{name:'scale', kind:'number', default:1.0, step:0.01}],
    // when scale==1 we emit the bare `u_time` identifier so downstream nodes
    // reference the uniform directly (no temp var needed). any other value
    // produces `(u_time * s)` — still cheap, still inlined where possible.
    generate:(ctx) => {
      const s = ctx.params.scale;
      return { exprs:{ out: s === 1 ? 'u_time' : `(u_time * ${glslNum(s)})` } };
    },
  },
  uv: {
    category:'Input', title:'UV', desc:'0..1 coords across the quad',
    inputs:[], outputs:[{name:'out', type:'vec2'}],
    preview:'uv',   // renders a (u, v, 0) gradient thumbnail in the node body
    generate:() => ({ exprs:{ out:'v_uv' } }),
  },
  centeredUV: {
    category:'Input', title:'Centered UV', desc:'UV re-centered (-0.5..0.5) w/ aspect',
    inputs:[], outputs:[{name:'p', type:'vec2'}, {name:'dist', type:'float'}],
    preview:'centeredUV',  // origin-at-center variant (|x|, |y|, 0) so it reads differently from plain UV
    generate:(ctx) => {
      const p = ctx.tmp('cuv');
      return {
        setup:`vec2 ${p} = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);`,
        exprs:{ p:p, dist:`length(${p})` },
      };
    },
  },
  mouse: {
    category:'Input', title:'Mouse', desc:'normalized cursor (0..1)',
    inputs:[], outputs:[{name:'out', type:'vec2'}],
    generate:() => ({ exprs:{ out:'u_mouse' } }),
  },
  cursorPos: {
    category:'Input', title:'Cursor', desc:'cursor position in centred UV space (always live, no toggle)',
    inputs:[], outputs:[{name:'pos', type:'vec2'}],
    // Derived from `u_mouse` (which always tracks the pointer regardless of
    // the Lighting button) and re-centred + aspect-corrected to match
    // Centered UV's coordinate space. Use this for parallax direction,
    // View Mask offset, or any other "what is the cursor doing" lookup
    // that should NOT be gated by the Lighting button. Sim Light's
    // `cursor` output, by contrast, is only valid when Lighting is on.
    generate:() => ({ exprs:{
      pos: '((u_mouse - vec2(0.5)) * vec2(u_resolution.x / u_resolution.y, 1.0))',
    } }),
  },
  resolution: {
    category:'Input', title:'Resolution', desc:'canvas size in px',
    inputs:[], outputs:[{name:'out', type:'vec2'}],
    generate:() => ({ exprs:{ out:'u_resolution' } }),
  },
  viewDir: {
    category:'Input', title:'View Dir', desc:'camera/view direction (vec3)',
    inputs:[], outputs:[{name:'out', type:'vec3'}],
    params:[{name:'dir', kind:'vec2', default:[0, 0], step:0.01}],   // tilt xy, z is auto
    // For our fullscreen-quad setup the "camera" looks along +Z, so (0,0,1)
    // is the natural default. Nudging x/y lets you fake a tilted camera
    // angle for Fresnel / iridescence without a real 3D scene.
    generate:(ctx) => {
      const [x, y] = ctx.params.dir;
      return { exprs:{ out: `normalize(vec3(${glslNum(x)}, ${glslNum(y)}, 1.0))` } };
    },
  },
  simLight: {
    category:'Input', title:'Sim Light', desc:'cursor-driven point-light direction + position',
    inputs:[
      // Wire Centered UV's `p` here for true per-fragment point-light
      // shading (each pixel sees the cursor as a local light). Leave
      // unconnected for the legacy global-direction behavior.
      {name:'pos', type:'vec2', default:[0, 0]},
    ],
    outputs:[
      {name:'out',    type:'vec3'},   // per-fragment direction toward the light
      {name:'cursor', type:'vec2'},   // raw cursor position in centered-UV space
    ],
    // `out`: u_simLight − fragment_pos, normalised → per-fragment direction
    //        toward the light. Use for Lambert / Fresnel shading.
    // `cursor`: u_simLight.xy alone → screen-space cursor position. Use as
    //          the `direction` input for Parallax UV nodes, or as the
    //          `offset` input for View Mask. Both outputs collapse to a
    //          quiescent value when Lighting is off (renderer parks
    //          u_simLight far away at (0,0,100), so .xy ≈ (0,0)).
    generate:(ctx) => ({ exprs:{
      out:    `normalize(u_simLight - vec3(${ctx.inputs.pos}, 0.0))`,
      cursor: `u_simLight.xy`,
    } }),
  },
  worldNormal: {
    category:'Input', title:'World Normal', desc:'per-fragment 3D normal from the test surface',
    inputs:[], outputs:[{name:'out', type:'vec3'}],
    // Exposes the `v_surfaceNormal` varying produced by the vertex shader.
    // When the Surface button is OFF the test mesh stays flat and the
    // normal reads as (0, 0, 1); when ON the VS analytically computes
    // per-vertex normals from a noise-based height field and passes them
    // through here so shading nodes (Lambert, Fresnel, Iridescence) have
    // real 3D normals to work with — useful as a lighting test bed.
    generate:() => ({ exprs:{ out: 'v_surfaceNormal' } }),
  },
  lightDir: {
    category:'Input', title:'Light Dir', desc:'directional light (vec3, normalized)',
    inputs:[], outputs:[{name:'out', type:'vec3'}],
    params:[
      {name:'x', kind:'number', default:0.4,  step:0.01},
      {name:'y', kind:'number', default:0.6,  step:0.01},
      {name:'z', kind:'number', default:1.0,  step:0.01, min:0.0},
    ],
    // Directional light vector. z=1 means the light shines straight at the
    // screen; x/y tilt it. Feed into Lambert for diffuse shading.
    generate:(ctx) => ({ exprs:{
      out: `normalize(vec3(${glslNum(ctx.params.x)}, ${glslNum(ctx.params.y)}, ${glslNum(ctx.params.z)}))`,
    } }),
  },
  float: {
    category:'Input', title:'Float', desc:'scalar constant',
    inputs:[], outputs:[{name:'out', type:'float'}],
    params:[{name:'value', kind:'number', default:1.0, step:0.01}],
    generate:(ctx) => ({ exprs:{ out:`float(${glslNum(ctx.params.value)})` } }),
  },
  vec2: {
    category:'Input', title:'Vec2', desc:'2-component constant',
    inputs:[], outputs:[{name:'out', type:'vec2'}],
    params:[{name:'xy', kind:'vec2', default:[1, 1], step:0.01}],
    generate:(ctx) => {
      const [x, y] = ctx.params.xy;
      return { exprs:{ out:`vec2(${glslNum(x)}, ${glslNum(y)})` } };
    },
  },
  color: {
    category:'Input', title:'Color', desc:'vec3 RGB — channels overridable by inputs',
    // Each channel has an optional float input. When wired, that input drives
    // the channel (e.g. a Random for a pastel-shifting color). When NOT wired,
    // the `rgb` color-picker param supplies the value. `noInline:true` keeps
    // the per-channel number field out of the node body so the picker is the
    // only static-input UI — prevents the ambiguous "why isn't my inline
    // number affecting anything?" situation.
    inputs:[
      {name:'r', type:'float', default:0, noInline:true},
      {name:'g', type:'float', default:0, noInline:true},
      {name:'b', type:'float', default:0, noInline:true},
    ],
    outputs:[{name:'out', type:'vec3'}],
    params:[{name:'rgb', kind:'color', default:[0.78, 0.58, 0.20]}],
    generate:(ctx) => {
      const [pR, pG, pB] = ctx.params.rgb;
      const r = ctx.isConnected('r') ? ctx.inputs.r : glslNum(pR);
      const g = ctx.isConnected('g') ? ctx.inputs.g : glslNum(pG);
      const b = ctx.isConnected('b') ? ctx.inputs.b : glslNum(pB);
      return { exprs:{ out:`vec3(${r}, ${g}, ${b})` } };
    },
  },

  /* ---- math / vector ---- */
  add: {
    category:'Math', title:'Add', desc:'a + b',
    inputs:[{name:'a', type:'float', default:0}, {name:'b', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.a} + ${ctx.inputs.b})` } }),
  },
  subtract: {
    category:'Math', title:'Subtract', desc:'a − b',
    inputs:[{name:'a', type:'float', default:0}, {name:'b', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.a} - ${ctx.inputs.b})` } }),
  },
  multiply: {
    category:'Math', title:'Multiply', desc:'a * b',
    inputs:[{name:'a', type:'float', default:1}, {name:'b', type:'float', default:1}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.a} * ${ctx.inputs.b})` } }),
  },
  divide: {
    category:'Math', title:'Divide', desc:'a / b',
    inputs:[{name:'a', type:'float', default:1}, {name:'b', type:'float', default:1}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.a} / ${ctx.inputs.b})` } }),
  },
  mix: {
    category:'Math', title:'Mix', desc:'lerp a → b by t',
    inputs:[
      {name:'a', type:'vec3', default:[0,0,0]},
      {name:'b', type:'vec3', default:[1,1,1]},
      {name:'t', type:'float', default:0.5},
    ],
    outputs:[{name:'out', type:'vec3'}],
    generate:(ctx) => ({ exprs:{
      out:`mix(${ctx.inputs.a}, ${ctx.inputs.b}, clamp(${ctx.inputs.t}, 0.0, 1.0))`,
    } }),
  },
  lerp: {
    category:'Math', title:'Lerp', desc:'float lerp: mix(a, b, t)',
    inputs:[
      {name:'a', type:'float', default:0},
      {name:'b', type:'float', default:1},
      {name:'t', type:'float', default:0.5},
    ],
    outputs:[{name:'out', type:'float'}],
    // The Mix node above only handles vec3. Float-to-float interpolation is
    // common enough (e.g. smoothly transitioning between two Random snapshots
    // on adjacent floor-ticks of time) that a dedicated node saves graphs
    // from assembling subtract/multiply/add chains by hand.
    generate:(ctx) => ({ exprs:{
      out:`mix(${ctx.inputs.a}, ${ctx.inputs.b}, clamp(${ctx.inputs.t}, 0.0, 1.0))`,
    } }),
  },
  pow: {
    category:'Math', title:'Power', desc:'pow(|x|, e)',
    inputs:[{name:'x', type:'float', default:1}, {name:'e', type:'float', default:2}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`pow(abs(${ctx.inputs.x}), ${ctx.inputs.e})` } }),
  },
  abs: {
    category:'Math', title:'Abs', desc:'|x|',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`abs(${ctx.inputs.x})` } }),
  },
  floor: {
    category:'Math', title:'Floor', desc:'floor(x) — round down to integer',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    // Pair with a scaled Time to get stepped values ("tick every N seconds"),
    // which combined with Random gives you clean slow drift instead of the
    // per-frame flicker that a continuous seed produces.
    generate:(ctx) => ({ exprs:{ out:`floor(${ctx.inputs.x})` } }),
  },
  fract: {
    category:'Math', title:'Fract', desc:'fract(x) — fractional part (x − floor(x))',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    // Pairs nicely with Floor: fract(t) gives the 0..1 progress within the
    // current Floor tick. Also the standard trick for building periodic
    // banding effects — e.g. fract(elevation × 10) produces a repeating
    // 0..1 value per elevation tier, which is how topographic contours get
    // rendered.
    generate:(ctx) => ({ exprs:{ out:`fract(${ctx.inputs.x})` } }),
  },
  sin: {
    category:'Math', title:'Sin', desc:'sin(x)',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`sin(${ctx.inputs.x})` } }),
  },
  cos: {
    category:'Math', title:'Cos', desc:'cos(x)',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`cos(${ctx.inputs.x})` } }),
  },
  clamp: {
    category:'Math', title:'Clamp', desc:'clamp(x, a, b)',
    inputs:[
      {name:'x', type:'float', default:0},
      {name:'a', type:'float', default:0},
      {name:'b', type:'float', default:1},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{
      out:`clamp(${ctx.inputs.x}, ${ctx.inputs.a}, ${ctx.inputs.b})`,
    } }),
  },
  smoothstep: {
    category:'Math', title:'Smoothstep', desc:'smoothstep(a, b, x)',
    inputs:[
      {name:'a', type:'float', default:0},
      {name:'b', type:'float', default:1},
      {name:'x', type:'float', default:0.5},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{
      out:`smoothstep(${ctx.inputs.a}, ${ctx.inputs.b}, ${ctx.inputs.x})`,
    } }),
  },
  length: {
    category:'Math', title:'Length', desc:'length(v)',
    inputs:[{name:'v', type:'vec2', default:[0,0]}],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`length(${ctx.inputs.v})` } }),
  },
  dot: {
    category:'Math', title:'Dot', desc:'dot(a, b) — vec3 · vec3 → float',
    inputs:[
      {name:'a', type:'vec3', default:[1, 0, 0]},
      {name:'b', type:'vec3', default:[0, 0, 1]},
    ],
    outputs:[{name:'out', type:'float'}],
    // The primitive behind every diffuse-lighting calculation. Also the
    // building block for Fresnel and any angle-dependent effect.
    generate:(ctx) => ({ exprs:{ out:`dot(${ctx.inputs.a}, ${ctx.inputs.b})` } }),
  },
  cross: {
    category:'Math', title:'Cross', desc:'cross(a, b) — vec3 × vec3 → vec3',
    inputs:[
      {name:'a', type:'vec3', default:[1, 0, 0]},
      {name:'b', type:'vec3', default:[0, 1, 0]},
    ],
    outputs:[{name:'out', type:'vec3'}],
    generate:(ctx) => ({ exprs:{ out:`cross(${ctx.inputs.a}, ${ctx.inputs.b})` } }),
  },
  min: {
    category:'Math', title:'Min', desc:'min(a, b)',
    inputs:[
      {name:'a', type:'float', default:0},
      {name:'b', type:'float', default:0},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`min(${ctx.inputs.a}, ${ctx.inputs.b})` } }),
  },
  max: {
    category:'Math', title:'Max', desc:'max(a, b)',
    inputs:[
      {name:'a', type:'float', default:0},
      {name:'b', type:'float', default:0},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{ out:`max(${ctx.inputs.a}, ${ctx.inputs.b})` } }),
  },
  pulse: {
    category:'Math', title:'Pulse', desc:'0→1→0 sinusoidal pulse (freq = cycles/unit)',
    inputs:[
      {name:'t',    type:'float', default:0},
      {name:'freq', type:'float', default:1},
    ],
    outputs:[{name:'out', type:'float'}],
    // `0.5 + 0.5*sin(2π·t·freq)` — clean 0..1 oscillation. Feed `t = Time`
    // for a steady rhythm, or `t = position.x * someScale` for a spatial
    // wave. freq controls how many cycles per unit of t.
    generate:(ctx) => ({ exprs:{
      out: `(0.5 + 0.5 * sin(${ctx.inputs.t} * ${ctx.inputs.freq} * 6.28318))`,
    } }),
  },
  ease: {
    category:'Math', title:'Ease', desc:'easing curve on 0..1 (in / out / inOut)',
    inputs:[{name:'t', type:'float', default:0.5}],
    outputs:[{name:'out', type:'float'}],
    params:[{name:'mode', kind:'segmented', default:'inOut', options:['in', 'out', 'inOut']}],
    // Reshapes a 0..1 linear progression into an eased curve. `in` is
    // slow-start / fast-end (t²); `out` is fast-start / slow-end (1−(1−t)²);
    // `inOut` is the classic S-curve (smoothstep). Wrap it around any
    // linear driver to make animations feel less mechanical.
    generate:(ctx) => {
      const t = ctx.tmp('et');
      const clamp = `clamp(${ctx.inputs.t}, 0.0, 1.0)`;
      if (ctx.params.mode === 'in'){
        return { setup: `float ${t} = ${clamp};`, exprs:{ out:`(${t} * ${t})` } };
      }
      if (ctx.params.mode === 'out'){
        return { setup: `float ${t} = ${clamp};`, exprs:{ out:`(1.0 - (1.0 - ${t}) * (1.0 - ${t}))` } };
      }
      // inOut — cubic smoothstep
      return { setup: `float ${t} = ${clamp};`, exprs:{ out:`(${t} * ${t} * (3.0 - 2.0 * ${t}))` } };
    },
  },
  /* Random — pseudo-random float from any combination of seeds.
     Provides THREE optional seed inputs (float / vec2 / vec3) so you can
     plug in whatever's natural: `time` for per-frame randoms, `uv` for
     per-pixel, both for per-pixel-and-animated, etc. All three are mixed
     into one scalar via a dot-product hash before the final sin-based
     hash — unused seeds sit at zero and contribute nothing.
     Output is clamped to [min, max]. `mode` picks integer vs decimal;
     decimal mode uses `precision` to quantize to N places after the dot. */
  random: {
    category:'Math', title:'Random', desc:'pseudo-random float in [min, max]',
    inputs:[
      {name:'seed',     type:'float', default:0},
      {name:'seedUV',   type:'vec2',  default:[0,0]},
      {name:'seedVec3', type:'vec3',  default:[0,0,0]},
      {name:'min',      type:'float', default:0},
      {name:'max',      type:'float', default:1},
    ],
    outputs:[{name:'out', type:'float'}],
    params:[
      {name:'mode',      kind:'segmented', default:'decimal', options:['decimal','integer']},
      {name:'precision', kind:'number',    default:2, min:0, max:6, step:1,
       visibleWhen:p => p.mode === 'decimal'},
    ],
    helpers:['rngHash3'],
    generate:(ctx) => {
      // Pack the three seed inputs into a single vec3 so rngHash3 can mix
      // them properly. The prior dot-product-then-sin construction reduced
      // everything to a scalar and produced visible banding — packing as
      // vec3 lets each hash axis see an independent dimension.
      const seedV  = ctx.tmp('rseedv');
      const rand   = ctx.tmp('rrand');
      const scaled = ctx.tmp('rscl');
      const setup =
`vec3 ${seedV}  = ${ctx.inputs.seedVec3} + vec3(${ctx.inputs.seedUV}, ${ctx.inputs.seed});
float ${rand}   = rngHash3(${seedV});
float ${scaled} = mix(${ctx.inputs.min}, ${ctx.inputs.max}, ${rand});`;

      let out;
      if (ctx.params.mode === 'integer'){
        out = `floor(${scaled} + 0.5)`;
      } else {
        const p   = Math.max(0, Math.min(6, Math.round(ctx.params.precision || 0)));
        const mul = glslNum(Math.pow(10, p));
        out = p === 0
          ? `floor(${scaled} + 0.5)`
          : `floor(${scaled} * ${mul} + 0.5) / ${mul}`;
      }
      return { setup, exprs:{ out } };
    },
  },

  makeVec2: {
    category:'Vector', title:'Make Vec2', desc:'vec2(x, y)',
    inputs:[{name:'x', type:'float', default:0}, {name:'y', type:'float', default:0}],
    outputs:[{name:'out', type:'vec2'}],
    generate:(ctx) => ({ exprs:{ out:`vec2(${ctx.inputs.x}, ${ctx.inputs.y})` } }),
  },
  makeVec3: {
    category:'Vector', title:'Make Vec3', desc:'vec3(r, g, b)',
    inputs:[
      {name:'r', type:'float', default:0},
      {name:'g', type:'float', default:0},
      {name:'b', type:'float', default:0},
    ],
    outputs:[{name:'out', type:'vec3'}],
    generate:(ctx) => ({ exprs:{
      out:`vec3(${ctx.inputs.r}, ${ctx.inputs.g}, ${ctx.inputs.b})`,
    } }),
  },
  splitVec3: {
    category:'Vector', title:'Split Vec3', desc:'vec3 → r, g, b',
    inputs:[{name:'v', type:'vec3', default:[0,0,0]}],
    outputs:[{name:'r', type:'float'}, {name:'g', type:'float'}, {name:'b', type:'float'}],
    generate:(ctx) => {
      const v = ctx.tmp('sv');
      return {
        setup:`vec3 ${v} = ${ctx.inputs.v};`,
        exprs:{ r:`${v}.x`, g:`${v}.y`, b:`${v}.z` },
      };
    },
  },
  splitVec2: {
    category:'Vector', title:'Split Vec2', desc:'vec2 → x, y',
    inputs:[{name:'v', type:'vec2', default:[0,0]}],
    outputs:[{name:'x', type:'float'}, {name:'y', type:'float'}],
    generate:(ctx) => {
      const v = ctx.tmp('sv2');
      return {
        setup:`vec2 ${v} = ${ctx.inputs.v};`,
        exprs:{ x:`${v}.x`, y:`${v}.y` },
      };
    },
  },
  /* Flexible "Combine" — same as Unity's. Floats in, both vec2 (xy) and
     vec3 (xyz) out so it covers most downstream needs with one node. */
  combine: {
    category:'Vector', title:'Combine', desc:'build vec3 (xyz) + vec2 (xy)',
    inputs:[
      {name:'x', type:'float', default:0},
      {name:'y', type:'float', default:0},
      {name:'z', type:'float', default:0},
    ],
    outputs:[
      {name:'xyz', type:'vec3'},
      {name:'xy',  type:'vec2'},
    ],
    generate:(ctx) => ({ exprs:{
      xyz:`vec3(${ctx.inputs.x}, ${ctx.inputs.y}, ${ctx.inputs.z})`,
      xy: `vec2(${ctx.inputs.x}, ${ctx.inputs.y})`,
    } }),
  },
  scaleVec2: {
    category:'Vector', title:'Scale Vec2', desc:'v * s',
    inputs:[{name:'v', type:'vec2', default:[0,0]}, {name:'s', type:'float', default:1}],
    outputs:[{name:'out', type:'vec2'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.v} * ${ctx.inputs.s})` } }),
  },
  parallaxUV: {
    category:'Vector', title:'Parallax UV', desc:'shift UV by direction × depth (per-layer parallax)',
    inputs:[
      {name:'uv',        type:'vec2',  default:[0, 0]},
      {name:'direction', type:'vec2',  default:[0, 0]},   // cursor offset, time-based, etc.
      {name:'depth',     type:'float', default:0.1},      // 0 = no shift, 1 = full follow
    ],
    outputs:[{name:'out', type:'vec2'}],
    // Plug a different `depth` into each layer's Parallax UV to get a
    // foreground/background separation: distant layer with depth=0.05,
    // close layer with depth=0.4. Wire the Sim Light's xy (split it
    // first) into `direction` and the cursor moves the foreground more
    // than the background — classic parallax.
    generate:(ctx) => ({ exprs:{
      out: `(${ctx.inputs.uv} + ${ctx.inputs.direction} * ${ctx.inputs.depth})`,
    } }),
  },
  grayscale: {
    category:'Vector', title:'Grayscale', desc:'float → vec3 (x, x, x)',
    inputs:[{name:'x', type:'float', default:0}],
    outputs:[{name:'out', type:'vec3'}],
    generate:(ctx) => ({ exprs:{ out:`vec3(${ctx.inputs.x})` } }),
  },
  normalToColor: {
    category:'Vector', title:'Normal to Color', desc:'(-1..1) → (0..1) RGB preview',
    inputs:[{name:'n', type:'vec3', default:[0, 0, 1]}],
    outputs:[{name:'out', type:'vec3'}],
    generate:(ctx) => ({ exprs:{ out:`(${ctx.inputs.n} * 0.5 + 0.5)` } }),
  },
  rotateUV: {
    category:'Vector', title:'Rotate UV', desc:'rotate a vec2 around a pivot by angle (rad)',
    inputs:[
      {name:'uv',    type:'vec2',  default:[0.5, 0.5]},
      {name:'angle', type:'float', default:0},
      {name:'pivot', type:'vec2',  default:[0.5, 0.5]},
    ],
    outputs:[{name:'out', type:'vec2'}],
    // 2×2 rotation matrix applied around an offset pivot (default = center
    // of the UV square). Feeding `angle = Time` gives a continuously-
    // rotating UV — useful for spinning any pattern in-place.
    generate:(ctx) => {
      const cs = ctx.tmp('rc');
      const sn = ctx.tmp('rs');
      const q  = ctx.tmp('rq');
      return {
        setup:
`float ${cs} = cos(${ctx.inputs.angle});
float ${sn} = sin(${ctx.inputs.angle});
vec2 ${q}   = ${ctx.inputs.uv} - ${ctx.inputs.pivot};`,
        exprs:{
          out: `vec2(${cs} * ${q}.x - ${sn} * ${q}.y, ${sn} * ${q}.x + ${cs} * ${q}.y) + ${ctx.inputs.pivot}`,
        },
      };
    },
  },
  polar: {
    category:'Vector', title:'Polar', desc:'vec2 → (radius, angle) around a pivot',
    inputs:[
      {name:'uv',    type:'vec2', default:[0.5, 0.5]},
      {name:'pivot', type:'vec2', default:[0.5, 0.5]},
    ],
    outputs:[
      {name:'radius', type:'float'},
      {name:'angle',  type:'float'},
    ],
    // Converts cartesian UV into polar coordinates relative to a pivot.
    // `angle` is in radians in the range (−π, π] — same as atan2. Pair
    // with Rotate UV, Fract, Smoothstep, etc. to build radial patterns
    // (spirals, pie wedges, kaleidoscopes, sundials, clocks).
    generate:(ctx) => {
      const d = ctx.tmp('pd');
      return {
        setup: `vec2 ${d} = ${ctx.inputs.uv} - ${ctx.inputs.pivot};`,
        exprs:{
          radius: `length(${d})`,
          angle:  `atan(${d}.y, ${d}.x)`,
        },
      };
    },
  },
  hsv2rgb: {
    category:'Vector', title:'HSV → RGB', desc:'hue (0..1) + sat + value → RGB',
    inputs:[
      {name:'h', type:'float', default:0},
      {name:'s', type:'float', default:1},
      {name:'v', type:'float', default:1},
    ],
    outputs:[{name:'out', type:'vec3'}],
    helpers:['hsv2rgb'],
    // Hue is on a 0..1 scale (not degrees or radians) — one full rotation
    // at h=1. Animate by feeding `h = Time` (scaled) for continuous hue
    // shift, or `h = dot(normal, view)` for iridescence-style angle tint.
    generate:(ctx) => ({ exprs:{
      out: `hsv2rgb(vec3(${ctx.inputs.h}, ${ctx.inputs.s}, ${ctx.inputs.v}))`,
    } }),
  },
  palette: {
    category:'Vector', title:'Palette', desc:'iq cosine palette: a + b·cos(2π·(c·t + d))',
    inputs:[
      {name:'t', type:'float', default:0},
      {name:'a', type:'vec3',  default:[0.5, 0.5, 0.5]},
      {name:'b', type:'vec3',  default:[0.5, 0.5, 0.5]},
      {name:'c', type:'vec3',  default:[1.0, 1.0, 1.0]},
      {name:'d', type:'vec3',  default:[0.0, 0.33, 0.67]},
    ],
    outputs:[{name:'out', type:'vec3'}],
    helpers:['palette'],
    // Unconnected defaults produce a full rainbow as t goes 0→1. Override
    // any of a/b/c/d via a Combine or Color node to tune the scheme —
    // examples of good presets live on iq's palette page.
    generate:(ctx) => ({ exprs:{
      out: `palette(${ctx.inputs.t}, ${ctx.inputs.a}, ${ctx.inputs.b}, ${ctx.inputs.c}, ${ctx.inputs.d})`,
    } }),
  },
  kaleidoscope: {
    category:'Vector', title:'Kaleidoscope', desc:'N-fold mirror fold around a pivot',
    inputs:[
      {name:'uv',      type:'vec2',  default:[0.5, 0.5]},
      {name:'sectors', type:'float', default:6},
      {name:'pivot',   type:'vec2',  default:[0.5, 0.5]},
    ],
    outputs:[{name:'out', type:'vec2'}],
    // Converts to polar, folds the angle into one sector via `mod`, then
    // mirrors that sector with `abs(a - sectorWidth/2)`. The result is a
    // UV space with N-fold symmetry — feed it into ANY downstream pattern
    // (noise, voronoi, whatever) to get instant kaleidoscope visuals.
    generate:(ctx) => {
      const d  = ctx.tmp('kd');
      const r  = ctx.tmp('kr');
      const a  = ctx.tmp('ka');
      const sw = ctx.tmp('ksw');
      return {
        setup:
`vec2 ${d}   = ${ctx.inputs.uv} - ${ctx.inputs.pivot};
float ${r}  = length(${d});
float ${a}  = atan(${d}.y, ${d}.x);
float ${sw} = 6.28318 / max(${ctx.inputs.sectors}, 1.0);
${a} = abs(mod(${a}, ${sw}) - ${sw} * 0.5);`,
        exprs:{
          out: `(vec2(cos(${a}), sin(${a})) * ${r} + ${ctx.inputs.pivot})`,
        },
      };
    },
  },
  pixelate: {
    category:'Vector', title:'Pixelate', desc:'quantize UV to an N × N grid',
    inputs:[
      {name:'uv',    type:'vec2',  default:[0, 0]},
      {name:'cells', type:'float', default:48},
    ],
    outputs:[{name:'out', type:'vec2'}],
    // `floor(uv * cells) / cells` snaps each pixel to the bottom-left of
    // its containing cell. Downstream patterns then see one constant UV
    // per cell — instant blocky / retro / 8-bit look when fed into smooth
    // patterns.
    generate:(ctx) => ({ exprs:{
      out: `(floor(${ctx.inputs.uv} * ${ctx.inputs.cells}) / ${ctx.inputs.cells})`,
    } }),
  },
  chromaShiftUV: {
    category:'Vector', title:'Chromatic UV', desc:'three offset UVs for R/G/B prism split',
    inputs:[
      {name:'uv',        type:'vec2',  default:[0, 0]},
      {name:'direction', type:'vec2',  default:[1, 0]},
      {name:'amount',    type:'float', default:0.01},
    ],
    outputs:[
      {name:'uvR', type:'vec2'},
      {name:'uvG', type:'vec2'},
      {name:'uvB', type:'vec2'},
    ],
    // True chromatic aberration needs to sample the rendered image at
    // three offsets, which we can't do single-pass. This node gives you
    // the three UVs; wire each into a COPY of your pattern path and
    // feed the outputs as R/G/B into a Combine — that's the workaround.
    generate:(ctx) => {
      const d = ctx.tmp('cdir');
      return {
        setup: `vec2 ${d} = ${ctx.inputs.direction} * ${ctx.inputs.amount};`,
        exprs:{
          uvR: `(${ctx.inputs.uv} - ${d})`,
          uvG: ctx.inputs.uv,
          uvB: `(${ctx.inputs.uv} + ${d})`,
        },
      };
    },
  },
  rgb2hsv: {
    category:'Vector', title:'RGB → HSV', desc:'inverse of HSV→RGB',
    inputs:[{name:'rgb', type:'vec3', default:[1, 0, 0]}],
    outputs:[
      {name:'h', type:'float'},
      {name:'s', type:'float'},
      {name:'v', type:'float'},
    ],
    helpers:['rgb2hsv'],
    generate:(ctx) => {
      const hsv = ctx.tmp('hsv');
      return {
        setup: `vec3 ${hsv} = rgb2hsv(${ctx.inputs.rgb});`,
        exprs:{
          h: `${hsv}.x`,
          s: `${hsv}.y`,
          v: `${hsv}.z`,
        },
      };
    },
  },
  hueShift: {
    category:'Vector', title:'Hue Shift', desc:'rotate hue of an RGB color by amount (0..1 = full rotation)',
    inputs:[
      {name:'rgb',    type:'vec3',  default:[1, 0, 0]},
      {name:'amount', type:'float', default:0.0},
    ],
    outputs:[{name:'out', type:'vec3'}],
    helpers:['rgb2hsv', 'hsv2rgb'],
    // Round-trips the color through HSV, adds `amount` to the hue, wraps
    // with fract(), converts back. amount=0.5 flips to complementary color;
    // amount=Time gives continuous hue cycling.
    generate:(ctx) => {
      const hsv = ctx.tmp('hs');
      return {
        setup: `vec3 ${hsv} = rgb2hsv(${ctx.inputs.rgb});`,
        exprs:{
          out: `hsv2rgb(vec3(fract(${hsv}.x + ${ctx.inputs.amount}), ${hsv}.y, ${hsv}.z))`,
        },
      };
    },
  },
  saturation: {
    category:'Vector', title:'Saturation', desc:'scale saturation (0 = gray, 1 = unchanged, >1 = boosted)',
    inputs:[
      {name:'rgb',   type:'vec3',  default:[1, 0, 0]},
      {name:'scale', type:'float', default:1.0},
    ],
    outputs:[{name:'out', type:'vec3'}],
    // Luminance-preserving saturation control. `mix(gray, color, scale)`
    // where gray = luma. Scale 0 → grayscale; 1 → identity; >1 → vivid.
    generate:(ctx) => {
      const lum = ctx.tmp('sl');
      return {
        setup: `float ${lum} = dot(${ctx.inputs.rgb}, vec3(0.299, 0.587, 0.114));`,
        exprs:{
          out: `mix(vec3(${lum}), ${ctx.inputs.rgb}, ${ctx.inputs.scale})`,
        },
      };
    },
  },
  rotateVec3: {
    category:'Vector', title:'Rotate Vec3', desc:'rotate vec3 around axis by angle (rad)',
    inputs:[
      {name:'v',     type:'vec3',  default:[1, 0, 0]},
      {name:'axis',  type:'vec3',  default:[0, 1, 0]},
      {name:'angle', type:'float', default:0},
    ],
    outputs:[{name:'out', type:'vec3'}],
    helpers:['rotateVec3'],
    // Rodrigues' formula for rotating any vec3 around any axis. Useful
    // for rotating normals for custom lighting or animating vectors.
    generate:(ctx) => ({ exprs:{
      out: `rotateVec3(${ctx.inputs.v}, ${ctx.inputs.axis}, ${ctx.inputs.angle})`,
    } }),
  },
  warpUV: {
    category:'Vector', title:'Warp UV', desc:'uv + warp (domain warp — use noise as warp source)',
    inputs:[
      {name:'uv',   type:'vec2',  default:[0, 0]},
      {name:'warp', type:'vec2',  default:[0, 0]},
    ],
    outputs:[{name:'out', type:'vec2'}],
    // Basic domain warp: offset the UV by another vec2 source. Classic
    // use: build a vec2 from two scaled simplex-noise samples and feed
    // it here to warp the input to a downstream pattern.
    generate:(ctx) => ({ exprs:{
      out: `(${ctx.inputs.uv} + ${ctx.inputs.warp})`,
    } }),
  },
  swirl: {
    category:'Vector', title:'Swirl', desc:'spiral rotation — angle grows with distance from center',
    inputs:[
      {name:'uv',       type:'vec2',  default:[0.5, 0.5]},
      {name:'center',   type:'vec2',  default:[0.5, 0.5]},
      {name:'strength', type:'float', default:5.0},
    ],
    outputs:[{name:'out', type:'vec2'}],
    // Classic vortex. For each point, the rotation angle depends on its
    // distance from center: angle = strength · radius. Points near center
    // barely move; points far away twist a lot — the swirl you get when
    // you stir a liquid. Use a negative strength to reverse direction.
    generate:(ctx) => {
      const d  = ctx.tmp('sd');
      const r  = ctx.tmp('sr');
      const a  = ctx.tmp('sa');
      const cs = ctx.tmp('scs');
      const sn = ctx.tmp('ssn');
      return {
        setup:
`vec2 ${d}  = ${ctx.inputs.uv} - ${ctx.inputs.center};
float ${r} = length(${d});
float ${a} = ${ctx.inputs.strength} * ${r};
float ${cs} = cos(${a});
float ${sn} = sin(${a});`,
        exprs:{
          out: `(vec2(${cs} * ${d}.x - ${sn} * ${d}.y, ${sn} * ${d}.x + ${cs} * ${d}.y) + ${ctx.inputs.center})`,
        },
      };
    },
  },

  /* ---- patterns ---- */
  simplex: {
    category:'Pattern', title:'Simplex Noise', desc:'3D simplex noise',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'z', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    helpers:['snoise'],
    generate:(ctx) => ({ exprs:{
      out:`snoise(vec3(${ctx.inputs.p}, ${ctx.inputs.z}))`,
    } }),
  },
  fbm: {
    category:'Pattern', title:'FBM', desc:'fractal Brownian motion',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'z', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    params:[{name:'octaves', kind:'number', default:6, min:1, max:8, step:1}],
    helpers:['snoise','fbm'],
    generate:(ctx) => ({ exprs:{
      out:`fbm(vec3(${ctx.inputs.p}, ${ctx.inputs.z}), ${glslNum(ctx.params.octaves)})`,
    } }),
  },
  marble: {
    category:'Pattern', title:'Marble Pattern', desc:'warped FBM + veins',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'time', type:'float', default:0}],
    outputs:[{name:'pattern', type:'float'}],
    params:[{name:'scale', kind:'number', default:2.0, min:0.1, max:10, step:0.05}],
    helpers:['snoise','fbm','marble'],
    generate:(ctx) => ({ exprs:{
      pattern:`marblePattern(${ctx.inputs.p}, ${ctx.inputs.time}, ${glslNum(ctx.params.scale)})`,
    } }),
  },
  veins: {
    category:'Pattern', title:'Veins', desc:'sharp abs(sin) veins',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'time', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    params:[
      {name:'frequency', kind:'number', default:4.0, min:0.1, max:20, step:0.1},
      {name:'sharpness', kind:'number', default:2.5, min:0.1, max:8, step:0.1},
    ],
    helpers:['snoise'],
    generate:(ctx) => {
      const v = ctx.tmp('veins');
      return {
        setup:`float ${v} = snoise(vec3(${ctx.inputs.p} * ${glslNum(ctx.params.frequency)}, ${ctx.inputs.time} * 0.5));`,
        exprs:{ out:`pow(abs(${v}), ${glslNum(ctx.params.sharpness)})` },
      };
    },
  },
  ridgedFbm: {
    category:'Pattern', title:'Ridged FBM', desc:'mountain-range noise — 1 − abs(fbm) per octave',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'z', type:'float', default:0}],
    outputs:[{name:'out', type:'float'}],
    params:[{name:'octaves', kind:'number', default:6, min:1, max:8, step:1}],
    helpers:['snoise', 'ridgedFbm'],
    generate:(ctx) => ({ exprs:{
      out:`ridgedFbm(vec3(${ctx.inputs.p}, ${ctx.inputs.z}), ${glslNum(ctx.params.octaves)})`,
    } }),
  },
  checkerboard: {
    category:'Pattern', title:'Checkerboard', desc:'black/white checker grid',
    inputs:[
      {name:'uv',    type:'vec2',  default:[0, 0]},
      {name:'cells', type:'float', default:8},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => {
      const c = ctx.tmp('ck');
      return {
        setup: `vec2 ${c} = floor(${ctx.inputs.uv} * ${ctx.inputs.cells});`,
        exprs:{ out: `mod(${c}.x + ${c}.y, 2.0)` },
      };
    },
  },
  stripes: {
    category:'Pattern', title:'Stripes', desc:'parallel stripes at an angle',
    inputs:[
      {name:'uv',        type:'vec2',  default:[0, 0]},
      {name:'angle',     type:'float', default:0},
      {name:'frequency', type:'float', default:10},
    ],
    outputs:[{name:'out', type:'float'}],
    // Rotates UV by `angle` then bands along x at `frequency`. Returns a
    // 0..1 mask with crisp anti-aliased edges — 0 in one stripe, 1 in the
    // other. angle=0 → horizontal, π/2 → vertical, π/4 → diagonal.
    generate:(ctx) => {
      const c = ctx.tmp('sc');
      const s = ctx.tmp('ss');
      const x = ctx.tmp('sx');
      return {
        setup:
`float ${c} = cos(${ctx.inputs.angle});
float ${s} = sin(${ctx.inputs.angle});
float ${x} = ${c} * ${ctx.inputs.uv}.x + ${s} * ${ctx.inputs.uv}.y;`,
        exprs:{ out: `smoothstep(0.48, 0.52, fract(${x} * ${ctx.inputs.frequency}))` },
      };
    },
  },
  grid: {
    category:'Pattern', title:'Grid', desc:'thin lines at cell boundaries',
    inputs:[
      {name:'uv',        type:'vec2',  default:[0, 0]},
      {name:'cells',     type:'float', default:10},
      {name:'lineWidth', type:'float', default:0.04},
    ],
    outputs:[{name:'out', type:'float'}],
    // 1 at cell boundary, 0 inside cell. `min(x, 1-x)` computes distance
    // to the nearest cell edge along each axis; we pick the smaller of the
    // two and smoothstep to make an anti-aliased line.
    generate:(ctx) => {
      const g = ctx.tmp('gg');
      const e = ctx.tmp('ge');
      const d = ctx.tmp('gd');
      return {
        setup:
`vec2 ${g}  = fract(${ctx.inputs.uv} * ${ctx.inputs.cells});
vec2 ${e}  = min(${g}, 1.0 - ${g});
float ${d} = min(${e}.x, ${e}.y);`,
        exprs:{
          out: `(1.0 - smoothstep(0.0, ${ctx.inputs.lineWidth}, ${d}))`,
        },
      };
    },
  },
  sdfCircle: {
    category:'Pattern', title:'SDF Circle', desc:'signed distance to a circle (neg inside)',
    inputs:[
      {name:'p',      type:'vec2',  default:[0, 0]},
      {name:'center', type:'vec2',  default:[0, 0]},
      {name:'radius', type:'float', default:0.3},
    ],
    outputs:[{name:'out', type:'float'}],
    // Signed distance field: 0 on the circle edge, negative inside,
    // positive outside. Feed into smoothstep(0, edgeWidth, d) for a
    // filled disk, or abs(d) < thickness for a ring outline.
    generate:(ctx) => ({ exprs:{
      out: `(length(${ctx.inputs.p} - ${ctx.inputs.center}) - ${ctx.inputs.radius})`,
    } }),
  },
  sdfBox: {
    category:'Pattern', title:'SDF Box', desc:'signed distance to an axis-aligned box',
    inputs:[
      {name:'p',      type:'vec2',  default:[0, 0]},
      {name:'center', type:'vec2',  default:[0, 0]},
      {name:'size',   type:'vec2',  default:[0.3, 0.2]},
    ],
    outputs:[{name:'out', type:'float'}],
    // Classic box SDF. `size` is the half-extent on each axis (so a
    // size of (0.3, 0.2) makes a 0.6 × 0.4 box). Compose with sdfCircle
    // via Min (union), Max (intersection), or Max(a, -b) (subtraction).
    generate:(ctx) => {
      const d = ctx.tmp('bd');
      return {
        setup: `vec2 ${d} = abs(${ctx.inputs.p} - ${ctx.inputs.center}) - ${ctx.inputs.size};`,
        exprs:{
          out: `(length(max(${d}, 0.0)) + min(max(${d}.x, ${d}.y), 0.0))`,
        },
      };
    },
  },
  sdfHexagon: {
    category:'Pattern', title:'SDF Hexagon', desc:'signed distance to a flat-top hexagon',
    inputs:[
      {name:'p',      type:'vec2',  default:[0, 0]},
      {name:'center', type:'vec2',  default:[0, 0]},
      {name:'radius', type:'float', default:0.3},
    ],
    outputs:[{name:'out', type:'float'}],
    helpers:['sdfHexagon'],
    generate:(ctx) => ({ exprs:{
      out: `sdfHexagon(${ctx.inputs.p} - ${ctx.inputs.center}, ${ctx.inputs.radius})`,
    } }),
  },
  sdfTriangle: {
    category:'Pattern', title:'SDF Triangle', desc:'signed distance to an equilateral triangle',
    inputs:[
      {name:'p',      type:'vec2',  default:[0, 0]},
      {name:'center', type:'vec2',  default:[0, 0]},
      {name:'radius', type:'float', default:0.3},
    ],
    outputs:[{name:'out', type:'float'}],
    helpers:['sdfTriangle'],
    // Pointing up by default. Use Rotate UV upstream on the `p` input to
    // spin it — the triangle itself is a pure shape function.
    generate:(ctx) => ({ exprs:{
      out: `sdfTriangle(${ctx.inputs.p} - ${ctx.inputs.center}, ${ctx.inputs.radius})`,
    } }),
  },
  sdfCrystal: {
    category:'Pattern', title:'SDF Crystal', desc:'convex pentagon crystal silhouette',
    inputs:[
      {name:'p',      type:'vec2',  default:[0, 0]},
      {name:'center', type:'vec2',  default:[0, 0]},
      {name:'size',   type:'vec2',  default:[0.18, 0.45]},  // (halfWidth, halfHeight)
    ],
    outputs:[{name:'out', type:'float'}],
    helpers:['sdfCrystal'],
    // Convex pentagon — apex up, two upper shoulders, two lower corners.
    // size.x is the half-width at the shoulders / base; size.y is the
    // half-height from center to apex. Feed into SDF Mask + SDF Normal.
    generate:(ctx) => ({ exprs:{
      out: `sdfCrystal(${ctx.inputs.p} - ${ctx.inputs.center}, ${ctx.inputs.size})`,
    } }),
  },
  sdfUnion: {
    category:'Pattern', title:'SDF Union', desc:'combine two SDFs — min(a, b), optionally smoothed',
    inputs:[
      {name:'a',      type:'float', default:1.0},
      {name:'b',      type:'float', default:1.0},
      {name:'smooth', type:'float', default:0.0},    // 0 = hard union
    ],
    outputs:[{name:'out', type:'float'}],
    // At smooth=0 this is plain min (sharp overlap). Higher values use the
    // classic polynomial smin to round the joint into a blob — great when
    // unioning overlapping crystal shards so they fuse smoothly.
    generate:(ctx) => {
      const k = ctx.tmp('uk');
      const h = ctx.tmp('uh');
      return {
        setup:
`float ${k} = max(${ctx.inputs.smooth}, 0.0);
float ${h} = ${k} > 0.0001 ? clamp(0.5 + 0.5 * (${ctx.inputs.b} - ${ctx.inputs.a}) / ${k}, 0.0, 1.0) : 0.0;`,
        exprs:{
          out: `(${k} > 0.0001 ? mix(${ctx.inputs.b}, ${ctx.inputs.a}, ${h}) - ${k} * ${h} * (1.0 - ${h}) : min(${ctx.inputs.a}, ${ctx.inputs.b}))`,
        },
      };
    },
  },
  sdfIntersect: {
    category:'Pattern', title:'SDF Intersect', desc:'overlap of two SDFs — max(a, b)',
    inputs:[
      {name:'a', type:'float', default:1.0},
      {name:'b', type:'float', default:1.0},
    ],
    outputs:[{name:'out', type:'float'}],
    generate:(ctx) => ({ exprs:{
      out: `max(${ctx.inputs.a}, ${ctx.inputs.b})`,
    } }),
  },
  sdfSubtract: {
    category:'Pattern', title:'SDF Subtract', desc:'cut b out of a — max(a, -b)',
    inputs:[
      {name:'a', type:'float', default:1.0},
      {name:'b', type:'float', default:1.0},
    ],
    outputs:[{name:'out', type:'float'}],
    // Use to carve holes: e.g. a big crystal minus smaller circles = cracks.
    generate:(ctx) => ({ exprs:{
      out: `max(${ctx.inputs.a}, -(${ctx.inputs.b}))`,
    } }),
  },
  sdfMask: {
    category:'Pattern', title:'SDF Mask', desc:'SDF → 0/1 filled mask with soft edge',
    inputs:[
      {name:'sd',   type:'float', default:1.0},
      {name:'edge', type:'float', default:0.005},
    ],
    outputs:[{name:'out', type:'float'}],
    // Converts a signed distance into a filled mask: 1 inside, 0 outside,
    // smoothly antialiased across the edge band. `edge` is the softness
    // width in UV units (match to pixel size for crisp edges: ~1/resolution).
    generate:(ctx) => ({ exprs:{
      out: `(1.0 - smoothstep(-(${ctx.inputs.edge}), (${ctx.inputs.edge}), ${ctx.inputs.sd}))`,
    } }),
  },
  sdfNormal: {
    category:'Pattern', title:'SDF Normal', desc:'fake 3D normal from an SDF (bulging surface)',
    inputs:[
      {name:'sd',    type:'float', default:1.0},
      {name:'bulge', type:'float', default:0.7},
    ],
    outputs:[{name:'out', type:'vec3'}],
    helpers:['sdfNormal3D'],
    // Uses screen-space derivatives (dFdx/dFdy) on the SDF to build a normal
    // that points +Z in the center and tilts outward near the edges — like
    // a bulging lens. Feed into Fresnel / Iridescence / Lambert. Requires
    // GL_OES_standard_derivatives (enabled automatically by the compiler).
    extensions:['GL_OES_standard_derivatives'],
    generate:(ctx) => ({ exprs:{
      out: `sdfNormal3D(${ctx.inputs.sd}, ${ctx.inputs.bulge})`,
    } }),
  },
  voronoi: {
    category:'Pattern', title:'Voronoi', desc:'cellular noise — distance + cell-id',
    inputs:[
      {name:'p',     type:'vec2',  default:[0, 0]},
      {name:'scale', type:'float', default:5},
    ],
    outputs:[
      {name:'dist', type:'float'},  // 0 at cell center, grows toward boundaries
      {name:'id',   type:'float'},  // uniform-random [0, 1) per cell, stable across frames
    ],
    helpers:['voronoi2'],
    // `dist` is the classic cellular-noise field — threshold it for cracks,
    // stripes for scales, or isolines. `id` gives a stable per-cell random,
    // perfect as the `t` input to a Palette for stained-glass coloring.
    generate:(ctx) => {
      const v = ctx.tmp('vv');
      return {
        setup: `vec2 ${v} = voronoi2(${ctx.inputs.p} * ${ctx.inputs.scale});`,
        exprs:{
          dist: `${v}.x`,
          id:   `${v}.y`,
        },
      };
    },
  },
  /* Generic image sampler — the "diffuse/spec/mask" counterpart to the
     specialized heightMap and normalMap static-mode samplers. Samples once
     and exposes all the commonly-used slices (full rgb, r channel, alpha),
     so users can plug the right output into whatever downstream node needs it
     (rgb → color math, r → heightfield / mask, a → transparency cutoff). */
  texture: {
    category:'Pattern', title:'Texture', desc:'sample an image — rgb / r / a',
    inputs:[{name:'p', type:'vec2', default:[0,0]}],
    outputs:[
      {name:'rgb', type:'vec3'},
      {name:'r',   type:'float'},
      {name:'a',   type:'float'},
    ],
    params:[{name:'imageUrl', kind:'image', default:''}],
    generate:(ctx) => {
      const uName = glslUniformName(ctx.node.id, 't');
      const v = ctx.tmp('texv');
      return {
        // one texture2D call materialized to a temp; outputs slice from it
        // so a single Texture node feeding both rgb and r only samples once.
        setup:`vec4 ${v} = texture2D(${uName}, fract(${ctx.inputs.p}));`,
        exprs:{ rgb:`${v}.rgb`, r:`${v}.r`, a:`${v}.a` },
        textures:[{ uniformName: uName }],
      };
    },
  },
  heightMap: {
    category:'Pattern', title:'Height Map', desc:'procedural FBM or static image',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'time', type:'float', default:0}],
    outputs:[{name:'height', type:'float'}],
    params:[
      // mode gates the rest: 'dynamic' = procedural FBM (default), 'static' = sampled image
      {name:'mode', kind:'segmented', default:'dynamic', options:['dynamic','static']},
      // dynamic-only
      {name:'scale',    kind:'number', default:1.5, min:0.1, max:20, step:0.05,
       visibleWhen:p => p.mode === 'dynamic'},
      // static-only — stores URL (or a data: URL when uploaded from disk)
      {name:'imageUrl', kind:'image', default:'',
       visibleWhen:p => p.mode === 'static'},
    ],
    // helpers selection also depends on mode — compiler respects the list from generate
    generate:(ctx) => {
      if (ctx.params.mode === 'static'){
        const uName = glslUniformName(ctx.node.id, 'h');
        return {
          exprs:{
            // R channel = height, fract() wraps any input range into 0..1 UV
            height:`texture2D(${uName}, fract(${ctx.inputs.p})).r`,
          },
          textures:[{ uniformName: uName }],
        };
      }
      // dynamic
      return { exprs:{
        height:`heightField(${ctx.inputs.p}, ${glslNum(ctx.params.scale)}, ${ctx.inputs.time})`,
      }, helpers:['snoise','fbm','heightField'] };
    },
  },
  normalMap: {
    category:'Pattern', title:'Normal Map', desc:'procedural derivatives or static image',
    inputs:[{name:'p', type:'vec2', default:[0,0]}, {name:'time', type:'float', default:0}],
    outputs:[{name:'normal', type:'vec3'}],
    params:[
      {name:'mode', kind:'segmented', default:'dynamic', options:['dynamic','static']},
      // dynamic-only params
      {name:'scale',    kind:'number', default:1.5,  min:0.1,    max:20,   step:0.05,
       visibleWhen:p => p.mode === 'dynamic'},
      {name:'strength', kind:'number', default:4.0,  min:0.1,    max:50,   step:0.1,
       visibleWhen:p => p.mode === 'dynamic'},
      {name:'epsilon',  kind:'number', default:0.01, min:0.0005, max:0.1,  step:0.0005,
       visibleWhen:p => p.mode === 'dynamic'},
      // static-only
      {name:'imageUrl', kind:'image', default:'',
       visibleWhen:p => p.mode === 'static'},
    ],
    generate:(ctx) => {
      if (ctx.params.mode === 'static'){
        const uName = glslUniformName(ctx.node.id, 'n');
        return {
          exprs:{
            // standard tangent-space unpack: rgb*2-1, then normalize
            normal:`normalize(texture2D(${uName}, fract(${ctx.inputs.p})).rgb * 2.0 - 1.0)`,
          },
          textures:[{ uniformName: uName }],
        };
      }
      // dynamic: central differences on heightField
      const p   = ctx.tmp('np');
      const eps = ctx.tmp('neps');
      const hL  = ctx.tmp('hL'), hR = ctx.tmp('hR');
      const hD  = ctx.tmp('hD'), hU = ctx.tmp('hU');
      const sc  = glslNum(ctx.params.scale);
      const st  = glslNum(ctx.params.strength);
      return {
        setup:`
vec2 ${p} = ${ctx.inputs.p};
float ${eps} = ${glslNum(ctx.params.epsilon)};
float ${hL} = heightField(${p} - vec2(${eps}, 0.0), ${sc}, ${ctx.inputs.time});
float ${hR} = heightField(${p} + vec2(${eps}, 0.0), ${sc}, ${ctx.inputs.time});
float ${hD} = heightField(${p} - vec2(0.0, ${eps}), ${sc}, ${ctx.inputs.time});
float ${hU} = heightField(${p} + vec2(0.0, ${eps}), ${sc}, ${ctx.inputs.time});`,
        exprs:{
          normal:`normalize(vec3((${hL} - ${hR}) * ${st}, (${hD} - ${hU}) * ${st}, 1.0))`,
        },
        helpers:['snoise','fbm','heightField'],
      };
    },
  },

  /* ---- effects ---- */
  posterize: {
    category:'Effect', title:'Posterize', desc:'quantize each color channel to N levels',
    inputs:[
      {name:'color',  type:'vec3',  default:[0, 0, 0]},
      {name:'levels', type:'float', default:4},
    ],
    outputs:[{name:'out', type:'vec3'}],
    // `floor(c * levels) / levels` snaps each channel to a discrete stair.
    // Low levels (3–5) give a cel-shaded / screen-print look; higher
    // levels (16–32) just round off subtle gradients.
    generate:(ctx) => ({ exprs:{
      out: `(floor(${ctx.inputs.color} * ${ctx.inputs.levels}) / ${ctx.inputs.levels})`,
    } }),
  },
  threshold: {
    category:'Effect', title:'Threshold', desc:'keep colors brighter than cutoff (bloom prep)',
    inputs:[
      {name:'color',    type:'vec3',  default:[0, 0, 0]},
      {name:'cutoff',   type:'float', default:0.6},
      {name:'softness', type:'float', default:0.1},
    ],
    outputs:[{name:'out', type:'vec3'}],
    // Extracts "bright" pixels using a luminance-weighted smoothstep. This
    // is the first half of a traditional bloom pipeline; combine the
    // output with Soft Glow / HDR Boost to fake the spread and boost.
    generate:(ctx) => {
      const lum  = ctx.tmp('thlum');
      const mask = ctx.tmp('thmask');
      return {
        setup:
`float ${lum}  = dot(${ctx.inputs.color}, vec3(0.299, 0.587, 0.114));
float ${mask} = smoothstep(${ctx.inputs.cutoff}, ${ctx.inputs.cutoff} + ${ctx.inputs.softness}, ${lum});`,
        exprs:{ out: `(${ctx.inputs.color} * ${mask})` },
      };
    },
  },
  softGlow: {
    category:'Effect', title:'Soft Glow', desc:'radial glow from a point — gaussian falloff',
    inputs:[
      {name:'pos',    type:'vec2',  default:[0.5, 0.5]},
      {name:'center', type:'vec2',  default:[0.5, 0.5]},
      {name:'radius', type:'float', default:0.3},
      {name:'color',  type:'vec3',  default:[1, 1, 1]},
    ],
    outputs:[{name:'out', type:'vec3'}],
    // Cheap bloom-like "halo" emitter. Emits `color` at `center`, falling
    // off smoothly over `radius` with a gaussian curve. Stack multiple
    // Soft Glows (Blend → Add) to fake multiple glowing points, or place
    // one at the position of a bright feature in your shader.
    generate:(ctx) => {
      const diff = ctx.tmp('gdiff');
      const d = ctx.tmp('gd');
      const i = ctx.tmp('gi');
      return {
        setup:
`vec2 ${diff} = ${ctx.inputs.pos} - ${ctx.inputs.center};
float ${d} = length(${diff});
float ${i} = exp(-(${d} * ${d}) / max(${ctx.inputs.radius} * ${ctx.inputs.radius}, 0.0001));`,
        exprs:{ out: `(${ctx.inputs.color} * ${i})` },
      };
    },
  },
  starburst: {
    category:'Effect', title:'Starburst', desc:'N-point star rays from a center (lens-flare)',
    inputs:[
      {name:'pos',       type:'vec2',  default:[0.5, 0.5]},
      {name:'center',    type:'vec2',  default:[0.5, 0.5]},
      {name:'points',    type:'float', default:6},
      {name:'sharpness', type:'float', default:20},
      {name:'radius',    type:'float', default:0.5},
    ],
    outputs:[{name:'out', type:'float'}],
    // Makes a lens-flare / anime-sparkle spike pattern. `cos(angle*N)` gives
    // N peaks around the center; `pow(max(·, 0), sharpness)` thins them to
    // thin rays. Distance falloff (`1 - smoothstep(0, radius, r)`) fades
    // the rays out as they leave the center. Feed the output into a
    // Grayscale → Blend(add) to composite onto a scene.
    generate:(ctx) => {
      const d = ctx.tmp('sbd');
      const r = ctx.tmp('sbr');
      const a = ctx.tmp('sba');
      const w = ctx.tmp('sbw');
      return {
        setup:
`vec2 ${d} = ${ctx.inputs.pos} - ${ctx.inputs.center};
float ${r} = length(${d});
float ${a} = atan(${d}.y, ${d}.x);
float ${w} = pow(max(cos(${a} * ${ctx.inputs.points}), 0.0), ${ctx.inputs.sharpness});`,
        exprs:{
          out: `(${w} * (1.0 - smoothstep(0.0, ${ctx.inputs.radius}, ${r})))`,
        },
      };
    },
  },
  hdrBoost: {
    category:'Effect', title:'HDR Boost', desc:'exposure (in stops) + gamma tonemap',
    inputs:[
      {name:'color',    type:'vec3',  default:[0, 0, 0]},
      {name:'exposure', type:'float', default:0.5},   // EV stops: 0 = no change, +1 = 2× brighter
      {name:'gamma',    type:'float', default:1.2},
    ],
    outputs:[{name:'out', type:'vec3'}],
    // Last step of a pseudo-bloom pipeline. `exp2(exposure)` gives you
    // "stops" of brightness (+1 = double, +2 = 4×, etc.). Gamma curve
    // compresses highlights — numbers > 1 make brights saturate more
    // gracefully, useful after stacking Soft Glows that push the color
    // past 1.0.
    generate:(ctx) => {
      const c = ctx.tmp('hdrc');
      return {
        setup: `vec3 ${c} = ${ctx.inputs.color} * exp2(${ctx.inputs.exposure});`,
        exprs:{
          out: `pow(max(${c}, vec3(0.0)), vec3(1.0 / max(${ctx.inputs.gamma}, 0.01)))`,
        },
      };
    },
  },
  sheenLines: {
    category:'Effect', title:'Sheen Lines', desc:'thin moving streaks of light (glass/sheen)',
    inputs:[
      {name:'uv',        type:'vec2',  default:[0, 0]},
      {name:'time',      type:'float', default:0},
      {name:'angle',     type:'float', default:0.5},   // radians, direction of streaks
      {name:'count',     type:'float', default:3.0},   // number of streaks across UV
      {name:'speed',     type:'float', default:0.25},  // streak slide rate
      {name:'thickness', type:'float', default:0.12},  // softness at peak, smaller = thinner
    ],
    outputs:[{name:'out', type:'float'}],
    // Rotates the UV by `angle`, takes a scalar coord along that axis,
    // offsets it by time*speed, then builds a thin symmetric peak at each
    // cycle. Output is a [0,1] mask with narrow bright lines separated by
    // dark — looks like light sliding across a pane of glass. Wrap it with
    // a Mix (→ iridescence color) and add over a crystal body for sheen.
    generate:(ctx) => {
      const c = ctx.tmp('sho_c');
      const s = ctx.tmp('sho_s');
      const u = ctx.tmp('sho_u');
      const f = ctx.tmp('sho_f');
      const d = ctx.tmp('sho_d');
      return {
        setup:
`float ${c} = cos(${ctx.inputs.angle});
float ${s} = sin(${ctx.inputs.angle});
float ${u} = ${c} * ${ctx.inputs.uv}.x + ${s} * ${ctx.inputs.uv}.y;
float ${f} = fract(${u} * ${ctx.inputs.count} - ${ctx.inputs.time} * ${ctx.inputs.speed});
float ${d} = abs(${f} - 0.5);`,
        // peak at d=0 (center of each cycle), falloff controlled by thickness
        exprs:{ out: `(1.0 - smoothstep(0.0, max(${ctx.inputs.thickness}, 0.001), ${d}))` },
      };
    },
  },
  viewMask: {
    category:'Effect', title:'View Mask', desc:'visibility based on view rotation / cursor offset',
    inputs:[
      {name:'offset',    type:'vec2',  default:[0, 0]},   // cursor offset from centre
      {name:'threshold', type:'float', default:0.05},     // distance below which "near" is fully on
      {name:'softness',  type:'float', default:0.45},     // fade band width
    ],
    outputs:[
      {name:'near', type:'float'},   // 1 when offset is small (cursor near centre / "facing camera")
      {name:'far',  type:'float'},   // 1 when offset is large (cursor at edge / "tilted away")
    ],
    // Use to fade layers in/out as the cursor (or any "view rotation"
    // proxy) moves. Wire Sim Light → split → xy → makeVec2 (or the
    // cursor's centeredUV offset) into `offset`. Multiply a layer by
    // `near` to keep it visible only while looking head-on; by `far`
    // for a sheen / edge layer that only appears at glancing angles.
    generate:(ctx) => {
      const d = ctx.tmp('vmd');
      const f = ctx.tmp('vmf');
      return {
        setup:
`float ${d} = length(${ctx.inputs.offset});
float ${f} = smoothstep(${ctx.inputs.threshold}, ${ctx.inputs.threshold} + max(${ctx.inputs.softness}, 0.001), ${d});`,
        exprs:{
          far:  f,
          near: `(1.0 - ${f})`,
        },
      };
    },
  },
  shadowTex: {
    category:'Effect', title:'Shadow Tex', desc:'soft raycast shadow using a height-map texture (with sample blur)',
    inputs:[
      {name:'pos',      type:'vec2', default:[0, 0]},
      {name:'lightDir', type:'vec3', default:[0, 0, 1]},
    ],
    outputs:[{name:'out', type:'float'}],
    params:[
      {name:'imageUrl',    kind:'image',     default:''},
      {name:'invert',      kind:'segmented', default:'no', options:['no', 'yes']},
      {name:'heightScale', kind:'number',    default:0.06,  min:0,    max:0.5,  step:0.005},
      {name:'maxDist',     kind:'number',    default:0.12,  min:0.01, max:1,    step:0.01},
      {name:'sharpness',   kind:'number',    default:16,    min:1,    max:128,  step:1},
      // 5-tap cross-pattern blur radius (UV units). Smooths out per-pixel
      // noise in the height map (e.g. brick face texture) so shadow edges
      // aren't speckled. 0 = no blur (one sample); ~0.003–0.006 = a few
      // texels at typical 1024-px heightmaps.
      {name:'blurRadius',  kind:'number',    default:0.004, min:0,    max:0.02, step:0.0005},
      // Distance-based fade-out: the per-step occlusion is lerped toward
      // "fully lit" as `t` approaches maxDist. `fadeStart` is the fraction
      // of maxDist at which the fade begins. Lower = longer soft tail
      // (shadows fade earlier); 1.0 = hard cutoff at maxDist (old behaviour).
      {name:'fadeStart',   kind:'number',    default:0.5,   min:0,    max:1,    step:0.05},
      // Spatial multi-sampling. 1 = single ray (fast). 4 = center + 3
      // offsets in a triangle pattern around it, averaged together. 9 =
      // 3×3 grid. Higher values blend each pixel's shadow with its
      // neighbours' shadows so cohesive regions emerge — at 4–9× the
      // per-pixel cost. Use `mergeRadius` to control how far the offset
      // samples sit from the centre (UV units).
      {name:'samples',     kind:'segmented', default:'1', options:['1', '4', '9']},
      {name:'mergeRadius', kind:'number',    default:0.003, min:0,    max:0.02, step:0.0005},
      {name:'darkness',    kind:'number',    default:0.45,  min:0,    max:1,    step:0.05},
    ],
    // SOFT shadow ray-march via IQ's classic accumulator + per-sample BLUR.
    // The accumulator (`min(sharpness * clearance / distance)`) gives a
    // continuous penumbra instead of a hard yes/no occlusion. The 5-tap
    // cross-pattern blur (`blurRadius` in UV units) low-pass filters the
    // height-map sample so per-pixel noise in the source texture (brick
    // face speckle, JPEG artifacts) doesn't bleed through into the shadow
    // factor. Together they produce smooth, continuous shadow edges
    // instead of the stair-stepped/Rorschach look you get from a binary
    // single-tap march.
    //
    // Cost: 24 march steps × 5 texture samples per step + 5 for the start
    // height = 125 samples per pixel. Still well within budget for typical
    // fullscreen shaders.
    generate:(ctx) => {
      const uName  = glslUniformName(ctx.node.id, 'sh');
      const result = ctx.tmp('shtR');
      const fnName = `_shtMarch_${ctx.node.id}`;     // per-instance march function

      const hs = glslNum(ctx.params.heightScale);
      const md = glslNum(ctx.params.maxDist);
      const dk = glslNum(ctx.params.darkness);
      const sk = glslNum(ctx.params.sharpness);
      const br = glslNum(ctx.params.blurRadius);
      const fs = glslNum(ctx.params.fadeStart);
      const mr = glslNum(ctx.params.mergeRadius);
      // Wrap structure: `((SUM) * 0.2)` for the 5-tap average. Invert flips
      // the outer paren to `(1.0 - (SUM) * 0.2)`. Both invPrefix opens TWO
      // parens (outer + sum-grouping), so the suffix must close TWO.
      const invPrefix = ctx.params.invert === 'yes' ? '(1.0 - (' : '((';
      const invSuffix = ') * 0.2)';

      // 5-tap cross-pattern blurred height sample, baked inline.
      const sampleH = (uvExpr) =>
        `${invPrefix}` +
        `texture2D(${uName}, fract(${uvExpr})).r + ` +
        `texture2D(${uName}, fract(${uvExpr} + vec2(-_px.x, 0.0))).r + ` +
        `texture2D(${uName}, fract(${uvExpr} + vec2( _px.x, 0.0))).r + ` +
        `texture2D(${uName}, fract(${uvExpr} + vec2(0.0, -_px.y))).r + ` +
        `texture2D(${uName}, fract(${uvExpr} + vec2(0.0,  _px.y))).r` +
        `${invSuffix}`;

      // Per-instance march function — emitted to file scope so we can call
      // it multiple times without inlining the whole 24-step loop. Returns
      // the lit factor in [darkness, 1].
      const marchFn = `
float ${fnName}(vec2 startPos, vec3 lightDir) {
  if (u_shadows < 0.5) return 1.0;
  vec2 _px = vec2(${br});
  float startH = (${sampleH('startPos')}) * ${hs};
  float lxy = length(lightDir.xy);
  if (lxy < 0.001) return 1.0;
  float occ = 1.0;
  float t; vec2 xy; float rh; float gh; float dh; float stepOcc; float distFade;
  for (int _i = 1; _i <= 24; _i++) {
    t = (float(_i) / 24.0) * ${md};
    xy = startPos + lightDir.xy * t;
    rh = startH + lightDir.z / lxy * t;
    gh = (${sampleH('xy')}) * ${hs};
    dh = rh - gh;
    distFade = smoothstep(${md} * ${fs}, ${md}, t);
    if (dh < 0.0) { occ = min(occ, distFade); break; }
    stepOcc = ${sk} * dh / t;
    occ = min(occ, mix(stepOcc, 1.0, distFade));
  }
  return mix(${dk}, 1.0, clamp(occ, 0.0, 1.0));
}`;

      // Build the per-pixel call(s) — average across N samples for
      // cohesive merged shadows.
      const samples = ctx.params.samples || '1';
      let callExpr;
      if (samples === '4') {
        // 4-sample triangle: centre + 3 around it.
        // Offsets chosen as roughly equilateral triangle around centre
        // with one centre tap, averaged.
        const r = mr;
        callExpr = `(
  ${fnName}(${ctx.inputs.pos},                                  ${ctx.inputs.lightDir}) +
  ${fnName}(${ctx.inputs.pos} + vec2(${r}, 0.0),                ${ctx.inputs.lightDir}) +
  ${fnName}(${ctx.inputs.pos} + vec2(-${r}*0.5,  ${r}*0.866),   ${ctx.inputs.lightDir}) +
  ${fnName}(${ctx.inputs.pos} + vec2(-${r}*0.5, -${r}*0.866),   ${ctx.inputs.lightDir})
) * 0.25`;
      } else if (samples === '9') {
        // 3×3 grid average.
        const r = mr;
        const offs = [];
        for (let dy = -1; dy <= 1; dy++){
          for (let dx = -1; dx <= 1; dx++){
            offs.push(`${fnName}(${ctx.inputs.pos} + vec2(${r}*${glslNum(dx)}, ${r}*${glslNum(dy)}), ${ctx.inputs.lightDir})`);
          }
        }
        callExpr = `(\n  ${offs.join(' +\n  ')}\n) * (1.0/9.0)`;
      } else {
        // Single sample (default, fastest).
        callExpr = `${fnName}(${ctx.inputs.pos}, ${ctx.inputs.lightDir})`;
      }

      return {
        setup: `float ${result} = ${callExpr};`,
        exprs:{ out: result },
        textures:[{ uniformName: uName }],
        inlineFunctions:[ marchFn ],
      };
    },
  },
  shadow: {
    category:'Effect', title:'Shadow', desc:'soft raycast heightfield shadow factor (0=shadowed, 1=lit)',
    inputs:[
      {name:'pos',      type:'vec2',  default:[0, 0]},
      {name:'lightDir', type:'vec3',  default:[0, 0, 1]},
      {name:'time',     type:'float', default:0.0},
    ],
    outputs:[{name:'out', type:'float'}],
    params:[
      {name:'scale',     kind:'number', default:2.5,  min:0.1,  max:20,  step:0.1},
      {name:'maxDist',   kind:'number', default:0.4,  min:0.05, max:2,   step:0.05},
      {name:'sharpness', kind:'number', default:16,   min:1,    max:128, step:1},
      {name:'fadeStart', kind:'number', default:0.5,  min:0,    max:1,   step:0.05},
      {name:'darkness',  kind:'number', default:0.35, min:0,    max:1,   step:0.05},
    ],
    helpers:['snoise', 'fbm', 'heightField'],
    // SOFT shadow ray-march via IQ's classic accumulator (same algorithm
    // as Shadow Tex, but the height field is the procedural FBM
    // `heightField` helper — same one Normal Map (dynamic) uses). Tracks
    // the smallest `sharpness * clearance / distance` ratio across the
    // march to produce a continuous penumbra instead of a pixelated hard
    // edge. Lower sharpness = softer/wider penumbra. 24 march steps for
    // smoothness. When the Shadows button is off (u_shadows < 0.5) the
    // node returns 1.0 immediately — zero march cost.
    generate:(ctx) => {
      const result = ctx.tmp('shRes');
      const occ    = ctx.tmp('shOcc');
      const startH = ctx.tmp('shH0');
      const lxy    = ctx.tmp('shLxy');
      const tt     = ctx.tmp('shT');
      const xy     = ctx.tmp('shXy');
      const rh     = ctx.tmp('shRh');
      const gh     = ctx.tmp('shGh');
      const dh     = ctx.tmp('shDh');
      const stepOcc  = ctx.tmp('shSO');
      const distFade = ctx.tmp('shDF');
      const sc = glslNum(ctx.params.scale);
      const md = glslNum(ctx.params.maxDist);
      const sk = glslNum(ctx.params.sharpness);
      const fs = glslNum(ctx.params.fadeStart);
      const dk = glslNum(ctx.params.darkness);
      return {
        setup:
`float ${result} = 1.0;
if (u_shadows > 0.5) {
  float ${startH} = heightField(${ctx.inputs.pos}, ${sc}, ${ctx.inputs.time});
  float ${lxy} = length(${ctx.inputs.lightDir}.xy);
  if (${lxy} > 0.001) {
    float ${occ} = 1.0;
    float ${tt}; vec2 ${xy}; float ${rh}; float ${gh}; float ${dh};
    float ${stepOcc}; float ${distFade};
    for (int _shi = 1; _shi <= 24; _shi++) {
      ${tt} = (float(_shi) / 24.0) * ${md};
      ${xy} = ${ctx.inputs.pos} + ${ctx.inputs.lightDir}.xy * ${tt};
      ${rh} = ${startH} + ${ctx.inputs.lightDir}.z / ${lxy} * ${tt};
      ${gh} = heightField(${xy}, ${sc}, ${ctx.inputs.time});
      ${dh} = ${rh} - ${gh};
      ${distFade} = smoothstep(${md} * ${fs}, ${md}, ${tt});
      if (${dh} < 0.0) { ${occ} = min(${occ}, ${distFade}); break; }
      ${stepOcc} = ${sk} * ${dh} / ${tt};
      ${occ} = min(${occ}, mix(${stepOcc}, 1.0, ${distFade}));
    }
    ${result} = mix(${dk}, 1.0, clamp(${occ}, 0.0, 1.0));
  }
}`,
        exprs:{ out: result },
      };
    },
  },
  lambert: {
    category:'Effect', title:'Lambert', desc:'diffuse lighting: max(N·L, 0)',
    inputs:[
      {name:'normal',   type:'vec3', default:[0, 0, 1]},
      {name:'lightDir', type:'vec3', default:[0.4, 0.6, 1.0]},
      {name:'ambient',  type:'float', default:0.15},   // floor value so shadowed sides aren't pitch black
    ],
    outputs:[{name:'out', type:'float'}],
    // Classic N·L diffuse term clamped to [0, 1], then mixed with an
    // ambient floor so the back side of an object still reads. Multiply
    // a surface color by this for basic directional shading.
    generate:(ctx) => {
      const d = ctx.tmp('lmd');
      return {
        setup: `float ${d} = max(dot(normalize(${ctx.inputs.normal}), normalize(${ctx.inputs.lightDir})), 0.0);`,
        exprs:{ out: `mix(${ctx.inputs.ambient}, 1.0, ${d})` },
      };
    },
  },
  fresnel: {
    category:'Effect', title:'Fresnel', desc:'edge-glow factor: pow(1 − |N·V|, power)',
    inputs:[
      {name:'normal', type:'vec3',  default:[0, 0, 1]},
      {name:'view',   type:'vec3',  default:[0, 0, 1]},
      {name:'power',  type:'float', default:2.5},
    ],
    outputs:[{name:'out', type:'float'}],
    // Classic rim-glow term. Output ≈ 0 where the surface faces the viewer
    // (normal parallel to view), ≈ 1 at grazing angles. Multiply a bright
    // color by this and add on top of your shaded surface for glass / wet /
    // crystal edges. `power` controls how thin the rim is (higher = thinner).
    generate:(ctx) => {
      const d = ctx.tmp('fdot');
      return {
        setup: `float ${d} = 1.0 - abs(dot(normalize(${ctx.inputs.normal}), normalize(${ctx.inputs.view})));`,
        exprs:{ out: `pow(${d}, ${ctx.inputs.power})` },
      };
    },
  },
  iridescence: {
    category:'Effect', title:'Iridescence', desc:'angle-shifting rainbow (oil/soap/crystal)',
    inputs:[
      {name:'normal', type:'vec3',  default:[0, 0, 1]},
      {name:'freq',   type:'float', default:4.0},   // number of rainbow cycles as angle sweeps 0→1
      {name:'bias',   type:'float', default:0.0},   // phase offset — rotates the color wheel
    ],
    outputs:[{name:'out', type:'vec3'}],
    // Uses the surface normal's Z (toward-viewer) component as the angle
    // factor. Runs a cosine palette with phase-shifted channels so R, G, B
    // cycle at different offsets — that's what gives the thin-film rainbow
    // shift across the surface as the normal varies.
    generate:(ctx) => {
      const a = ctx.tmp('ianb');
      const t = ctx.tmp('itt');
      return {
        setup:
`float ${a} = 1.0 - abs(normalize(${ctx.inputs.normal}).z);
float ${t} = ${a} * ${ctx.inputs.freq} + ${ctx.inputs.bias};`,
        exprs:{
          out: `(vec3(0.5) + vec3(0.5) * cos(6.28318 * (${t} + vec3(0.0, 0.333, 0.667))))`,
        },
      };
    },
  },
  vignette: {
    category:'Effect', title:'Vignette', desc:'darken edges',
    inputs:[
      {name:'color', type:'vec3', default:[0,0,0]},
      {name:'uv', type:'vec2', default:[0.5, 0.5]},
    ],
    outputs:[{name:'out', type:'vec3'}],
    params:[{name:'strength', kind:'number', default:1.15, min:0, max:3, step:0.01}],
    generate:(ctx) => {
      const v = ctx.tmp('vig');
      return {
        setup:`float ${v} = smoothstep(0.0, 1.0, 1.0 - length(${ctx.inputs.uv} - 0.5) * ${glslNum(ctx.params.strength)});`,
        exprs:{ out:`(${ctx.inputs.color} * ${v})` },
      };
    },
  },
  mouseGlow: {
    category:'Effect', title:'Mouse Glow', desc:'warm halo at cursor',
    inputs:[
      {name:'uv', type:'vec2', default:[0.5, 0.5]},
      {name:'color', type:'vec3', default:[1,1,1]},
    ],
    outputs:[{name:'out', type:'vec3'}, {name:'influence', type:'float'}],
    params:[
      {name:'radius', kind:'number', default:0.8, min:0.05, max:3, step:0.01},
      {name:'intensity', kind:'number', default:0.09, min:0, max:1, step:0.01},
    ],
    generate:(ctx) => {
      const d = ctx.tmp('mglowd');
      const g = ctx.tmp('mglowg');
      return {
        setup:`
          float ${d} = length((${ctx.inputs.uv} - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0) - (u_mouse - 0.5) * vec2(u_resolution.x/u_resolution.y, 1.0));
          float ${g} = exp(-${d} * ${d} * 8.0) * ${glslNum(ctx.params.intensity * 10)};
        `,
        exprs:{
          out:`(${ctx.inputs.color} * ${g})`,
          influence:`smoothstep(${glslNum(ctx.params.radius)}, 0.0, ${d}) * 0.15`,
        },
      };
    },
  },

  /* Photoshop-style blend between two colors. Each mode emits a different
     GLSL expression; overlay/soft-light need a setup block for per-channel
     branching via step(). The final result is mix(base, blended, amount)
     so `amount` acts like a layer opacity slider. */
  blend: {
    category:'Effect', title:'Blend', desc:'combine two colors (10 modes)',
    inputs:[
      {name:'a',      type:'vec3',  default:[0,0,0]},  // base
      {name:'b',      type:'vec3',  default:[1,1,1]},  // top
      {name:'amount', type:'float', default:1.0},       // 0..1 opacity
    ],
    outputs:[{name:'out', type:'vec3'}],
    params:[{
      name:'mode', kind:'select', default:'normal',
      options:['normal','multiply','screen','overlay','softLight','darken','lighten','difference','exclusion','add'],
    }],
    generate:(ctx) => {
      const a = ctx.inputs.a, b = ctx.inputs.b, t = ctx.inputs.amount;
      const mode = ctx.params.mode;
      let setup = '';
      let blended;

      if (mode === 'overlay'){
        const at = ctx.tmp('ova'), bt = ctx.tmp('ovb');
        const lo = ctx.tmp('ovlo'), hi = ctx.tmp('ovhi');
        setup = `vec3 ${at} = ${a}; vec3 ${bt} = ${b};\n` +
                `vec3 ${lo} = 2.0 * ${at} * ${bt};\n` +
                `vec3 ${hi} = 1.0 - 2.0 * (1.0 - ${at}) * (1.0 - ${bt});`;
        blended = `mix(${lo}, ${hi}, step(0.5, ${at}))`;
      } else if (mode === 'softLight'){
        // Pegtop-style approximation — smooth and cheap, close to Photoshop.
        const at = ctx.tmp('sla'), bt = ctx.tmp('slb');
        setup = `vec3 ${at} = ${a}; vec3 ${bt} = ${b};`;
        blended = `((1.0 - 2.0 * ${bt}) * ${at} * ${at} + 2.0 * ${bt} * ${at})`;
      } else {
        switch (mode){
          case 'multiply':   blended = `(${a} * ${b})`; break;
          case 'screen':     blended = `(1.0 - (1.0 - ${a}) * (1.0 - ${b}))`; break;
          case 'darken':     blended = `min(${a}, ${b})`; break;
          case 'lighten':    blended = `max(${a}, ${b})`; break;
          case 'difference': blended = `abs(${a} - ${b})`; break;
          case 'exclusion':  blended = `(${a} + ${b} - 2.0 * ${a} * ${b})`; break;
          case 'add':        blended = `(${a} + ${b})`; break;
          default:           blended = `${b}`;  // "normal"
        }
      }

      return {
        setup,
        exprs:{
          out:`clamp(mix(${a}, ${blended}, clamp(${t}, 0.0, 1.0)), vec3(0.0), vec3(1.0))`,
        },
      };
    },
  },

  /* ---- layered material compositor ---- */
  layerStack: {
    category:'Module', title:'Layer Stack', desc:'composite N material layers with per-layer blend mode + opacity',
    // Dynamic schema: 1 base input + numLayers layer inputs. Output is a
    // single composited vec3. Per-layer opacity (0..1) and blend mode are
    // params edited inline on the node body.
    inputs: (node) => {
      const n = (node && node.params && node.params.numLayers) || 0;
      const list = [{ name: 'base', type: 'vec3', default: [0, 0, 0] }];
      for (let i = 0; i < n; i++){
        list.push({ name: `layer${i}`, type: 'vec3', default: [0, 0, 0] });
      }
      return list;
    },
    outputs: () => [{ name: 'out', type: 'vec3' }],
    customBody: 'layerStack',
    params: [
      { name: 'numLayers', kind: 'hidden', default: 2 },
      { name: 'opacity',   kind: 'hidden', default: [1.0, 1.0] },
      { name: 'modes',     kind: 'hidden', default: ['normal', 'multiply'] },
    ],
    // For each layer i, blend `result` (so far) with `layer_i` using mode_i,
    // then lerp by opacity_i. Mirrors the inline blend node semantics.
    generate: (ctx) => {
      const numL    = (ctx.node.params.numLayers) || 0;
      const opacity = Array.isArray(ctx.node.params.opacity) ? ctx.node.params.opacity : [];
      const modes   = Array.isArray(ctx.node.params.modes)   ? ctx.node.params.modes   : [];

      let result = ctx.inputs.base;
      const setup = [];
      for (let i = 0; i < numL; i++){
        const layerExpr = ctx.inputs[`layer${i}`];
        const mode = modes[i] || 'normal';
        const op   = opacity[i] != null ? opacity[i] : 1.0;
        let blended;
        switch (mode){
          case 'multiply':   blended = `(${result} * ${layerExpr})`; break;
          case 'screen':     blended = `(vec3(1.0) - (vec3(1.0) - ${result}) * (vec3(1.0) - ${layerExpr}))`; break;
          case 'add':        blended = `(${result} + ${layerExpr})`; break;
          case 'darken':     blended = `min(${result}, ${layerExpr})`; break;
          case 'lighten':    blended = `max(${result}, ${layerExpr})`; break;
          case 'difference': blended = `abs(${result} - ${layerExpr})`; break;
          default:           blended = layerExpr;   // normal = replace
        }
        const tmp = ctx.tmp(`ls${i}`);
        setup.push(`vec3 ${tmp} = clamp(mix(${result}, ${blended}, clamp(${glslNum(op)}, 0.0, 1.0)), vec3(0.0), vec3(1.0));`);
        result = tmp;
      }
      return {
        setup: setup.join('\n'),
        exprs: { out: result },
      };
    },
  },

  /* ---- patch bay / debug routing ---- */
  flag: {
    category:'Module', title:'Flag', desc:'patch bay — internally wire inputs to outputs, toggle each',
    // Dynamic schema: the input / output socket lists are derived from the
    // `numInputs` / `numOutputs` params at render + compile time. See
    // getNodeInputs / getNodeOutputs in graph-state.js and the editor's
    // customBody path in renderNode.
    inputs:  (node) => {
      const n = (node && node.params && node.params.numInputs) || 0;
      const list = [];
      for (let i = 0; i < n; i++) list.push({ name: `in${i}`, type: 'vec3', default: [0, 0, 0] });
      return list;
    },
    outputs: (node) => {
      const n = (node && node.params && node.params.numOutputs) || 0;
      const list = [];
      for (let j = 0; j < n; j++) list.push({ name: `out${j}`, type: 'vec3' });
      return list;
    },
    // The editor renders a bespoke body (internal sockets + wires + toggles).
    // Normal param rows aren't drawn — see editor.js renderFlagBody.
    customBody: 'flag',
    params: [
      { name:'numInputs',  kind:'hidden', default: 3 },
      { name:'numOutputs', kind:'hidden', default: 3 },
      { name:'enabled',    kind:'hidden', default: [true, true, true] },
      { name:'wires',      kind:'hidden', default: [] },   // [{from:inputIdx, to:outputIdx}]
    ],
    // For each module output j:
    //   - if enabled[j] is false → vec3(0)
    //   - otherwise sum every input wired to j; if none, vec3(0)
    generate: (ctx) => {
      const numOut  = (ctx.node.params.numOutputs) || 0;
      const enabled = Array.isArray(ctx.node.params.enabled) ? ctx.node.params.enabled : [];
      const wires   = Array.isArray(ctx.node.params.wires)   ? ctx.node.params.wires   : [];
      const exprs = {};
      for (let j = 0; j < numOut; j++){
        if (enabled[j] === false){
          exprs[`out${j}`] = 'vec3(0.0)';
          continue;
        }
        const feeds = wires
          .filter(w => w.to === j)
          .map(w => ctx.inputs[`in${w.from}`])
          .filter(Boolean);
        if (feeds.length === 0)      exprs[`out${j}`] = 'vec3(0.0)';
        else if (feeds.length === 1) exprs[`out${j}`] = feeds[0];
        else                         exprs[`out${j}`] = `(${feeds.join(' + ')})`;
      }
      return { exprs };
    },
  },

  /* ---- terminal ---- */
  output: {
    category:'Output', title:'Fragment Output', desc:'gl_FragColor + specular-driven bloom',
    // `specular` is a per-pixel reflectivity mask (0 = matte, 1 = mirror).
    // The renderer writes it into the scene FBO's alpha channel, and the
    // bloom pass uses it to decide which pixels glow — so a Fresnel / spec
    // map can light up only the shiny parts instead of everything bright.
    // Default 1.0 when unconnected preserves the old luminance-only behavior.
    inputs:[
      {name:'color',    type:'vec3',  default:[0, 0, 0]},
      {name:'specular', type:'float', default:1.0},
    ],
    outputs:[],
    // Bloom params are consumed by the renderer (not by `generate`). When
    // `bloom` is 'on' the renderer switches to a multi-pass pipeline:
    // render to an offscreen FBO, H-blur with threshold, V-blur, composite.
    params:[
      {name:'bloom',          kind:'segmented', default:'off',
       options:['off','on']},
      {name:'bloomThreshold', kind:'number', default:0.60, min:0.0, max:2.0, step:0.01,
       visibleWhen:p => p.bloom === 'on'},
      {name:'bloomRadius',    kind:'number', default:2.0, min:0.1, max:10.0, step:0.1,
       visibleWhen:p => p.bloom === 'on'},
      {name:'bloomIntensity', kind:'number', default:1.0, min:0.0, max:3.0, step:0.05,
       visibleWhen:p => p.bloom === 'on'},
    ],
    generate:(ctx) => ({
      // .rgb = final color, .a = specular mask. The bloom pass reads alpha.
      setup:`gl_FragColor = vec4(clamp(${ctx.inputs.color}, 0.0, 1.0), clamp(${ctx.inputs.specular}, 0.0, 1.0));`,
      exprs:{},
    }),
  },
};
