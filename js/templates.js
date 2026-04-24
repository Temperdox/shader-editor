/* Built-in shader templates.
 *
 * Each template has { name, desc, load } where load() wipes state and populates
 * it with the template's graph. The "Load Template" button opens a picker that
 * lists all of these; clicking one mutates state and triggers a recompile.
 *
 * Templates mutate state directly (same pattern as seedDefaultGraph) rather
 * than returning a graph object — keeps the wiring code terse and consistent
 * with the rest of the editor.
 */

// Shorthand helpers shared by every template body. We redeclare them per
// template so each build function stays self-contained and easy to read.
// The optional `defaults` arg on `n` overrides unconnected-socket literals —
// useful for demonstrating inline value inputs on nodes like Combine.
function _tplHelpers(){
  const n = (type, x, y, params = {}, defaults = {}) => {
    const node = makeNode(type, x, y);
    Object.assign(node.params, params);
    Object.assign(node.defaults, defaults);
    state.nodes.push(node);
    return node;
  };
  const c = (from, fsock, to, tsock) => {
    state.connections.push({
      id: uid('c'),
      from: { nodeId: from.id, socket: fsock },
      to:   { nodeId: to.id,   socket: tsock },
    });
  };
  return { n, c };
}

function _clearGraph(){
  state.nodes = [];
  state.connections = [];
}

/* ---------------- Marble Gold — the original dossier shader ---------------- */
function tplMarbleGold(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV', -820,  -40);
  const time   = n('time',       -820,  210);
  const marble = n('marble',     -480,   80, { scale: 2.0 });
  const veins  = n('veins',      -480,  280, { frequency: 4.0, sharpness: 2.5 });

  const base   = n('color', -160, -120, { rgb: [0.04, 0.03, 0.012] });
  const gold   = n('color', -160,   60, { rgb: [0.78, 0.58, 0.20] });
  const deep   = n('color', -160,  240, { rgb: [0.42, 0.30, 0.09] });

  const baseMix = n('mix', 180, -30);
  const goldMix = n('mix', 500,  60);
  const deepMix = n('mix', 820, 120);

  const vig    = n('vignette', 1140,  90, { strength: 1.15 });
  const uvIn   = n('uv',       1140, 260);

  const out    = n('output', 1440, 100);

  c(cuv, 'p',  marble, 'p');  c(time, 'out', marble, 'time');
  c(cuv, 'p',  veins,  'p');  c(time, 'out', veins,  'time');
  c(base,  'out', baseMix, 'a');
  c(gold,  'out', baseMix, 'b');
  c(veins, 'out', baseMix, 't');
  c(baseMix, 'out',     goldMix, 'a');
  c(deep,    'out',     goldMix, 'b');
  c(marble,  'pattern', goldMix, 't');
  c(goldMix, 'out', deepMix, 'a');
  c(gold,    'out', deepMix, 'b');
  c(veins,   'out', deepMix, 't');
  c(deepMix, 'out', vig, 'color');
  c(uvIn,    'out', vig, 'uv');
  c(vig,     'out', out, 'color');
}

/* ---------------- Normal Preview — shows the new normalMap node ---------------- */
function tplNormalPreview(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV',     -520,  40);
  const time   = n('time',           -520, 220);
  const normal = n('normalMap',      -160,  80, { scale: 2.5, strength: 3.0, epsilon: 0.004 });
  const color  = n('normalToColor',   220,  80);
  const out    = n('output',          560,  80);

  c(cuv,    'p',       normal, 'p');
  c(time,   'out',     normal, 'time');
  c(normal, 'normal',  color,  'n');
  c(color,  'out',     out,    'color');
}

/* ---------------- Height Field — visualizes heightMap as grayscale ---------------- */
function tplHeightField(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV', -600,  20);
  const time   = n('time',       -600, 200);
  const height = n('heightMap',  -240,  80, { scale: 1.5 });
  const gray   = n('grayscale',   120,  80);

  const uvIn   = n('uv',          120, 240);
  const vig    = n('vignette',    440, 100, { strength: 1.05 });
  const out    = n('output',      760, 100);

  c(cuv,    'p',      height, 'p');
  c(time,   'out',    height, 'time');
  c(height, 'height', gray,   'x');
  c(gray,   'out',    vig,    'color');
  c(uvIn,   'out',    vig,    'uv');
  c(vig,    'out',    out,    'color');
}

/* ---------------- Terrain Relief — heightMap + normalMap composited ---------------- */
/* Height modulates luminance while the normal's Z component (facing-ness)
   acts as a cheap diffuse term — the result reads like shaded terrain. */
function tplTerrainRelief(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv     = n('centeredUV',  -820,   0);
  const time    = n('time',        -820, 200);
  const height  = n('heightMap',   -500,  60, { scale: 1.8 });
  const normal  = n('normalMap',   -500, 260, { scale: 1.8, strength: 6.0, epsilon: 0.003 });
  const nColor  = n('normalToColor', -160, 260);

  // tint the height: dark valley → bright peak
  const valley  = n('color',       -160, -60, { rgb: [0.06, 0.10, 0.08] });
  const peak    = n('color',       -160, 120, { rgb: [0.92, 0.86, 0.72] });
  const tint    = n('mix',           160,  60);

  // multiply tint by normalColor to fake directional shading
  const shaded  = n('mix',           500,  120);
  const half    = n('float',        160, 260, { value: 0.6 });

  const out     = n('output',        820, 120);

  c(cuv,    'p',       height, 'p');
  c(time,   'out',     height, 'time');
  c(cuv,    'p',       normal, 'p');
  c(time,   'out',     normal, 'time');
  c(normal, 'normal',  nColor, 'n');

  c(valley, 'out',     tint, 'a');
  c(peak,   'out',     tint, 'b');
  c(height, 'height',  tint, 't');

  c(tint,   'out',     shaded, 'a');
  c(nColor, 'out',     shaded, 'b');
  c(half,   'out',     shaded, 't');

  c(shaded, 'out',     out, 'color');
}

/* ---------------- Channel Mixer — demos Combine, Split Vec2, inline values ----------------
 * UV (vec2) is split into x/y floats, swapped, and fed back into a Combine
 * node. The Combine's `z` input is left UNCONNECTED and its inline default is
 * bumped to 0.4 — that's what renders the purple tint and shows off the new
 * inline value-input field on unconnected sockets.
 */
function tplChannelMixer(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv       = n('uv',         -700,  20);
  const split    = n('splitVec2',  -360,  80);
  // combine with z's default bumped to 0.4 so the unconnected z-input
  // shows that value in its inline editor.
  const combine  = n('combine',      20,  80, {}, { z: 0.4 });
  const out      = n('output',      420,  100);

  c(uv,      'out', split,   'v');
  // swap: Combine.x <= split.y, Combine.y <= split.x — rotates the UV gradient
  c(split,   'y',   combine, 'x');
  c(split,   'x',   combine, 'y');
  // combine.z stays unconnected and reads its inline default (0.4)

  c(combine, 'xyz', out, 'color');
}

/* ---------------- Marble Onyx — Marble Gold stripped of the gold veining ----
 * Same warped-FBM marble pattern as the dossier preset, but the gold-color
 * mix chain (baseMix / goldMix / deepMix + the veins node) is gone. The
 * pattern drives a single dark→silver mix so you get a clean polished-stone
 * look without the warm splotches.
 */
function tplMarbleOnyx(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV', -640,   0);
  const time   = n('time',       -640, 200);
  const marble = n('marble',     -300,  80, { scale: 2.2 });

  const dark   = n('color',      -300, -220, { rgb: [0.035, 0.035, 0.050] });
  const light  = n('color',      -300, -400, { rgb: [0.780, 0.800, 0.850] });

  const tint   = n('mix',          40,   40);
  const uvIn   = n('uv',           40,  220);
  const vig    = n('vignette',    380,   80, { strength: 1.20 });
  const out    = n('output',      700,   80);

  c(cuv,  'p',       marble, 'p');
  c(time, 'out',     marble, 'time');

  c(dark,   'out',      tint, 'a');
  c(light,  'out',      tint, 'b');
  c(marble, 'pattern',  tint, 't');

  c(tint, 'out', vig, 'color');
  c(uvIn, 'out', vig, 'uv');
  c(vig,  'out', out, 'color');
}

/* ---------------- Lit Heightfield — Height Map + Normal Map composed together
 * Height drives a low→high color ramp (deep blue valleys → warm sand peaks),
 * and the normal's Z component modulates brightness: flat ground stays lit,
 * cliff faces (low nz) fall into shadow. Matching `scale` on both nodes keeps
 * the surface and its shading in lock-step.
 */
