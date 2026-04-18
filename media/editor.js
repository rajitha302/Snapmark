(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const state = {
    tool: 'pen',
    color: '#ef4444',
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
  };

  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 8;

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

    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'loadImage') {
        if (msg.dataUrl) loadImage(msg.dataUrl);
        else showEmptyState();
      } else if (msg.type === 'config') {
        if (typeof msg.maxDimension === 'number') state.maxDimension = msg.maxDimension;
      }
    });

    attachDropAndPaste();

    window.addEventListener('resize', () => {
      if (state.imgW) applyFitScale();
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
      applyFitScale();
      state.history = [state.canvas.toJSON(['data'])];
      state.redoStack = [];
      state.numberCounter = 1;
      state.zoom = 1;
      updateHistoryButtons();
      document.body.classList.add('loaded');
      document.body.classList.remove('empty');
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
          '<button id="empty-pick" class="action secondary" type="button">Choose file…</button>' +
          '<input id="empty-file" type="file" accept="image/*" hidden />' +
        '</div>';
      const fileInput = document.getElementById('empty-file');
      const pickBtn = document.getElementById('empty-pick');
      pickBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => loadImage(reader.result);
        reader.readAsDataURL(file);
      });
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
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file || !file.type || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => loadImage(reader.result);
      reader.readAsDataURL(file);
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
          const reader = new FileReader();
          reader.onload = () => loadImage(reader.result);
          reader.readAsDataURL(file);
          return;
        }
      }
    });
  }

  function applyFitScale() {
    const wrap = document.getElementById('canvas-wrap');
    const maxW = wrap.clientWidth - 48;
    const maxH = wrap.clientHeight - 48;
    const fit = Math.min(1, maxW / state.imgW, maxH / state.imgH);
    state.scale = fit;
    const effective = fit * state.zoom;
    state.canvas.setDimensions(
      { width: state.imgW * effective + 'px', height: state.imgH * effective + 'px' },
      { cssOnly: true }
    );
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

  function setTool(tool) {
    if (state.pendingCrop && tool !== 'crop') cancelCrop();
    state.tool = tool;
    const c = state.canvas;
    c.isDrawingMode = tool === 'pen';
    c.selection = tool === 'select';
    c.discardActiveObject();
    c.forEachObject((o) => {
      o.selectable = tool === 'select';
      o.evented = tool === 'select';
    });
    c.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    c.requestRenderAll();
    document.querySelectorAll('button.tool').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.tool === tool ? 'true' : 'false');
    });
  }

  function setColor(color) {
    state.color = color;
    state.canvas.freeDrawingBrush.color = color;
    document.querySelectorAll('button.swatch').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.color === color ? 'true' : 'false');
    });
  }

  function setWidth(width) {
    state.width = width;
    state.canvas.freeDrawingBrush.width = width;
    document.querySelectorAll('button.width').forEach((btn) => {
      btn.setAttribute('aria-pressed', parseInt(btn.dataset.width, 10) === width ? 'true' : 'false');
    });
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

    c.on('mouse:down', (opt) => {
      if (c.isDrawingMode || state.tool === 'select') return;
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
      } else if (state.tool === 'arrow') {
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
      } else if (state.tool === 'text') {
        state.isDrawing = false;
        const text = new fabric.IText('Text', {
          left: p.x, top: p.y,
          fill: state.color, fontSize: 28, fontFamily: 'sans-serif', stroke: null,
          editable: true,
        });
        c.add(text);
        setTool('select');
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
      } else if (state.tool === 'arrow') {
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
        if (s.width < 8 || s.height < 8) {
          c.remove(s); state.currentShape = null; return;
        }
        s.set({ left: Math.max(0, s.left), top: Math.max(0, s.top) });
        s.set({
          width: Math.min(s.width, state.imgW - s.left),
          height: Math.min(s.height, state.imgH - s.top),
        });
        state.pendingCrop = s;
        state.currentShape = null;
        c.requestRenderAll();
        showCropActions();
        return;
      } else if (state.tool === 'redact') {
        const left = Math.max(0, Math.round(s.left));
        const top = Math.max(0, Math.round(s.top));
        const width = Math.round(Math.min(s.width, state.imgW - left));
        const height = Math.round(Math.min(s.height, state.imgH - top));
        c.remove(s);
        state.currentShape = null;
        if (width < 6 || height < 6) return;
        applyRedaction(left, top, width, height);
        return;
      } else if (state.tool === 'ellipse') {
        if (s.rx < 2 || s.ry < 2) {
          c.remove(s); state.currentShape = null; return;
        }
      } else if (state.tool === 'arrow') {
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        if (Math.hypot(dx, dy) < 6) {
          c.remove(s); state.currentShape = null; return;
        }
        const path = new fabric.Path(arrowPath(s.x1, s.y1, s.x2, s.y2, state.width), {
          stroke: state.color, strokeWidth: state.width, fill: null,
          strokeLineCap: 'round', strokeLineJoin: 'round',
          selectable: false, evented: false,
        });
        c.remove(s);
        c.add(path);
        state.currentShape = path;
      }
      snapshot();
      state.currentShape = null;
    });

    c.on('object:modified', () => snapshot());
  }

  function arrowPath(x1, y1, x2, y2, width) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(14, width * 4);
    const headAngle = Math.PI / 7;
    const hx1 = x2 - headLen * Math.cos(angle - headAngle);
    const hy1 = y2 - headLen * Math.sin(angle - headAngle);
    const hx2 = x2 - headLen * Math.cos(angle + headAngle);
    const hy2 = y2 - headLen * Math.sin(angle + headAngle);
    return 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2 +
           ' M ' + hx1 + ' ' + hy1 + ' L ' + x2 + ' ' + y2 + ' L ' + hx2 + ' ' + hy2;
  }

  function snapshot() {
    if (state.suppressSnapshot) return;
    state.history.push(state.canvas.toJSON(['data']));
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
    state.canvas.loadFromJSON(json, () => {
      state.canvas.forEachObject((o) => {
        o.selectable = state.tool === 'select';
        o.evented = state.tool === 'select';
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
        state.history = [c.toJSON(['data'])];
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

  function applyRedaction(left, top, width, height) {
    const c = state.canvas;
    const bgEl = c.backgroundImage && c.backgroundImage.getElement();
    if (!bgEl) return;

    const blockSize = Math.max(6, Math.round(Math.min(width, height) / 20));
    const smallW = Math.max(1, Math.round(width / blockSize));
    const smallH = Math.max(1, Math.round(height / blockSize));

    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bgEl, left, top, width, height, 0, 0, smallW, smallH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, smallW, smallH, 0, 0, width, height);

    fabric.Image.fromURL(tmp.toDataURL('image/png'), (img) => {
      img.set({
        left, top,
        selectable: state.tool === 'select',
        evented: state.tool === 'select',
        data: { kind: 'redact' },
      });
      c.add(img);
      c.requestRenderAll();
      snapshot();
    });
  }

  function placeNumberMarker(x, y) {
    const c = state.canvas;
    const radius = 14 + state.width * 2;
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
      fill: '#ffffff',
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

  function reseedNumberCounter() {
    let max = 0;
    state.canvas.getObjects().forEach((o) => {
      const v = o && o.data && o.data.kind === 'step' ? o.data.value : 0;
      if (typeof v === 'number' && v > max) max = v;
    });
    state.numberCounter = max + 1;
  }

  function done() {
    const c = state.canvas;
    cancelCrop();
    c.discardActiveObject();
    c.requestRenderAll();
    const longEdge = Math.max(state.imgW, state.imgH);
    const multiplier = state.maxDimension > 0 && longEdge > state.maxDimension
      ? state.maxDimension / longEdge
      : 1;
    const dataUrl = c.toDataURL({ format: 'png', multiplier });
    vscode.postMessage({ type: 'done', dataUrl });
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
    document.getElementById('btn-done').addEventListener('click', done);
    document.getElementById('btn-cancel').addEventListener('click', cancel);
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
      else if (k === 'r' || k === 'R') setTool('rect');
      else if (k === 't' || k === 'T') setTool('text');
      else if (k === 'c' || k === 'C') setTool('crop');
      else if (k === 'b' || k === 'B') setTool('redact');
      else if (k === 'n' || k === 'N') setTool('number');
      else if ((k === 'Delete' || k === 'Backspace') && state.tool === 'select') {
        const obj = state.canvas.getActiveObject();
        if (!obj) return;
        if (obj.type === 'activeSelection') {
          obj.forEachObject((o) => state.canvas.remove(o));
          state.canvas.discardActiveObject();
        } else {
          state.canvas.remove(obj);
        }
        snapshot();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
