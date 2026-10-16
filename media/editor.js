(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const state = {
    tool: 'pen',
    color: '#007aff',
    width: 4,
    canvas: null,
    imgW: 0,
    imgH: 0,
    scale: 1,
    history: [],
    redoStack: [],
    maxHistory: 50,
    isDrawing: false,
    startPoint: null,
    currentShape: null,
    suppressSnapshot: false,
    pendingCrop: null,
    numberCounter: 1,
    maxDimension: 1920,
    zoom: 1,
    dock: 'left',
    pxScale: 1, // screenshot pixels per CSS pixel, for Measure labels
    tourSeen: true, // until the extension says otherwise
    sampler: null, // { bg, canvas, ctx } holding the background's pixels
  };

  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 8;

  const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';

  // Tools that share a toolbar slot (see data-group in editor.html). The slot
  // shows the last one used; clicking the active slot opens the others.
  const TOOL_INFO = {
    arrow: { label: 'Arrow', key: 'A', icon: svg('<line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/>') },
    arrow2: { label: 'Two-way arrow', key: 'D', icon: svg('<line x1="5" y1="19" x2="19" y2="5"/><polyline points="11 5 19 5 19 13"/><polyline points="5 11 5 19 13 19"/>') },
    rect: { label: 'Rectangle', key: 'R', icon: svg('<rect x="3" y="5" width="18" height="14" rx="3"/>') },
    ellipse: { label: 'Ellipse', key: 'E', icon: svg('<ellipse cx="12" cy="12" rx="9" ry="6"/>') },
    highlight: { label: 'Highlight', key: 'H', icon: svg('<path d="M9 11l-6 6v3h3l6-6"/><path d="M22 12l-4.5 4.5a2.1 2.1 0 0 1-3 0L9 12l6-6 4.5 4.5a2.1 2.1 0 0 1 0 3z"/>') },
    spotlight: { label: 'Spotlight', key: 'S', icon: svg('<path fill="currentColor" fill-opacity="0.4" stroke="none" fill-rule="evenodd" d="M6 2.5h12A3.5 3.5 0 0 1 21.5 6v12a3.5 3.5 0 0 1-3.5 3.5H6A3.5 3.5 0 0 1 2.5 18V6A3.5 3.5 0 0 1 6 2.5ZM9 7.5A1.5 1.5 0 0 0 7.5 9v6A1.5 1.5 0 0 0 9 16.5h6a1.5 1.5 0 0 0 1.5-1.5V9A1.5 1.5 0 0 0 15 7.5Z"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/>') },
  };

  const toolSlots = () => Array.from(document.querySelectorAll('#tools button.tool'));
  const slotId = (btn) => btn.dataset.slot || btn.dataset.tool;
  const slotFor = (tool) => toolSlots().find((b) => (b.dataset.group || b.dataset.tool).split(' ').includes(tool));

  function renderSlot(btn, tool) {
    const info = TOOL_INFO[tool];
    btn.dataset.tool = tool;
    btn.innerHTML = info.icon;
    btn.setAttribute('aria-label', info.label + ' (' + info.key + ')');
  }

  // Figma-style comment: editable text inside a speech bubble whose sharp
  // corner (`tail`: 'bl' | 'br' | 'tl' | 'tr') sits on the clicked point. The
  // origin is that corner, so the bubble grows away from the point as you type.
  // While the text is empty the bubble is sized to, and shows, a dimmed
  // placeholder; empty bubbles are removed when editing ends.
  const COMMENT_PLACEHOLDER = 'Comment';
  const measureCtx = document.createElement('canvas').getContext('2d');

  fabric.CommentBubble = fabric.util.createClass(fabric.IText, {
    type: 'commentBubble',
    objectCaching: false, // the bubble is drawn outside the text's own bounds

    initialize: function (text, options) {
      this.callSuper('initialize', text, options);
      this.padding = Math.round(this.fontSize * 0.6);
    },

    toObject: function (props) {
      return this.callSuper('toObject', ['tail'].concat(props || []));
    },

    calcTextWidth: function () {
      if (this.text) return this.callSuper('calcTextWidth');
      measureCtx.font = this._getFontDeclaration();
      return measureCtx.measureText(COMMENT_PLACEHOLDER).width;
    },

    _render: function (ctx) {
      this.callSuper('_render', ctx);
      if (this.text) return;
      // Same baseline fabric uses for the first line of real text.
      const baseline = -this.height / 2 + this.fontSize * this._fontSizeMult * (1 - this._fontSizeFraction);
      ctx.save();
      ctx.font = this._getFontDeclaration();
      ctx.fillStyle = this.fill;
      ctx.globalAlpha *= 0.55;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(COMMENT_PLACEHOLDER, -this.width / 2, baseline);
      ctx.restore();
    },

    _renderBackground: function (ctx) {
      const pad = this.padding;
      const w = this.width + pad * 2;
      const h = this.height + pad * 2;
      const r = Math.min(pad * 1.6, h / 2);
      const radii = { tl: r, tr: r, br: r, bl: r };
      radii[this.tail] = 0;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, [radii.tl, radii.tr, radii.br, radii.bl]);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = pad;
      ctx.shadowOffsetY = pad * 0.25;
      ctx.fillStyle = this.backgroundColor;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(2, this.fontSize * 0.08);
      ctx.strokeStyle = isLightColor(this.backgroundColor) ? 'rgba(0, 0, 0, 0.18)' : '#ffffff';
      ctx.stroke();
      ctx.restore();
    },
  });

  fabric.CommentBubble.fromObject = function (object, callback) {
    const styles = fabric.util.stylesFromArray(object.styles, object.text);
    return fabric.Object._fromObject('CommentBubble', Object.assign({}, object, { styles }), callback, 'text');
  };

  // Dimension line: end ticks plus a pill with the length in CSS pixels
  // (screenshot pixels / state.pxScale), so "16 px" on a Retina screenshot
  // means 16 CSS px. The label reads state.pxScale at render time, so
  // changing the scale relabels every measurement.
  fabric.Measure = fabric.util.createClass(fabric.Line, {
    type: 'measure',
    objectCaching: false, // the label is drawn outside the line's bounds
    hasControls: false,

    initialize: function (points, options) {
      this.callSuper('initialize', points, options);
      this.padding = 10; // a horizontal line is only strokeWidth tall to click
    },

    _render: function (ctx) {
      const p = this.calcLinePoints();
      const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      if (!len) return;
      const w = this.strokeWidth;
      const ux = (p.x2 - p.x1) / len, uy = (p.y2 - p.y1) / len;
      let nx = -uy, ny = ux;
      if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; } // point up, or left
      const tick = 4 + w * 2;
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.lineWidth = w;
      ctx.strokeStyle = this.stroke;
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
      ctx.lineTo(p.x2, p.y2);
      [[p.x1, p.y1], [p.x2, p.y2]].forEach(([x, y]) => {
        ctx.moveTo(x + nx * tick, y + ny * tick);
        ctx.lineTo(x - nx * tick, y - ny * tick);
      });
      ctx.stroke();

      const text = measureLabel(len);
      const fs = 12 + w * 2;
      ctx.font = '600 ' + fs + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
      const lw = ctx.measureText(text).width + fs;
      const lh = fs * 1.5;
      let cx = (p.x1 + p.x2) / 2, cy = (p.y1 + p.y2) / 2;
      // Too short to hold the label: put it beside the line instead.
      if (len < Math.abs(ux) * lw + Math.abs(uy) * lh + tick * 2) {
        const off = (Math.abs(nx) * lw + Math.abs(ny) * lh) / 2 + tick + 4;
        cx += nx * off;
        cy += ny * off;
      }
      ctx.beginPath();
      ctx.roundRect(cx - lw / 2, cy - lh / 2, lw, lh, lh / 2);
      ctx.fillStyle = this.stroke;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, fs * 0.08);
      ctx.strokeStyle = isLightColor(this.stroke) ? 'rgba(0, 0, 0, 0.18)' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = isLightColor(this.stroke) ? '#1c1c1e' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, cy + fs * 0.04);
      ctx.restore();
    },
  });

  fabric.Measure.fromObject = function (object, callback) {
    const options = Object.assign({}, object, { points: [object.x1, object.y1, object.x2, object.y2] });
    return fabric.Object._fromObject('Measure', options, (m) => {
      delete m.points;
      if (callback) callback(m);
    }, 'points');
  };

  function measureLabel(len) {
    const v = len / state.pxScale;
    const shown = Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
    return shown + ' px';
  }

  // The density a PNG was saved at, from its pHYs chunk: macOS writes 144 dpi
  // for Retina screenshots (72 dpi = 1x); Windows and Linux count from 96.
  // No pHYs, or not PNG: assume 1x. The scale button corrects a wrong guess.
  function detectPixelScale(dataUrl) {
    const head = /^data:image\/png;base64,/.exec(dataUrl);
    if (!head) return 1;
    let bytes;
    try {
      bytes = atob(dataUrl.slice(head[0].length, head[0].length + 87384)); // ~64KB, past any colour profile
    } catch {
      return 1;
    }
    const u32 = (k) => ((bytes.charCodeAt(k) << 24) | (bytes.charCodeAt(k + 1) << 16) |
      (bytes.charCodeAt(k + 2) << 8) | bytes.charCodeAt(k + 3)) >>> 0;
    for (let i = 8; i + 8 <= bytes.length;) {
      const type = bytes.slice(i + 4, i + 8);
      if (type === 'pHYs' && i + 17 <= bytes.length) {
        if (bytes.charCodeAt(i + 16) !== 1) return 1; // unit isn't metres
        const dpi = u32(i + 8) * 0.0254;
        return Math.min(3, Math.max(1, Math.round(dpi / (IS_MAC ? 72 : 96))));
      }
      if (type === 'IDAT' || type === 'IEND') break;
      i += 12 + u32(i);
    }
    return 1;
  }

  // Selection handles in the brand gold instead of fabric's default blue.
  fabric.Object.prototype.set({
    borderColor: '#e6c36a',
    cornerColor: '#fff1c2',
    cornerStrokeColor: '#9a6e1c',
    transparentCorners: false,
  });

  function init() {
    const el = document.getElementById('canvas');
    state.canvas = new fabric.Canvas(el, {
      preserveObjectStacking: true,
      selection: false,
      isDrawingMode: true,
    });
    // Spotlight dimming sits between the screenshot and the annotations, so
    // arrows and labels drawn over it stay bright. Exports render it too.
    const renderBackground = state.canvas._renderBackground;
    state.canvas._renderBackground = function (ctx) {
      renderBackground.call(this, ctx);
      renderSpotlights(ctx, this);
    };
    toolSlots().forEach((b) => { if (b.dataset.group) renderSlot(b, b.dataset.tool); });
    configureBrush();
    attachCanvasHandlers();
    attachToolbarHandlers();
    attachKeyboardHandlers();
    attachWheelZoom();
    attachToolsDrag();
    attachToolReorder();
    attachLoupe();
    layoutChrome();

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'loadImage') {
        if (msg.dataUrl) loadImage(msg.dataUrl);
        else showEmptyState();
      } else if (msg.type === 'config') {
        if (typeof msg.maxDimension === 'number') state.maxDimension = msg.maxDimension;
        if (Array.isArray(msg.toolsOrder)) applyToolOrder(msg.toolsOrder);
        if (typeof msg.toolsDock === 'string') setDock(msg.toolsDock);
        if (typeof msg.pet === 'string') setPet(msg.pet);
        if (typeof msg.tourSeen === 'boolean') {
          state.tourSeen = msg.tourSeen;
          maybeStartTour();
        }
      }
    });

    attachDropAndPaste();
    attachContextMenu();
    attachTour();
    attachPet();

    window.addEventListener('resize', () => {
      layoutChrome();
      if (state.imgW) applyFitScale();
    });
  }

  const DOCKS = ['left', 'right', 'top', 'bottom'];

  function setDock(dock) {
    if (!DOCKS.includes(dock)) return;
    state.dock = dock;
    document.body.dataset.dock = dock;
    document.getElementById('tools').removeAttribute('style'); // drop drag position
    layoutChrome();
    if (state.imgW) applyFitScale();
    positionTour();
  }

  // The bars float over the stage, so pad the scroll area and the empty state
  // to the space they leave. The tool pill can sit on any edge.
  function layoutChrome() {
    const tools = document.getElementById('tools');
    const stylebarTop = document.getElementById('stylebar').getBoundingClientRect().top;
    // Docked at the bottom, the pill sits just above the style bar, whose
    // height changes when it wraps.
    tools.style.bottom = state.dock === 'bottom' ? (window.innerHeight - stylebarTop + 10) + 'px' : '';
    const t = tools.getBoundingClientRect();
    const topbarBottom = document.getElementById('topbar').getBoundingClientRect().bottom;
    const pad = {
      top: Math.max(topbarBottom, state.dock === 'top' ? t.bottom : 0) + 16,
      right: state.dock === 'right' ? window.innerWidth - t.left + 16 : 24,
      bottom: window.innerHeight - (state.dock === 'bottom' ? t.top : stylebarTop) + 16,
      left: state.dock === 'left' ? t.right + 16 : 24,
    };
    const css = pad.top + 'px ' + pad.right + 'px ' + pad.bottom + 'px ' + pad.left + 'px';
    document.getElementById('canvas-wrap').style.padding = css;
    document.getElementById('empty-state').style.inset = css;
    positionPet();
    return pad;
  }

  // Drag the grip to move the tool pill; it snaps to the nearest edge on
  // release. Arrow keys on the focused grip do the same without a mouse.
  // Saved order from the extension. Tools missing from it (e.g. added in a
  // later version) keep their default position relative to each other, at
  // the end.
  // Ids are slots; a tool id (saved before tools were grouped) stands for its
  // slot.
  function applyToolOrder(order) {
    const tools = document.getElementById('tools');
    const buttons = toolSlots();
    const byId = new Map(buttons.map((b) => [slotId(b), b]));
    const sorted = [];
    order.forEach((id) => {
      const b = byId.get(id) || slotFor(id);
      if (b && !sorted.includes(b)) sorted.push(b);
    });
    buttons.forEach((b) => { if (!sorted.includes(b)) sorted.push(b); });
    sorted.forEach((b) => tools.appendChild(b));
  }

  // Drag a tool button along the pill to reorder (the others shuffle as you
  // go); Alt+Arrow on a focused tool moves it one place. A plain click still
  // selects the tool.
  function attachToolReorder() {
    const tools = document.getElementById('tools');
    const toolButtons = toolSlots;
    const save = () => vscode.postMessage({ type: 'toolsOrder', order: toolButtons().map(slotId) });
    let drag = null;
    let swallowClick = false;
    tools.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('button.tool');
      if (!btn || e.button !== 0) return;
      drag = { btn, id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false };
    });
    tools.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
        drag.active = true;
        drag.btn.setPointerCapture(e.pointerId);
        drag.btn.classList.add('reordering');
        closeMenu(); // a hover flyout would sit over the tools being shuffled
      }
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const target = over && over.closest('#tools button.tool');
      if (!target || target === drag.btn) return;
      const list = toolButtons();
      if (list.indexOf(drag.btn) < list.indexOf(target)) target.after(drag.btn);
      else target.before(drag.btn);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.active;
      drag.btn.classList.remove('reordering');
      drag = null;
      if (!moved) return;
      save();
      // The release fires a click on the dragged button; don't let it count
      // as choosing that tool.
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 0);
    };
    tools.addEventListener('pointerup', end);
    tools.addEventListener('pointercancel', end);
    tools.addEventListener('click', (e) => {
      if (!swallowClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    tools.addEventListener('keydown', (e) => {
      const btn = e.target.closest('button.tool');
      if (!btn || !e.altKey) return;
      const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      const list = toolButtons();
      const neighbour = list[list.indexOf(btn) + step];
      if (!neighbour) return;
      if (step < 0) neighbour.before(btn); else neighbour.after(btn);
      btn.focus();
      save();
    });
  }

  function attachToolsDrag() {
    const tools = document.getElementById('tools');
    const grip = document.getElementById('tools-grip');
    const commit = (dock) => {
      setDock(dock);
      vscode.postMessage({ type: 'toolsDock', dock });
    };
    const hint = document.getElementById('dock-hint');
    const nearestDock = (x, y) => {
      const dist = { left: x, right: window.innerWidth - x, top: y, bottom: window.innerHeight - y };
      return DOCKS.reduce((a, b) => (dist[b] < dist[a] ? b : a));
    };
    // Where the pill would land on `dock`, mirroring the #tools CSS: grid
    // cells of --tool with 2px gaps, 6px padding+border per side, wrapping
    // into extra lines when the edge's max length is exceeded.
    const landingRect = (dock) => {
      const cell = parseFloat(getComputedStyle(tools).getPropertyValue('--tool'));
      const n = tools.children.length;
      const narrow = window.matchMedia('(max-width: 520px)').matches;
      const W = window.innerWidth, H = window.innerHeight;
      const maxLen = {
        left: H - 168, right: H - 168,
        top: W - (narrow ? 256 : 276), bottom: W - 24,
      }[dock];
      const perLine = Math.max(1, Math.min(n, Math.floor((maxLen - 12 + 2) / (cell + 2))));
      const lines = Math.ceil(n / perLine);
      const len = perLine * cell + (perLine - 1) * 2 + 12;
      const thick = lines * cell + (lines - 1) * 2 + 12;
      if (dock === 'left') return { x: 12, y: (H - len) / 2, w: thick, h: len };
      if (dock === 'right') return { x: W - 12 - thick, y: (H - len) / 2, w: thick, h: len };
      if (dock === 'top') return { x: 12, y: 12, w: len, h: thick };
      const stylebarTop = document.getElementById('stylebar').getBoundingClientRect().top;
      return { x: (W - len) / 2, y: stylebarTop - 10 - thick, w: len, h: thick };
    };
    const showHint = (dock) => {
      const r = landingRect(dock);
      const first = !hint.classList.contains('visible');
      if (first) hint.style.transition = 'none'; // appear in place, then glide between edges
      Object.assign(hint.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      if (first) {
        void hint.offsetWidth;
        hint.style.transition = '';
        hint.classList.add('visible');
      }
    };
    const hideHint = () => hint.classList.remove('visible');

    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
      const r = tools.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      tools.classList.add('dragging');
      Object.assign(tools.style, {
        left: e.clientX - drag.dx + 'px', top: e.clientY - drag.dy + 'px',
        right: 'auto', bottom: 'auto', transform: 'none',
      });
      showHint(nearestDock(e.clientX, e.clientY));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      tools.classList.remove('dragging');
      hideHint();
      if (!moved) return;
      if (e.type === 'pointercancel') { setDock(state.dock); return; }
      commit(nearestDock(e.clientX, e.clientY));
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('keydown', (e) => {
      const dock = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[e.key];
      if (!dock) return;
      e.preventDefault();
      e.stopPropagation();
      commit(dock);
    });
  }

  function configureBrush() {
    const b = state.canvas.freeDrawingBrush;
    b.color = state.color;
    b.width = state.width;
    b.strokeLineCap = 'round';
    b.strokeLineJoin = 'round';
  }

  function loadImage(dataUrl) {
    cancelCrop();
    setPxScale(detectPixelScale(dataUrl));
    fabric.Image.fromURL(dataUrl, (img) => {
      state.imgW = img.width;
      state.imgH = img.height;
      state.canvas.clear();
      state.canvas.setDimensions({ width: img.width, height: img.height });
      state.canvas.setBackgroundImage(
        img,
        state.canvas.renderAll.bind(state.canvas),
        { originX: 'left', originY: 'top' }
      );
      state.zoom = 1;
      applyFitScale();
      state.history = [serialize()];
      state.redoStack = [];
      state.numberCounter = 1;
      updateHistoryButtons();
      document.body.classList.add('loaded');
      maybeStartTour();
      document.body.classList.remove('empty');
    });
  }

  // mode 'compare' places the file next to the current image instead of
  // replacing it.
  function loadFile(file, mode) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (mode === 'compare' && state.imgW) placeBeside(reader.result);
      else loadImage(reader.result);
    };
    reader.readAsDataURL(file);
  }

  // Expected vs actual: a second image (say, the design) joins the current one
  // on a wider background, scaled to match its height (or width when they
  // stack), each with an editable label. Annotations keep their place on the
  // first image. Like crop, this resets history; the labels are the one step
  // that can be undone.
  function placeBeside(dataUrl) {
    cancelCrop();
    const c = state.canvas;
    const bg = c.backgroundImage;
    fabric.util.loadImage(dataUrl, (img) => {
      if (!img || !bg) return;
      const W1 = state.imgW, H1 = state.imgH;
      const stacked = W1 > H1; // wide screenshots stack, so the result stays near square
      const s = stacked ? W1 / img.width : H1 / img.height;
      const w2 = Math.round(img.width * s), h2 = Math.round(img.height * s);
      const gap = Math.max(16, Math.round(Math.max(W1, H1) * 0.02));
      const x2 = stacked ? 0 : W1 + gap, y2 = stacked ? H1 + gap : 0;
      const W = stacked ? W1 : x2 + w2, H = stacked ? y2 + h2 : H1;
      const tmp = document.createElement('canvas');
      tmp.width = W;
      tmp.height = H;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#2c2c2e';
      if (stacked) ctx.fillRect(0, H1, W, gap); else ctx.fillRect(W1, 0, gap, H);
      ctx.drawImage(bg.getElement(), 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x2, y2, w2, h2);
      fabric.Image.fromURL(tmp.toDataURL('image/png'), (newBg) => {
        state.imgW = W;
        state.imgH = H;
        c.setDimensions({ width: W, height: H });
        c.setBackgroundImage(newBg, () => {
          state.zoom = 1;
          applyFitScale();
          state.history = [serialize()];
          state.redoStack = [];
          const m = Math.round(gap * 0.75);
          // Big enough to read once Copy scales the pair down.
          const fs = Math.max(commentFontSize(state.width), Math.round(Math.max(W, H) / 60));
          [makeComment(m, m, 'Actual', 'tl', fs), makeComment(x2 + m, y2 + m, 'Expected', 'tl', fs)].forEach((label) => {
            label.selectable = label.evented = isInteractive(label);
            c.add(label);
          });
          c.requestRenderAll();
          snapshot();
        }, { originX: 'left', originY: 'top' });
      });
    });
  }

  function showEmptyState() {
    document.body.classList.add('empty');
    document.body.classList.remove('loaded');
    const el = document.getElementById('empty-state');
    if (el) {
      const pasteKey = navigator.platform.toUpperCase().indexOf('MAC') >= 0 ? '⌘V' : 'Ctrl+V';
      el.innerHTML =
        '<div class="empty-inner">' +
          '<div class="empty-title">Drop an image here</div>' +
          '<div class="empty-sub">or paste from clipboard (' + pasteKey + ')</div>' +
          '<button id="empty-pick" class="action glass" type="button">Choose file…</button>' +
        '</div>';
      document.getElementById('empty-pick').addEventListener('click', () =>
        document.getElementById('file-input').click()
      );
    }
    updateHistoryButtons();
  }

  // Dropping a file with no image open loads it. With one open, two targets
  // appear: replace it, or place the new one beside it to compare.
  function attachDropAndPaste() {
    const wrap = document.getElementById('canvas-wrap');
    const zones = document.getElementById('drop-zones');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const zoneAt = (e) => e.target.closest && e.target.closest('.drop-zone');
    const hide = () => {
      wrap.classList.remove('dragging');
      zones.hidden = true;
    };
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!state.imgW) { wrap.classList.add('dragging'); return; }
      zones.hidden = false;
      const zone = zoneAt(e);
      zones.querySelectorAll('.drop-zone').forEach((z) => z.classList.toggle('over', z === zone));
      e.dataTransfer.dropEffect = zone ? 'copy' : 'none';
    });
    // relatedTarget is null only when the drag leaves the page.
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) hide(); });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      const zone = zoneAt(e);
      const loaded = !!state.imgW;
      hide();
      if (!loaded) loadFile(file);
      else if (zone) loadFile(file, zone.dataset.mode);
    });
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it && it.type && it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          loadFile(file);
          return;
        }
      }
    });
  }

  function applyFitScale() {
    const wrap = document.getElementById('canvas-wrap');
    const pad = layoutChrome();
    const maxW = wrap.clientWidth - pad.left - pad.right;
    const maxH = wrap.clientHeight - pad.top - pad.bottom;
    const fit = Math.min(1, maxW / state.imgW, maxH / state.imgH);
    state.scale = fit;
    const effective = fit * state.zoom;
    state.canvas.setDimensions(
      { width: state.imgW * effective + 'px', height: state.imgH * effective + 'px' },
      { cssOnly: true }
    );
    // On HiDPI screens setDimensions re-applies retina scaling, which resets
    // the canvas bitmap, but cssOnly skips the re-render. Without this the
    // image stays blank until the next draw.
    state.canvas.requestRenderAll();
    if (state.pendingCrop) positionCropActions();
  }

  function setZoom(newZoom, focalClientX, focalClientY) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (clamped === state.zoom) return;
    const wrap = document.getElementById('canvas-wrap');
    const canvasEl = state.canvas.upperCanvasEl;
    const oldRect = canvasEl.getBoundingClientRect();
    const anchorX = typeof focalClientX === 'number'
      ? focalClientX - oldRect.left
      : oldRect.width / 2;
    const anchorY = typeof focalClientY === 'number'
      ? focalClientY - oldRect.top
      : oldRect.height / 2;
    const ratio = clamped / state.zoom;
    state.zoom = clamped;
    applyFitScale();
    const dx = anchorX * (ratio - 1);
    const dy = anchorY * (ratio - 1);
    wrap.scrollLeft += dx;
    wrap.scrollTop += dy;
  }

  function resetZoom() {
    if (state.zoom === 1) return;
    state.zoom = 1;
    applyFitScale();
  }

  // Which objects respond to the pointer: everything in Select, and the
  // tool's own objects in Text/Comment so you can re-edit or drag them
  // without leaving the tool.
  function isInteractive(o) {
    return state.tool === 'select' ||
      (state.tool === 'text' && o.type === 'i-text') ||
      (state.tool === 'comment' && o.type === 'commentBubble');
  }

  function setTool(tool) {
    if (state.pendingCrop && tool !== 'crop') cancelCrop();
    state.tool = tool;
    const c = state.canvas;
    c.isDrawingMode = tool === 'pen';
    c.selection = tool === 'select';
    c.discardActiveObject();
    c.forEachObject((o) => {
      o.selectable = o.evented = isInteractive(o);
    });
    c.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    c.requestRenderAll();
    const slot = slotFor(tool);
    if (slot && slot.dataset.group) renderSlot(slot, tool);
    toolSlots().forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.tool === tool ? 'true' : 'false');
    });
    hideLoupe();
    closeMenu();
    syncScaleButton();
  }

  // The scale button is only relevant to measurements, so it shows while
  // measuring or while any measurement is on the image.
  function syncScaleButton() {
    const show = state.tool === 'measure' || state.canvas.getObjects().some((o) => o.type === 'measure');
    const btn = document.getElementById('btn-scale');
    if (btn.hidden === !show) return;
    btn.hidden = !show;
    layoutChrome();
  }

  function setPxScale(scale) {
    state.pxScale = scale;
    const btn = document.getElementById('btn-scale');
    btn.textContent = scale + '×';
    btn.title = scale === 1
      ? 'Measuring in image pixels. Click if this is a 2× (Retina) screenshot'
      : 'Screenshot taken at ' + scale + '×: measuring in CSS pixels (image pixels ÷ ' + scale + '). Click to change';
    btn.setAttribute('aria-label', 'Screenshot scale ' + scale + '×');
    if (state.canvas) state.canvas.requestRenderAll();
  }

  // Picking a colour also recolours whatever is selected.
  function setColor(color) {
    state.color = color;
    state.canvas.freeDrawingBrush.color = color;
    document.querySelectorAll('button.swatch').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.color === color ? 'true' : 'false');
    });
    const active = state.canvas.getActiveObject();
    if (!active) return;
    const targets = active.type === 'activeSelection' ? active.getObjects() : [active];
    const changed = targets.filter((o) => recolor(o, color)).length > 0;
    if (changed) {
      state.canvas.requestRenderAll();
      snapshot();
    }
  }

  // Apply a colour the way each kind of object was drawn with it. Redactions
  // stay black so they keep hiding what's under them.
  function recolor(o, color) {
    const kind = o.data && o.data.kind;
    const onColor = isLightColor(color) ? '#1c1c1e' : '#ffffff';
    // A colour label shows a sampled colour, and spotlights have none.
    if (kind === 'redact' || kind === 'color' || kind === 'spotlight') return false;
    if (o.type === 'commentBubble') {
      o.set({ backgroundColor: color, fill: onColor });
    } else if (kind === 'step') {
      const [circle, label] = o.getObjects();
      circle.set('fill', color);
      label.set('fill', onColor);
      o.dirty = true;
    } else if (o.type === 'i-text') {
      o.set('fill', color);
    } else if (o.type === 'rect' && !o.stroke) {
      o.set('fill', hexToRgba(color, 0.3)); // highlight
    } else if (o.stroke) {
      o.set('stroke', color); // pen, arrows, rectangle, ellipse
    } else {
      return false;
    }
    return true;
  }

  // Sizes derived from the width setting, shared by creation and resizing.
  const markerRadius = (width) => 14 + width * 2;
  const commentFontSize = (width) => Math.round(20 + width * 2.5);
  const textFontSize = (width) => 16 + width * 3;
  const chipFontSize = (width) => 14 + width * 2;

  // Picking a size also resizes whatever is selected.
  function setWidth(width) {
    state.width = width;
    state.canvas.freeDrawingBrush.width = width;
    document.querySelectorAll('button.width').forEach((btn) => {
      btn.setAttribute('aria-pressed', parseInt(btn.dataset.width, 10) === width ? 'true' : 'false');
    });
    const c = state.canvas;
    const active = c.getActiveObject();
    if (!active) return;
    const multi = active.type === 'activeSelection';
    const targets = multi ? active.getObjects() : [active];
    // Resize in canvas coordinates, then reselect so the selection box fits.
    if (multi) c.discardActiveObject();
    const changed = targets.filter((o) => resize(o, width)).length > 0;
    if (multi) c.setActiveObject(new fabric.ActiveSelection(targets, { canvas: c }));
    if (changed) {
      c.requestRenderAll();
      snapshot();
    }
  }

  function resize(o, width) {
    const kind = o.data && o.data.kind;
    if (kind === 'redact' || kind === 'spotlight') return false;
    if (kind === 'color') {
      // Scale around the sampled point, so the ring stays on its pixel.
      const ring = o.getObjects()[o.getObjects().length - 1];
      const at = () => fabric.util.transformPoint(new fabric.Point(ring.left, ring.top), o.calcTransformMatrix());
      const before = at();
      o.scale(chipFontSize(width) / o.data.size);
      const after = at();
      o.set({ left: o.left + before.x - after.x, top: o.top + before.y - after.y });
    } else if (o.type === 'commentBubble') {
      const oldPad = o.padding;
      o.set('fontSize', commentFontSize(width));
      o.padding = Math.round(o.fontSize * 0.6);
      // left/top sit one padding in from the tail; keep the tail on its point.
      const d = o.padding - oldPad;
      o.set({ left: o.left + (o.tail[1] === 'l' ? d : -d), top: o.top + (o.tail[0] === 'b' ? -d : d) });
    } else if (kind === 'step') {
      // Every part of a marker is proportional to its radius.
      o.scale(markerRadius(width) / o.getObjects()[0].radius);
    } else if (o.type === 'i-text') {
      o.set('fontSize', textFontSize(width));
    } else if (kind === 'arrow') {
      setArrowWidth(o, width);
    } else if (o.stroke) {
      o.set('strokeWidth', width); // pen, rectangle, ellipse
    } else {
      return false; // highlight
    }
    o.setCoords();
    return true;
  }

  // Arrowheads scale with width, so rebuild the path from its end points
  // (stored in path space at creation) and shift it so the shaft stays put,
  // whatever it has been moved, scaled or rotated to since.
  function setArrowWidth(o, width) {
    const [x1, y1, x2, y2] = o.data.pts;
    const startOnCanvas = () => fabric.util.transformPoint(
      new fabric.Point(x1 - o.pathOffset.x, y1 - o.pathOffset.y), o.calcTransformMatrix()
    );
    const before = startOnCanvas();
    const fresh = new fabric.Path(arrowPath(x1, y1, x2, y2, width, o.data.twoWay));
    o.set({ path: fresh.path, width: fresh.width, height: fresh.height, strokeWidth: width });
    o.pathOffset = fresh.pathOffset;
    const after = startOnCanvas();
    o.set({ left: o.left + before.x - after.x, top: o.top + before.y - after.y, dirty: true });
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function attachCanvasHandlers() {
    const c = state.canvas;

    c.on('path:created', (e) => {
      if (e.path) {
        e.path.set({ selectable: state.tool === 'select', evented: state.tool === 'select' });
      }
      snapshot();
    });

    // Fabric ends text editing before 'mouse:down' fires, so note it here.
    c.on('mouse:down:before', () => {
      const active = c.getActiveObject();
      state.wasEditing = !!(active && active.isEditing);
    });

    c.on('mouse:down', (opt) => {
      if (c.isDrawingMode || state.tool === 'select') return;
      // The tool stays selected, so a click on an existing text/comment edits
      // or drags it, and a click away from one being typed in just finishes it.
      if (opt.target && isInteractive(opt.target)) return;
      if (state.wasEditing) return;
      const p = c.getPointer(opt.e);
      state.isDrawing = true;
      state.startPoint = p;
      state.currentShape = null;

      if (state.tool === 'rect') {
        state.currentShape = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          fill: 'transparent', stroke: state.color, strokeWidth: state.width,
          strokeUniform: true, selectable: false, evented: false,
        });
        c.add(state.currentShape);
      } else if (state.tool === 'ellipse') {
        state.currentShape = new fabric.Ellipse({
          left: p.x, top: p.y, rx: 0, ry: 0,
          fill: 'transparent', stroke: state.color, strokeWidth: state.width,
          strokeUniform: true, selectable: false, evented: false,
          originX: 'left', originY: 'top',
        });
        c.add(state.currentShape);
      } else if (state.tool === 'highlight') {
        state.currentShape = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          fill: hexToRgba(state.color, 0.3),
          stroke: null, strokeWidth: 0,
          selectable: false, evented: false,
        });
        c.add(state.currentShape);
      } else if (state.tool === 'spotlight') {
        state.currentShape = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          fill: 'rgba(0, 0, 0, 0)', stroke: null, strokeWidth: 0,
          selectable: false, evented: false,
          data: { kind: 'spotlight' },
        });
        c.add(state.currentShape);
      } else if (state.tool === 'measure') {
        const x = Math.round(p.x), y = Math.round(p.y);
        state.startPoint = { x, y };
        state.currentShape = new fabric.Measure([x, y, x, y], {
          stroke: state.color, strokeWidth: state.width,
          selectable: false, evented: false,
          data: { kind: 'measure' },
        });
        c.add(state.currentShape);
      } else if (state.tool === 'eyedropper') {
        state.isDrawing = false;
        placeColorChip(p.x, p.y);
        return;
      } else if (state.tool === 'arrow' || state.tool === 'arrow2') {
        state.currentShape = new fabric.Line([p.x, p.y, p.x, p.y], {
          stroke: state.color, strokeWidth: state.width,
          strokeLineCap: 'round', selectable: false, evented: false,
        });
        c.add(state.currentShape);
      } else if (state.tool === 'crop') {
        if (state.pendingCrop) {
          c.remove(state.pendingCrop);
          state.pendingCrop = null;
          hideCropActions();
        }
        state.currentShape = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          fill: 'rgba(236, 220, 178, 0.14)',
          stroke: '#e6c36a', strokeWidth: 1,
          strokeDashArray: [6, 4], strokeUniform: true,
          selectable: false, evented: false,
          excludeFromExport: true,
        });
        c.add(state.currentShape);
      } else if (state.tool === 'redact') {
        state.currentShape = new fabric.Rect({
          left: p.x, top: p.y, width: 0, height: 0,
          fill: 'rgba(30, 30, 30, 0.35)',
          stroke: '#d4d4d4', strokeWidth: 1,
          strokeDashArray: [6, 4], strokeUniform: true,
          selectable: false, evented: false,
          excludeFromExport: true,
        });
        c.add(state.currentShape);
      } else if (state.tool === 'number') {
        state.isDrawing = false;
        placeNumberMarker(p.x, p.y);
        return;
      } else if (state.tool === 'comment') {
        state.isDrawing = false;
        placeComment(p.x, p.y);
        return;
      } else if (state.tool === 'text') {
        state.isDrawing = false;
        const text = new fabric.IText('Text', {
          left: p.x, top: p.y,
          fill: state.color, fontSize: textFontSize(state.width), fontFamily: 'sans-serif', stroke: null,
          editable: true,
        });
        c.add(text);
        c.setActiveObject(text);
        text.enterEditing();
        text.selectAll();
        snapshot();
      }
    });

    c.on('mouse:move', (opt) => {
      if (!state.isDrawing || !state.currentShape) return;
      const p = c.getPointer(opt.e);
      const s = state.currentShape;
      const sp = state.startPoint;

      if (['rect', 'highlight', 'spotlight', 'crop', 'redact'].includes(state.tool)) {
        s.set({
          left: Math.min(sp.x, p.x), top: Math.min(sp.y, p.y),
          width: Math.abs(p.x - sp.x), height: Math.abs(p.y - sp.y),
        });
      } else if (state.tool === 'ellipse') {
        s.set({
          left: Math.min(sp.x, p.x), top: Math.min(sp.y, p.y),
          rx: Math.abs(p.x - sp.x) / 2, ry: Math.abs(p.y - sp.y) / 2,
        });
      } else if (state.tool === 'arrow' || state.tool === 'arrow2') {
        s.set({ x2: p.x, y2: p.y });
      } else if (state.tool === 'measure') {
        // Whole pixels; snap to horizontal/vertical within a few degrees, or
        // always with Shift.
        let x = Math.round(p.x), y = Math.round(p.y);
        const dx = Math.abs(x - sp.x), dy = Math.abs(y - sp.y);
        if (opt.e.shiftKey || dy < dx * 0.07) { if (dx >= dy) y = sp.y; }
        if (opt.e.shiftKey || dx < dy * 0.07) { if (dy > dx) x = sp.x; }
        s.set({ x2: x, y2: y });
      }
      c.requestRenderAll();
    });

    c.on('mouse:up', () => {
      if (!state.isDrawing) return;
      state.isDrawing = false;
      const s = state.currentShape;
      if (!s) return;

      if (state.tool === 'rect' || state.tool === 'highlight') {
        if (s.width < 3 || s.height < 3) {
          c.remove(s); state.currentShape = null; return;
        }
      } else if (state.tool === 'spotlight') {
        if (s.width < 6 || s.height < 6) {
          c.remove(s); state.currentShape = null; return;
        }
        const r = Math.min(12, s.width / 4, s.height / 4);
        s.set({ rx: r, ry: r });
        // Behind everything, so annotations over it stay clickable.
        c.sendToBack(s);
      } else if (state.tool === 'measure') {
        if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4) {
          c.remove(s); state.currentShape = null; return;
        }
      } else if (state.tool === 'crop') {
        const r = clampToImage(s);
        if (r.width < 8 || r.height < 8) {
          c.remove(s); state.currentShape = null; return;
        }
        s.set(r);
        state.pendingCrop = s;
        state.currentShape = null;
        c.requestRenderAll();
        showCropActions();
        return;
      } else if (state.tool === 'redact') {
        const r = clampToImage(s);
        c.remove(s);
        state.currentShape = null;
        if (r.width < 6 || r.height < 6) return;
        applyRedaction(r.left, r.top, r.width, r.height);
        return;
      } else if (state.tool === 'ellipse') {
        if (s.rx < 2 || s.ry < 2) {
          c.remove(s); state.currentShape = null; return;
        }
      } else if (state.tool === 'arrow' || state.tool === 'arrow2') {
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        if (Math.hypot(dx, dy) < 6) {
          c.remove(s); state.currentShape = null; return;
        }
        const twoWay = state.tool === 'arrow2';
        const path = new fabric.Path(arrowPath(s.x1, s.y1, s.x2, s.y2, state.width, twoWay), {
          stroke: state.color, strokeWidth: state.width, fill: null,
          strokeLineCap: 'round', strokeLineJoin: 'round',
          selectable: false, evented: false,
          data: { kind: 'arrow', twoWay, pts: [s.x1, s.y1, s.x2, s.y2] },
        });
        c.remove(s);
        c.add(path);
        state.currentShape = path;
      }
      // Shapes are added at zero size and grown while dragging; refresh their
      // hit-test coords or only the starting corner is clickable.
      state.currentShape.setCoords();
      snapshot();
      state.currentShape = null;
    });

    c.on('object:modified', () => snapshot());
    c.on('object:added', syncScaleButton);
    c.on('object:removed', syncScaleButton);

    // A comment that ends editing with no text is dismissed. Deferred because
    // fabric still uses obj.canvas after firing this event. A new comment is
    // only recorded in history once it has text, so dismissing one leaves
    // history unchanged (snapshot() skips the identical state).
    c.on('text:editing:exited', (e) => {
      const t = e.target;
      if (!t || t.type !== 'commentBubble' || t.text.trim()) return;
      queueMicrotask(() => {
        c.remove(t);
        snapshot();
      });
    });
  }

  function arrowPath(x1, y1, x2, y2, width, twoWay) {
    const headLen = Math.max(14, width * 4);
    const headAngle = Math.PI / 7;
    // Head at (tx, ty), pointing away from (fx, fy).
    const head = (fx, fy, tx, ty) => {
      const angle = Math.atan2(ty - fy, tx - fx);
      const hx1 = tx - headLen * Math.cos(angle - headAngle);
      const hy1 = ty - headLen * Math.sin(angle - headAngle);
      const hx2 = tx - headLen * Math.cos(angle + headAngle);
      const hy2 = ty - headLen * Math.sin(angle + headAngle);
      return ' M ' + hx1 + ' ' + hy1 + ' L ' + tx + ' ' + ty + ' L ' + hx2 + ' ' + hy2;
    };
    return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2 +
           head(x1, y1, x2, y2) + (twoWay ? head(x2, y2, x1, y1) : '');
  }

  // Clamp a drag rectangle to the image on all four edges, so dragging past
  // the top/left edge doesn't push the region past the drawn bottom/right.
  function clampToImage(s) {
    const left = Math.max(0, Math.round(s.left));
    const top = Math.max(0, Math.round(s.top));
    const right = Math.min(state.imgW, Math.round(s.left + s.width));
    const bottom = Math.min(state.imgH, Math.round(s.top + s.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  // History entries omit the background image: it only changes on load/crop,
  // which reset history, and serializing it would copy the full screenshot
  // as base64 into every entry.
  function serialize() {
    const json = state.canvas.toJSON(['data']);
    delete json.backgroundImage;
    return json;
  }

  function snapshot() {
    if (state.suppressSnapshot) return;
    const json = serialize();
    const last = state.history[state.history.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(json)) return;
    state.history.push(json);
    if (state.history.length > state.maxHistory + 1) state.history.shift();
    state.redoStack = [];
    updateHistoryButtons();
  }

  function undo() {
    if (state.history.length <= 1) return;
    cancelCrop();
    state.redoStack.push(state.history.pop());
    restoreFromHistory(state.history[state.history.length - 1]);
    updateHistoryButtons();
  }

  function redo() {
    if (state.redoStack.length === 0) return;
    cancelCrop();
    const snap = state.redoStack.pop();
    state.history.push(snap);
    restoreFromHistory(snap);
    updateHistoryButtons();
  }

  function restoreFromHistory(json) {
    state.suppressSnapshot = true;
    const bg = state.canvas.backgroundImage;
    state.canvas.loadFromJSON(json, () => {
      state.canvas.backgroundImage = bg;
      state.canvas.forEachObject((o) => {
        o.selectable = o.evented = isInteractive(o);
      });
      reseedNumberCounter();
      state.canvas.requestRenderAll();
      state.suppressSnapshot = false;
    });
  }

  function clearAll() {
    const c = state.canvas;
    cancelCrop();
    const drawn = c.getObjects().filter((o) => !o.excludeFromExport);
    if (drawn.length === 0) return;
    const bg = c.backgroundImage;
    c.getObjects().slice().forEach((o) => c.remove(o));
    c.backgroundImage = bg;
    state.numberCounter = 1;
    c.requestRenderAll();
    snapshot();
  }

  function updateHistoryButtons() {
    const hasEdits = state.history.length > 1;
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    const clearBtn = document.getElementById('btn-clear');
    if (undoBtn) undoBtn.disabled = !hasEdits;
    if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
    if (clearBtn) clearBtn.disabled = state.canvas.getObjects().filter((o) => !o.excludeFromExport).length === 0;
  }

  function showCropActions() {
    document.getElementById('crop-actions').hidden = false;
    positionCropActions();
  }
  function hideCropActions() {
    document.getElementById('crop-actions').hidden = true;
  }
  function positionCropActions() {
    const rect = state.pendingCrop;
    if (!rect) return;
    const wrap = document.getElementById('canvas-wrap');
    const canvasEl = state.canvas.upperCanvasEl;
    const wrapRect = wrap.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    const offLeft = canvasRect.left - wrapRect.left + wrap.scrollLeft;
    const offTop = canvasRect.top - wrapRect.top + wrap.scrollTop;
    const s = state.scale * state.zoom;
    const overlay = document.getElementById('crop-actions');
    const ox = offLeft + (rect.left + rect.width) * s;
    const oy = offTop + (rect.top + rect.height) * s + 8;
    overlay.style.left = ox + 'px';
    overlay.style.top = oy + 'px';
    overlay.style.transform = 'translateX(-100%)';
  }

  function applyCrop() {
    const rect = state.pendingCrop;
    const c = state.canvas;
    if (!rect) return;
    const left = Math.round(rect.left);
    const top = Math.round(rect.top);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    const bgEl = c.backgroundImage && c.backgroundImage.getElement();
    if (!bgEl) return;

    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(bgEl, left, top, width, height, 0, 0, width, height);

    const croppedUrl = tmp.toDataURL('image/png');

    c.remove(rect);
    state.pendingCrop = null;
    hideCropActions();

    fabric.Image.fromURL(croppedUrl, (newBg) => {
      state.imgW = width;
      state.imgH = height;
      c.setDimensions({ width, height });
      c.getObjects().forEach((o) => {
        o.left = o.left - left;
        o.top = o.top - top;
        o.setCoords();
      });
      c.setBackgroundImage(newBg, () => {
        applyFitScale();
        c.requestRenderAll();
        state.history = [serialize()];
        state.redoStack = [];
        reseedNumberCounter();
        updateHistoryButtons();
      }, { originX: 'left', originY: 'top' });
    });
  }

  function cancelCrop() {
    const c = state.canvas;
    if (state.pendingCrop) {
      c.remove(state.pendingCrop);
      state.pendingCrop = null;
      c.requestRenderAll();
    }
    hideCropActions();
  }

  // Solid fill, not pixelation: pixelated text can be recovered (e.g. Depix),
  // and an opaque block also covers annotations drawn underneath.
  function applyRedaction(left, top, width, height) {
    const c = state.canvas;
    const rect = new fabric.Rect({
      left, top, width, height,
      fill: '#111111', stroke: null, strokeWidth: 0,
      selectable: state.tool === 'select',
      evented: state.tool === 'select',
      data: { kind: 'redact' },
    });
    c.add(rect);
    c.requestRenderAll();
    snapshot();
  }

  function placeNumberMarker(x, y) {
    const c = state.canvas;
    const radius = markerRadius(state.width);
    const value = state.numberCounter++;
    const fontSize = Math.round(radius * 1.2);
    const strokeWidth = Math.max(2, Math.round(radius / 6));
    const circle = new fabric.Circle({
      radius,
      fill: state.color,
      stroke: '#ffffff', strokeWidth,
      originX: 'center', originY: 'center',
      left: 0, top: 0,
    });
    const label = new fabric.Text(String(value), {
      fontSize, fontFamily: 'sans-serif', fontWeight: 'bold',
      fill: isLightColor(state.color) ? '#1c1c1e' : '#ffffff',
      originX: 'center', originY: 'center',
      left: 0, top: 0,
    });
    const group = new fabric.Group([circle, label], {
      left: x, top: y,
      originX: 'center', originY: 'center',
      selectable: state.tool === 'select',
      evented: state.tool === 'select',
      data: { kind: 'step', value },
    });
    c.add(group);
    c.requestRenderAll();
    snapshot();
  }

  function isLightColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.7;
  }

  function placeComment(x, y) {
    const c = state.canvas;
    // Point from the bottom-left like Figma, but flip near the right/top edges
    // so the bubble grows into the image instead of off it.
    const vertical = y < state.imgH * 0.25 ? 't' : 'b';
    const horizontal = x > state.imgW * 0.6 ? 'r' : 'l';
    const bubble = makeComment(x, y, '', vertical + horizontal);
    c.add(bubble);
    c.setActiveObject(bubble);
    bubble.enterEditing();
    // No snapshot yet: it is recorded once it has text (object:modified on
    // exit), and dismissed if it never gets any.
  }

  // A comment bubble whose `tail` corner sits on (x, y).
  function makeComment(x, y, text, tail, fontSize = commentFontSize(state.width)) {
    const pad = Math.round(fontSize * 0.6);
    return new fabric.CommentBubble(text, {
      tail,
      originX: tail[1] === 'l' ? 'left' : 'right',
      originY: tail[0] === 'b' ? 'bottom' : 'top',
      left: x + (tail[1] === 'l' ? pad : -pad),
      top: y + (tail[0] === 'b' ? -pad : pad),
      fontSize,
      // Not the system font: fabric measures glyphs at 400px, where SF's
      // optical sizing is narrower than the rendered size, so the bubble
      // came out too small and clipped the last characters.
      fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontWeight: '500',
      fill: isLightColor(state.color) ? '#1c1c1e' : '#ffffff',
      backgroundColor: state.color,
      data: { kind: 'comment' },
    });
  }

  // Colour picker: a label with the hex of the screenshot pixel under (x, y),
  // a ring on that pixel and a pill beside it (flipped near the right edge).
  function placeColorChip(x, y) {
    const hex = sampleAt(x, y);
    if (!hex) return;
    const c = state.canvas;
    const fs = chipFontSize(state.width);
    const r = Math.round(fs * 0.45);
    const shadow = { color: 'rgba(0, 0, 0, 0.45)', blur: fs * 0.5, offsetY: fs * 0.1 };
    const ring = new fabric.Circle({
      radius: r, fill: hex, stroke: '#ffffff', strokeWidth: Math.max(2, fs * 0.14),
      originX: 'center', originY: 'center', left: 0, top: 0, shadow,
    });
    const text = new fabric.Text(hex, {
      fontSize: fs, fontWeight: '600', fill: '#ffffff', originY: 'center', top: 0,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    });
    const padX = fs * 0.55, sw = fs * 0.85, gapIn = fs * 0.4, gapOut = r + fs * 0.4;
    const pillW = padX + sw + gapIn + text.width + padX, pillH = fs * 1.7;
    const pillLeft = x + gapOut + pillW > state.imgW ? -(gapOut + pillW) : gapOut;
    const pill = new fabric.Rect({
      left: pillLeft, top: -pillH / 2, width: pillW, height: pillH, rx: pillH / 2, ry: pillH / 2,
      fill: 'rgba(28, 28, 30, 0.92)', stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 1, shadow,
    });
    const swatch = new fabric.Rect({
      left: pillLeft + padX, top: -sw / 2, width: sw, height: sw, rx: sw * 0.25, ry: sw * 0.25,
      fill: hex, stroke: 'rgba(255, 255, 255, 0.6)', strokeWidth: 1,
    });
    text.set('left', pillLeft + padX + sw + gapIn);
    // The ring is last: resize() finds it there.
    const chip = new fabric.Group([pill, swatch, text, ring], {
      objectCaching: false, // a cached group would clip its parts' shadows
      selectable: state.tool === 'select', evented: state.tool === 'select',
      data: { kind: 'color', hex, size: fs },
    });
    // Built around (0, 0) = the ring's centre; move that onto the pixel.
    chip.set({ left: chip.left + x, top: chip.top + y });
    chip.setCoords();
    c.add(chip);
    c.requestRenderAll();
    snapshot();
  }

  // Hex of the screenshot pixel at canvas (x, y), ignoring annotations. The
  // pixels are copied once per background (load, crop and compare replace it).
  function sampler() {
    const bg = state.canvas.backgroundImage;
    if (!bg) return null;
    if (!state.sampler || state.sampler.bg !== bg) {
      const cv = document.createElement('canvas');
      cv.width = state.imgW;
      cv.height = state.imgH;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bg.getElement(), 0, 0);
      state.sampler = { bg, canvas: cv, ctx };
    }
    return state.sampler;
  }

  function sampleAt(x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    const sm = sampler();
    if (!sm || px < 0 || py < 0 || px >= state.imgW || py >= state.imgH) return null;
    const d = sm.ctx.getImageData(px, py, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  // Dim the screenshot outside every spotlight. Clipping to the outside of
  // each hole in turn intersects the clips, which leaves the outside of their
  // union, so overlapping spotlights don't re-dim each other.
  function renderSpotlights(ctx, canvas) {
    const spots = canvas.getObjects().filter((o) => o.data && o.data.kind === 'spotlight' && o.visible);
    if (!spots.length) return;
    const W = state.imgW, H = state.imgH;
    const v = canvas.viewportTransform;
    ctx.save();
    ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
    spots.forEach((o) => {
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.save();
      const m = o.calcTransformMatrix();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.roundRect(-o.width / 2, -o.height / 2, o.width, o.height, o.rx || 0);
      ctx.restore(); // the path survives restore; the transform doesn't
      ctx.clip('evenodd');
    });
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Magnifier for Measure and the colour picker: 15×15 screenshot pixels
  // around the pointer, the centre one outlined, with its hex when picking.
  const LOUPE_PX = 15;
  const LOUPE_SIZE = 120;

  function attachLoupe() {
    const loupe = document.getElementById('loupe');
    const cv = loupe.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.height = LOUPE_SIZE * dpr;
    const ctx = cv.getContext('2d');
    const label = loupe.querySelector('.loupe-label');
    const el = state.canvas.upperCanvasEl;
    el.addEventListener('pointermove', (e) => {
      if (state.tool !== 'measure' && state.tool !== 'eyedropper') return;
      const sm = sampler();
      if (!sm) return;
      const p = state.canvas.getPointer(e);
      const px = Math.floor(p.x), py = Math.floor(p.y);
      const cell = cv.width / LOUPE_PX;
      const half = (LOUPE_PX - 1) / 2;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(sm.canvas, px - half, py - half, LOUPE_PX, LOUPE_PX, 0, 0, cv.width, cv.height);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#000000';
      ctx.strokeRect(half * cell, half * cell, cell, cell);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(half * cell + dpr, half * cell + dpr, cell - 2 * dpr, cell - 2 * dpr);
      const hex = state.tool === 'eyedropper' ? sampleAt(px, py) : null;
      label.textContent = hex || '';
      label.hidden = !hex;
      loupe.hidden = false;
      // Down-right of the pointer, flipped near the window edges.
      const w = loupe.offsetWidth, h = loupe.offsetHeight;
      let x = e.clientX + 24, y = e.clientY + 24;
      if (x + w > window.innerWidth - 8) x = e.clientX - 24 - w;
      if (y + h > window.innerHeight - 8) y = e.clientY - 24 - h;
      loupe.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    });
    el.addEventListener('pointerleave', hideLoupe);
  }

  function hideLoupe() {
    document.getElementById('loupe').hidden = true;
  }

  function reseedNumberCounter() {
    let max = 0;
    state.canvas.getObjects().forEach((o) => {
      const v = o && o.data && o.data.kind === 'step' ? o.data.value : 0;
      if (typeof v === 'number' && v > max) max = v;
    });
    state.numberCounter = max + 1;
  }

  function exportPng(multiplier) {
    const c = state.canvas;
    cancelCrop();
    c.discardActiveObject();
    // The editing-exited handler removes empty comments a tick later; export
    // now, so drop them here or the placeholder bubble would be exported.
    c.getObjects()
      .filter((o) => o.type === 'commentBubble' && !o.text.trim())
      .forEach((o) => c.remove(o));
    c.requestRenderAll();
    return c.toDataURL({ format: 'png', multiplier });
  }

  // Copy: downscaled to maxDimension to save vision-model tokens.
  function done() {
    if (!state.imgW) return;
    const longEdge = Math.max(state.imgW, state.imgH);
    const multiplier = state.maxDimension > 0 && longEdge > state.maxDimension
      ? state.maxDimension / longEdge
      : 1;
    vscode.postMessage({ type: 'done', dataUrl: exportPng(multiplier) });
  }

  // Download: full resolution; the extension shows the save dialog.
  function download() {
    if (!state.imgW) return;
    vscode.postMessage({ type: 'download', dataUrl: exportPng(1) });
  }

  function cancel() {
    vscode.postMessage({ type: 'cancel' });
  }

  function attachToolbarHandlers() {
    // A grouped slot lists the tools it holds when hovered (or, without a
    // mouse, when clicked while active, or right-clicked). A click picks the
    // tool it shows.
    toolSlots().forEach((btn) => {
      btn.addEventListener('click', () => {
        if (menuOwnerJustClosed(btn)) return;
        const open = !document.getElementById('context-menu').hidden && menuState.owner === btn;
        if (!btn.dataset.group || state.tool !== btn.dataset.tool) setTool(btn.dataset.tool);
        else if (open) menuState.hover = false; // clicked while hovering: keep it open
        else openToolFlyout(btn);
      });
      if (btn.dataset.group) {
        btn.addEventListener('pointerenter', (e) => {
          if (e.pointerType === 'mouse' && e.buttons === 0) hoverFlyout(btn);
        });
        btn.addEventListener('pointerleave', hoverLeave);
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openToolFlyout(btn);
        });
      }
    });
    document.getElementById('btn-scale').addEventListener('click', () => setPxScale(state.pxScale % 3 + 1));
    setPxScale(1);
    document.querySelectorAll('button.swatch').forEach((btn) => {
      btn.addEventListener('click', () => setColor(btn.dataset.color));
    });
    document.querySelectorAll('button.width').forEach((btn) => {
      btn.addEventListener('click', () => setWidth(parseInt(btn.dataset.width, 10)));
    });
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-clear').addEventListener('click', clearAll);
    document.getElementById('btn-delete').addEventListener('click', () => {
      const active = state.canvas.getActiveObject();
      if (active) removeObjects(active.type === 'activeSelection' ? active.getObjects() : [active]);
    });
    // Delete is only usable while something is selected.
    const syncDelete = () => {
      document.getElementById('btn-delete').disabled = !state.canvas.getActiveObject();
    };
    ['selection:created', 'selection:updated', 'selection:cleared', 'object:removed'].forEach((ev) =>
      state.canvas.on(ev, syncDelete)
    );
    document.getElementById('btn-done').addEventListener('click', done);
    document.getElementById('btn-cancel').addEventListener('click', cancel);
    const fileInput = document.getElementById('file-input');
    const upload = document.getElementById('btn-upload');
    const pick = (mode) => {
      fileInput.dataset.mode = mode;
      fileInput.click();
    };
    upload.addEventListener('click', () => {
      if (menuOwnerJustClosed(upload)) return;
      if (!state.imgW) { pick('replace'); return; }
      openMenu([
        { label: 'Replace image…', icon: 'replace', run: () => pick('replace') },
        { label: 'Compare with another image…', icon: 'compare', run: () => pick('compare') },
      ], { anchor: upload, side: 'below', align: 'end' });
    });
    fileInput.addEventListener('change', () => {
      loadFile(fileInput.files[0], fileInput.dataset.mode);
      fileInput.value = ''; // so picking the same file again still fires change
    });
    document.getElementById('crop-apply').addEventListener('click', applyCrop);
    document.getElementById('crop-cancel').addEventListener('click', cancelCrop);
  }

  function attachWheelZoom() {
    const wrap = document.getElementById('canvas-wrap');
    wrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      setZoom(state.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });
  }

  function attachKeyboardHandlers() {
    document.addEventListener('keydown', (e) => {
      const active = state.canvas.getActiveObject();
      if (active && active.isEditing) return;

      const cmd = e.metaKey || e.ctrlKey;
      const k = e.key;

      if (k === 'Escape') {
        e.preventDefault();
        if (state.pendingCrop) { cancelCrop(); return; }
        cancel();
        return;
      }
      if (k === 'Enter' && !cmd && state.pendingCrop) { e.preventDefault(); applyCrop(); return; }
      if (cmd && k === 'Enter') { e.preventDefault(); done(); return; }
      if (cmd && !e.shiftKey && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
      if (cmd && e.shiftKey && (k === 'z' || k === 'Z')) { e.preventDefault(); redo(); return; }
      if (cmd && (k === '=' || k === '+')) { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
      if (cmd && k === '-') { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
      if (cmd && k === '0') { e.preventDefault(); resetZoom(); return; }
      if (cmd) return;

      if (k === 'v' || k === 'V') setTool('select');
      else if (k === 'p' || k === 'P') setTool('pen');
      else if (k === 'a' || k === 'A') setTool('arrow');
      else if (k === 'd' || k === 'D') setTool('arrow2');
      else if (k === 'r' || k === 'R') setTool('rect');
      else if (k === 'e' || k === 'E') setTool('ellipse');
      else if (k === 'h' || k === 'H') setTool('highlight');
      else if (k === 't' || k === 'T') setTool('text');
      else if (k === 'c' || k === 'C') setTool('crop');
      else if (k === 'b' || k === 'B') setTool('redact');
      else if (k === 'n' || k === 'N') setTool('number');
      else if (k === 'm' || k === 'M') setTool('comment');
      else if (k === 's' || k === 'S') setTool('spotlight');
      else if (k === 'u' || k === 'U') setTool('measure');
      else if (k === 'i' || k === 'I') setTool('eyedropper');
      else if (k === 'Delete' || k === 'Backspace') {
        const obj = state.canvas.getActiveObject();
        if (!obj) return;
        removeObjects(obj.type === 'activeSelection' ? obj.getObjects() : [obj]);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Context menu: replaces the webview's default Cut/Copy/Paste menu, except
  // while typing in a text or comment, where the native text menu is kept.
  // ---------------------------------------------------------------------------

  const keyHint = (mac, other) => (IS_MAC ? mac : other);
  const MENU_ICONS = {
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    duplicate: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>'),
    front: svg('<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5" opacity="0.45"/>'),
    back: svg('<path d="m3 8 9 5 9-5" opacity="0.45"/><path d="m12 11 9 5-9 5-9-5Z"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    fit: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    clear: svg('<path d="m7 21-4-4L14 6l4 4L7 21Z"/><path d="M11 21h10"/>'),
    replace: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
    tips: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>'),
    paw: svg('<circle cx="7" cy="9" r="1.6"/><circle cx="11" cy="6" r="1.6"/><circle cx="15.5" cy="6.5" r="1.6"/><circle cx="18.5" cy="10.5" r="1.6"/><path d="M8.5 17c0-2.5 2-5 4.5-5s4.5 2.5 4 5c-.3 1.6-1.8 2.3-4 2.3s-4.2-.7-4.5-2.3Z"/>'),
    hide: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 5 9 7a10 10 0 0 1-2.3 3.4"/><path d="M6.6 6.6C4.4 8 3 10.5 3 12c0 2 4 7 9 7a9.6 9.6 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    compare: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>'),
  };

  function removeObjects(objs) {
    const c = state.canvas;
    c.discardActiveObject();
    objs.forEach((o) => c.remove(o));
    c.requestRenderAll();
    snapshot();
  }

  function duplicateObjects(objs) {
    const c = state.canvas;
    c.discardActiveObject(); // so members of a selection are in canvas coordinates
    const clones = [];
    objs.forEach((o) => o.clone((copy) => {
      copy.set({ left: copy.left + 24, top: copy.top + 24 });
      copy.selectable = copy.evented = isInteractive(copy);
      c.add(copy);
      clones.push(copy);
      if (clones.length < objs.length) return;
      if (state.tool === 'select') {
        c.setActiveObject(clones.length === 1 ? clones[0] : new fabric.ActiveSelection(clones, { canvas: c }));
      }
      c.requestRenderAll();
      snapshot();
    }, ['data']));
  }

  function restack(objs, toFront) {
    const c = state.canvas;
    const active = c.getActiveObject();
    const multi = active && active.type === 'activeSelection';
    if (multi) c.discardActiveObject();
    // Walk so the selection keeps its own stacking order.
    (toFront ? objs : objs.slice().reverse()).forEach((o) => (toFront ? c.bringToFront(o) : c.sendToBack(o)));
    if (multi) c.setActiveObject(new fabric.ActiveSelection(objs, { canvas: c }));
    c.requestRenderAll();
    snapshot();
  }

  function editText(o) {
    const c = state.canvas;
    c.setActiveObject(o);
    o.enterEditing();
    o.selectionStart = o.selectionEnd = o.text.length;
    c.requestRenderAll();
  }

  // Topmost annotation under the pointer, whatever tool is active.
  function objectAt(e) {
    const c = state.canvas;
    const p = c.getPointer(e);
    const active = c.getActiveObject();
    if (active && active.type === 'activeSelection' && active.containsPoint(p)) return active;
    const objs = c.getObjects();
    for (let i = objs.length - 1; i >= 0; i--) {
      if (!objs[i].excludeFromExport && objs[i].containsPoint(p)) return objs[i];
    }
    return null;
  }

  function menuItemsFor(target) {
    const c = state.canvas;
    const items = [];
    if (target) {
      const objs = target.type === 'activeSelection' ? target.getObjects() : [target];
      if (objs.length === 1 && (target.type === 'i-text' || target.type === 'commentBubble')) {
        items.push({ label: 'Edit text', icon: 'edit', run: () => editText(target) });
      }
      items.push(
        { label: 'Duplicate', icon: 'duplicate', run: () => duplicateObjects(objs) },
        { label: 'Bring to front', icon: 'front', run: () => restack(objs, true) },
        { label: 'Send to back', icon: 'back', run: () => restack(objs, false) },
        { label: 'Delete', icon: 'trash', hint: '⌫', danger: true, run: () => removeObjects(objs) },
        'sep'
      );
    }
    items.push(
      { label: 'Undo', icon: 'undo', hint: keyHint('⌘Z', 'Ctrl+Z'), disabled: state.history.length <= 1, run: undo },
      { label: 'Redo', icon: 'redo', hint: keyHint('⇧⌘Z', 'Ctrl+Shift+Z'), disabled: state.redoStack.length === 0, run: redo },
      'sep',
      { label: 'Copy image', icon: 'copy', hint: keyHint('⌘⏎', 'Ctrl+Enter'), run: done },
      { label: 'Download PNG…', icon: 'download', run: download }
    );
    if (state.zoom !== 1) {
      items.push({ label: 'Fit to window', icon: 'fit', hint: keyHint('⌘0', 'Ctrl+0'), run: resetZoom });
    }
    if (!target && c.getObjects().some((o) => !o.excludeFromExport)) {
      items.push('sep', { label: 'Clear annotations', icon: 'clear', danger: true, run: clearAll });
    }
    if (!target) items.push('sep', { label: 'Show tips', icon: 'tips', run: startTour });
    return items;
  }

  // One glass menu serves the right-click menu, the tool-slot flyouts and the
  // Upload menu. `place` is a point { x, y } or { anchor, side, align }: next
  // to an element on side 'right' | 'left' | 'below' | 'above', aligned to its
  // 'start' (default) or 'end'. An anchor element is the menu's owner, so
  // clicking it while the menu is open closes the menu instead of reopening.
  // hover: the menu is a tool flyout opened by hovering its slot, and closes
  // when the pointer leaves both.
  const menuState = { owner: null, justClosed: null, hover: false, openTimer: 0, closeTimer: 0 };

  function closeMenu() {
    clearTimeout(menuState.openTimer);
    clearTimeout(menuState.closeTimer);
    document.getElementById('context-menu').hidden = true;
    menuState.owner = null;
    menuState.hover = false;
  }

  // A short pause before opening, so sweeping across the pill doesn't flash
  // flyouts; once one is open, moving to the next slot swaps it at once.
  function hoverFlyout(btn) {
    clearTimeout(menuState.openTimer);
    clearTimeout(menuState.closeTimer);
    const open = !document.getElementById('context-menu').hidden;
    if (open && menuState.owner === btn) return;
    if (open && !menuState.hover) return; // leave a clicked-open menu alone
    const show = () => openToolFlyout(btn, true);
    if (open) show(); else menuState.openTimer = setTimeout(show, 180);
  }

  // Grace period to cross the gap between the slot and its flyout.
  function hoverLeave() {
    clearTimeout(menuState.openTimer);
    if (!menuState.hover) return;
    clearTimeout(menuState.closeTimer);
    menuState.closeTimer = setTimeout(closeMenu, 280);
  }

  function menuOwnerJustClosed(el) {
    if (menuState.justClosed !== el) return false;
    menuState.justClosed = null;
    return true;
  }

  function openMenu(items, place) {
    const menu = document.getElementById('context-menu');
    hideLoupe();
    menu.innerHTML = '';
    items.forEach((it) => {
      if (it === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item' + (it.danger ? ' danger' : '');
      b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
      b.disabled = !!it.disabled;
      b.innerHTML = MENU_ICONS[it.icon] + '<span class="menu-label"></span><span class="menu-hint"></span>';
      b.querySelector('.menu-label').textContent = it.label;
      b.querySelector('.menu-hint').textContent = it.hint || '';
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menu.appendChild(b);
    });
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    let x = place.x, y = place.y;
    if (place.anchor) {
      const a = place.anchor.getBoundingClientRect();
      const end = place.align === 'end';
      if (place.side === 'right' || place.side === 'left') {
        x = place.side === 'right' ? a.right + 8 : a.left - 8 - r.width;
        y = end ? a.bottom - r.height : a.top;
      } else {
        x = end ? a.right - r.width : a.left;
        y = place.side === 'below' ? a.bottom + 8 : a.top - 8 - r.height;
      }
    }
    menuState.owner = place.anchor || null;
    menuState.hover = !!place.hover;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    // Focus the menu, not its first item: a focused item draws as
    // highlighted, which looks like a hover on a mouse-opened menu. Arrow
    // keys move onto the items from here. A hover flyout leaves focus alone.
    if (!place.hover) menu.focus({ preventScroll: true });
  }

  // The tools sharing a slot, opened beside the pill on the side facing the
  // canvas.
  function openToolFlyout(btn, hover) {
    const side = { left: 'right', right: 'left', top: 'below', bottom: 'above' }[state.dock];
    openMenu(btn.dataset.group.split(' ').map((tool) => {
      const info = TOOL_INFO[tool];
      return { label: info.label, icon: tool, hint: info.key, checked: state.tool === tool, run: () => setTool(tool) };
    }), { anchor: btn, side, hover });
  }

  function attachContextMenu() {
    const menu = document.getElementById('context-menu');
    const wrap = document.getElementById('canvas-wrap');
    const enabledItems = () => Array.from(menu.querySelectorAll('.menu-item:not(:disabled)'));
    Object.keys(TOOL_INFO).forEach((tool) => { MENU_ICONS[tool] = TOOL_INFO[tool].icon; });

    document.addEventListener('contextmenu', (e) => {
      const active = state.canvas.getActiveObject();
      if (active && active.isEditing) return; // keep the native text menu
      e.preventDefault();
      if (!state.imgW || !wrap.contains(e.target)) { closeMenu(); return; }
      const target = objectAt(e);
      // Select what was right-clicked, so it's clear what the menu acts on.
      if (target && target !== active && state.tool === 'select') {
        state.canvas.setActiveObject(target);
        state.canvas.requestRenderAll();
      }
      openMenu(menuItemsFor(target), { x: e.clientX, y: e.clientY });
    });

    document.addEventListener('pointerdown', (e) => {
      menuState.justClosed = null;
      if (menu.hidden || menu.contains(e.target)) return;
      if (menuState.owner && menuState.owner.contains(e.target)) {
        if (menuState.hover) return; // the click picks the slot's tool
        menuState.justClosed = menuState.owner;
      }
      closeMenu();
    }, true);
    // Capture phase, so Escape closes the menu instead of the editor.
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      const list = enabledItems();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        const owner = menuState.owner;
        closeMenu();
        if (owner) owner.focus();
      }
      else if (e.key === 'ArrowDown') list[(i + 1) % list.length].focus();
      else if (e.key === 'ArrowUp') list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length].focus();
      else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) list[i].click(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    menu.addEventListener('pointerenter', () => clearTimeout(menuState.closeTimer));
    menu.addEventListener('pointerleave', hoverLeave);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    wrap.addEventListener('scroll', closeMenu);
  }

  // ---------------------------------------------------------------------------
  // First-run tour: a few tips pointing at the toolbar, the style bar, the
  // canvas and Copy. Shown once per install (the extension keeps
  // snapmark.tourSeen in globalState), and again from "Show tips" in the
  // right-click menu. It doesn't block the editor.
  // ---------------------------------------------------------------------------

  const TOUR_STEPS = [
    {
      target: () => document.getElementById('tools'),
      side: () => ({ left: 'right', right: 'left', top: 'below', bottom: 'above' }[state.dock]),
      title: 'Pick a tool',
      body: () => 'A small corner mark means more tools are inside: hover over it to see them. Drag ⠿ to move the toolbar, or drag a tool to reorder it.',
    },
    {
      target: () => document.getElementById('stylebar'),
      side: () => 'above',
      title: 'Color and size',
      body: () => 'They apply to what you draw next. With something selected, they change it instead.',
    },
    {
      target: () => state.canvas.upperCanvasEl,
      side: () => 'center',
      title: 'Right-click for more',
      body: () => 'Duplicate, delete, download the PNG and more. Zoom with ' + keyHint('⌘', 'Ctrl') + ' + scroll.',
    },
    {
      target: () => document.getElementById('btn-done'),
      side: () => 'below',
      title: 'Copy, then paste',
      body: () => 'Copy (' + keyHint('⌘⏎', 'Ctrl+Enter') + ') puts the annotated image on your clipboard. Paste it into any AI chat.',
    },
  ];

  const tour = { step: -1, timer: 0 };

  function maybeStartTour() {
    if (state.tourSeen || !state.imgW || tour.step >= 0) return;
    state.tourSeen = true;
    vscode.postMessage({ type: 'tourSeen' });
    clearTimeout(tour.timer);
    tour.timer = setTimeout(startTour, 500); // let the image settle in first
  }

  function startTour() {
    closeMenu();
    showTourStep(0);
  }

  function endTour() {
    clearTimeout(tour.timer);
    tour.step = -1;
    document.getElementById('tour').hidden = true;
    document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
  }

  function showTourStep(i) {
    if (i >= TOUR_STEPS.length) { endTour(); return; }
    tour.step = i;
    const s = TOUR_STEPS[i];
    document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
    const target = s.target();
    if (s.side() !== 'center') target.classList.add('tour-target');
    document.getElementById('tour-step').textContent = (i + 1) + ' of ' + TOUR_STEPS.length;
    document.getElementById('tour-title').textContent = s.title;
    document.getElementById('tour-body').textContent = s.body();
    const last = i === TOUR_STEPS.length - 1;
    document.getElementById('tour-next').textContent = last ? 'Got it' : 'Next';
    document.getElementById('tour-skip').hidden = last;
    const pop = document.getElementById('tour');
    pop.hidden = false;
    positionTour();
    document.getElementById('tour-next').focus({ preventScroll: true });
  }

  // Beside the target on the given side, with the arrow pointing at the
  // target's centre; 'center' sits over the middle of the visible canvas.
  function positionTour() {
    if (tour.step < 0) return;
    const s = TOUR_STEPS[tour.step];
    const pop = document.getElementById('tour');
    const side = s.side();
    let r = s.target().getBoundingClientRect();
    if (side === 'center') {
      const w = document.getElementById('canvas-wrap').getBoundingClientRect();
      r = {
        left: Math.max(r.left, w.left), right: Math.min(r.right, w.right),
        top: Math.max(r.top, w.top), bottom: Math.min(r.bottom, w.bottom),
      };
    }
    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 14;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    let x, y;
    if (side === 'right') { x = r.right + gap; y = cy - ph / 2; }
    else if (side === 'left') { x = r.left - gap - pw; y = cy - ph / 2; }
    else if (side === 'below') { x = cx - pw / 2; y = r.bottom + gap; }
    else if (side === 'above') { x = cx - pw / 2; y = r.top - gap - ph; }
    else { x = cx - pw / 2; y = cy - ph / 2; }
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - ph - 8));
    pop.dataset.side = side;
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    // Keep the arrow on the target even when the bubble was clamped.
    pop.style.setProperty('--arrow-x', Math.max(18, Math.min(pw - 18, cx - x)) + 'px');
    pop.style.setProperty('--arrow-y', Math.max(18, Math.min(ph - 18, cy - y)) + 'px');
  }

  function attachTour() {
    document.getElementById('tour-next').addEventListener('click', () => showTourStep(tour.step + 1));
    document.getElementById('tour-skip').addEventListener('click', endTour);
    // Capture phase, so Escape ends the tour instead of closing the editor.
    document.addEventListener('keydown', (e) => {
      if (tour.step < 0 || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      endTour();
    }, true);
    window.addEventListener('resize', positionTour);
  }

  // ---------------------------------------------------------------------------
  // Pet (snapmark.pet): a small pixel-art cat or dog that lives at the bottom
  // left, on a floor just above the style bar, with a cushion (cat) or a dog
  // house (dog). It's mostly a homebody (blinks, tail, grooms or pants,
  // yawns, naps); now and then it strolls out and back, turns round halfway,
  // or walks off an edge and later comes back in through the same edge. All
  // art is drawn from shapes on a design grid (26×24 units for the pet, 2
  // detail pixels per unit), shaded and outlined automatically, so poses are
  // parameters rather than hand-drawn frames. It's DOM, not canvas content,
  // so it never appears in the copied image.
  // ---------------------------------------------------------------------------

  const PET_F = 2; // detail pixels (CSS px) per design unit
  const PET_W = 26 * PET_F, PET_H = 24 * PET_F;
  const PET_COLORS = {
    cat: {
      fur: '#eba25b', hi: '#f9c88c', shade: '#c47334', dark: '#b8652b', far: '#c47235',
      light: '#fbe8ca', lightShade: '#e6c99c', nose: '#f08a9b', ear: '#f4a9b4', eye: '#24170d',
      mouth: '#8a5236', whisker: '#fff4e4', line: '#3e1f0c',
    },
    dog: {
      fur: '#c99460', hi: '#e6bb8a', shade: '#9c6a3a', dark: '#6f4424', far: '#a06c3c',
      light: '#f6eacf', lightShade: '#dcc6a0', nose: '#24170d', ear: '#6f4424', eye: '#24170d',
      mouth: '#5a3a26', tongueLine: '#c95a6a', collar: '#d9433f', tag: '#f2cf73', line: '#2a170b',
    },
  };
  const HOME_COLORS = {
    cushion: { base: '#5aa6a0', hi: '#8fd0c8', shade: '#3c7c77', tuft: '#2f6662', piping: '#e9cf8a', line: '#143534' },
    house: {
      wall: '#6f9dc6', wallHi: '#9cc3e4', wallShade: '#4f7ca4', plank: '#5a87b0',
      roof: '#d0533f', roofHi: '#ec7f66', roofShade: '#a23a2b', trim: '#f4e9d2', door: '#1d140c', line: '#191828',
    },
  };
  const PET_TONGUE = '#f07c8c', PET_ZZZ = '#d7dbe4', PET_HEART = '#ff6b8b';
  const CUSHION_W = 44, CUSHION_H = 16, CUSHION_LIFT = 9; // the cat sits this far up on it
  const HOUSE_W = 46, HOUSE_H = 42, HOUSE_GAP = 26; // the dog sits this far right of the house's left edge
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

  function mixHex(a, b, t) {
    const n = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
    return '#' + [0, 1, 2].map((i) => Math.round(n(a, i) + (n(b, i) - n(a, i)) * t).toString(16).padStart(2, '0')).join('');
  }

  // A w×h grid of detail pixels. Shapes take design units (× PET_F); dot()
  // and hline() take detail pixels, for fine touches.
  function pixelGrid(w, h) {
    const F = PET_F;
    const g = new Array(w * h).fill(null);
    const dot = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = c;
    };
    const ell = (cx, cy, rx, ry, c) => {
      cx *= F; cy *= F; rx *= F; ry *= F;
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy <= 1) dot(x, y, c);
        }
      }
    };
    return {
      g, dot, ell,
      set(x, y, c) {
        x = Math.round(x) * F; y = Math.round(y) * F;
        for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) dot(x + i, y + j, c);
      },
      rect(x0, y0, x1, y1, c) { // design units, inclusive
        for (let y = Math.round(y0 * F); y < Math.round((y1 + 1) * F); y++) {
          for (let x = Math.round(x0 * F); x < Math.round((x1 + 1) * F); x++) dot(x, y, c);
        }
      },
      tri(a, b, d, c) {
        const [A, B, D] = [a, b, d].map(([x, y]) => [x * F, y * F]);
        const side = (p0, p1, q) => (p1[0] - p0[0]) * (q[1] - p0[1]) - (p1[1] - p0[1]) * (q[0] - p0[0]);
        for (let y = Math.floor(Math.min(A[1], B[1], D[1])); y <= Math.ceil(Math.max(A[1], B[1], D[1])); y++) {
          for (let x = Math.floor(Math.min(A[0], B[0], D[0])); x <= Math.ceil(Math.max(A[0], B[0], D[0])); x++) {
            const q = [x + 0.5, y + 0.5];
            const s0 = side(A, B, q), s1 = side(B, D, q), s2 = side(D, A, q);
            if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) dot(x, y, c);
          }
        }
      },
      line(pts, r, c) { // a thick stroke through design-unit points
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * F * 2));
          for (let k = 0; k <= n; k++) ell(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, r, r, c);
        }
      },
      hline(x0, y0, x1, y1, c) { // a 1px line in detail pixels
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let k = 0; k <= n; k++) dot(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, c);
      },
      // Light from above: a two-pixel lit band along top edges and a
      // two-pixel shadow along undersides. tones: { colour: [lit, shadow] }.
      shade(tones) {
        const src = g.slice();
        const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[y * w + x];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const c = src[y * w + x], t = c && tones[c];
            if (!t) continue;
            const top = !filled(x, y - 1) ? 1 : !filled(x, y - 2) ? 2 : 0;
            const bot = !filled(x, y + 1) ? 1 : !filled(x, y + 2) ? 2 : 0;
            if (t[0] && top) g[y * w + x] = top === 1 ? t[0] : mixHex(c, t[0], 0.5);
            else if (bot) g[y * w + x] = bot === 1 ? t[1] : mixHex(c, t[1], 0.45);
          }
        }
      },
      outline(c) { // every empty pixel touching the shape, diagonals included
        const src = g.slice();
        const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[y * w + x];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (src[y * w + x]) continue;
            for (let j = -1; j <= 1 && !g[y * w + x]; j++) {
              for (let i = -1; i <= 1; i++) if ((i || j) && filled(x + i, y + j)) { g[y * w + x] = c; break; }
            }
          }
        }
      },
      pattern(x, y, rows, c) { // chunky design-unit pixels, e.g. z's and the heart
        rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === '#') this.set(x + i, y + j, c); });
      },
    };
  }

  // p: { pose: 'sit' | 'stand' | 'lie', swing (tail, -1..1), eyes: 'open' |
  // 'shut', mouth: 'shut' | 'open' | 'tongue', paw (cat grooming), headDown,
  // leg (walk frame 0-3), z (0-3 sleep z's), heart }. Faces right.
  function petSprite(kind, p) {
    const C = PET_COLORS[kind];
    const cat = kind === 'cat';
    const F = PET_F;
    const G = pixelGrid(PET_W, PET_H);
    const { set, ell, rect, tri, line, dot, hline } = G;
    const sw = p.swing || 0;
    const after = []; // details drawn over the outline
    // Eye whose lower-right design unit is (x, y): round, with a catch-light;
    // shut, a sleepy curve.
    const eyes = (x, y) => {
      const ex = (x - 1) * F, ey = (y - 1) * F;
      if (p.eyes === 'shut') { [[0, 2], [1, 3], [2, 3], [3, 2]].forEach(([i, j]) => dot(ex + i, ey + j, C.eye)); return; }
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) if (!((i === 0 || i === 3) && (j === 0 || j === 3))) dot(ex + i, ey + j, C.eye);
      }
      dot(ex + 2, ey + 1, '#ffffff');
    };
    const stripe = (x, y) => { dot(x * F + 1, y * F, C.dark); dot(x * F, y * F + 1, C.dark); dot(x * F, y * F + 2, C.dark); };
    const blush = (x, y) => { dot(x * F, y * F + 1, C.ear); dot(x * F + 1, y * F + 1, C.ear); };
    const whiskers = (x, y) => after.push(() => {
      hline(x * F + 3, y * F + 2, x * F + 6, y * F + 1, C.whisker);
      hline(x * F + 3, y * F + 4, x * F + 6, y * F + 5, C.whisker);
    });
    const collar = (pts, tx, ty) => {
      line(pts, 0.55, C.collar);
      dot(tx * F, ty * F, C.tag); dot(tx * F + 1, ty * F, C.tag); dot(tx * F, ty * F + 1, C.tag); dot(tx * F + 1, ty * F + 1, '#b8902f');
    };
    // The cat looks at you: a round face centred on design (cx, cy) with two
    // big eyes, a pink nose and a "ω" mouth, whiskers both sides, pink inner
    // ears and tabby forehead marks. Details are mirrored about the centre.
    const catFace = (cx, cy) => {
      ell(cx, cy + 0.3, 4.6, 3.8, C.fur);
      ell(cx, cy + 1.4, 5, 2.4, C.fur); // cheek fluff
      tri([cx - 4.1, cy - 1], [cx - 3.3, cy - 5.6], [cx - 0.6, cy - 2.6], C.fur);
      tri([cx + 0.6, cy - 2.6], [cx + 3.3, cy - 5.6], [cx + 4.1, cy - 1], C.fur);
      ell(cx, cy + 1.7, 2.4, 1.4, C.light); // muzzle
      const X = Math.round(cx * F), Y = Math.round(cy * F);
      const both = (x, y, c) => { dot(x, y, c); dot(2 * X - 1 - x, y, c); };
      [[X - 6, Y - 8], [X - 6, Y - 7], [X - 5, Y - 7]].forEach(([x, y]) => both(x, y, C.ear));
      [[X - 3, Y - 6], [X - 3, Y - 5], [X - 1, Y - 7], [X - 1, Y - 6]].forEach(([x, y]) => both(x, y, C.dark));
      if (p.eyes === 'shut') {
        [[X - 6, Y], [X - 5, Y + 1], [X - 4, Y + 1], [X - 3, Y]].forEach(([x, y]) => both(x, y, C.eye));
      } else {
        [[X - 5, Y - 2], [X - 4, Y - 2], [X - 6, Y - 1], [X - 5, Y - 1], [X - 4, Y - 1], [X - 3, Y - 1],
          [X - 6, Y], [X - 5, Y], [X - 4, Y], [X - 3, Y], [X - 5, Y + 1], [X - 4, Y + 1]].forEach(([x, y]) => both(x, y, C.eye));
        both(X - 4, Y - 1, '#ffffff');
      }
      both(X - 8, Y + 2, C.ear); both(X - 7, Y + 2, C.ear); // blush
      both(X - 1, Y + 2, C.nose);
      if (p.mouth === 'open') {
        for (let y = Y + 3; y <= Y + 5; y++) { both(X - 2, y, C.eye); both(X - 1, y, C.eye); }
        both(X - 1, Y + 5, C.nose);
      } else {
        [[X - 1, Y + 3], [X - 2, Y + 4], [X - 3, Y + 3]].forEach(([x, y]) => both(x, y, C.mouth));
      }
      if (p.paw) line([[14, 19], [15, 15.5], [cx - 0.4, cy + 2.4]], 1.1, C.light);
      after.push(() => {
        hline(X - 9, Y + 2, X - 14, Y + 1, C.whisker); hline(X - 9, Y + 4, X - 14, Y + 5, C.whisker);
        hline(X + 8, Y + 2, X + 13, Y + 1, C.whisker); hline(X + 8, Y + 4, X + 13, Y + 5, C.whisker);
      });
    };
    // The dog looks at you too: a round head centred on design (cx, cy) with
    // floppy ears, a cream blaze and muzzle, big eyes, a shiny black nose and
    // a tongue when it pants. Details are mirrored about the centre.
    const dogFace = (cx, cy) => {
      ell(cx, cy, 4.2, 3.9, C.fur);
      ell(cx, cy - 1.6, 0.9, 2.3, C.light); // blaze
      ell(cx, cy + 2, 2.7, 1.9, C.light); // muzzle
      ell(cx - 4, cy + 0.9, 1.5, 3.1, C.ear);
      ell(cx + 4, cy + 0.9, 1.5, 3.1, C.ear);
      const X = Math.round(cx * F), Y = Math.round(cy * F);
      const both = (x, y, c) => { dot(x, y, c); dot(2 * X - 1 - x, y, c); };
      if (p.eyes === 'shut') {
        [[X - 6, Y - 1], [X - 5, Y], [X - 4, Y], [X - 3, Y - 1]].forEach(([x, y]) => both(x, y, C.eye));
      } else {
        [[X - 5, Y - 3], [X - 4, Y - 3], [X - 6, Y - 2], [X - 5, Y - 2], [X - 4, Y - 2], [X - 3, Y - 2],
          [X - 6, Y - 1], [X - 5, Y - 1], [X - 4, Y - 1], [X - 3, Y - 1], [X - 5, Y], [X - 4, Y]].forEach(([x, y]) => both(x, y, C.eye));
        both(X - 4, Y - 2, '#ffffff');
      }
      [[X - 2, Y + 1], [X - 1, Y + 1], [X - 3, Y + 2], [X - 2, Y + 2], [X - 1, Y + 2], [X - 2, Y + 3], [X - 1, Y + 3]]
        .forEach(([x, y]) => both(x, y, C.nose));
      dot(X - 2, Y + 1, '#8a7a72'); // shine
      if (p.mouth === 'open') {
        for (let y = Y + 4; y <= Y + 6; y++) { both(X - 2, y, C.eye); both(X - 1, y, C.eye); }
        both(X - 1, Y + 6, PET_TONGUE);
      } else {
        [[X - 1, Y + 4], [X - 2, Y + 5], [X - 3, Y + 5]].forEach(([x, y]) => both(x, y, C.mouth));
        if (p.mouth === 'tongue') {
          for (let y = Y + 5; y <= Y + 8; y++) { both(X - 2, y, PET_TONGUE); both(X - 1, y, PET_TONGUE); }
          both(X - 1, Y + 6, C.tongueLine); both(X - 1, Y + 7, C.tongueLine);
        }
      }
    };
    // A rounded paw centred on design x with its sole on design row y (the
    // bottom of the row), with two toe lines.
    const paw = (cx, y, c) => {
      ell(cx, y - 0.4, 1.5, 0.9, c);
      const X = Math.round(cx * F), Y = Math.round((y + 1) * F) - 1;
      [X - 2, X + 1].forEach((x) => { dot(x, Y, C.lightShade); dot(x, Y - 1, C.lightShade); });
    };
    let heartAt = [9, 0];

    if (p.pose === 'lie') {
      if (cat) line([[5, 20], [2, 21], [4, 22], [9, 22]], 1.1, C.fur);
      else line([[5, 19], [2, 17 + sw]], 1.2, C.fur);
      ell(11, 19 - (p.breath ? 0.25 : 0), 7.5, 3.3 + (p.breath ? 0.3 : 0), C.fur);
      if (cat) [[8, 16], [10, 16], [12, 16]].forEach(([x, y]) => stripe(x, y));
      else ell(9, 18, 2, 1.3, C.dark);
      paw(18.3, 22, C.light); paw(21.3, 22, C.light);
      if (cat) {
        catFace(18.5, 17.2);
      } else {
        dogFace(18.5, 17.2);
      }
      heartAt = [12, 8];
    } else if (p.pose === 'stand') {
      // Walk cycle: 8 frames of a diagonal gait (far back with near front,
      // near back with far front). Each leg swings forward lifted and pushes
      // back planted; the body bobs up as the legs pass under it.
      const phase = ((p.leg || 0) / 8) * Math.PI * 2;
      const by = -0.5 * Math.round(Math.abs(Math.cos(phase)));
      const legs = [[5, C.far, 0], [8, C.fur, Math.PI], [15, C.far, Math.PI], [18, C.fur, 0]].map(([x, c, off], i) => ({
        x: x + Math.round(Math.sin(phase + off) * 2.2) / 2, c, near: i % 2 === 1,
        lift: Math.round(Math.max(0, Math.cos(phase + off)) * 2) / 2,
      }));
      // Rounded legs that widen into the body at the top, so there's no
      // corner for the belly's shading and outline to cut across.
      const leg = (l) => {
        ell(l.x + 1, 18.4 + by, 1.7, 1.6, l.c);
        line([[l.x + 1, 18 + by], [l.x + 1, 21.2 - l.lift]], 1.05, l.c);
        paw(l.x + 1, 22 - l.lift, l.near ? C.light : C.lightShade);
      };
      legs.filter((l) => !l.near).forEach(leg);
      if (cat) line([[5, 15 + by], [2, 12 + sw + by], [2.5, 8 + sw * 1.5 + by]], 1.1, C.fur);
      else line([[5, 15 + by], [2.5 + sw * 1.5, 11 + by]], 1.2, C.fur);
      ell(11.5, 16 + by, 7, 3.4, C.fur);
      ell(12, 18.2 + by, 4, 1.1, C.light);
      ell(7, 16.8 + by, 2.8, 2.4, C.fur); // hip
      ell(17.2, 16.2 + by, 2.4, 2.5, C.fur); // shoulder
      legs.filter((l) => l.near).forEach(leg);
      if (cat) {
        [[9, 13], [11, 13], [13, 13]].forEach(([x, y]) => stripe(x, y + by));
        ell(19, 11 + by, 4, 3.6, C.fur);
        tri([15.8, 9 + by], [16.6, 4.8 + by], [18.6, 8 + by], C.fur);
        tri([19.6, 8 + by], [21.6, 4.8 + by], [22.4, 9.4 + by], C.fur);
        set(17, 7 + by, C.ear); set(21, 7 + by, C.ear);
        ell(21.4, 12.4 + by, 1.6, 1.2, C.light);
        set(23, 11 + by, C.nose);
        eyes(20, 11 + by);
        blush(19, 12 + by);
        whiskers(23, 11 + by);
      } else {
        ell(10, 14.5 + by, 2, 1.3, C.dark);
        ell(18.5, 11 + by, 3.8, 3.5, C.fur);
        ell(22.2, 12.4 + by, 2, 1.6, C.light);
        set(23, 11 + by, C.nose); set(24, 11 + by, C.nose);
        ell(16.5, 12 + by, 1.4, 2.8, C.ear);
        eyes(19, 11 + by);
        collar([[15.3, 12.2 + by], [16.4, 14.6 + by]], 16.6, 15 + by);
        if (p.mouth === 'tongue') { set(21, 14 + by, C.eye); rect(22, 14 + by, 22, 15 + by, PET_TONGUE); }
      }
      heartAt = [10, 1];
    } else {
      // Sitting.
      if (cat) line([[6, 21], [2.5, 21], [1.5 + sw * 0.8, 17], [2.5 + sw * 1.5, 13.5]], 1.1, C.fur);
      else line([[6, 18], [3 + sw * 1.8, 13.5]], 1.2, C.fur);
      ell(9, 19, 5, 3.6, C.fur);
      ell(11.5, 16 - (p.breath ? 0.25 : 0), 4.3, 5.2 + (p.breath ? 0.25 : 0), C.fur);
      ell(14, 17, 2, 3.8, C.light);
      paw(10.8, 22, C.light);
      if (!p.paw) { rect(13, 18, 15, 21.4, C.light); paw(14.5, 22, C.light); }
      else if (!cat) line([[14, 19], [16, 15], [18.5, 13]], 1.2, C.light);
      const hy = 9.5 + (p.headDown ? 1 : 0) - (p.breath ? 0.5 : 0);
      if (cat) {
        [[7, 17], [8, 15], [10, 12]].forEach(([x, y]) => stripe(x, y));
        catFace(15.5, hy);
      } else {
        ell(9, 17, 1.8, 1.5, C.dark);
        collar([[12.6, hy + 3.4], [18.2, hy + 3.6]], 15.2, hy + 4.1);
        dogFace(15.5, hy - 0.4);
      }
    }

    G.shade({ [C.fur]: [C.hi, C.shade], [C.light]: [null, C.lightShade] });
    G.outline(C.line);
    after.forEach((draw) => draw());
    if (p.pose === 'lie' && p.z) {
      [[12, 9, ['###', '..#', '.#.', '###']], [7, 5, ['####', '..#.', '.#..', '####']], [2, 0, ['####', '..#.', '.#..', '####']]]
        .slice(0, p.z).forEach(([x, y, rows]) => G.pattern(x, y, rows, PET_ZZZ));
    }
    if (p.heart) G.pattern(heartAt[0], heartAt[1], ['.#.#.', '#####', '#####', '.###.', '..#..'], PET_HEART);
    return G.g;
  }

  // The cat's cushion (CUSHION_W×CUSHION_H) or the dog's house (HOUSE_W×HOUSE_H).
  function homeSprite(kind) {
    if (kind === 'cat') {
      const K = HOME_COLORS.cushion;
      const G = pixelGrid(CUSHION_W, CUSHION_H);
      G.ell(11, 4, 10, 3, K.base);
      G.rect(1.5, 4, 20, 5.5, K.base);
      G.ell(11, 5.8, 10.2, 1.4, K.base);
      G.shade({ [K.base]: [K.hi, K.shade] });
      // Button tufts pulling the fabric in.
      [[11, 7], [22, 6], [33, 7]].forEach(([x, y]) => {
        G.dot(x - 1, y, K.tuft); G.dot(x, y + 1, K.tuft); G.dot(x + 1, y, K.tuft); G.dot(x, y + 2, K.hi);
      });
      G.hline(4, 11, 39, 11, K.piping);
      G.outline(K.line);
      return { px: G.g, w: CUSHION_W, h: CUSHION_H };
    }
    const K = HOME_COLORS.house;
    const G = pixelGrid(HOUSE_W, HOUSE_H);
    G.rect(2.5, 9, 19.5, 19, K.wall);
    G.rect(8, 15, 14, 19, K.door);
    G.ell(11.5, 15, 3.5, 2.6, K.door);
    G.shade({ [K.wall]: [K.wallHi, K.wallShade] });
    [26, 33].forEach((y) => { G.hline(6, y, 15, y, K.plank); G.hline(30, y, 39, y, K.plank); });
    G.tri([0.6, 10.8], [11.5, 0.8], [22.4, 10.8], K.roof);
    G.shade({ [K.roof]: [K.roofHi, K.roofShade] });
    G.hline(2, 21, 43, 21, K.trim);
    G.outline(K.line);
    return { px: G.g, w: HOUSE_W, h: HOUSE_H };
  }

  function paint(canvas, px, w) {
    const ctx = canvas.getContext('2d');
    const s = canvas.width / w;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < px.length; i++) {
      if (!px[i]) continue;
      ctx.fillStyle = px[i];
      ctx.fillRect((i % w) * s, Math.floor(i / w) * s, s, s);
    }
  }

  // queue: steps still to run, each { act, ms } | { walk: x | 'home', speed }
  // | { away: ms } | { at: x } (reappear there).
  const pet = {
    kind: 'off', raf: 0, ctx: null, last: 0, drawn: '',
    act: 'sit', step: null, stepUntil: 0, walkStart: 0, walked: 0, queue: [], facing: 1,
    x: null, home: 10, base: 10, floor: 0, nextOuting: 0, blinkAt: -1e9, heartUntil: 0,
  };

  function setPet(kind) {
    kind = kind in PET_COLORS ? kind : 'off';
    if (kind === pet.kind) return;
    pet.kind = kind;
    pet.drawn = '';
    cancelAnimationFrame(pet.raf);
    const el = document.getElementById('pet');
    const homeEl = document.getElementById('pet-home');
    el.hidden = homeEl.hidden = kind === 'off';
    if (kind === 'off') return;
    const home = homeSprite(kind);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    homeEl.width = home.w * dpr;
    homeEl.height = home.h * dpr;
    homeEl.style.width = home.w + 'px';
    homeEl.style.height = home.h + 'px';
    paint(homeEl, home.px, home.w);
    positionPet();
    pet.x = pet.home;
    pet.queue = [];
    setPetAway(false);
    pet.last = performance.now();
    pet.nextOuting = pet.last + 30000; // settle in first
    nextPetStep(pet.last);
    pet.raf = requestAnimationFrame(petFrame);
  }

  function choosePet(kind) {
    setPet(kind);
    vscode.postMessage({ type: 'setPet', pet: kind });
  }

  // The floor is just above the style bar (above the pill when that's docked
  // at the bottom; the pet walks behind it). Home is at the left edge, or
  // just right of a left-docked pill that reaches down to the floor.
  function positionPet() {
    if (pet.kind === 'off') return;
    const t = document.getElementById('tools').getBoundingClientRect();
    pet.floor = document.getElementById('stylebar').getBoundingClientRect().top - 3;
    const tallest = pet.kind === 'cat' ? PET_H + CUSHION_LIFT : HOUSE_H;
    pet.base = state.dock === 'left' && t.bottom > pet.floor - tallest - 4 ? t.right + 8 : 8;
    pet.home = pet.kind === 'cat' ? pet.base : pet.base + HOUSE_GAP;
    if (pet.x === null) pet.x = pet.home;
    const homeEl = document.getElementById('pet-home');
    const hx = pet.kind === 'cat' ? pet.base - 2 : pet.base;
    const hh = pet.kind === 'cat' ? CUSHION_H : HOUSE_H;
    homeEl.style.transform = 'translate3d(' + hx + 'px, ' + (pet.floor - hh + 2) + 'px, 0)';
    placePet();
  }

  // Moved with a transform every frame, snapped to device pixels so the pixel
  // art stays crisp. Near home the cat steps up onto its cushion.
  function placePet() {
    const dpr = window.devicePixelRatio || 1;
    const lift = pet.kind === 'cat' ? CUSHION_LIFT * Math.max(0, Math.min(1, 1 - Math.abs(pet.x - pet.home) / 16)) : 0;
    const x = Math.round(pet.x * dpr) / dpr;
    const y = Math.round((pet.floor - PET_H - lift) * dpr) / dpr;
    document.getElementById('pet').style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
  }

  function setPetAway(away) {
    document.getElementById('pet').style.visibility = away ? 'hidden' : '';
  }

  const PET_TRICKS = { cat: ['groom', 'groom', 'yawn', 'look'], dog: ['pant', 'pant', 'wag', 'look'] };
  const PET_ACT_MS = { sit: 3000, groom: 2600, pant: 3200, wag: 2000, yawn: 1300, look: 1200, sleep: 15000 };
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // A random little routine. Outings (a stroll, a change of heart halfway,
  // walking off an edge) are rare and at least a minute apart, so it doesn't
  // distract; it always comes back in through the edge it left by.
  function planPet(now) {
    const w = PET_W, W = window.innerWidth, home = pet.home;
    const span = Math.max(80, W - w - 20 - home);
    const out = (a, b) => home + rand(a, b) * span;
    const sit = (a = 4000, b = 10000) => ({ act: 'sit', ms: rand(a, b) });
    const trick = () => ({ act: pick(PET_TRICKS[pet.kind]) });
    const walk = (to) => ({ walk: to, speed: rand(30, 52) }); // px per second
    const left = -w - 12, right = W + 12;
    const plans = [
      [10, () => [sit(), trick()]],
      [2.5, () => [{ act: 'sleep', ms: rand(12000, 30000) }, { act: 'yawn' }]],
    ];
    if (!REDUCED_MOTION.matches && now >= pet.nextOuting) {
      plans.push(
        // Out to somewhere, hang about, come home.
        [0.8, () => [walk(out(0.2, 0.7)), sit(1500, 5000), Math.random() < 0.5 ? trick() : sit(800, 2000), walk('home')]],
        // Change of heart partway.
        [0.6, () => [walk(out(0.15, 0.45)), { act: 'look' }, walk('home')]],
        // All the way across and out on the right; back in from the right.
        [0.35, () => [walk(right), { away: rand(8000, 30000) }, { at: right }, walk('home')]],
        // Slips out on the left; back in from the left.
        [0.25, () => [walk(left), { away: rand(6000, 20000) }, { at: left }, walk('home')]],
      );
    }
    let roll = Math.random() * plans.reduce((n, [weight]) => n + weight, 0);
    for (const [i, [weight, plan]] of plans.entries()) {
      roll -= weight;
      if (roll >= 0) continue;
      if (i >= 2) pet.nextOuting = now + rand(60000, 150000);
      return plan();
    }
    return [sit()];
  }

  function nextPetStep(now) {
    if (!pet.queue.length) pet.queue = planPet(now);
    const s = pet.queue.shift();
    pet.step = s;
    if (s.at !== undefined) {
      pet.x = s.at;
      placePet();
      setPetAway(false);
      nextPetStep(now);
    } else if (s.walk !== undefined) {
      pet.act = 'walk';
      pet.walkStart = now;
      const to = s.walk === 'home' ? pet.home : s.walk;
      if (to !== pet.x) pet.facing = to > pet.x ? 1 : -1;
    } else if (s.away) {
      pet.act = 'away';
      pet.stepUntil = now + s.away;
      setPetAway(true);
    } else {
      pet.act = s.act;
      pet.stepUntil = now + (s.ms || PET_ACT_MS[s.act]);
      if (s.act === 'look') pet.facing = -pet.facing;
      else if (pet.x === pet.home && s.act !== 'sit') pet.facing = 1; // settles facing into the room
    }
  }

  // Runs every animation frame (paused by the browser in background tabs).
  // Walking eases in and out and the walk cycle advances with the distance
  // covered, so the feet don't slide; the sprite is only redrawn when the
  // pose changes.
  function petFrame(now) {
    pet.raf = requestAnimationFrame(petFrame);
    const dt = Math.min(100, now - pet.last);
    pet.last = now;
    if (pet.act === 'walk') {
      const to = pet.step.walk === 'home' ? pet.home : pet.step.walk;
      const dist = to - pet.x;
      const ease = Math.min(1, (now - pet.walkStart) / 350) * Math.min(1, Math.max(0.35, Math.abs(dist) / 36));
      const step = pet.step.speed * ease * dt / 1000;
      if (Math.abs(dist) <= Math.max(step, 0.3)) { pet.x = to; nextPetStep(now); }
      else { pet.x += Math.sign(dist) * step; pet.walked += step; }
      placePet();
    } else if (now >= pet.stepUntil) {
      nextPetStep(now);
    }
    if (pet.act === 'away') return;
    if (pet.act === 'sit' && now - pet.blinkAt > 2000 && Math.random() < dt / 1000 * 0.35) pet.blinkAt = now;

    const t = now / 125; // the animation clock, in 125ms beats
    const q = (v) => Math.round(v * 4) / 4; // fewer distinct tail positions to draw
    const blink = now - pet.blinkAt < 180;
    const p = { pose: 'sit', swing: q(Math.sin(t * 0.35) * 0.7), eyes: blink ? 'shut' : 'open', mouth: 'shut', heart: now < pet.heartUntil };
    if (pet.kind === 'dog') p.swing = q(Math.sin(t * 0.9) * 0.6);
    if (pet.act === 'groom') Object.assign(p, { paw: Math.floor(t / 2) % 2 === 0, headDown: true, eyes: 'shut' });
    if (pet.act === 'yawn') Object.assign(p, { mouth: 'open', eyes: 'shut' });
    if (pet.act === 'pant') Object.assign(p, { mouth: 'tongue', swing: q(Math.sin(t * 1.6)) });
    if (pet.act === 'wag') p.swing = Math.floor(t) % 2 ? 1 : -1;
    if (pet.act === 'walk') {
      const leg = Math.floor(pet.walked / 2.5) % 8;
      Object.assign(p, { pose: 'stand', leg, swing: q(Math.sin((leg / 8) * Math.PI * 2) * 0.5), mouth: pet.kind === 'dog' ? 'tongue' : 'shut' });
    }
    if (pet.act === 'sleep') Object.assign(p, { pose: 'lie', eyes: 'shut', z: Math.floor(t / 5) % 4, swing: 0 });
    // Slow breathing at rest: in for ~1.6s, out for ~1.6s (slower asleep).
    if (pet.act !== 'walk' && !REDUCED_MOTION.matches) p.breath = Math.sin(now / (pet.act === 'sleep' ? 700 : 520)) > 0.3;
    if (REDUCED_MOTION.matches) p.swing = 0;

    const key = JSON.stringify(p) + pet.facing;
    if (key === pet.drawn) return;
    pet.drawn = key;
    paint(pet.ctx.canvas, petSprite(pet.kind, p), PET_W);
    pet.ctx.canvas.style.transform = pet.facing < 0 ? 'scaleX(-1)' : '';
  }

  function attachPet() {
    const el = document.getElementById('pet');
    const cv = el.querySelector('canvas');
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    cv.width = PET_W * dpr;
    cv.height = PET_H * dpr;
    pet.ctx = cv.getContext('2d');
    // Click to pet: a hop and a heart. A napping pet wakes up instead. Now
    // and then a sitting pet takes that as a cue for a little stroll, and a
    // walking one stops to say hello before heading home.
    el.addEventListener('click', () => {
      const now = performance.now();
      if (pet.act === 'sleep') {
        pet.queue.unshift({ act: 'yawn' });
        pet.stepUntil = 0;
        return;
      }
      pet.heartUntil = now + 1200;
      const walk = (to) => ({ walk: to, speed: rand(30, 52) });
      if (pet.act === 'walk') {
        if (Math.random() < 0.4) {
          pet.queue = [{ act: 'sit', ms: rand(2500, 6000) }, walk('home')];
          nextPetStep(now);
        }
      } else if (!REDUCED_MOTION.matches && Math.random() < 0.3) {
        const W = window.innerWidth;
        const roomRight = W - PET_W - 16 - pet.x, roomLeft = pet.x - 8;
        const dir = roomRight >= roomLeft ? 1 : -1;
        const to = pet.x + dir * rand(60, Math.max(70, (dir > 0 ? roomRight : roomLeft) * 0.6));
        pet.queue = [walk(to), { act: 'sit', ms: rand(1500, 4000) }, walk('home')];
        pet.nextOuting = now + rand(60000, 150000);
        nextPetStep(now);
      } else if (pet.kind === 'dog' && pet.act === 'sit') {
        pet.queue.unshift({ act: 'wag' });
        pet.stepUntil = 0;
      }
      if (REDUCED_MOTION.matches) return;
      el.classList.remove('hop');
      void el.offsetWidth;
      el.classList.add('hop');
    });
    el.addEventListener('animationend', () => el.classList.remove('hop'));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu([
        { label: 'Cat', icon: 'paw', checked: pet.kind === 'cat', run: () => choosePet('cat') },
        { label: 'Dog', icon: 'paw', checked: pet.kind === 'dog', run: () => choosePet('dog') },
        'sep',
        { label: 'Hide pet', icon: 'hide', run: () => choosePet('off') },
      ], { x: e.clientX, y: e.clientY });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
