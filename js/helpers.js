/* Global utilities — attached to window so the other classic scripts can use
   them without module imports. Keep this file dependency-free. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const uid = (() => {
  let n = 0;
  return (p = 'n') => `${p}${(++n).toString(36)}`;
})();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function toast(msg, kind = 'ok'){
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('err', kind === 'err');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function escapeHTML(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

// GLSL literal formatter: ensures a decimal point so GLSL treats the value as float
// (otherwise `1` is an int and you get type errors on `float(1) * 1.5`).
function glslNum(v){
  const n = Number(v);
  if (!isFinite(n)) return '0.0';
  const s = n.toString();
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

// Literal used when a socket is unconnected. Uses the node-level override
// (node.defaults[name]) if present, otherwise the type-level default from the
// socket definition.
function defaultLiteral(socket, overrideValue){
  const d = overrideValue !== undefined ? overrideValue : socket.default;
  if (socket.type === 'float'){
    return glslNum(d ?? 0);
  }
  if (socket.type === 'vec2'){
    const [x, y] = Array.isArray(d) ? d : [0, 0];
    return `vec2(${glslNum(x)}, ${glslNum(y)})`;
  }
  if (socket.type === 'vec3'){
    const [x, y, z] = Array.isArray(d) ? d : [0, 0, 0];
    return `vec3(${glslNum(x)}, ${glslNum(y)}, ${glslNum(z)})`;
  }
  return '0.0';
}

function rgbToHex(r, g, b){
  const to = v => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function hexToRgb(hex){
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Builds a GLSL-safe uniform identifier from a node id + a one-letter tag.
// node ids look like "nk3" (from uid()); we prefix with `u_tex_` and strip any
// characters GLSL wouldn't accept in an identifier.
function glslUniformName(nodeId, tag){
  const safe = String(nodeId).replace(/[^a-zA-Z0-9_]/g, '_');
  return `u_tex_${tag}_${safe}`;
}
