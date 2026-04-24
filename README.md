# Shader Graph Editor

A node-based WebGL shader editor — Unity Shader Graph-style, in plain HTML/CSS/JS.

Drag modules onto the canvas, wire outputs to inputs, and the compiled
fragment shader renders live as the background of the page.
Click **Preview** to see it rendered on a dossier-style character card;
click **Save PNG** to download the current frame.

## Try it

Hosted on GitHub Pages: **https://temperdox.github.io/shader-editor/**

## Running locally

Because WebGL blocks cross-origin image loads — and Chrome treats every
`file://` URL as its own origin — opening `index.html` by double-click
works for procedural shaders (Marble Gold, Channel Mixer, etc.) but
**not** for the image-backed templates (Brick Wall, static Normal/Height
Map). Serve the folder over HTTP instead:

```
python -m http.server 8000
```

Then open <http://localhost:8000/>.

## Controls

- **Scroll** — zoom toward the cursor
- **Middle-drag** — pan the graph
- **Right-click empty space** — recenter, add a module, reset the graph
- **Right-click a module** — disconnect / duplicate / reset / delete
- **Drag between sockets** — create a connection (cyan = input, amber = output)
- **Click an existing connected socket and drag away** — detach the wire

## Folder layout

```
shader-editor/
├── index.html              entry point
├── css/
│   ├── main.css            editor styles
│   └── preview.css         preview-mode card styles (scoped to .preview-root)
├── js/
│   ├── helpers.js          $ / uid / clamp / toast / glsl formatters
│   ├── node-types.js       NODE_TYPES registry + GLSL helper fragments
│   ├── graph-state.js      state, makeNode, seedDefaultGraph
│   ├── compiler.js         graph → GLSL, topological walk, on-demand helpers
│   ├── textures.js         image cache + per-context WebGL texture registries
│   ├── renderer.js         editor-background WebGL renderer
│   ├── editor.js           node DOM, connections, socket drag, inline editors
│   ├── interactions.js     pan / zoom / context menu / add-module picker
│   ├── templates.js        built-in shader templates
│   ├── persistence.js      save / load (localStorage + file), templates picker
│   ├── preview.js          preview-mode card renderer + fade transitions
│   └── main.js             boot — wires header buttons + Save PNG
└── assets/
    └── textures/
        └── brick-wall/
            ├── diffuse.png
            ├── normal.png
            ├── spec.png
            └── source/     originals (TGA) for re-export
```

## License

Personal / educational use.
