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

// Lightbulb cursor follower — only visible when sim-lighting is on AND the
// cursor is over the bare shader background (not over the editor UI, not
// over the preview card). When over UI / in preview, the native cursor is
// restored so the user can interact normally. Both the bulb visibility
// and the body's `cursor: none` are gated by the same JS check below so
// they're always in sync.
(() => {
  const lc = $('#lightCursor');
  if (!lc) return;
  // Anything matching one of these selectors counts as "editor UI" — bulb
  // hides, native cursor returns. Add new chrome elements here if needed.
  const UI_SEL = [
    '.modal',
    '.fab-group',
    '.picker',
    '.picker-backdrop',
    '.ctx',
    '.toast',
    '.chrome',
    '.preview-root',  // entire preview surface, including the card
  ].join(', ');

  function setBulbState(showBulb){
    lc.classList.toggle('visible', showBulb);
    document.body.classList.toggle('light-bulb-active', showBulb);
  }

  window.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('sim-lighting-on')){
      setBulbState(false);
      return;
    }
    const overUI = !!(e.target && e.target.closest && e.target.closest(UI_SEL));
    const inPreview = document.body.classList.contains('preview-mode');
    const showBulb = !overUI && !inPreview;
    setBulbState(showBulb);
    if (showBulb){
      lc.style.left = e.clientX + 'px';
      lc.style.top  = e.clientY + 'px';
    }
  }, { passive: true });

  // Hide when the cursor leaves the window so a stale bulb doesn't linger.
  document.addEventListener('pointerleave', () => setBulbState(false));
  // Re-evaluate after toggling Lighting off so the bulb hides immediately.
  $('#simLightBtn').addEventListener('click', () => {
    if (!document.body.classList.contains('sim-lighting-on')) setBulbState(false);
  });
})();


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
