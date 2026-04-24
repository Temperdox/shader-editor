/* Shared image cache + WebGL texture registries used by static-mode
 * Height Map and Normal Map nodes.
 *
 * Design
 * ------
 * - `imageCache` holds one decoded `HTMLImageElement` per node id. Loading is
 *   fire-and-forget: `loadImageForNode` dispatches async fetch/load, and when
 *   the image is ready it marks every registered renderer dirty so their
 *   draw loop rebuilds the GL texture on the next frame.
 * - Each renderer (editor bg + preview card) installs its own
 *   `TextureRegistry` by calling `registerTextureRegistry(registry)`. A
 *   registry owns GL resources for a single WebGL context — we can't share
 *   GL objects across contexts.
 * - `TextureRegistry.getTexture(nodeId)` lazy-creates the texture from the
 *   cached image the first time it's requested, or returns a 1×1 gray
 *   placeholder while the image is still loading / missing. Draw loops call
 *   this once per bound slot per frame — cheap after the first call.
 * - `scheduleRecompile()` is fired on image-load so bindings added while the
 *   image was pending are rewired with a real texture on the next compile
 *   (not strictly required, but ensures the `uniform1i` slot assignment is
 *   up to date if the bindings list changed).
 */

const imageCache = new Map();          // nodeId → { url, img, loaded, error }
const textureRegistries = new Set();   // Set<TextureRegistry>

/* Start loading `url` (http(s)://… or data:…) as the image for `nodeId`.
   Replaces any prior cache entry. On success, notifies every registered
   TextureRegistry so its cached GL texture gets invalidated and rebuilt. */
function loadImageForNode(nodeId, url){
  if (!url){
    // Clearing the URL removes any cached image and GL textures for this node.
    imageCache.delete(nodeId);
    for (const reg of textureRegistries) reg.invalidate(nodeId);
    if (typeof scheduleRecompile === 'function') scheduleRecompile();
    return;
  }

  const entry = { url, img: null, loaded: false, error: false };
  imageCache.set(nodeId, entry);

  const img = new Image();
  // Only set crossOrigin for HTTP(S) URLs. For `file://` and `data:` sources
  // there's no server to send CORS headers, and `crossOrigin='anonymous'`
  // would cause those loads to fail outright. Setting it only on remote
  // URLs lets WebGL upload local images AND keeps the canvas un-tainted
  // when sampling public CDN images.
  if (/^https?:/i.test(url)){
    img.crossOrigin = 'anonymous';
  }
  img.onload = () => {
    entry.img = img;
    entry.loaded = true;
    for (const reg of textureRegistries) reg.invalidate(nodeId);
    if (typeof scheduleRecompile === 'function') scheduleRecompile();
  };
  img.onerror = () => {
    entry.error = true;
    if (typeof toast === 'function') toast('image failed to load', 'err');
  };
  img.src = url;
}

/* Creates a registry bound to a specific WebGL context. The renderer calls
   `.getTexture(nodeId)` for each binding before drawArrays; the registry
   handles lazy upload + placeholder fallback transparently. */
function createTextureRegistry(gl){
  // 1×1 medium-gray placeholder — used when a binding exists but the image
  // hasn't loaded (or failed). Matches the "no data yet" visual.
  const placeholder = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, placeholder);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([128, 128, 128, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const textures     = new Map();   // nodeId → GLTexture
  const dirty        = new Set();   // nodeIds whose image changed
  const uploadFailed = new Set();   // nodeIds whose upload permanently errored (file:// CORS, etc.)

  /* Uploads an HTMLImageElement to a fresh GL texture. Returns `null` if
     texImage2D throws — which happens when the image is cross-origin to
     the document (notably every `file://` load, since Chrome treats each
     local file as its own origin). Critically, we MUST catch that throw
     here: before this guard, the SecurityError bubbled up through the
     render loop's `getTexture` call, and the caught exception aborted
     frame() before it could reschedule its requestAnimationFrame — which
     is why a single failed upload silently froze every subsequent frame
     of every shader, not just the one using the image. */
  function uploadFromImage(img){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    } catch (e){
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.deleteTexture(tex);
      console.warn('[textures] texImage2D blocked:', e.message);
      return null;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Non-power-of-two safety: CLAMP + LINEAR (no mipmaps) works for any size.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  const registry = {
    getTexture(nodeId){
      // Permanent-failure short-circuit — no point retrying the same upload
      // every frame if the first attempt hit Chrome's file:// security error.
      if (uploadFailed.has(nodeId)) return placeholder;

      // If this node's image changed, free the old GL texture so we rebuild.
      if (dirty.has(nodeId)){
        const prev = textures.get(nodeId);
        if (prev) gl.deleteTexture(prev);
        textures.delete(nodeId);
        dirty.delete(nodeId);
        uploadFailed.delete(nodeId);  // new image — let it try again
      }
      let tex = textures.get(nodeId);
      if (tex) return tex;

      const entry = imageCache.get(nodeId);
      if (!entry || !entry.loaded || !entry.img) return placeholder;

      tex = uploadFromImage(entry.img);
      if (!tex){
        uploadFailed.add(nodeId);
        notifyFileProtocolOnce();   // one-shot user-facing hint
        return placeholder;
      }
      textures.set(nodeId, tex);
      return tex;
    },
    invalidate(nodeId){
      dirty.add(nodeId);
    },
    dispose(){
      for (const tex of textures.values()) gl.deleteTexture(tex);
      textures.clear();
      gl.deleteTexture(placeholder);
      textureRegistries.delete(registry);
    },
  };

  textureRegistries.add(registry);
  return registry;
}

/* Fired once per page load when a texImage2D upload is blocked. Chrome
   treats every `file://` URL as its own origin, so opening the editor by
   double-clicking index.html blocks WebGL from sampling any local image
   (data: URLs uploaded via the file-picker still work fine). The fix for
   end users is to serve the folder over HTTP — even a one-liner like
   `python -m http.server` is enough. */
let _fileProtocolNotified = false;
function notifyFileProtocolOnce(){
  if (_fileProtocolNotified) return;
  _fileProtocolNotified = true;
  const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
  const msg = isFile
    ? 'file:// blocks local image textures — run a local server (e.g. python -m http.server) and open via http://'
    : 'image blocked by CORS — host with cross-origin headers or upload via the file picker';
  console.warn('[shader-editor] ' + msg);
  if (typeof toast === 'function') toast(msg, 'err');
}
