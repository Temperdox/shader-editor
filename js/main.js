/* Boot — wire up the header buttons + Save PNG, seed the default graph, and
   kick off the first shader compile. All other files declare globals on the
   window so this file can just use them. */

// header buttons
$('#addNodeBtn').addEventListener('click', () => openPicker());
$('#resetGraphBtn').addEventListener('click', resetGraph);
$('#clearGraphBtn').addEventListener('click', clearGraph);
$('#saveShaderBtn').addEventListener('click', () => openSaveModal());
$('#loadShaderBtn').addEventListener('click', () => openLoadModal());

// Hide/Show — hides all UI chrome so only the background shader + these fabs
// are visible. Toggles the button label between "Hide" and "Show".
$('#hideUiBtn').addEventListener('click', () => {
  const hidden = document.body.classList.toggle('ui-hidden');
  const label = document.querySelector('#hideUiBtn .hide-label');
  if (label) label.textContent = hidden ? 'Show' : 'Hide';
});

// Lighting — toggles cursor-driven light + rotation uniforms. Shaders using
// the `Sim Light` / `Sim Rotation` input nodes react live while the button
// is active. The button itself just flips `body.sim-lighting-on`; the
// renderer reads that class each frame to decide which uniform values to
// send (see renderer.js / preview.js).
$('#simLightBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('sim-lighting-on');
  const btn = $('#simLightBtn');
  const label = btn.querySelector('.sim-light-label');
  if (label) label.textContent = on ? 'Lit' : 'Lighting';
  btn.classList.toggle('active', on);
});

// Lightbulb cursor follower — tracks the pointer whenever sim-lighting is
// active so the user can see exactly where the virtual point light sits.
// Position is updated in pixel space; CSS handles the show/hide via opacity.
(() => {
  const lc = $('#lightCursor');
  if (!lc) return;
  window.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('sim-lighting-on')) return;
    lc.style.left = e.clientX + 'px';
    lc.style.top  = e.clientY + 'px';
  }, { passive: true });
})();

// Surface — toggles the 64×64 tessellated test mesh's procedural height
// field. When on, the vertex shader computes per-vertex normals from a
// noise-based height field and passes them via v_surfaceNormal (readable
// in-graph via the World Normal node). Exists as a lighting test bed so
// you can see Fresnel / Lambert / iridescence react across real 3D normals
// instead of the flat (0,0,1) they get on an untextured fullscreen quad.
$('#surfaceBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('surface-on');
  const btn = $('#surfaceBtn');
  const label = btn.querySelector('.surface-label');
  if (label) label.textContent = on ? 'On' : 'Surface';
  btn.classList.toggle('active', on);
});

// Save shader as PNG — downloads the current bgShader canvas. Requires
// `preserveDrawingBuffer: true` on the WebGL context (set in renderer.js).
$('#saveBtn').addEventListener('click', () => {
  const c = renderer.canvas;
  if (!c){ toast('nothing to save', 'err'); return; }
  try {
    c.toBlob((blob) => {
      if (!blob){ toast('save failed', 'err'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // ISO timestamp, minus punctuation that Windows doesn't like in filenames
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `shader-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('saved to downloads');
    }, 'image/png');
  } catch (e){
    console.error(e);
    toast('save failed', 'err');
  }
});

// Suppress the browser's native context menu over our own UI chrome so our
// custom menu is the only one that ever appears there. (Right-click on the
// background shader outside the modal still shows the native menu by design.)
document.addEventListener('contextmenu', (e) => {
  if (
    e.target.closest('.modal') ||
    e.target.closest('.ctx')   ||
    e.target.closest('.save-fab')
  ){
    e.preventDefault();
  }
});

// initial render
seedDefaultGraph();
renderAll();
recenterView();
recompileShader();
pushHistory();   // seed the undo stack with the initial graph
