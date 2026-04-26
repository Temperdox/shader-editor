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


// Save Video — opens a settings modal (filename, codec, bitrate, fps, crop)
// then records the bg canvas via MediaRecorder. Toggle: first click opens the
// modal (or stops if already recording); the modal's Start button kicks off
// recording. Cropped recordings draw the cropped region into an offscreen
// canvas each frame and capture that.
(() => {
  const btn = $('#saveVideoBtn');
  if (!btn) return;
  const label = btn.querySelector('.save-video-label');

  // ---- modal DOM refs ----
  const modal     = $('#saveVideoModal');
  const back      = $('#saveVideoBack');
  const previewCv = $('#svPreviewCanvas');
  const previewCt = previewCv ? previewCv.getContext('2d') : null;
  const wrap      = $('#svPreviewWrap');
  const cropEl    = $('#svCrop');
  const cropInfo  = $('#svCropInfo');
  const filenameI = $('#svFilename');
  const codecSel  = $('#svCodec');
  const brSlider  = $('#svBitrate');
  const brMax     = $('#svBitrateMax');
  const brReadout = $('#svBitrateReadout');
  const cancelBtn = $('#svCancelBtn');
  const startBtn  = $('#svStartBtn');
  const arBtns    = modal ? [...modal.querySelectorAll('[data-ar]')] : [];
  const brBtns    = modal ? [...modal.querySelectorAll('[data-br]')] : [];
  const fpsBtns   = modal ? [...modal.querySelectorAll('[data-fps]')] : [];
  const durBtns   = modal ? [...modal.querySelectorAll('[data-dur]')] : [];
  const durInput  = $('#svDuration');
  const durRead   = $('#svDurationReadout');

  // ---- recording state ----
  let recorder        = null;
  let chunks          = [];
  let pickedExt       = 'webm';
  let pickedMime      = '';
  let timerId         = null;
  let startTs         = 0;
  let previewRafId    = 0;
  let recordRafId     = 0;
  let recordCanvas    = null;
  let recordCtx       = null;
  let chosenFilename  = '';
  let chosenFps       = 60;
  let chosenDuration  = 0;       // seconds; 0 = manual stop
  let autoStopId      = null;
  let cropNorm        = { x:0, y:0, w:1, h:1 };

  // codecs in the dropdown — only those actually supported are shown.
  // WebM is listed first because Chrome's MP4 muxer often produces broken files.
  const ALL_CODECS = [
    { mime:'video/webm;codecs=vp9,opus',   ext:'webm', label:'WebM · VP9 (recommended)' },
    { mime:'video/webm;codecs=vp9',        ext:'webm', label:'WebM · VP9' },
    { mime:'video/webm;codecs=vp8',        ext:'webm', label:'WebM · VP8' },
    { mime:'video/webm',                   ext:'webm', label:'WebM (browser default)' },
    { mime:'video/mp4;codecs=avc1.42E01E', ext:'mp4',  label:'MP4 · H.264 (Chrome may produce a broken file)' },
    { mime:'video/mp4;codecs=avc1',        ext:'mp4',  label:'MP4 · H.264 generic (may be broken)' },
    { mime:'video/mp4',                    ext:'mp4',  label:'MP4 (may be broken)' },
  ];

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function srcCanvas(){ return (typeof renderer !== 'undefined' && renderer && renderer.canvas) || $('#bgShader'); }
  function defaultFilename(){
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `shader-${ts}`;
  }
  function setActive(buttons, predicate){
    buttons.forEach(b => b.classList.toggle('active', !!predicate(b)));
  }

  function populateCodecs(){
    if (!codecSel) return;
    codecSel.innerHTML = '';
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported){
      const o = document.createElement('option');
      o.textContent = 'MediaRecorder unsupported';
      o.disabled = true;
      codecSel.appendChild(o);
      return;
    }
    let added = 0;
    for (const c of ALL_CODECS){
      if (!MediaRecorder.isTypeSupported(c.mime)) continue;
      const o = document.createElement('option');
      o.value = c.mime;
      o.dataset.ext = c.ext;
      o.textContent = c.label;
      codecSel.appendChild(o);
      added++;
    }
    if (!added){
      const o = document.createElement('option');
      o.textContent = 'No supported codec';
      o.disabled = true;
      codecSel.appendChild(o);
    }
  }

  function applyCropToDom(){
    if (!cropEl) return;
    cropEl.style.left   = (cropNorm.x * 100) + '%';
    cropEl.style.top    = (cropNorm.y * 100) + '%';
    cropEl.style.width  = (cropNorm.w * 100) + '%';
    cropEl.style.height = (cropNorm.h * 100) + '%';
    const sc = srcCanvas();
    if (sc && cropInfo){
      const px = Math.round(cropNorm.w * sc.width);
      const py = Math.round(cropNorm.h * sc.height);
      const ox = Math.round(cropNorm.x * sc.width);
      const oy = Math.round(cropNorm.y * sc.height);
      cropInfo.textContent = `${px}×${py} px  ·  offset ${ox},${oy}  ·  ${(cropNorm.w*100).toFixed(0)}% × ${(cropNorm.h*100).toFixed(0)}%`;
    }
  }

  function setAspectPreset(ar){
    if (ar === 'full' || ar === 'reset' || ar === 'free'){
      cropNorm = { x:0, y:0, w:1, h:1 };
    } else {
      const [aw, ah] = ar.split(':').map(Number);
      const target = aw / ah;
      const sc = srcCanvas();
      const srcAR = sc ? sc.width/sc.height : 16/9;
      let w, h;
      if (target > srcAR){
        // crop is wider than source — saturate width, shrink height
        w = 1; h = srcAR / target;
      } else {
        // crop is narrower — saturate height, shrink width
        h = 1; w = target / srcAR;
      }
      cropNorm = { x:(1-w)/2, y:(1-h)/2, w, h };
    }
    setActive(arBtns, b => b.dataset.ar === ar);
    applyCropToDom();
  }

  // ---- crop drag/resize ----
  let dragMode = null;
  let dragStart = null;
  function onPointerDown(e){
    const t = e.target;
    if (!t) return;
    let mode = null;
    if (t.classList && t.classList.contains('sv-crop-handle')){
      mode = t.dataset.h;
    } else if (t === cropEl){
      mode = 'move';
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = wrap.getBoundingClientRect();
    dragMode  = mode;
    dragStart = {
      mx: e.clientX, my: e.clientY,
      crop: { ...cropNorm },
      wrapW: rect.width, wrapH: rect.height,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup',   onPointerUp);
  }
  function onPointerMove(e){
    if (!dragMode || !dragStart) return;
    const dx = (e.clientX - dragStart.mx) / dragStart.wrapW;
    const dy = (e.clientY - dragStart.my) / dragStart.wrapH;
    let { x, y, w, h } = dragStart.crop;
    const minS = 0.04;
    if (dragMode === 'move'){
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else {
      let x2 = x + w, y2 = y + h;
      if (dragMode.includes('w')) x  = clamp(x  + dx, 0, x2 - minS);
      if (dragMode.includes('e')) x2 = clamp(x2 + dx, x + minS, 1);
      if (dragMode.includes('n')) y  = clamp(y  + dy, 0, y2 - minS);
      if (dragMode.includes('s')) y2 = clamp(y2 + dy, y + minS, 1);
      w = x2 - x; h = y2 - y;
    }
    cropNorm = { x, y, w, h };
    setActive(arBtns, b => b.dataset.ar === 'free');
    applyCropToDom();
  }
  function onPointerUp(){
    dragMode = null; dragStart = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup',   onPointerUp);
  }

  function resizePreviewCanvas(){
    if (!wrap || !previewCv) return;
    const sc = srcCanvas();
    if (sc) wrap.style.aspectRatio = `${sc.width} / ${sc.height}`;
    const rect = wrap.getBoundingClientRect();
    const dpr  = Math.min(window.devicePixelRatio || 1, 2);
    previewCv.width  = Math.max(1, Math.round(rect.width  * dpr));
    previewCv.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function updateBitrateUI(){
    if (!brSlider || !brReadout) return;
    if (brMax.checked){
      brSlider.disabled = true;
      brReadout.textContent = 'MAX (browser cap)';
    } else {
      brSlider.disabled = false;
      brReadout.textContent = `${brSlider.value} Mbps`;
    }
  }

  function fmtDur(sec){
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function updateDurationUI(){
    if (!durInput || !durRead) return;
    const v = Math.max(0, parseInt(durInput.value, 10) || 0);
    if (v === 0){
      durRead.textContent = 'Manual stop';
    } else {
      durRead.textContent = `Auto-stop ${fmtDur(v)}`;
    }
    setActive(durBtns, b => +b.dataset.dur === v);
  }

  function openModal(){
    if (!modal) return;
    populateCodecs();
    if (filenameI) filenameI.value = defaultFilename();
    cropNorm = { x:0, y:0, w:1, h:1 };
    setAspectPreset('full');
    if (brMax) brMax.checked = false;
    if (brSlider) brSlider.value = 16;
    updateBitrateUI();
    setActive(brBtns, b => +b.dataset.br === 16);
    setActive(fpsBtns, b => +b.dataset.fps === chosenFps);
    if (durInput) durInput.value = chosenDuration;
    updateDurationUI();

    modal.classList.add('open');
    back.classList.add('open');
    // wait for layout, then size preview canvas + start the rAF mirror loop
    requestAnimationFrame(() => {
      resizePreviewCanvas();
      applyCropToDom();
    });
    if (previewRafId) cancelAnimationFrame(previewRafId);
    const drawPreview = () => {
      const sc = srcCanvas();
      if (sc && previewCt){
        previewCt.clearRect(0, 0, previewCv.width, previewCv.height);
        try { previewCt.drawImage(sc, 0, 0, previewCv.width, previewCv.height); } catch {}
      }
      previewRafId = requestAnimationFrame(drawPreview);
    };
    drawPreview();
  }
  function closeModal(){
    if (!modal) return;
    modal.classList.remove('open');
    back.classList.remove('open');
    if (previewRafId){ cancelAnimationFrame(previewRafId); previewRafId = 0; }
  }

  function startRecording(){
    if (typeof MediaRecorder === 'undefined'){
      toast('MediaRecorder unsupported in this browser', 'err');
      return;
    }
    const sc = srcCanvas();
    if (!sc){ toast('canvas not ready', 'err'); return; }
    if (typeof sc.captureStream !== 'function'){
      toast('canvas.captureStream unsupported', 'err');
      return;
    }
    const opt = codecSel && codecSel.options[codecSel.selectedIndex];
    if (!opt || opt.disabled){ toast('no supported codec', 'err'); return; }
    pickedMime = opt.value;
    pickedExt  = opt.dataset.ext || 'webm';

    chosenFilename = ((filenameI && filenameI.value.trim()) || defaultFilename())
      .replace(/[\\/:*?"<>|]/g, '_');
    chosenDuration = durInput ? Math.max(0, parseInt(durInput.value, 10) || 0) : 0;
    chunks = [];

    const isFull = cropNorm.x === 0 && cropNorm.y === 0
                && cropNorm.w === 1 && cropNorm.h === 1;
    let captureSource;
    if (isFull){
      captureSource = sc;
      recordCanvas  = null;
      recordCtx     = null;
    } else {
      const cw = Math.max(2, Math.round(cropNorm.w * sc.width));
      const ch = Math.max(2, Math.round(cropNorm.h * sc.height));
      recordCanvas = document.createElement('canvas');
      recordCanvas.width  = cw;
      recordCanvas.height = ch;
      recordCtx = recordCanvas.getContext('2d');
      captureSource = recordCanvas;
      const tick = () => {
        if (!recordCanvas) return;
        const sx = Math.round(cropNorm.x * sc.width);
        const sy = Math.round(cropNorm.y * sc.height);
        const sw = Math.round(cropNorm.w * sc.width);
        const sh = Math.round(cropNorm.h * sc.height);
        try { recordCtx.drawImage(sc, sx, sy, sw, sh, 0, 0, recordCanvas.width, recordCanvas.height); } catch {}
        recordRafId = requestAnimationFrame(tick);
      };
      recordRafId = requestAnimationFrame(tick);
    }

    const useMax  = brMax && brMax.checked;
    const reqRate = useMax ? 500_000_000 : Math.round(parseFloat(brSlider.value) * 1_000_000);
    const stream  = captureSource.captureStream(chosenFps);
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: pickedMime,
        videoBitsPerSecond: reqRate,
      });
    } catch (err){
      console.error(err);
      toast('recorder init failed', 'err');
      if (recordRafId){ cancelAnimationFrame(recordRafId); recordRafId = 0; }
      recordCanvas = null; recordCtx = null;
      return;
    }
    const actualRate = recorder.videoBitsPerSecond || 0;
    console.log(
      `[saveVideo] ${captureSource.width}x${captureSource.height} @ ${chosenFps}fps, ` +
      `requested ${(reqRate/1_000_000).toFixed(1)} Mbps, actual ${(actualRate/1_000_000).toFixed(1)} Mbps, ` +
      `codec ${pickedMime}, file ${chosenFilename}.${pickedExt}`
    );

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: pickedMime || 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${chosenFilename}.${pickedExt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast(`saved ${pickedExt.toUpperCase()} video`);
      if (recordRafId){ cancelAnimationFrame(recordRafId); recordRafId = 0; }
      recordCanvas = null; recordCtx = null;
    };

    recorder.start(250);
    btn.classList.add('recording');
    startTs = performance.now();
    const totalStr = chosenDuration > 0 ? ` / ${fmtDur(chosenDuration)}` : '';
    if (label) label.textContent = `STOP 0:00${totalStr}`;
    timerId = setInterval(() => {
      const elapsedSec = Math.floor((performance.now() - startTs) / 1000);
      if (label) label.textContent = `STOP ${fmtDur(elapsedSec)}${totalStr}`;
    }, 250);
    if (chosenDuration > 0){
      autoStopId = setTimeout(stopRecording, chosenDuration * 1000);
    }
  }

  function stopRecording(){
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
    btn.classList.remove('recording');
    if (timerId){ clearInterval(timerId); timerId = null; }
    if (autoStopId){ clearTimeout(autoStopId); autoStopId = null; }
    if (label) label.textContent = 'Save Video';
  }

  // ---- modal wiring ----
  if (modal){
    arBtns.forEach(b => b.addEventListener('click', () => setAspectPreset(b.dataset.ar)));
    fpsBtns.forEach(b => b.addEventListener('click', () => {
      chosenFps = +b.dataset.fps;
      setActive(fpsBtns, x => x === b);
    }));
    brBtns.forEach(b => b.addEventListener('click', () => {
      if (brMax) brMax.checked = false;
      brSlider.value = b.dataset.br;
      updateBitrateUI();
      setActive(brBtns, x => x === b);
    }));
    if (brSlider) brSlider.addEventListener('input', () => {
      if (brMax) brMax.checked = false;
      updateBitrateUI();
      setActive(brBtns, b => +b.dataset.br === +brSlider.value);
    });
    if (brMax) brMax.addEventListener('change', () => {
      updateBitrateUI();
      if (brMax.checked) setActive(brBtns, () => false);
    });
    durBtns.forEach(b => b.addEventListener('click', () => {
      if (durInput) durInput.value = b.dataset.dur;
      updateDurationUI();
    }));
    if (durInput) durInput.addEventListener('input', updateDurationUI);
    if (cropEl){
      cropEl.addEventListener('pointerdown', onPointerDown);
      [...cropEl.querySelectorAll('.sv-crop-handle')].forEach(h =>
        h.addEventListener('pointerdown', onPointerDown));
    }
    cancelBtn.addEventListener('click', closeModal);
    back.addEventListener('click', closeModal);
    startBtn.addEventListener('click', () => {
      closeModal();
      startRecording();
    });
    if (filenameI) filenameI.addEventListener('keydown', (e) => {
      if (e.key === 'Enter'){ e.preventDefault(); closeModal(); startRecording(); }
      else if (e.key === 'Escape'){ closeModal(); }
    });
    window.addEventListener('resize', () => {
      if (modal.classList.contains('open')){
        resizePreviewCanvas();
        applyCropToDom();
      }
    });
  }

  // main button: stop if recording, otherwise open the settings modal
  btn.addEventListener('click', () => {
    if (recorder && recorder.state !== 'inactive') stopRecording();
    else openModal();
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
