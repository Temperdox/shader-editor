/* Boot — wire up the header buttons + Save PNG, seed the default graph, and
   kick off the first shader compile. All other files declare globals on the
   window so this file can just use them. */

// header buttons
$('#addNodeBtn').addEventListener('click', () => openPicker());
$('#resetGraphBtn').addEventListener('click', resetGraph);
$('#saveShaderBtn').addEventListener('click', () => openSaveModal());
$('#loadShaderBtn').addEventListener('click', () => openLoadModal());

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
