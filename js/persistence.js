/* Persistence — shader graph serialization, localStorage storage, and file I/O,
   plus the Save / Load modals that drive all of the above. */

const STORAGE_KEY = 'shaderGraphSaves';
const FILE_VERSION = 1;
// tracks the last name used, so reopening Save defaults to that instead of "Untitled"
let currentShaderName = '';

/* ---------------- serialization ----------------
 * Deep-copies everything so mutating the graph after saving doesn't corrupt
 * stored snapshots. The view is preserved so a loaded shader restores its
 * camera exactly. */
function serializeGraph(name){
  return {
    version: FILE_VERSION,
    name: name || 'Untitled',
    timestamp: Date.now(),
    view: { ...state.view },
    nodes: state.nodes.map(n => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      params: deepClone(n.params),
      defaults: deepClone(n.defaults),
    })),
    connections: state.connections.map(c => ({
      id: c.id,
      from: { ...c.from },
      to:   { ...c.to   },
    })),
  };
}

function deepClone(obj){
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = deepClone(obj[k]);
  return out;
}

function deserializeGraph(data){
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.connections)){
    throw new Error('invalid shader file');
  }
  // validate every node type exists in the current registry before touching state
  for (const n of data.nodes){
    if (!NODE_TYPES[n.type]){
      throw new Error(`unknown node type "${n.type}"`);
    }
  }

  state.nodes = data.nodes.map(n => ({
    id: n.id,
    type: n.type,
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    params: deepClone(n.params || {}),
    defaults: deepClone(n.defaults || {}),
  }));
  state.connections = data.connections
    // strip connections that reference missing nodes (in case a legacy file
    // mentions node types that no longer exist)
    .filter(c => state.nodes.find(n => n.id === c.from.nodeId)
              && state.nodes.find(n => n.id === c.to.nodeId))
    .map(c => ({
      id: c.id,
      from: { ...c.from },
      to:   { ...c.to   },
    }));

  if (data.view && typeof data.view.tx === 'number'){
    state.view = { ...data.view };
  }

  // Re-trigger image loads for any static-mode Height/Normal Map nodes. The
  // URL (or data: URL) lives in node.params.imageUrl and is already restored
  // by the deep-clone above — we just need the texture infrastructure to
  // know about it so the placeholder gets replaced.
  for (const n of state.nodes){
    if (n.params && n.params.mode === 'static' && n.params.imageUrl){
      loadImageForNode(n.id, n.params.imageUrl);
    }
  }

  currentShaderName = data.name || '';
  renderAll();
  updateViewportTransform();
  recompileShader();
}

/* ---------------- localStorage ---------------- */
function getAllStored(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAllStored(map){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e){
    // most likely a quota error; surface it
    toast('storage full', 'err');
    console.error(e);
  }
}

function saveToStorage(name){
  if (!name || !name.trim()){ toast('name required', 'err'); return; }
  const all = getAllStored();
  all[name] = serializeGraph(name);
  writeAllStored(all);
  currentShaderName = name;
  toast(`saved "${name}"`);
}

function deleteFromStorage(name){
  const all = getAllStored();
  delete all[name];
  writeAllStored(all);
}

function loadFromStorage(name){
  const all = getAllStored();
  const data = all[name];
  if (!data) throw new Error(`no shader "${name}"`);
  deserializeGraph(data);
  toast(`loaded "${name}"`);
}