function tplLitHeightfield(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV', -820,   0);
  const time   = n('time',       -820, 220);

  const height = n('heightMap',  -480,   0,   { scale: 1.8 });
  const normal = n('normalMap',  -480, 220,   { scale: 1.8, strength: 5.0, epsilon: 0.004 });
  const split  = n('splitVec3',  -140, 220);  // we want the normal's Z (up-facing term)

  const valley = n('color',      -820, -240, { rgb: [0.08, 0.12, 0.28] }); // deep blue
  const peak   = n('color',      -820, -420, { rgb: [0.96, 0.90, 0.72] }); // warm sand

  // elevation tint: mix(valley, peak, height)
  const tint   = n('mix',         -140, -100);

  // shade: mix(black, tint, normal.z) — nz → 1 means "facing up" → fully lit
  const black  = n('color',        200,  260, { rgb: [0, 0, 0] });
  const shade  = n('mix',          460,   60);

  const out    = n('output',       780,   60);

  c(cuv,  'p',   height, 'p');
  c(time, 'out', height, 'time');
  c(cuv,  'p',   normal, 'p');
  c(time, 'out', normal, 'time');

  c(normal, 'normal', split, 'v');

  c(valley, 'out',    tint, 'a');
  c(peak,   'out',    tint, 'b');
  c(height, 'height', tint, 't');

  c(black, 'out', shade, 'a');
  c(tint,  'out', shade, 'b');
  c(split, 'b',   shade, 't');   // normal.z as the lighting coefficient

  c(shade, 'out', out, 'color');
}

/* ---------------- Blend Demo — shows the Blend node combining two gradients ----
 * Horizontal warm gradient (red → yellow, driven by UV.x) on one layer.
 * Vertical cool gradient (navy → sky, driven by UV.y) on the other layer.
 * A Blend node combines them in overlay mode so the diagonal bright spot
 * pops — try changing `mode` on the Blend node (multiply, screen, difference,
 * etc.) to see the other modes in-place.
 */
function tplBlendDemo(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv    = n('uv',        -740,   20);
  const split = n('splitVec2', -420,   20);

  // layer A — warm horizontal gradient
  const warm1  = n('color', -420, -220, { rgb: [0.95, 0.28, 0.18] });  // red-orange
  const warm2  = n('color', -420, -400, { rgb: [1.00, 0.82, 0.30] });  // warm gold
  const layerA = n('mix',   -100, -160);

  // layer B — cool vertical gradient
  const cool1  = n('color', -420, 220, { rgb: [0.06, 0.10, 0.40] });   // deep navy
  const cool2  = n('color', -420, 400, { rgb: [0.35, 0.82, 0.96] });   // sky cyan
  const layerB = n('mix',   -100, 260);

  // the blend — overlay gives a punchy cross-fade; try the mode dropdown
  const blend = n('blend',  260, 40, { mode: 'overlay' });
  const out   = n('output', 620, 40);

  c(uv, 'out', split, 'v');

  c(warm1, 'out', layerA, 'a');
  c(warm2, 'out', layerA, 'b');
  c(split, 'x',   layerA, 't');

  c(cool1, 'out', layerB, 'a');
  c(cool2, 'out', layerB, 'b');
  c(split, 'y',   layerB, 't');

  c(layerA, 'out', blend, 'a');
  c(layerB, 'out', blend, 'b');
  // Blend.amount stays at its default 1.0 (visible via the inline editor)

  c(blend, 'out', out, 'color');
}

/* ---------------- Brick Wall — static diffuse + normal map pair ----
 * Uses real textures shipped in `assets/textures/brick-wall/`. Flow:
 *   UV → Texture (diffuse) → rgb
 *   UV → Normal Map (static) → normal → Split → .b (up-facing coefficient)
 *   mix(black, rgb, nz) → shaded diffuse, so bricks catch "overhead light"
 * The spec map is intentionally not wired up — the template stays simple,
 * and users can add another Texture node pointing at the spec PNG and blend
 * its `r` output into the final color to experiment.
 */
function tplBrickWall(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  // Relative paths to the PNGs (TGA originals live under the same folder in
  // source/). Works for local file:// opens thanks to the crossOrigin guard
  // in textures.js.
  const DIFF_URL = 'assets/textures/brick-wall/diffuse.png';
  const NORM_URL = 'assets/textures/brick-wall/normal.png';

  const uv = n('uv', -780, 40);

  // generic Texture node for the albedo — rgb output drives the surface color
  const diff = n('texture', -480, -80, { imageUrl: DIFF_URL });

  // Normal Map in static mode — reuses the existing node, imageUrl param
  const norm = n('normalMap', -480, 200, {
    mode: 'static',
    imageUrl: NORM_URL,
  });

  // Split the normal to pull out the Z component ("how up-facing is this pixel?")
  const split = n('splitVec3', -140, 200);

  // Fake overhead light: mix(black, diffuse, normal.z). Flat bricks stay lit,
  // recessed mortar darkens automatically because its normal tilts off-axis.
  const black = n('color',  -140, -280, { rgb: [0, 0, 0] });
  const shade = n('mix',     220,   40);

  const out   = n('output',  540,   40);

  c(uv, 'out', diff, 'p');
  c(uv, 'out', norm, 'p');

  c(norm, 'normal', split, 'v');

  c(black, 'out', shade, 'a');
  c(diff,  'rgb', shade, 'b');
  c(split, 'b',   shade, 't');

  c(shade, 'out', out, 'color');
}

/* ---------------- Brick Wall + Spec — adds a specular-highlight pass ----
 * Extends the Brick Wall template: same diffuse + normal pipeline, plus a
 * third Texture node sampling the spec map. Its `.r` output (single-channel
 * shininess) is promoted to a gray vec3 and screen-blended onto the shaded
 * diffuse at low amount — a cheap fake specular highlight that makes the
 * brick faces catch light and leaves the mortar matte (because the mortar
 * is dark in the spec map).
 *
 * Try toggling the Blend mode from `screen` → `add` for a hotter look, or
 * raising the Blend amount for chrome-y mortar.
 */
function tplBrickWallSpec(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const DIFF_URL = 'assets/textures/brick-wall/diffuse.png';
  const NORM_URL = 'assets/textures/brick-wall/normal.png';
  const SPEC_URL = 'assets/textures/brick-wall/spec.png';

  const uv = n('uv', -820, 40);

  // Diffuse + Normal (same structure as tplBrickWall)
  const diff  = n('texture',   -520, -100, { imageUrl: DIFF_URL });
  const norm  = n('normalMap', -520,  180, {
    mode: 'static',
    imageUrl: NORM_URL,
  });
  const split = n('splitVec3', -200,  180);

  const black = n('color',     -200, -320, { rgb: [0, 0, 0] });
  const shade = n('mix',        140,  -20);   // shaded = mix(black, diff.rgb, normal.z)

  // Spec pass — third Texture node reading the spec map as a single-channel mask
  const spec  = n('texture',   -520, 420, { imageUrl: SPEC_URL });
  const gray  = n('grayscale', -200, 420);    // float spec.r → vec3(r,r,r)

  // Cheap specular: screen-blend the spec layer onto the shaded diffuse.
  // amount=0.35 is the "low amount" sweet spot; bumping to ~0.7 makes the
  // bricks look wet.
  const blend = n('blend',      460,   40, { mode: 'screen' }, { amount: 0.35 });

  const out   = n('output',     760,   40);

  // wiring
  c(uv, 'out', diff, 'p');
  c(uv, 'out', norm, 'p');
  c(uv, 'out', spec, 'p');

  c(norm, 'normal', split, 'v');

  c(black, 'out', shade, 'a');
  c(diff,  'rgb', shade, 'b');
  c(split, 'b',   shade, 't');

  c(spec, 'r',   gray,  'x');

  c(shade, 'out', blend, 'a');
  c(gray,  'out', blend, 'b');
  // blend.amount is left unconnected — the template seeded the socket default
  // to 0.35 above, so the inline editor on the node shows "0.35" out of the box.

  c(blend, 'out', out, 'color');
}

/* ---------------- Radial Pulse — animated distance-to-center gradient ---------------- */
function tplRadialPulse(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv    = n('centeredUV', -640, 40);
  const time   = n('time',       -640, 220);

  // add a time-wobble to the distance so the ring pulses
  const wobble = n('sin',        -300, 220);
  const scale  = n('float',      -300, 320, { value: 2.2 });
  const scaled = n('multiply',    -40, 270);

  const dist   = n('add',         -40,  60);
  const softer = n('smoothstep',   260,  80);
  const a0     = n('float',        260, 180, { value: 0.0 });
  const a1     = n('float',        260, 240, { value: 0.9 });

  const inner  = n('color',       260, 300, { rgb: [1.00, 0.62, 0.22] });
  const outer  = n('color',       260, 380, { rgb: [0.12, 0.03, 0.20] });
  const final  = n('mix',         620, 160);

  const out    = n('output',      940, 160);

  c(time,   'out', wobble, 'x');
  c(wobble, 'out', scaled, 'a');
  c(scale,  'out', scaled, 'b');

  c(cuv,    'dist', dist, 'a');
  c(scaled, 'out',  dist, 'b');

  c(a0,    'out', softer, 'a');
  c(a1,    'out', softer, 'b');
  c(dist,  'out', softer, 'x');

  c(inner, 'out', final, 'a');
  c(outer, 'out', final, 'b');
  c(softer,'out', final, 't');

  c(final, 'out', out, 'color');
}

/* ============================================================
 * SHOWCASE TEMPLATES — fun/wild creative shaders to start from.
 * ============================================================ */

