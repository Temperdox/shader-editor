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

  // --- RANDOM PASTEL COLORS ---
  // Slow-stepped time is the trick to avoiding flicker: Time(×0.3) → Floor
  // only ticks forward every ~3.3 seconds, so the 6 Randoms seeded from it
  // hold their values between ticks and snap to fresh pastels on each tick.
  const tSlow = n('time',  -920, 560, { scale: 0.3 });
  const tFlr  = n('floor', -640, 560);

  // Each of the six Random nodes (2 colors × 3 channels) shares the same
  // floor-time seed but gets a unique `seedVec3` default so the 6 values
  // stay decorrelated. Range 0.6–1.0 = lightness floor that guarantees
  // pastel (no dark / saturated colors).
  const mkChan = (x, y, off) =>
    n('random', x, y,
      { mode: 'decimal', precision: 2 },
      { min: 0.6, max: 1.0, seedVec3: off }
    );

  const c1r = mkChan(-160, -520, [1, 0, 0]);
  const c1g = mkChan(-160, -400, [2, 0, 0]);
  const c1b = mkChan(-160, -280, [3, 0, 0]);
  const c2r = mkChan(-160,  560, [4, 0, 0]);
  const c2g = mkChan(-160,  700, [5, 0, 0]);
  const c2b = mkChan(-160,  840, [6, 0, 0]);

  // Base pickers stay as a fallback — if the user DISCONNECTS a Random from
  // one channel, the picker's matching channel value takes over. Current
  // defaults: warm peach, cool periwinkle.
  const col1 = n('color',  320, -400, { rgb: [0.95, 0.70, 0.55] });
  const col2 = n('color',  320,  700, { rgb: [0.60, 0.75, 0.95] });

  const mix01 = n('mix',    900,  40);
  const out   = n('output', 1260,  40);

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

  // slow-stepped seed fans out to every Random (output fan-out in action)
  c(tSlow, 'out', tFlr, 'x');
  c(tFlr,  'out', c1r,  'seed');
  c(tFlr,  'out', c1g,  'seed');
  c(tFlr,  'out', c1b,  'seed');
  c(tFlr,  'out', c2r,  'seed');
  c(tFlr,  'out', c2g,  'seed');
  c(tFlr,  'out', c2b,  'seed');

  // randoms drive the color channels (each wired Random overrides its
  // matching channel from the color-picker param)
  c(c1r, 'out', col1, 'r');
  c(c1g, 'out', col1, 'g');
  c(c1b, 'out', col1, 'b');
  c(c2r, 'out', col2, 'r');
  c(c2g, 'out', col2, 'g');
  c(c2b, 'out', col2, 'b');

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
];