/* ---------------- file I/O ---------------- */
function saveToFile(name){
  const data = serializeGraph(name);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safe = (name || 'shader').replace(/[^\w\-\.]+/g, '_');
  a.download = `${safe}.shader.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  currentShaderName = name;
  toast(`exported "${safe}.shader.json"`);
}

async function loadFromFile(file){
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('file is not valid JSON');
  }
  deserializeGraph(data);
}

/* ---------------- Save modal ---------------- */
const saveModal     = $('#saveModal');
const saveBack      = $('#saveBack');
const saveNameInput = $('#saveName');
const shaderCodeEl  = $('#shaderCode');
const copyShaderBtn = $('#copyShaderBtn');
const copyLabelEl   = copyShaderBtn.querySelector('.copy-label');

function resetCopyBtn(){
  copyShaderBtn.classList.remove('copied');
  copyLabelEl.textContent = 'Copy';
}

copyShaderBtn.addEventListener('click', async () => {
  const text = shaderCodeEl.textContent || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
    } else {
      // fallback for file:// contexts where Clipboard API may be blocked
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copyShaderBtn.classList.add('copied');
    copyLabelEl.textContent = 'Copied';
    clearTimeout(copyShaderBtn._t);
    copyShaderBtn._t = setTimeout(resetCopyBtn, 1400);
  } catch (e){
    console.error(e);
    toast('copy failed', 'err');
  }
});

function openSaveModal(){
  saveNameInput.value = currentShaderName || 'Untitled';
  // recompile once to populate the preview with the CURRENT graph state; if
  // compilation fails, surface the error in the preview instead of leaving stale code.
  const res = compileGraph();
  const code = res.ok ? formatShaderAsJS(res.fs) : `/* compile error: ${res.error} */`;
  shaderCodeEl.textContent = code;
  resetCopyBtn();
  saveModal.classList.add('open');
  saveBack.classList.add('open');
  setTimeout(() => {
    saveNameInput.focus();
    saveNameInput.select();
  }, 30);
}

// Wrap the GLSL source in a JS template literal so the copied text drops
// straight into a WebGL setup (`const FRAGMENT_SHADER = \`...\`;`).
function formatShaderAsJS(glsl){
  return `const FRAGMENT_SHADER = \`\n${glsl.trim()}\n\`;`;
}
function closeSaveModal(){
  saveModal.classList.remove('open');
  saveBack.classList.remove('open');
}
saveBack.addEventListener('click', closeSaveModal);
saveNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter'){
    // Enter defaults to Save-to-Storage since that's the primary action
    const name = saveNameInput.value.trim();
    if (name){
      saveToStorage(name);
      closeSaveModal();
    }
  } else if (e.key === 'Escape'){
    closeSaveModal();
  }
});
$('#saveToStorageBtn').addEventListener('click', () => {
  const name = saveNameInput.value.trim();
  if (!name){ toast('name required', 'err'); return; }
  saveToStorage(name);
  closeSaveModal();
});
$('#saveToFileBtn').addEventListener('click', () => {
  const name = saveNameInput.value.trim() || 'shader';
  saveToFile(name);
  closeSaveModal();
});

/* ---------------- Load modal ---------------- */
const loadModal     = $('#loadModal');
const loadBack      = $('#loadBack');
const loadSearch    = $('#loadSearch');
const loadList      = $('#loadList');
const loadFileInput = $('#loadFileInput');

function openLoadModal(){
  renderLoadList('');
  loadSearch.value = '';
  loadModal.classList.add('open');
  loadBack.classList.add('open');
  setTimeout(() => loadSearch.focus(), 30);
}
function closeLoadModal(){
  loadModal.classList.remove('open');
  loadBack.classList.remove('open');
}
loadBack.addEventListener('click', closeLoadModal);
loadSearch.addEventListener('input', () => renderLoadList(loadSearch.value));
loadSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){ closeLoadModal(); }
  else if (e.key === 'Enter'){
    const first = loadList.querySelector('.shader-list-item');
    if (first) first.click();
  }
});

function renderLoadList(q){
  const all = getAllStored();
  const names = Object.keys(all).sort((a, b) => (all[b].timestamp || 0) - (all[a].timestamp || 0));
  const query = q.trim().toLowerCase();
  const matches = query ? names.filter(n => n.toLowerCase().includes(query)) : names;

  loadList.innerHTML = '';

  if (!matches.length){
    const empty = document.createElement('div');
    empty.className = 'shader-list-empty';
    empty.textContent = names.length
      ? 'no matches'
      : 'no saved shaders yet — save one to see it here';
    loadList.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'shader-list';
  for (const name of matches){
    const data = all[name];
    const item = document.createElement('div');
    item.className = 'shader-list-item';

    const main = document.createElement('div');
    main.className = 'sli-main';
    const title = document.createElement('div');
    title.className = 'sli-name';
    title.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'sli-meta';
    const when = data.timestamp ? new Date(data.timestamp).toLocaleString() : '';
    const count = (data.nodes && data.nodes.length) || 0;
    meta.textContent = `${count} nodes${when ? ' · ' + when : ''}`;
    main.appendChild(title);
    main.appendChild(meta);
    item.appendChild(main);

    const del = document.createElement('button');
    del.className = 'sli-del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h12M8 6V4h4v2M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6M9 9v6M11 9v6"/></svg>`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFromStorage(name);
      renderLoadList(loadSearch.value);
    });
    item.appendChild(del);

    item.addEventListener('click', () => {
      try {
        loadFromStorage(name);
        closeLoadModal();
      } catch (err){
        toast(err.message, 'err');
      }
    });
    list.appendChild(item);
  }
  loadList.appendChild(list);
}

$('#loadTemplateBtn').addEventListener('click', () => openTemplatesModal());

/* ---------------- templates picker ---------------- */
const templatesModal  = $('#templatesModal');
const templatesBack   = $('#templatesBack');
const templatesSearch = $('#templatesSearch');
const templatesList   = $('#templatesList');