/* ---- Aurora — flowing curtains in aurora green & purple ---- */
function tplAurora(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv  = n('centeredUV', -760, -20);
  // slow time so the curtain drift is languid, not frantic
  const time = n('time',       -760, 180, { scale: 0.25 });

  // warped FBM gives the organic curtain motion
  const marb = n('marble', -440, 80, { scale: 3.0 });

  // three-layer color ramp: deep-space navy → aurora green → violet hotspots
  const navy  = n('color', -440, -280, { rgb: [0.02, 0.04, 0.12] });
  const green = n('color', -440, -440, { rgb: [0.20, 0.95, 0.55] });
  const violet= n('color', -440, -600, { rgb: [0.55, 0.25, 0.90] });

  // first mix: navy → green across the full pattern
  const mix1 = n('mix', -80, -60);
  // second mix: overlay violet only in the brightest bands, via pow(pattern, 3)
  const pow3 = n('pow',  -80, 140);
  const p3e  = n('float',-260, 260, { value: 3.0 });
  const mix2 = n('mix',   260, -20);

  const out  = n('output', 560, -20);

  c(cuv,  'p',       marb, 'p');
  c(time, 'out',     marb, 'time');

  c(navy,  'out',    mix1, 'a');
  c(green, 'out',    mix1, 'b');
  c(marb,  'pattern',mix1, 't');

  c(marb, 'pattern', pow3, 'x');
  c(p3e,  'out',     pow3, 'e');

  c(mix1,   'out', mix2, 'a');
  c(violet, 'out', mix2, 'b');
  c(pow3,   'out', mix2, 't');

  c(mix2, 'out', out, 'color');
}

/* ---- Lava Flow — molten warped texture with glowing veins ---- */
function tplLavaFlow(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv  = n('centeredUV', -800, -20);
  const time = n('time',       -800, 180, { scale: 0.35 });

  const marb  = n('marble', -480,  60, { scale: 4.0 });
  const veins = n('veins',  -480, 280, { frequency: 5.0, sharpness: 3.0 });

  // molten palette: near-black rock → dark red → orange → hot yellow
  const black = n('color', -480, -280, { rgb: [0.02, 0.01, 0.00] });
  const dRed  = n('color', -480, -440, { rgb: [0.45, 0.06, 0.02] });
  const orng  = n('color', -480, -600, { rgb: [0.95, 0.45, 0.10] });
  const ylw   = n('color', -480, -760, { rgb: [1.00, 0.95, 0.35] });

  // base: black → dark red by the marble pattern
  const mix1 = n('mix', -120, -80);
  // add orange in the veins (hot cracks)
  const mix2 = n('mix',  200,  40);
  // highlight brightest specks with yellow, gated by pattern^5
  const hot  = n('pow',  200,  260);
  const hotE = n('float', 20,  320, { value: 5.0 });
  const mix3 = n('mix',  520,  120);

  const uvIn = n('uv',   520, 280);
  const vig  = n('vignette', 820, 160, { strength: 1.20 });
  const out  = n('output', 1120, 160);

  c(cuv,  'p',       marb,  'p');
  c(time, 'out',     marb,  'time');
  c(cuv,  'p',       veins, 'p');
  c(time, 'out',     veins, 'time');

  c(black, 'out',    mix1, 'a');
  c(dRed,  'out',    mix1, 'b');
  c(marb,  'pattern',mix1, 't');

  c(mix1,  'out',    mix2, 'a');
  c(orng,  'out',    mix2, 'b');
  c(veins, 'out',    mix2, 't');

  c(marb, 'pattern', hot, 'x');
  c(hotE, 'out',     hot, 'e');

  c(mix2, 'out',     mix3, 'a');
  c(ylw,  'out',     mix3, 'b');
  c(hot,  'out',     mix3, 't');

  c(mix3, 'out',  vig, 'color');
  c(uvIn, 'out',  vig, 'uv');
  c(vig,  'out',  out, 'color');
}

/* ---- Plasma Wave — classic demoscene interfering sin/cos plasma ---- */
function tplPlasmaWave(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  // --- BASE PLASMA (no random frequency) ---
  // Random-driven frequencies caused every-frame hash flicker. Here the
  // Multiply `b` sockets hold the frequencies as inline defaults (6 and
  // 5), so the wave pattern itself is steady; only the COLORS cycle
  // randomly, far below flicker rate.
  const uv    = n('uv',        -920,  40);
  const split = n('splitVec2', -640,  40);

  const timeA = n('time', -920, 240, { scale: 1.0 });
  const timeB = n('time', -920, 380, { scale: 1.3 });

  const xMul  = n('multiply', -400,  -40, {}, { b: 6 });
  const phA   = n('add',      -160,  -40);
  const waveA = n('sin',        80,  -40);

  const yMul  = n('multiply', -400, 200, {}, { b: 5 });
  const phB   = n('add',      -160, 200);
  const waveB = n('cos',        80, 200);

  const sum   = n('add',       320,  80);
  const halfS = n('float',    -160, 360, { value: 0.25 });
  const scl   = n('multiply',  560,  80);
  const biasV = n('float',     320, 200, { value: 0.5 });
  const t01   = n('add',       800,  80);

  // --- RANDOM PASTEL COLORS (smoothly interpolated) ---
  // We need two things simultaneously: RANDOM color choices, and SMOOTH
  // transitions between them. The trick is to run two Random nodes per
  // channel — one seeded at the current integer tick (tA) and one at the
  // next tick (tB = tA + 1) — and lerp between them by the fractional
  // progress (0..1) within the current tick. Every ~3.3 s a new "next"
  // value is generated, while the previous "next" smoothly becomes the
  // new "current." No hard snaps.

  const tSlow = n('time',     -960, 520, { scale: 0.3 });  // wall-clock × 0.3
  const tA    = n('floor',    -700, 520);                   // integer tick, held for ~3.3 s
  const tB    = n('add',      -460, 520, {}, { b: 1 });     // tB = tA + 1 (next tick)
  const tFrac = n('subtract', -460, 680);                   // tFrac = tScale − tA  →  0..1
  const tEase = n('smoothstep', -160, 680);                 // cubic ease (0..1 → 0..1, smoother-looking blend)

  // factories — each pair (randA, randB) shares a `seedVec3` so it
  // represents "the SAME random stream offset by 1 tick." That continuity
  // is what makes tB's value at tick N become tA's value at tick N+1.
  const mkR = (x, y, off, seedInput) =>
    n('random', x, y,
      { mode: 'decimal', precision: 2 },
      { min: 0.6, max: 1.0, seedVec3: off }
    );

  const c1rA = mkR(-160, -720, [1, 0, 0]);
  const c1rB = mkR( 140, -720, [1, 0, 0]);
  const c1gA = mkR(-160, -560, [2, 0, 0]);
  const c1gB = mkR( 140, -560, [2, 0, 0]);
  const c1bA = mkR(-160, -400, [3, 0, 0]);
  const c1bB = mkR( 140, -400, [3, 0, 0]);

  const c2rA = mkR(-160,  840, [4, 0, 0]);
  const c2rB = mkR( 140,  840, [4, 0, 0]);
  const c2gA = mkR(-160, 1000, [5, 0, 0]);
  const c2gB = mkR( 140, 1000, [5, 0, 0]);
  const c2bA = mkR(-160, 1160, [6, 0, 0]);
  const c2bB = mkR( 140, 1160, [6, 0, 0]);

  // lerp between A (current tick) and B (next tick) using the eased fraction
  const lR1 = n('lerp',  440, -720);
  const lG1 = n('lerp',  440, -560);
  const lB1 = n('lerp',  440, -400);
  const lR2 = n('lerp',  440,  840);
  const lG2 = n('lerp',  440, 1000);
  const lB2 = n('lerp',  440, 1160);

  // Base pickers stay as a fallback — if the user DISCONNECTS a Lerp from
  // one channel, the picker's matching channel value takes over.
  const col1 = n('color',  780, -560, { rgb: [0.95, 0.70, 0.55] });
  const col2 = n('color',  780, 1000, { rgb: [0.60, 0.75, 0.95] });

  const mix01 = n('mix',   1120,  40);
  const out   = n('output', 1460,  40);

  // --- WIRING ---
  c(uv,    'out', split, 'v');

  // x wave
  c(split, 'x',   xMul, 'a');
  c(xMul,  'out', phA,  'a');
  c(timeA, 'out', phA,  'b');
  c(phA,   'out', waveA,'x');

  // y wave
  c(split, 'y',   yMul, 'a');
  c(yMul,  'out', phB,  'a');
  c(timeB, 'out', phB,  'b');
  c(phB,   'out', waveB,'x');

  // combine → t01 in 0..1
  c(waveA, 'out', sum,  'a');
  c(waveB, 'out', sum,  'b');
  c(sum,   'out', scl,  'a');
  c(halfS, 'out', scl,  'b');
  c(scl,   'out', t01,  'a');
  c(biasV, 'out', t01,  'b');

  // slow-stepped seed infrastructure
  c(tSlow, 'out', tA,    'x');         // tA = floor(tScale)
  c(tA,    'out', tB,    'a');         // tB = tA + 1 (inline b=1 default)
  c(tSlow, 'out', tFrac, 'a');         // tFrac = tScale − tA (fract, 0..1 within tick)
  c(tA,    'out', tFrac, 'b');
  c(tFrac, 'out', tEase, 'x');         // cubic ease over the 0..1 fraction

  // every "current-tick" Random seeds from tA (fan-out)
  c(tA, 'out', c1rA, 'seed');
  c(tA, 'out', c1gA, 'seed');
  c(tA, 'out', c1bA, 'seed');
  c(tA, 'out', c2rA, 'seed');
  c(tA, 'out', c2gA, 'seed');
  c(tA, 'out', c2bA, 'seed');

  // every "next-tick" Random seeds from tB (fan-out)
  c(tB, 'out', c1rB, 'seed');
  c(tB, 'out', c1gB, 'seed');
  c(tB, 'out', c1bB, 'seed');
  c(tB, 'out', c2rB, 'seed');
  c(tB, 'out', c2gB, 'seed');
  c(tB, 'out', c2bB, 'seed');

  // lerp A→B per channel by the eased fraction
  const pairs = [
    [c1rA, c1rB, lR1, col1, 'r'],
    [c1gA, c1gB, lG1, col1, 'g'],
    [c1bA, c1bB, lB1, col1, 'b'],
    [c2rA, c2rB, lR2, col2, 'r'],
    [c2gA, c2gB, lG2, col2, 'g'],
    [c2bA, c2bB, lB2, col2, 'b'],
  ];
  for (const [rA, rB, lerp, color, chan] of pairs){
    c(rA,    'out', lerp,  'a');
    c(rB,    'out', lerp,  'b');
    c(tEase, 'out', lerp,  't');
    c(lerp,  'out', color, chan);
  }

  c(col1, 'out', mix01, 'a');
  c(col2, 'out', mix01, 'b');
  c(t01,  'out', mix01, 't');

  c(mix01, 'out', out, 'color');
}

