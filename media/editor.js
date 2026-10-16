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
  };

  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 8;

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

  function init() {
    const el = document.getElementById('canvas');
    state.canvas = new fabric.Canvas(el, {
      preserveObjectStacking: true,
      selection: false,
      isDrawingMode: true,
    });
    configureBrush();
    attachCanvasHandlers();
    attachToolbarHandlers();
    attachKeyboardHandlers();
    attachWheelZoom();
    attachToolsDrag();
    attachToolReorder();
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
      }
    });

    attachDropAndPaste();
    attachContextMenu();

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
    return pad;
  }

  // Drag the grip to move the tool pill; it snaps to the nearest edge on
  // release. Arrow keys on the focused grip do the same without a mouse.
  // Saved order from the extension. Tools missing from it (e.g. added in a
  // later version) keep their default position relative to each other, at
  // the end.
  function applyToolOrder(order) {
    const tools = document.getElementById('tools');
    const buttons = Array.from(tools.querySelectorAll('button.tool'));
    const byId = new Map(buttons.map((b) => [b.dataset.tool, b]));
    const sorted = order.map((id) => byId.get(id)).filter(Boolean);
    buttons.forEach((b) => { if (!sorted.includes(b)) sorted.push(b); });
    sorted.forEach((b) => tools.appendChild(b));
  }

  // Drag a tool button along the pill to reorder (the others shuffle as you
  // go); Alt+Arrow on a focused tool moves it one place. A plain click still
  // selects the tool.
  function attachToolReorder() {
    const tools = document.getElementById('tools');
    const toolButtons = () => Array.from(tools.querySelectorAll('button.tool'));
    const save = () => vscode.postMessage({ type: 'toolsOrder', order: toolButtons().map((b) => b.dataset.tool) });
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
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      tools.classList.remove('dragging');
      if (!moved) return;
      if (e.type === 'pointercancel') { setDock(state.dock); return; }
      const dist = { left: e.clientX, right: window.innerWidth - e.clientX, top: e.clientY, bottom: window.innerHeight - e.clientY };
      commit(DOCKS.reduce((a, b) => (dist[b] < dist[a] ? b : a)));
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
      document.body.classList.remove('empty');
    });
  }

  function loadFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => loadImage(reader.result);
    reader.readAsDataURL(file);
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

  function attachDropAndPaste() {
    const wrap = document.getElementById('canvas-wrap');
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach((ev) =>
      wrap.addEventListener(ev, (e) => { stop(e); wrap.classList.add('dragging'); })
    );
    ['dragleave', 'dragend'].forEach((ev) =>
      wrap.addEventListener(ev, (e) => { stop(e); wrap.classList.remove('dragging'); })
    );
    wrap.addEventListener('drop', (e) => {
      stop(e);
      wrap.classList.remove('dragging');
      loadFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
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
    document.querySelectorAll('button.tool').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.tool === tool ? 'true' : 'false');
    });
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
    if (kind === 'redact') return false;
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
    if (kind === 'redact') return false;
    if (o.type === 'commentBubble') {
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
          fill: 'rgba(14, 99, 156, 0.12)',
          stroke: '#0e639c', strokeWidth: 1,
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

      if (state.tool === 'rect' || state.tool === 'highlight' || state.tool === 'crop' || state.tool === 'redact') {
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
    const fontSize = commentFontSize(state.width);
    const pad = Math.round(fontSize * 0.6);
    // Point from the bottom-left like Figma, but flip near the right/top edges
    // so the bubble grows into the image instead of off it.
    const vertical = y < state.imgH * 0.25 ? 't' : 'b';
    const horizontal = x > state.imgW * 0.6 ? 'r' : 'l';
    const bubble = new fabric.CommentBubble('', {
      tail: vertical + horizontal,
      originX: horizontal === 'l' ? 'left' : 'right',
      originY: vertical === 'b' ? 'bottom' : 'top',
      left: x + (horizontal === 'l' ? pad : -pad),
      top: y + (vertical === 'b' ? -pad : pad),
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
    c.add(bubble);
    c.setActiveObject(bubble);
    bubble.enterEditing();
    // No snapshot yet: it is recorded once it has text (object:modified on
    // exit), and dismissed if it never gets any.
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
    document.querySelectorAll('button.tool').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
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
    document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      loadFile(fileInput.files[0]);
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

  const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const keyHint = (mac, other) => (IS_MAC ? mac : other);
  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
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
    return items;
  }

  function attachContextMenu() {
    const menu = document.getElementById('context-menu');
    const wrap = document.getElementById('canvas-wrap');
    const enabledItems = () => Array.from(menu.querySelectorAll('.menu-item:not(:disabled)'));
    const close = () => { menu.hidden = true; };

    const open = (items, x, y) => {
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
        b.setAttribute('role', 'menuitem');
        b.disabled = !!it.disabled;
        b.innerHTML = MENU_ICONS[it.icon] + '<span class="menu-label"></span><span class="menu-hint"></span>';
        b.querySelector('.menu-label').textContent = it.label;
        b.querySelector('.menu-hint').textContent = it.hint || '';
        b.addEventListener('click', () => { close(); it.run(); });
        menu.appendChild(b);
      });
      menu.hidden = false;
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
      const first = enabledItems()[0];
      if (first) first.focus({ preventScroll: true });
    };

    document.addEventListener('contextmenu', (e) => {
      const active = state.canvas.getActiveObject();
      if (active && active.isEditing) return; // keep the native text menu
      e.preventDefault();
      if (!state.imgW || !wrap.contains(e.target)) { close(); return; }
      const target = objectAt(e);
      // Select what was right-clicked, so it's clear what the menu acts on.
      if (target && target !== active && state.tool === 'select') {
        state.canvas.setActiveObject(target);
        state.canvas.requestRenderAll();
      }
      open(menuItemsFor(target), e.clientX, e.clientY);
    });

    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) close();
    }, true);
    // Capture phase, so Escape closes the menu instead of the editor.
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      const list = enabledItems();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown') list[(i + 1) % list.length].focus();
      else if (e.key === 'ArrowUp') list[(i - 1 + list.length) % list.length].focus();
      else if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) list[i].click(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    wrap.addEventListener('scroll', close);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