function openTemplatesModal(){
  renderTemplatesList('');
  templatesSearch.value = '';
  templatesModal.classList.add('open');
  templatesBack.classList.add('open');
  setTimeout(() => templatesSearch.focus(), 30);
}
function closeTemplatesModal(){
  templatesModal.classList.remove('open');
  templatesBack.classList.remove('open');
}
templatesBack.addEventListener('click', closeTemplatesModal);
templatesSearch.addEventListener('input', () => renderTemplatesList(templatesSearch.value));
templatesSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){ closeTemplatesModal(); }
  else if (e.key === 'Enter'){
    const first = templatesList.querySelector('.shader-list-item');
    if (first) first.click();
  }
});

// Display order + human-readable label for each category. Items whose
// category isn't in this list fall into "demo" by default.
const TEMPLATE_CATEGORIES = [
  { id: 'showcase', label: 'Showcase' },
  { id: 'demo',     label: 'Demos'    },
];

function buildTemplateItem(t){
  const item = document.createElement('div');
  item.className = 'shader-list-item';

  const main = document.createElement('div');
  main.className = 'sli-main';
  const title = document.createElement('div');
  title.className = 'sli-name';
  title.textContent = t.name;
  const meta = document.createElement('div');
  meta.className = 'sli-meta';
  meta.textContent = t.desc || '';
  main.appendChild(title);
  main.appendChild(meta);
  item.appendChild(main);

  item.addEventListener('click', () => {
    try {
      t.load();
      currentShaderName = '';
      // templates that use Texture / static Height/Normal nodes stash a
      // URL in node.params.imageUrl — kick off the actual image loads
      // here so the template author doesn't have to remember to do it.
      for (const n of state.nodes){
        const url = n.params && n.params.imageUrl;
        if (url) loadImageForNode(n.id, url);
      }
      renderAll();
      recenterView();
      recompileShader();
      closeTemplatesModal();
      closeLoadModal();
      toast(`loaded "${t.name}"`);
    } catch (err){
      toast(err.message || 'template failed', 'err');
      console.error(err);
    }
  });
  return item;
}

function renderTemplatesList(q){
  const query = q.trim().toLowerCase();
  const matches = !query ? SHADER_TEMPLATES : SHADER_TEMPLATES.filter(t =>
    t.name.toLowerCase().includes(query) ||
    (t.desc || '').toLowerCase().includes(query) ||
    t.id.toLowerCase().includes(query)
  );

  templatesList.innerHTML = '';

  if (!matches.length){
    const empty = document.createElement('div');
    empty.className = 'shader-list-empty';
    empty.textContent = 'no matches';
    templatesList.appendChild(empty);
    return;
  }

  // group matches by category so each gets its own collapsible section.
  const grouped = new Map();   // categoryId → [template,…]
  for (const t of matches){
    const cat = t.category || 'demo';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(t);
  }

  for (const { id: catId, label } of TEMPLATE_CATEGORIES){
    const items = grouped.get(catId);
    if (!items || !items.length) continue;

    // <details>/<summary> gives native open/closed state + keyboard a11y
    // for free. Both groups start expanded; user can collapse with a click.
    const details = document.createElement('details');
    details.className = 'tpl-cat';
    details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'tpl-cat-header';
    summary.innerHTML = `<span class="tpl-cat-label">${escapeHTML(label)}</span>` +
                       `<span class="tpl-cat-count">${items.length}</span>`;
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'shader-list';
    for (const t of items) list.appendChild(buildTemplateItem(t));
    details.appendChild(list);

    templatesList.appendChild(details);
  }

  // Any uncategorized (or unknown-category) matches — show them in a trailing
  // "Other" section so they don't disappear if someone mistypes a category.
  const knownIds = new Set(TEMPLATE_CATEGORIES.map(c => c.id));
  const leftovers = matches.filter(t => !knownIds.has(t.category || 'demo'));
  if (leftovers.length){
    const details = document.createElement('details');
    details.className = 'tpl-cat';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'tpl-cat-header';
    summary.innerHTML = `<span class="tpl-cat-label">Other</span>` +
                       `<span class="tpl-cat-count">${leftovers.length}</span>`;
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'shader-list';
    for (const t of leftovers) list.appendChild(buildTemplateItem(t));
    details.appendChild(list);
    templatesList.appendChild(details);
  }
}

$('#loadFromFileBtn').addEventListener('click', () => {
  loadFileInput.value = '';       // reset so selecting the same file re-fires 'change'
  loadFileInput.click();
});
loadFileInput.addEventListener('change', async () => {
  const file = loadFileInput.files && loadFileInput.files[0];
  if (!file) return;
  try {
    await loadFromFile(file);
    closeLoadModal();
    toast(`loaded "${file.name}"`);
  } catch (err){
    toast(err.message || 'load failed', 'err');
  }
});

// close all IO modals on Escape (in addition to the in-field handlers)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape'){
    if (templatesModal.classList.contains('open')) closeTemplatesModal();
    if (saveModal.classList.contains('open'))      closeSaveModal();
    if (loadModal.classList.contains('open'))      closeLoadModal();
  }
});