/* ---- Neon Rings — radial pulse with sharp smoothstep edges ---- */
function tplNeonRings(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv   = n('centeredUV', -760, 40);
  // fast time gives the rings a tight propagation speed
  const time  = n('time', -760, 240, { scale: 3.0 });

  const k     = n('float', -760, -200, { value: 22.0 });
  const dMul  = n('multiply', -440, 20);      // dist * 22
  const phase = n('subtract', -160, 40);      // dMul - time
  const wave  = n('sin',         80, 40);
  const posW  = n('abs',        320, 40);     // sharp bands via |sin|

  // sharp band edges via smoothstep — ring width controlled by the range
  const s0    = n('float', 80,  220, { value: 0.85 });
  const s1    = n('float', 80,  340, { value: 1.00 });
  const ring  = n('smoothstep', 560, 80);

  const bg    = n('color', 560, -180, { rgb: [0.02, 0.02, 0.10] });
  const neon  = n('color', 560, -320, { rgb: [0.35, 0.95, 1.00] });
  const mix1  = n('mix',   880,  -40);

  const out   = n('output', 1180, -40);

  c(cuv,  'dist', dMul, 'a');
  c(k,    'out',  dMul, 'b');
  c(dMul, 'out',  phase,'a');
  c(time, 'out',  phase,'b');
  c(phase,'out',  wave, 'x');
  c(wave, 'out',  posW, 'x');

  c(s0,   'out',  ring, 'a');
  c(s1,   'out',  ring, 'b');
  c(posW, 'out',  ring, 'x');

  c(bg,   'out',  mix1, 'a');
  c(neon, 'out',  mix1, 'b');
  c(ring, 'out',  mix1, 't');

  c(mix1, 'out',  out, 'color');
}

/* ---- Static Grain — per-pixel animated random (Random-node showcase) ---- */
function tplStaticGrain(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv    = n('uv',     -820, 40);
  // spatial seed: scale UV way up so every pixel hashes differently
  const sc    = n('float',    -820, -140, { value: 73.0 });
  const uvBig = n('scaleVec2',-560,  60);

  // Three time streams at different scales so R / G / B each decorrelate
  // in time — without this, all three channels would flicker together
  // and the output would look grayscale despite having three randoms.
  const timeR = n('time',   -820, 260, { scale: 6.0 });
  const timeG = n('time',   -820, 380, { scale: 7.3 });
  const timeB = n('time',   -820, 500, { scale: 5.7 });

  // One Random per channel. All three share the same spatial seed (uvBig
  // fans out — only possible since the output-fan-out fix), so each pixel
  // keeps its own identity. Their time seeds differ so the three channels
  // fluctuate independently, producing the saturated RGB TV-static look.
  const rR    = n('random', -220, -140, { mode: 'decimal', precision: 2 });
  const rG    = n('random', -220,   60, { mode: 'decimal', precision: 2 });
  const rB    = n('random', -220,  260, { mode: 'decimal', precision: 2 });

  const comb  = n('combine',  160,  60);
  const out   = n('output',   500,  60);

  c(uv, 'out', uvBig, 'v');
  c(sc, 'out', uvBig, 's');

  // fan-out: the same scaled UV seeds all three channel randoms
  c(uvBig, 'out', rR, 'seedUV');
  c(uvBig, 'out', rG, 'seedUV');
  c(uvBig, 'out', rB, 'seedUV');

  // per-channel time so each color flickers independently
  c(timeR, 'out', rR, 'seed');
  c(timeG, 'out', rG, 'seed');
  c(timeB, 'out', rB, 'seed');

  // pack the three random floats into a vec3 color
  c(rR, 'out', comb, 'x');
  c(rG, 'out', comb, 'y');
  c(rB, 'out', comb, 'z');

  c(comb, 'xyz', out, 'color');
}

/* ---- Topography — procedural heightfield as a pastel topo map ----
 * Renders isolines of equal elevation (contour lines) over a slowly-morphing
 * FBM terrain. Elevation drives a pastel low→high color gradient that uses
 * the SAME smooth-drift pastel technique as Plasma Wave (two Random snapshots
 * per channel on adjacent Floor ticks, lerped by the eased fraction), so the
 * map re-tints itself through fresh pastel combinations every few seconds
 * without visible snaps. Lines come from the classic:
 *     band = abs(fract(h * freq) - 0.5)
 *     line = smoothstep(0.48, 0.5, band)    // 1 at contour boundary, 0 between
 * and get composited over the pastel background as a dark overlay. */
