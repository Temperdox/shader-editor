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
  resolution: {
    category:'Input', title:'Resolution', desc:'canvas size in px',
    inputs:[], outputs:[{name:'out', type:'vec2'}],
    generate:() => ({ exprs:{ out:'u_resolution' } }),
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

  /* ---- terminal ---- */
  output: {
    category:'Output', title:'Fragment Output', desc:'gl_FragColor',
    inputs:[{name:'color', type:'vec3', default:[0,0,0]}],
    outputs:[],
    generate:(ctx) => ({
      setup:`gl_FragColor = vec4(clamp(${ctx.inputs.color}, 0.0, 1.0), 1.0);`,
      exprs:{},
    }),
  },
};
