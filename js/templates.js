/* Built-in shader templates.
 *
 * As of v=12 the templates are BAKED from `assets/Graphs/Reorganized/*.json`
 * into `js/templates/baked-graphs.js` (a single `window.BAKED_TEMPLATES` map
 * keyed by the registry IDs below). The procedural builders that used to
 * live here are gone — the JSON files are now the canonical source. To
 * regenerate after editing a JSON, run `node bake_templates.js` from the
 * project root.
 *
 * Each `tpl*` function is a one-liner that hands the matching baked entry
 * to `deserializeGraph()`, which replaces `state.nodes` / `state.connections`
 * in place. The registry at the bottom maps user-visible names → these
 * loader functions and groups them into picker categories.
 */

function _loadBaked(id){
  const data = window.BAKED_TEMPLATES && window.BAKED_TEMPLATES[id];
  if (!data){
    console.error('[templates] missing baked entry for', id);
    return;
  }
  // deserializeGraph (persistence.js) replaces state in place — no need to
  // call _clearGraph first.
  deserializeGraph(data);
}

/* ---------------- demo templates ---------------- */
function tplLightingTest()    { _loadBaked('lightingTest');    }
function tplLightingCompare() { _loadBaked('lightingCompare'); }
function tplParallaxAurora()  { _loadBaked('parallaxAurora');  }
function tplMarbleGold()      { _loadBaked('marbleGold');      }
function tplMarbleOnyx()      { _loadBaked('marbleOnyx');      }
function tplChannelMixer()    { _loadBaked('channelMixer');    }
function tplBlendDemo()       { _loadBaked('blendDemo');       }
function tplHeightField()     { _loadBaked('heightField');     }
function tplNormalPreview()   { _loadBaked('normalPreview');   }
function tplNormalLit()       { _loadBaked('normalLit');       }
function tplTerrainRelief()   { _loadBaked('terrainRelief');   }
function tplLitHeightfield()  { _loadBaked('litHeightfield');  }
function tplBrickWall()       { _loadBaked('brickWall');       }
function tplBrickWallSpec()   { _loadBaked('brickWallSpec');   }
function tplRadialPulse()     { _loadBaked('radialPulse');     }

/* ---------------- showcase templates ---------------- */
function tplAurora()           { _loadBaked('aurora');           }
function tplLavaFlow()         { _loadBaked('lavaFlow');         }
function tplPlasmaWave()       { _loadBaked('plasmaWave');       }
function tplNeonRings()        { _loadBaked('neonRings');        }
function tplStaticGrain()      { _loadBaked('staticGrain');      }
function tplTopographyJagged() { _loadBaked('topographyJagged'); }
function tplTopographySmooth() { _loadBaked('topographySmooth'); }
function tplCrystal()          { _loadBaked('crystal');          }
function tplPixelFlow()        { _loadBaked('pixelFlow');        }
function tplPixelSort()        { _loadBaked('pixelSort');        }
function tplPlaid()            { _loadBaked('plaid');            }
function tplVortex()           { _loadBaked('vortex');           }
function tplSDFShapes()        { _loadBaked('sdfShapes');        }

/* ---------------- Registry (order = display order in the picker) ---------------- */
/* `category` groups items in the picker UI: 'demo' is the tutorial / feature
   walkthrough set, 'showcase' is the fun / standalone-visual set. */
const SHADER_TEMPLATES = [
  // ---- Demos: illustrate specific features ----
  { id: 'lightingTest',    name: 'Lighting Test',    category:'demo',
    desc: 'Surface + Sim Light + Flag patch bay. Toggle diffuse/rim/iridescence.', load: tplLightingTest },
  { id: 'lightingCompare', name: 'Lighting Compare', category:'demo',
    desc: 'Side-by-side: World Normal vs Normal Map, both lit by Sim Light.', load: tplLightingCompare },
  { id: 'parallaxAurora',  name: 'Parallax Aurora',  category:'demo',
    desc: 'Layer Stack + Parallax UV + View Mask: 4-layer parallax scene.', load: tplParallaxAurora },
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
  { id: 'normalLit',       name: 'Normal + Color',   category:'demo',
    desc: 'Same procedural normal lit by Sim Light — toggle Lighting to see.', load: tplNormalLit },
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

  // ---- Showcase: creative / standalone visuals ----
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
  { id: 'pixelSort',       name: 'Pixel Sort',       category:'showcase',
    desc: 'Glitch-art vertical color streaks dripping downward — fakes pixel sorting via Y-stretched FBM.', load: tplPixelSort },
  { id: 'plaid',           name: 'Plaid',            category:'showcase',
    desc: 'Crossed Stripes × two pastel colors — warm/cool tartan weave.',   load: tplPlaid },
  { id: 'vortex',          name: 'Vortex',           category:'showcase',
    desc: 'Swirl + noise-driven Warp UV feeding an FBM palette field.',      load: tplVortex },
  { id: 'sdfShapes',       name: 'SDF Shapes',       category:'showcase',
    desc: 'Circle + animated Box combined via Min, palette-colored.',        load: tplSDFShapes },
];