function tplTopographyJagged(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  // ---- ELEVATION ----
  const cuv   = n('centeredUV', -1040, -40);
  const tTerr = n('time',       -1040, 140, { scale: 0.3 });   // slow terrain morph
  const elev  = n('heightMap',   -720,  20, { scale: 2.0 });   // → float in ~0..1

  // ---- CONTOUR LINES ----
  // Each step uses an inline socket default so no Float node is needed.
  const scaled = n('multiply',   -720, 220, {}, { b: 10 });    // elev × 10 → 10 tiers
  const frac   = n('fract',      -460, 220);                    // 0..1 inside a tier
  const shift  = n('subtract',   -220, 220, {}, { b: 0.5 });    // −0.5..+0.5
  const absSh  = n('abs',           40, 220);                    // 0 mid-tier, 0.5 at border
  // smoothstep(0.48, 0.5, absShift): 1 AT tier border (the contour line), 0 away.
  const line   = n('smoothstep',   300, 220, {},
                                   { a: 0.48, b: 0.5 });

  // ---- SMOOTH PASTEL COLOR DRIFT (same infra as Plasma Wave) ----
  const tClr  = n('time',        -1040, 420, { scale: 0.25 });  // color tick = 4 s
  const tA    = n('floor',        -720, 420);                    // current integer tick
  const tB    = n('add',          -460, 420, {}, { b: 1 });      // next tick (= tA + 1)
  const tFrac = n('fract',        -720, 560);                    // 0..1 progress inside tick
  const tEase = n('smoothstep',   -460, 560);                    // cubic ease

  // A/B pair per channel, seedVec3 distinguishes the six streams. Same
  // offset in A and B of a channel so B at tick N equals A at tick N+1 —
  // that's how the lerp transitions have no discontinuity.
  const mkR = (x, y, off) =>
    n('random', x, y,
      { mode: 'decimal', precision: 2 },
      { min: 0.6, max: 1.0, seedVec3: off });

  const lowRA = mkR(-220,  740, [1, 0, 0]);
  const lowRB = mkR(  40,  740, [1, 0, 0]);
  const lerpLR = n('lerp', 320,  740);
  const lowGA = mkR(-220,  880, [2, 0, 0]);
  const lowGB = mkR(  40,  880, [2, 0, 0]);
  const lerpLG = n('lerp', 320,  880);
  const lowBA = mkR(-220, 1020, [3, 0, 0]);
  const lowBB = mkR(  40, 1020, [3, 0, 0]);
  const lerpLB = n('lerp', 320, 1020);

  const hiRA  = mkR(-220, 1220, [4, 0, 0]);
  const hiRB  = mkR(  40, 1220, [4, 0, 0]);
  const lerpHR = n('lerp', 320, 1220);
  const hiGA  = mkR(-220, 1360, [5, 0, 0]);
  const hiGB  = mkR(  40, 1360, [5, 0, 0]);
  const lerpHG = n('lerp', 320, 1360);
  const hiBA  = mkR(-220, 1500, [6, 0, 0]);
  const hiBB  = mkR(  40, 1500, [6, 0, 0]);
  const lerpHB = n('lerp', 320, 1500);

  // Picker-value fallbacks (only visible if a Lerp wire is disconnected).
  // Minty low, rosy high — arbitrary pastel starting palette.
  const colLow  = n('color', 620,  880, { rgb: [0.65, 0.85, 0.75] });
  const colHigh = n('color', 620, 1360, { rgb: [0.95, 0.75, 0.80] });

  // Elevation → pastel gradient
  const bg = n('mix', 900, 1120);

  // Dark contour-line ink — stays constant (could be randomized too but
  // topo maps traditionally use a single consistent ink color).
  const colLine = n('color', 900, 740, { rgb: [0.08, 0.06, 0.12] });

  // Final overlay: mix(bg, lineColor, lineMask)
  const final = n('mix',    1200,  900);
  const out   = n('output', 1500,  900);

  // ---- WIRING ----
  c(cuv,   'p',   elev, 'p');
  c(tTerr, 'out', elev, 'time');

  // contour pipeline
  c(elev,   'height', scaled, 'a');
  c(scaled, 'out',    frac,   'x');
  c(frac,   'out',    shift,  'a');
  c(shift,  'out',    absSh,  'x');
  c(absSh,  'out',    line,   'x');

  // pastel color drift infrastructure
  c(tClr,  'out', tA,    'x');
  c(tA,    'out', tB,    'a');
  c(tClr,  'out', tFrac, 'x');    // tFrac = fract(tClr)
  c(tFrac, 'out', tEase, 'x');

  // fan-out: all A-randoms seed from tA
  c(tA, 'out', lowRA, 'seed');
  c(tA, 'out', lowGA, 'seed');
  c(tA, 'out', lowBA, 'seed');
  c(tA, 'out',  hiRA, 'seed');
  c(tA, 'out',  hiGA, 'seed');
  c(tA, 'out',  hiBA, 'seed');
  // all B-randoms seed from tB
  c(tB, 'out', lowRB, 'seed');
  c(tB, 'out', lowGB, 'seed');
  c(tB, 'out', lowBB, 'seed');
  c(tB, 'out',  hiRB, 'seed');
  c(tB, 'out',  hiGB, 'seed');
  c(tB, 'out',  hiBB, 'seed');

  // lerps for each channel, feeding the two color nodes' r/g/b
  const pairs = [
    [lowRA, lowRB, lerpLR, colLow,  'r'],
    [lowGA, lowGB, lerpLG, colLow,  'g'],
    [lowBA, lowBB, lerpLB, colLow,  'b'],
    [ hiRA,  hiRB, lerpHR, colHigh, 'r'],
    [ hiGA,  hiGB, lerpHG, colHigh, 'g'],
    [ hiBA,  hiBB, lerpHB, colHigh, 'b'],
  ];
  for (const [rA, rB, lp, col, ch] of pairs){
    c(rA,    'out', lp,  'a');
    c(rB,    'out', lp,  'b');
    c(tEase, 'out', lp,  't');
    c(lp,    'out', col, ch);
  }

  // elevation-driven gradient
  c(colLow,  'out',    bg, 'a');
  c(colHigh, 'out',    bg, 'b');
  c(elev,    'height', bg, 't');

  // overlay dark contour lines on top
  c(bg,      'out', final, 'a');
  c(colLine, 'out', final, 'b');
  c(line,    'out', final, 't');

  c(final, 'out', out, 'color');
}

/* ---- Topography Smooth — same look as Topography Jagged but cos-based lines ----
 * Jagged version uses `abs(fract(h·freq) − 0.5)`, which is a triangle wave
 * with visible kinks at each tier transition. This version uses
 * `cos(h · freq · 2π)` — a true sinusoid with smooth extrema — so every
 * contour line transitions into and out of the ridge without any sharp
 * corners. Pair the smooth wave with a wide smoothstep band (0.85…1.0)
 * to draw soft anti-aliased curves. Rest of the pipeline (pastel drift,
 * elevation tint, dark ink overlay) is identical to the Jagged template.
 */
function tplTopographySmooth(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv   = n('centeredUV', -1040, -40);
  const tTerr = n('time',       -1040, 140, { scale: 0.3 });
  const elev  = n('heightMap',   -720,  20, { scale: 2.0 });

  // CONTOUR LINES (smooth). Scale = 10·2π ≈ 62.83 → 10 ridge cycles across
  // the [0..1] elevation range. `cos` gives the sinusoid; smoothstep(0.85,
  // 1.0, wave) picks out the peaks (the elevation boundaries) with a soft
  // falloff that kills the kink-artifacts of the fract-based version.
  const scaled = n('multiply',   -720, 220, {}, { b: 62.83185 });
  const wave   = n('cos',        -460, 220);
  const line   = n('smoothstep', -200, 220, {}, { a: 0.85, b: 1.0 });

  // ---- PASTEL COLOR DRIFT (same as Topography Jagged) ----
  const tClr  = n('time',      -1040, 420, { scale: 0.25 });
  const tA    = n('floor',      -720, 420);
  const tB    = n('add',        -460, 420, {}, { b: 1 });
  const tFrac = n('fract',      -720, 560);
  const tEase = n('smoothstep', -460, 560);

  const mkR = (x, y, off) =>
    n('random', x, y,
      { mode: 'decimal', precision: 2 },
      { min: 0.6, max: 1.0, seedVec3: off });

  const lowRA = mkR(-220,  740, [1, 0, 0]);
  const lowRB = mkR(  40,  740, [1, 0, 0]);
  const lerpLR = n('lerp', 320,  740);
  const lowGA = mkR(-220,  880, [2, 0, 0]);
  const lowGB = mkR(  40,  880, [2, 0, 0]);
  const lerpLG = n('lerp', 320,  880);
  const lowBA = mkR(-220, 1020, [3, 0, 0]);
  const lowBB = mkR(  40, 1020, [3, 0, 0]);
  const lerpLB = n('lerp', 320, 1020);

  const hiRA  = mkR(-220, 1220, [4, 0, 0]);
  const hiRB  = mkR(  40, 1220, [4, 0, 0]);
  const lerpHR = n('lerp', 320, 1220);
  const hiGA  = mkR(-220, 1360, [5, 0, 0]);
  const hiGB  = mkR(  40, 1360, [5, 0, 0]);
  const lerpHG = n('lerp', 320, 1360);
  const hiBA  = mkR(-220, 1500, [6, 0, 0]);
  const hiBB  = mkR(  40, 1500, [6, 0, 0]);
  const lerpHB = n('lerp', 320, 1500);

  const colLow  = n('color', 620,  880, { rgb: [0.75, 0.90, 0.80] });
  const colHigh = n('color', 620, 1360, { rgb: [0.98, 0.82, 0.85] });
  const bg      = n('mix',   900, 1120);
  const colLine = n('color', 900, 420, { rgb: [0.08, 0.06, 0.12] });
  const final   = n('mix',   1200, 700);
  const out     = n('output', 1500, 700);

  c(cuv,   'p',   elev, 'p');
  c(tTerr, 'out', elev, 'time');

  // smooth contour pipeline
  c(elev,   'height', scaled, 'a');
  c(scaled, 'out',    wave,   'x');
  c(wave,   'out',    line,   'x');

  // color drift infrastructure
  c(tClr,  'out', tA,    'x');
  c(tA,    'out', tB,    'a');
  c(tClr,  'out', tFrac, 'x');
  c(tFrac, 'out', tEase, 'x');

  c(tA, 'out', lowRA, 'seed');
  c(tA, 'out', lowGA, 'seed');
  c(tA, 'out', lowBA, 'seed');
  c(tA, 'out',  hiRA, 'seed');
  c(tA, 'out',  hiGA, 'seed');
  c(tA, 'out',  hiBA, 'seed');
  c(tB, 'out', lowRB, 'seed');
  c(tB, 'out', lowGB, 'seed');
  c(tB, 'out', lowBB, 'seed');
  c(tB, 'out',  hiRB, 'seed');
  c(tB, 'out',  hiGB, 'seed');
  c(tB, 'out',  hiBB, 'seed');

  const pairs = [
    [lowRA, lowRB, lerpLR, colLow,  'r'],
    [lowGA, lowGB, lerpLG, colLow,  'g'],
    [lowBA, lowBB, lerpLB, colLow,  'b'],
    [ hiRA,  hiRB, lerpHR, colHigh, 'r'],
    [ hiGA,  hiGB, lerpHG, colHigh, 'g'],
    [ hiBA,  hiBB, lerpHB, colHigh, 'b'],
  ];
  for (const [rA, rB, lp, col, ch] of pairs){
    c(rA,    'out', lp,  'a');
    c(rB,    'out', lp,  'b');
    c(tEase, 'out', lp,  't');
    c(lp,    'out', col, ch);
  }

  c(colLow,  'out',    bg, 'a');
  c(colHigh, 'out',    bg, 'b');
  c(elev,    'height', bg, 't');

  c(bg,      'out', final, 'a');
  c(colLine, 'out', final, 'b');
  c(line,    'out', final, 't');

  c(final, 'out', out, 'color');
}

