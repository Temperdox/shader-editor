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

// Shadows — toggles `body.shadows-on`. The renderer reads that class each
// frame to decide whether u_shadows = 1.0 (raycast) or 0.0 (skip). Preview
// always sends 1.0 regardless. Shaders only react to it via the Shadow node.
$('#shadowsBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('shadows-on');
  const btn = $('#shadowsBtn');
  const label = btn.querySelector('.shadows-label');
  if (label) label.textContent = on ? 'On' : 'Shadows';
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


// Save Video — records the bg canvas via captureStream + MediaRecorder.
// Tries MP4/H.264 first (the user-requested format), falls back to WebM if
// the browser can't muxer MP4 (Firefox can't, Chrome/Edge usually can).
// Toggle: first click starts; second click stops + downloads the file. The
// button shows the elapsed time while recording so the user knows it's live.
(() => {
  const btn = $('#saveVideoBtn');
  if (!btn) return;
  const label = btn.querySelector('.save-video-label');
  let recorder = null;
  let chunks = [];
  let pickedMime = '';
  let pickedExt  = 'webm';
  let timerId    = null;
  let startTs    = 0;

  function pickMime(){
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    // WebM first: Chrome/Edge MediaRecorder MP4 muxing is buggy and the resulting
    // files often fail to play in Windows Media Player / QuickTime even though
    // isTypeSupported() returns true. WebM (VP9/VP8) plays reliably in browsers
    // and VLC. Convert to MP4 externally with ffmpeg if needed.
    const candidates = [
      ['video/webm;codecs=vp9,opus',   'webm'],
      ['video/webm;codecs=vp9',        'webm'],
      ['video/webm;codecs=vp8',        'webm'],
      ['video/webm',                   'webm'],
      ['video/mp4;codecs=avc1.42E01E', 'mp4'],
      ['video/mp4;codecs=avc1',        'mp4'],
      ['video/mp4',                    'mp4'],
    ];
    for (const [m, e] of candidates){
      if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: e };
    }
    return null;
  }

  function startRecording(){
    if (typeof MediaRecorder === 'undefined'){
      toast('MediaRecorder unsupported in this browser', 'err');
      return;
    }
    const canvas = (renderer && renderer.canvas) || $('#bgShader');
    if (!canvas){ toast('canvas not ready', 'err'); return; }
    if (typeof canvas.captureStream !== 'function'){
      toast('canvas.captureStream unsupported', 'err');
      return;
    }
    const picked = pickMime();
    if (!picked){ toast('no supported video codec', 'err'); return; }
    pickedMime = picked.mime;
    pickedExt  = picked.ext;
    chunks = [];

    const stream = canvas.captureStream(60);
    try {
      recorder = new MediaRecorder(stream, { mimeType: pickedMime });
    } catch (err){
      console.error(err);
      toast('recorder init failed', 'err');
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: pickedMime || 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `shader-${ts}.${pickedExt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast(`saved ${pickedExt.toUpperCase()} video`);
    };

    recorder.start(250);   // request a chunk every 250ms (smoother seeking)
    btn.classList.add('recording');
    startTs = performance.now();
    if (label) label.textContent = 'STOP 0:00';
    timerId = setInterval(() => {
      const elapsed = Math.floor((performance.now() - startTs) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      if (label) label.textContent = `STOP ${m}:${String(s).padStart(2, '0')}`;
    }, 250);
  }

  function stopRecording(){
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
    btn.classList.remove('recording');
    if (timerId){ clearInterval(timerId); timerId = null; }
    if (label) label.textContent = 'Save Video';
  }

  btn.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stopRecording();
    else startRecording();
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