/* ---- Crystal — clear glass silhouette with fresnel edges + iridescent sheen --
 * The crystal body is mostly TRANSPARENT (background shows through), with:
 *   - Fresnel rim: opaque highlight on the silhouette, so the edges read solid
 *   - Sheen Lines: thin bright streaks sliding across the surface, each tinted
 *     by Iridescence so they shimmer rainbow as the normal varies
 *   - Subtle cyan tint weighted by fresnel (stronger near edges, faint in center)
 * The crystal colour is added OVER the background (blend mode=add with mask as
 * amount), which naturally produces the "glass lets you see through it" look.
 * Specular-bloom is wired to (fresnel + sheen) × mask so only the shiny bits
 * glow — the clear interior doesn't trigger bloom spuriously.
 */
function tplCrystal(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  // --- inputs ---
  const cuv    = n('centeredUV', -1400,   0);
  const tIrid  = n('time',       -1400, 160, { scale: 0.25 });
  const tSheen = n('time',       -1400, 300, { scale: 0.9  });
  const simRot = n('simRotation',-1400, 440);   // 0 by default; cursor-X when Lighting is on

  // Rotate the centered UV by the sim-rotation angle so the crystal
  // appears to turn with the cursor when Lighting is on.
  const rot = n('rotateUV', -1120, 80);

  // --- shape (centered, tall pentagon crystal) ---
  const sdf  = n('sdfCrystal', -860, 80);

  // fake-3D normal + hard fill mask + a soft interior mask for the body glow
  const nor     = n('sdfNormal',   -580, -120, {}, { bulge: 0.9 });
  const mask    = n('sdfMask',     -580,   20, {}, { edge: 0.003 });
  const glowMsk = n('sdfMask',     -580,  160, {}, { edge: 0.32 });   // soft interior falloff

  // --- lighting vectors ---
  const simLit = n('simLight', -580, 300);   // cursor-driven light dir when Lighting is on
  const view   = n('viewDir',  -580, 440);

  // --- shading terms ---
  // Iridescence — rainbow colour shift tied to the surface normal.
  const irid = n('iridescence', -260, -200, {}, { freq: 3.5 });

  // Lambert — diffuse shading using the sim light so edges reading "toward
  // the cursor" get brighter. Ambient stays up so the body never goes black.
  const lamb = n('lambert',     -260,  -40, {}, { ambient: 0.55 });

  // Fresnel — silhouette factor; drives edge opacity and sheen brightness.
  const fres = n('fresnel',     -260,  120, {}, { power: 1.4 });

  // Sheen lines — thicker, closer-spaced, faster than before so they actually
  // read as a moving highlight rather than a single barely-visible streak.
  const sheen = n('sheenLines', -260, 280, {}, {
    angle:     0.6,
    count:     5.0,
    speed:     0.8,
    thickness: 0.22,
  });

  // --- colour layers ---
  // Body glow: iridescence × glowMsk — fills the interior with a soft
  // rainbow wash so the crystal has a visible body (not just clear glass).
  const bodyGlow = n('mix', 60, -120);   // mix(black, irid, glowMsk) scaled below
  const bodyAmt  = n('float',  60,  40, { value: 0.35 });
  const bodyMul  = n('multiply', 380, 40);                  // glowMsk * 0.35
  const bodyLit  = n('mix',      60, 160);                  // mix(black, irid, glowMsk*0.35)

  // Sheen lines tinted by iridescence.
  const sheenLit = n('mix', 380, 260);   // mix(black, irid, sheen)

  // Fresnel rim — near-white, lit by lambert so edges respond to the light.
  const rimC    = n('color',    380, 440, { rgb: [1.0, 1.05, 1.1] });
  const rimCLit = n('mix',      700, 340);                  // mix(black, rimC, lamb)
  const rimFres = n('mix',      980, 260);                  // mix(black, rimCLit, fres)

  // Accumulate body + sheen + rim (additive so they stack as light emission).
  const bs   = n('blend', 700,  60, { mode: 'add' });       // body + sheen
  const bsr  = n('blend', 1260, 200, { mode: 'add' });      // (body+sheen) + rim

  // --- background: deep navy, almost black ---
  const bgC = n('color', 980, 580, { rgb: [0.015, 0.03, 0.055] });

  // Final = bg + mask * crystal. blend-add with amount=mask gives
  // mix(bg, bg+crystal, mask): outside → bg; inside → bg + crystal.
  const final = n('blend', 1580, 400, { mode: 'add' });

  // Specular for bloom: fresnel + sheen, masked to the interior.
  const specSum = n('add',      700, 700);
  const specMul = n('multiply', 980, 700);

  const out = n('output', 1880, 400, {
    bloom:          'on',
    bloomThreshold: 0.12,
    bloomRadius:    3.0,
    bloomIntensity: 1.4,
  });

  // --- wiring ---
  // rotate the UV by simRotation, then feed into the crystal SDF
  c(cuv,    'p',   rot, 'uv');
  c(simRot, 'out', rot, 'angle');
  c(rot,    'out', sdf, 'p');

  // SDF → normal / masks
  c(sdf, 'out', nor,     'sd');
  c(sdf, 'out', mask,    'sd');
  c(sdf, 'out', glowMsk, 'sd');

  // normal drives iridescence / lambert / fresnel
  c(nor,    'out', irid, 'normal');
  c(nor,    'out', lamb, 'normal');
  c(nor,    'out', fres, 'normal');
  c(tIrid,  'out', irid, 'bias');
  c(simLit, 'out', lamb, 'lightDir');
  c(view,   'out', fres, 'view');

  // sheen uses UV (spatial) + time for a sliding highlight
  c(rot,    'out', sheen, 'uv');
  c(tSheen, 'out', sheen, 'time');

  // body glow = mix(black, iridescence, glowMsk * bodyAmt)
  c(glowMsk, 'out', bodyMul, 'a');
  c(bodyAmt, 'out', bodyMul, 'b');
  c(irid,    'out', bodyLit, 'b');
  c(bodyMul, 'out', bodyLit, 't');

  // sheenLit = mix(black, iridescence, sheen)
  c(irid,  'out', sheenLit, 'b');
  c(sheen, 'out', sheenLit, 't');

  // rim: rimC shaded by lambert, then gated by fresnel
  c(rimC,    'out', rimCLit, 'b');
  c(lamb,    'out', rimCLit, 't');
  c(rimCLit, 'out', rimFres, 'b');
  c(fres,    'out', rimFres, 't');

  // accumulate: body + sheen + rim
  c(bodyLit,  'out', bs,  'a');
  c(sheenLit, 'out', bs,  'b');
  c(bs,       'out', bsr, 'a');
  c(rimFres,  'out', bsr, 'b');

  // composite onto background via mask
  c(bgC,  'out', final, 'a');
  c(bsr,  'out', final, 'b');
  c(mask, 'out', final, 'amount');

  // spec = (fres + sheen) * mask  → bloom catches rim + streaks only
  c(fres,    'out', specSum, 'a');
  c(sheen,   'out', specSum, 'b');
  c(specSum, 'out', specMul, 'a');
  c(mask,    'out', specMul, 'b');

  c(final,   'out', out, 'color');
  c(specMul, 'out', out, 'specular');
}

/* ---- Stained Glass — Voronoi cells through a slowly-rotating UV ---- */
/* Showcases Voronoi + Palette + Rotate UV. Each Voronoi cell gets a unique
 * id (via the cell's integer coords hashed); feeding that id into the iq
 * cosine Palette turns it into a randomly-assigned rainbow color. A dark
 * ink overlay on cells' outer shells gives the stained-glass leading.
 * Rotate UV animates the whole mosaic — the cells slowly drift + spin. */
function tplStainedGlass(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv    = n('uv',         -780, 40);
  const tSlow = n('time',       -780, 220, { scale: 0.05 });  // very slow rotation
  const rot   = n('rotateUV',   -460,  60);

  const vor   = n('voronoi',    -140,  60, {}, { scale: 6 });

  // id → rainbow palette (defaults give iq's rainbow)
  const pal   = n('palette',     200, -80);

  // thin dark edges where dist is in the cells' outer shells
  const edge  = n('smoothstep',  200, 200, {}, { a: 0.35, b: 0.5 });
  const ink   = n('color',       200, 340, { rgb: [0.06, 0.04, 0.10] });

  const final = n('mix',    560, 60);
  const out   = n('output', 900, 60);

  // UV → slow rotation → Voronoi
  c(uv,    'out',   rot, 'uv');
  c(tSlow, 'out',   rot, 'angle');
  c(rot,   'out',   vor, 'p');

  // id feeds the cosine palette (a/b/c/d left at rainbow defaults)
  c(vor, 'id', pal, 't');

  // dist feeds the edge smoothstep to build the lead-line mask
  c(vor, 'dist', edge, 'x');

  // composite: palette color, darkened at cell boundaries
  c(pal,  'out', final, 'a');
  c(ink,  'out', final, 'b');
  c(edge, 'out', final, 't');

  c(final, 'out', out, 'color');
}

/* ---- Mandala — kaleidoscope + Voronoi + Palette ---- */
/* UV slowly rotates → N-fold kaleidoscope fold → Voronoi cells →
 * palette-color per cell id, with dark leading at cell boundaries.
 * The rotating input means cells drift through the symmetry, creating
 * the live-mandala look. */
function tplMandala(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv    = n('uv',          -860,  40);
  const tRot  = n('time',        -860, 220, { scale: 0.05 });
  const rot   = n('rotateUV',    -540,  60);
  const kal   = n('kaleidoscope', -220,  60, {}, { sectors: 8 });

  const vor   = n('voronoi',      100,  60, {}, { scale: 4 });

  // id → rainbow palette (defaults give iq's rainbow)
  const pal   = n('palette',      420, -80);

  // dark ink on cell outer shells = stained-glass leading
  const edge  = n('smoothstep',   420, 200, {}, { a: 0.35, b: 0.5 });
  const ink   = n('color',        420, 340, { rgb: [0.05, 0.03, 0.10] });

  const final = n('mix',    760,  60);
  const out   = n('output', 1080, 60);

  c(uv,   'out',   rot, 'uv');
  c(tRot, 'out',   rot, 'angle');
  c(rot,  'out',   kal, 'uv');
  c(kal,  'out',   vor, 'p');

  c(vor,  'id',    pal,  't');
  c(vor,  'dist',  edge, 'x');

  c(pal,  'out', final, 'a');
  c(ink,  'out', final, 'b');
  c(edge, 'out', final, 't');

  c(final, 'out', out, 'color');
}

/* ---- Pixel Flow — Pixelate + Ridged FBM + Palette + Posterize ---- */
/* Retro / 8-bit feel. UV gets snapped to a 48×48 grid, each cell gets a
 * ridgedFbm value (animated slowly), fed through the cosine palette and
 * then posterized to a few color steps. Every cell reads as a flat tile
 * of one of a handful of colors that shift over time. */
function tplPixelFlow(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv    = n('uv',         -820, 40);
  const tFlow = n('time',       -820, 220, { scale: 0.15 });

  const pix   = n('pixelate',   -520,  60, {}, { cells: 48 });
  const ridge = n('ridgedFbm',  -200,  60);

  const pal   = n('palette',     120,  60);
  const post  = n('posterize',   440,  60, {}, { levels: 5 });

  const out   = n('output',      760,  60);

  c(uv,    'out', pix,   'uv');
  c(pix,   'out', ridge, 'p');
  c(tFlow, 'out', ridge, 'z');
  c(ridge, 'out', pal,   't');
  c(pal,   'out', post,  'color');
  c(post,  'out', out,   'color');
}

/* ---- Cosmic Star — Soft Glow + Starburst + HDR Boost ---- */
/* A bright orange core with hexagonal spikes radiating outward, all
 * boosted into saturation via HDR tonemap. Showcases the bloom-cluster
 * trio. Centered at (0, 0) in Centered-UV space, which is the middle of
 * the canvas. */
function tplCosmicStar(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv   = n('centeredUV', -820, 40);

  // warm halo around the center
  const glow  = n('softGlow',   -500, 40, {},
    { radius: 0.35, color: [1.0, 0.55, 0.25] });

  // 6-pointed spike pattern
  const star  = n('starburst',  -500, 240, {},
    { points: 6, sharpness: 40, radius: 0.6 });
  const starC = n('grayscale',  -200, 240);

  // additively composite the rays onto the halo
  const add   = n('blend', 100, 120, { mode: 'add' });

  // boost into visible saturation
  const hdr   = n('hdrBoost', 420, 120, {},
    { exposure: 0.6, gamma: 1.3 });

  const out   = n('output', 740, 120);

  c(cuv, 'p', glow, 'pos');
  c(cuv, 'p', star, 'pos');

  c(star,  'out', starC, 'x');

  c(glow,  'out', add,   'a');
  c(starC, 'out', add,   'b');

  c(add,   'out', hdr,   'color');
  c(hdr,   'out', out,   'color');
}

/* ---- Plaid — Stripes layered (horizontal × vertical) in pastel ---- */
/* Two Stripes nodes at 0° and π/2 combined multiplicatively to form a
 * plaid. The pastel color pair varies between the "warp" and "weft" via
 * Mix — classic tartan vibe. Try tweaking the frequencies for finer weave. */
function tplPlaid(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const uv   = n('uv', -760, 40);

  // vertical stripes (angle = π/2)
  const sv   = n('stripes', -480, -120, {}, { angle: 1.5708, frequency: 14 });
  // horizontal stripes (angle = 0)
  const sh   = n('stripes', -480,  200, {}, { angle: 0,      frequency: 10 });

  // two pastel colors — one for weft, one for warp
  const warm = n('color',   -480, -320, { rgb: [0.95, 0.76, 0.62] });  // salmon pastel
  const cool = n('color',   -480,  400, { rgb: [0.58, 0.72, 0.92] });  // sky pastel

  // each stripes mask picks between warm and cool
  const mixV = n('mix',     -140, -200);
  const mixH = n('mix',     -140,  280);

  // multiplicatively combine: avg of the two so intersections stay bright
  const avg  = n('blend',     220,  40, { mode: 'multiply' }, { amount: 1.0 });

  const out  = n('output',    560,  40);

  c(uv, 'out', sv, 'uv');
  c(uv, 'out', sh, 'uv');

  c(warm, 'out', mixV, 'a');
  c(cool, 'out', mixV, 'b');
  c(sv,   'out', mixV, 't');

  c(cool, 'out', mixH, 'a');
  c(warm, 'out', mixH, 'b');
  c(sh,   'out', mixH, 't');

  c(mixV, 'out', avg, 'a');
  c(mixH, 'out', avg, 'b');

  c(avg, 'out', out, 'color');
}

/* ---- Vortex — Swirl + domain warp + noise + palette ---- */
/* UV gets swirled around the center, then domain-warped by a noise field
 * so it feels organic rather than perfectly spiral. Final position feeds
 * FBM → palette → output. The swirl strength + slow time give a liquid-
 * mercury look. */
function tplVortex(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv   = n('centeredUV', -960, 40);
  const tSlow = n('time',       -960, 220, { scale: 0.15 });

  // primary swirl
  const swirl = n('swirl',      -620,  60, {}, { strength: 6.0, center: [0, 0] });

  // secondary domain warp: noise-driven vec2 offset
  const tWarp = n('time',       -960, 380, { scale: 0.25 });
  const wx    = n('simplex',    -620, 300);
  const wy    = n('simplex',    -620, 460);
  const warpS = n('multiply',   -320, 300, {}, { b: 0.15 });
  const warpT = n('multiply',   -320, 460, {}, { b: 0.15 });
  const warpV = n('makeVec2',   -60,  380);
  const warped= n('warpUV',      240,  140);

  // final pattern
  const fbmN  = n('fbm',         540,  140);
  const pal   = n('palette',     860,  140);

  const out   = n('output',     1180,  140);

  // swirl
  c(cuv, 'p', swirl, 'uv');

  // warp contributions: sample noise twice (x, y offsets) with small mults
  c(swirl, 'out', wx, 'p');
  c(tWarp, 'out', wx, 'z');
  c(swirl, 'out', wy, 'p');
  c(tWarp, 'out', wy, 'z');
  // the wy simplex uses a z-shifted lookup — wire tWarp(*2) for decorrelation
  // (kept simple: same z here; OK for the visual)

  c(wx, 'out', warpS, 'a');
  c(wy, 'out', warpT, 'a');
  c(warpS, 'out', warpV, 'x');
  c(warpT, 'out', warpV, 'y');

  c(swirl, 'out', warped, 'uv');
  c(warpV, 'out', warped, 'warp');

  // drive FBM with the warped + swirled UV, and use slow time as z to animate
  c(warped, 'out', fbmN, 'p');
  c(tSlow,  'out', fbmN, 'z');

  c(fbmN, 'out', pal, 't');
  c(pal,  'out', out, 'color');
}

/* ---- SDF Shapes — circle + box boolean combinations ---- */
/* Demonstrates the SDF nodes with Min (union) and Max(a, -b) (subtraction).
 * Two shapes orbit the center via a rotating vec2; Min gives their union,
 * smoothstep around 0 turns the union into a filled sprite with clean
 * anti-aliased edges. Palette colors the shape, Time animates the orbit. */
function tplSDFShapes(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv   = n('centeredUV', -1020, 40);
  const tOrb  = n('time',       -1020, 220, { scale: 0.5 });

  // animated box center — orbit using pulse-ish sin/cos
  const pOrbX = n('multiply',    -720, 200, {}, { b: 0.25 });
  const pOrbY = n('multiply',    -720, 340, {}, { b: 0.25 });
  const sOrb  = n('sin',         -960, 200);
  const cOrb  = n('cos',         -960, 340);
  const ctr   = n('makeVec2',    -460, 260);

  // SDFs
  const circ  = n('sdfCircle',   -460,  20, {}, { center: [0, 0], radius: 0.25 });
  const box   = n('sdfBox',      -180, 260, {}, { size:   [0.18, 0.18] });

  // Union via Min
  const un    = n('min',          140, 120);

  // fill — smoothstep(0, edgeWidth, -d). negative inside → becomes 1 inside.
  // trick: negate the SDF so inside > 0 → smoothstep to a filled shape.
  const neg   = n('subtract',    440, 120, {}, { a: 0.0 });   // 0 − d = −d
  const fill  = n('smoothstep',  740, 120, {}, { a: 0.0, b: 0.02 });

  // palette-color the filled shape, dark background
  const bg    = n('color',       740,  -60, { rgb: [0.04, 0.03, 0.10] });
  const pal   = n('palette',    1040,  120);
  const tPal  = n('multiply',    440, -100, {}, { b: 0.1 });   // slow hue drift
  const blend = n('mix',        1340,  100);

  const out   = n('output',     1640,  100);

  // orbit
  c(tOrb, 'out', sOrb, 'x');
  c(tOrb, 'out', cOrb, 'x');
  c(sOrb, 'out', pOrbX, 'a');
  c(cOrb, 'out', pOrbY, 'a');
  c(pOrbX, 'out', ctr, 'x');
  c(pOrbY, 'out', ctr, 'y');

  // SDFs
  c(cuv, 'p', circ, 'p');
  c(cuv, 'p', box,  'p');
  c(ctr, 'out', box, 'center');

  // Union
  c(circ, 'out', un, 'a');
  c(box,  'out', un, 'b');

  // negate and smoothstep for filled mask
  c(un,  'out', neg,  'b');
  c(neg, 'out', fill, 'x');

  // palette hue drifts over time
  c(tOrb, 'out', tPal, 'a');
  c(tPal, 'out', pal,  't');

  // mix(bg, shapeColor, fill)
  c(bg,   'out', blend, 'a');
  c(pal,  'out', blend, 'b');
  c(fill, 'out', blend, 't');

  c(blend, 'out', out, 'color');
}

/* ---- Bloom Star — real post-process bloom on a star-field scene ----
 * Scene: a bright cosmic star (Soft Glow + Starburst on a dark sky).
 * Output node has `bloom: on` with tuned threshold/radius/intensity — the
 * renderer then runs the 3-pass FBO bloom chain (threshold→H-blur→V-blur+
 * composite), so the bright parts of the scene bleed into the surrounding
 * dark sky automatically. This is the showcase for genuine post-process
 * bloom (not the HDR-Boost fake). */
function tplBloomStar(){
  _clearGraph();
  const { n, c } = _tplHelpers();

  const cuv  = n('centeredUV', -820,  40);

  // warm halo at origin
  const glow = n('softGlow',   -520,  40, {},
    { radius: 0.18, color: [1.0, 0.75, 0.45] });

  // 6-point starburst through the same origin
  const star = n('starburst',  -520, 240, {},
    { points: 6, sharpness: 50, radius: 0.55 });
  const starC = n('grayscale', -200, 240);

  // starry background noise — tiny sparse dots
  const tw   = n('time',       -820, 460, { scale: 0.3 });
  const snz  = n('simplex',    -520, 460);
  const sharp= n('smoothstep', -200, 460, {}, { a: 0.75, b: 0.82 });
  const starsC = n('grayscale',  100, 460);

  // combine: halo + spike + dusty stars
  const add1 = n('blend',       420,  80, { mode: 'add' });
  const add2 = n('blend',       720, 200, { mode: 'add' });

  // bloom is enabled on the output node — this is the whole point of the template
  const out  = n('output',     1040, 200, {
    bloom: 'on',
    bloomThreshold: 0.55,
    bloomRadius:    3.5,
    bloomIntensity: 1.2,
  });

  // wire halo + spike into add1
  c(cuv,  'p',   glow, 'pos');
  c(cuv,  'p',   star, 'pos');
  c(star, 'out', starC, 'x');
  c(glow,  'out', add1, 'a');
  c(starC, 'out', add1, 'b');

  // dusty star background
  c(cuv, 'p',   snz, 'p');
  c(tw,  'out', snz, 'z');
  c(snz, 'out', sharp, 'x');
  c(sharp, 'out', starsC, 'x');

  // add halo+spike + dust
  c(add1,   'out', add2, 'a');
  c(starsC, 'out', add2, 'b');

  c(add2, 'out', out, 'color');
}

/* ---------------- Registry (order = display order in the picker) ---------------- */
/* Template registry. `category` groups items into collapsible sections in the
   picker UI: 'demo' is the tutorial/feature-walkthrough set, 'showcase' is the
   fun/wild creative-use set. Default is 'demo' if omitted. */
const SHADER_TEMPLATES = [
  // ---- Demos: illustrate specific features ----
  { id: 'marbleGold',      name: 'Marble Gold',      category:'demo',
    desc: 'Warped FBM marble with gold veins — the dossier preset.',        load: tplMarbleGold },
  { id: 'marbleOnyx',      name: 'Marble Onyx',      category:'demo',
    desc: 'Same warped marble, gold splotches removed — dark stone only.',  load: tplMarbleOnyx },
  { id: 'channelMixer',    name: 'Channel Mixer',    category:'demo',
    desc: 'Split + Combine + inline value — swaps UV channels.',            load: tplChannelMixer },
  { id: 'blendDemo',       name: 'Blend Demo',       category:'demo',
    desc: 'Two gradients combined via the Blend node — try other modes.',   load: tplBlendDemo },
  { id: 'heightField',     name: 'Height Field',     category:'demo',
    desc: 'FBM heightmap visualized as grayscale + vignette.',              load: tplHeightField },
  { id: 'normalPreview',   name: 'Normal Preview',   category:'demo',
    desc: 'Normal map encoded as RGB (the classic blue-ish look).',         load: tplNormalPreview },
  { id: 'terrainRelief',   name: 'Terrain Relief',   category:'demo',
    desc: 'Height + normal composited for shaded-terrain look.',            load: tplTerrainRelief },
  { id: 'litHeightfield',  name: 'Lit Heightfield',  category:'demo',
    desc: 'Height Map → elevation tint, Normal Map → overhead-light shade.', load: tplLitHeightfield },
  { id: 'brickWall',       name: 'Brick Wall',       category:'demo',
    desc: 'Static diffuse + normal map from assets/textures/brick-wall/.',   load: tplBrickWall },
  { id: 'brickWallSpec',   name: 'Brick Wall + Spec', category:'demo',
    desc: 'Adds the spec map — screen-blended highlights on brick faces.',  load: tplBrickWallSpec },
  { id: 'radialPulse',     name: 'Radial Pulse',     category:'demo',
    desc: 'Animated radial gradient driven by time-wobbled dist.',          load: tplRadialPulse },

  // ---- Showcase: creative/standalone visuals ----
  { id: 'aurora',          name: 'Aurora',           category:'showcase',
    desc: 'Flowing curtains of cold green and deep purple — FBM-warped.',   load: tplAurora },
  { id: 'lavaFlow',        name: 'Lava Flow',        category:'showcase',
    desc: 'Warped marble in molten reds, orange veins, hot-spot highlights.', load: tplLavaFlow },
  { id: 'plasmaWave',      name: 'Plasma Wave',      category:'showcase',
    desc: 'Classic demoscene plasma — interfering sin & cos waves in UV.',  load: tplPlasmaWave },
  { id: 'neonRings',       name: 'Neon Rings',       category:'showcase',
    desc: 'Radial sin pulses + sharp smoothstep edges = cyberpunk neon.',   load: tplNeonRings },
  { id: 'staticGrain',     name: 'Static Grain',     category:'showcase',
    desc: 'Animated per-pixel random — showcases the Random node (with Time seed).', load: tplStaticGrain },
  { id: 'topographyJagged',name: 'Topography Jagged', category:'showcase',
    desc: 'Contour lines via fract → triangle wave → smoothstep (hard kinks).', load: tplTopographyJagged },
  { id: 'topographySmooth', name: 'Topography Smooth', category:'showcase',
    desc: 'Contour lines via cos → sinusoid → smoothstep (smooth curves).',    load: tplTopographySmooth },
  { id: 'crystal',         name: 'Crystal',          category:'showcase',
    desc: 'Voronoi facets + per-cell normals → iridescence + Fresnel.',       load: tplCrystal },
  { id: 'pixelFlow',       name: 'Pixel Flow',       category:'showcase',
    desc: '48×48 pixelated grid over animated Ridged FBM, palette-tinted and posterized.', load: tplPixelFlow },
  { id: 'plaid',           name: 'Plaid',            category:'showcase',
    desc: 'Crossed Stripes × two pastel colors — warm/cool tartan weave.',   load: tplPlaid },
  { id: 'vortex',          name: 'Vortex',           category:'showcase',
    desc: 'Swirl + noise-driven Warp UV feeding an FBM palette field.',      load: tplVortex },
  { id: 'sdfShapes',       name: 'SDF Shapes',       category:'showcase',
    desc: 'Circle + animated Box combined via Min, palette-colored.',        load: tplSDFShapes },
];
