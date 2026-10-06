(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const ui = {
    cam: el("cam"),
    stage: el("stage"),
    overlay: el("overlay"),
    count: el("pageCount"),
    hint: el("liveHint"),
    shutter: el("btnShutter"),
    torch: el("btnTorch"),
    btnPages: el("btnPages"),
    lastPreview: el("lastPreview"),
    pagesBadge: el("pagesBadge"),
    review: el("reviewScreen"),
    reviewStage: el("reviewStage"),
    reviewCanvas: el("reviewCanvas"),
    handles: Array.from(document.querySelectorAll(".handle")),
    loupe: el("loupe"),
    strip: el("filterStrip"),
    pagesSheet: el("pagesSheet"),
    grid: el("pageGrid"),
    busy: el("busy"),
    busyBar: el("busyBar"),
    busyText: el("busyText"),
    toast: el("toast"),
    importBtn: el("btnImport"),
    importBig: el("btnImportBig"),
    fileInput: el("fileInput"),
    noCam: el("noCam"),
    noCamText: el("noCamText"),
    docName: el("docName"),
    newDoc: el("btnNewDoc"),
    textSheet: el("textSheet"),
    textOut: el("textOut"),
    textNote: el("textNote")
  };

  const state = {
    pages: [],
    stream: null,
    track: null,
    torchOn: false,
    zoom: 1,
    panX: 0,
    panY: 0,
    det: { quad: null, hist: [], locked: false, sharpMax: 20 },
    work: null,
    lastDetect: 0,
    editing: null,
    preview: null,
    view: null,
    raf: 0,
    gestures: new Map(),
    pinchStart: 0,
    drag: null,
    tesseract: null,
    hintShown: false,
    importQueue: [],
    docName: "",
    persistWarned: false
  };

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), ms);
  }

  function busy(text, ratio) {
    ui.busy.hidden = false;
    ui.busyText.textContent = text || "Wird verarbeitet";
    if (ratio == null) {
      ui.busyBar.classList.add("is-indeterminate");
      ui.busyBar.firstElementChild.style.width = "35%";
    } else {
      ui.busyBar.classList.remove("is-indeterminate");
      ui.busyBar.firstElementChild.style.width = Math.round(clamp(ratio, 0, 1) * 100) + "%";
    }
  }

  const busyHide = () => (ui.busy.hidden = true);

  const boxCache = new WeakMap();

  const clampBox = (rgba, w, h) => {
    const hit = boxCache.get(rgba);
    if (hit && hit.w === w && hit.h === h) return hit.canvas;
    const o = document.createElement("canvas");
    o.width = w;
    o.height = h;
    const ctx = o.getContext("2d");
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    boxCache.set(rgba, { w, h, canvas: o });
    return o;
  };

  const loadImage = (src) =>
    new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("Bild nicht lesbar"));
      i.src = src;
    });

  const DB_NAME = "dokumentenscanner";
  let dbPromise = null;
  let saveTimer = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      if (!("indexedDB" in window)) return rej(new Error("kein Speicher"));
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbPromise;
  }

  function storedPage(p, order) {
    return {
      id: p.id, src: p.src, w: p.w, h: p.h, filter: p.filter, thumb: p.thumb,
      text: p.text == null ? null : p.text, words: p.words || null,
      ocrW: p.ocrW || 0, ocrH: p.ocrH || 0, order
    };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeAll, 250);
  }

  async function writeAll() {
    try {
      const db = await openDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(["pages", "meta"], "readwrite");
        const store = tx.objectStore("pages");
        store.clear();
        state.pages.forEach((p, i) => store.put(storedPage(p, i)));
        tx.objectStore("meta").put(state.docName, "docName");
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    } catch (e) {
      if (!state.persistWarned) {
        state.persistWarned = true;
        toast("Speichern auf dem Gerät nicht möglich. Seiten bleiben nur bis zum Schließen.", 5000);
      }
    }
  }

  async function restore() {
    try {
      const db = await openDb();
      const [pages, name] = await new Promise((res, rej) => {
        const tx = db.transaction(["pages", "meta"], "readonly");
        const a = tx.objectStore("pages").getAll();
        const b = tx.objectStore("meta").get("docName");
        tx.oncomplete = () => res([a.result || [], b.result]);
        tx.onerror = () => rej(tx.error);
      });
      pages.sort((x, y) => x.order - y.order);
      const restored = pages.map((p) => {
        const copy = Object.assign({}, p);
        delete copy.order;
        return copy;
      });
      state.pages = restored.concat(state.pages);
      if (typeof name === "string" && name.trim()) state.docName = name;
    } catch (e) {}
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function defaultDocName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `Scan ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  function fileBase() {
    const raw = String(state.docName || "").trim() || defaultDocName();
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "scan";
  }

  const indexOfPage = (page) => state.pages.findIndex((p) => p.id === page.id);

  const toDataUrl = (rgba, w, h, q) => clampBox(rgba, w, h).toDataURL("image/jpeg", q == null ? 0.92 : q);

  const insetQuad = (w, h, m) => [
    w * m, h * m, w * (1 - m), h * m, w * (1 - m), h * (1 - m), w * m, h * (1 - m)
  ];

  function detectFromRGBA(rgba, w, h, workWidth) {
    const src = clampBox(rgba, w, h);
    const sw = Math.min(workWidth || 420, w);
    const sh = Math.max(1, Math.round((h / w) * sw));
    const c = document.createElement("canvas");
    c.width = sw;
    c.height = sh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, sw, sh);
    const d = ctx.getImageData(0, 0, sw, sh);
    const g = Vision.luma(d.data, sw, sh);
    const q = Vision.detectQuad(g, sw, sh);
    if (!q) return null;
    const kx = w / sw, ky = h / sh;
    const out = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      out[i * 2] = q[i * 2] * kx;
      out[i * 2 + 1] = q[i * 2 + 1] * ky;
    }
    return Vision.refineQuad(rgba, w, h, out, Math.round(3 * Math.max(kx, ky) + 2));
  }

  function coverMap(vw, vh, sw, sh) {
    const va = vw / vh, sa = sw / sh;
    if (va > sa) {
      const s = sh / vh;
      return { s, ox: (sw - vw * s) / 2, oy: 0 };
    }
    const s = sw / vw;
    return { s, ox: 0, oy: (sh - vh * s) / 2 };
  }

  function applyStageTransform() {
    ui.stage.style.transform = `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`;
  }

  function showNoCamera(reason) {
    ui.noCamText.textContent = reason;
    ui.noCam.hidden = false;
  }

  async function startCamera() {
    if (state.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showNoCamera(window.isSecureContext
        ? "Dieser Browser gibt keine Kamera frei. Fotos oder Bilder kannst du trotzdem importieren."
        : "Die Kamera geht nur über HTTPS oder localhost. Fotos oder Bilder kannst du trotzdem importieren.");
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 2560 },
          height: { ideal: 1440 }
        },
        audio: false
      });
      state.track = state.stream.getVideoTracks()[0];
      ui.cam.srcObject = state.stream;
      await ui.cam.play();
      try {
        const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
        if (caps.torch) ui.torch.hidden = false;
      } catch (e) {}
      ui.noCam.hidden = true;
      state.lastDetect = 0;
      loop();
    } catch (e) {
      state.stream = null;
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      showNoCamera(denied
        ? "Der Kamerazugriff wurde nicht erlaubt. Fotos oder Bilder kannst du trotzdem importieren."
        : "Keine Kamera gefunden. Fotos oder Bilder vom Gerät importieren und wie einen Scan bearbeiten.");
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
      state.track = null;
    }
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function loop() {
    state.raf = requestAnimationFrame(loop);
    const v = ui.cam;
    if (!v.videoWidth) return;
    const now = performance.now();
    if (now - state.lastDetect > 110 && !state.editing) {
      state.lastDetect = now;
      runDetection();
    }
    drawOverlay();
  }

  function runDetection() {
    const v = ui.cam;
    const w = 360;
    const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
    if (!state.work) {
      state.work = document.createElement("canvas");
      state.work.width = w;
      state.work.height = h;
    }
    if (state.work.height !== h) {
      state.work.height = h;
    }
    const ctx = state.work.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const g = Vision.luma(d.data, w, h);
    const q = Vision.detectQuad(g, w, h);
    const det = state.det;
    det.sharpMax = Math.max(20, det.sharpMax * 0.98, Vision.varianceOfLaplacian(g, w, h, q));
    if (!q) {
      det.quad = null;
      det.hist.length = 0;
      det.locked = false;
      return;
    }
    det.quad = q;
    det.hist.push(q);
    if (det.hist.length > 8) det.hist.shift();
    const dev = Vision.deviation(det.hist);
    const still = det.hist.length >= 5 && dev.avg < 2.2 && dev.max < 6;
    const sharp = Vision.varianceOfLaplacian(g, w, h, q) > Math.max(80, det.sharpMax * 0.12);
    det.locked = still && sharp;
  }

  function quadToScreen(q) {
    const stageW = ui.stage.clientWidth;
    const stageH = ui.stage.clientHeight;
    const m = coverMap(ui.cam.videoWidth, ui.cam.videoHeight, stageW, stageH);
    const kx = (ui.cam.videoWidth / state.work.width) * m.s;
    const ky = (ui.cam.videoHeight / state.work.height) * m.s;
    const out = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      out[i * 2] = q[i * 2] * kx + m.ox;
      out[i * 2 + 1] = q[i * 2 + 1] * ky + m.oy;
    }
    return out;
  }

  function drawOverlay() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const sw = ui.stage.clientWidth;
    const sh = ui.stage.clientHeight;
    if (!sw || !sh) return;
    const cv = ui.overlay;
    if (cv.width !== Math.round(sw * dpr) || cv.height !== Math.round(sh * dpr)) {
      cv.width = Math.round(sw * dpr);
      cv.height = Math.round(sh * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sw, sh);

    const q = state.det.quad;
    const locked = state.det.locked;
    if (q) {
      const s = quadToScreen(q);
      const strength = locked ? 1 : 0.35;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const grid = 7;
      for (let i = 1; i < grid; i++) {
        const t = i / grid;
        ctx.beginPath();
        for (let e = 0; e < 4; e++) {
          const a = e * 2, b = ((e + 1) % 4) * 2;
          const px = s[a] + (s[b] - s[a]) * t;
          const py = s[a + 1] + (s[b + 1] - s[a + 1]) * t;
          const nx = s[b] + (s[a] - s[b]) * t;
          const ny = s[b + 1] + (s[a + 1] - s[b + 1]) * t;
          ctx.moveTo(px, py);
          ctx.lineTo(nx, ny);
        }
        ctx.strokeStyle = `rgba(47,224,138,${0.1 * strength + 0.05})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(s[0], s[1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(s[i * 2], s[i * 2 + 1]);
      ctx.closePath();
      ctx.shadowColor = locked ? "rgba(47,224,138,0.95)" : "rgba(47,224,138,0.28)";
      ctx.shadowBlur = locked ? 26 : 8;
      ctx.strokeStyle = locked ? "rgba(70,255,170,0.98)" : "rgba(47,224,138,0.55)";
      ctx.lineWidth = locked ? 3.5 : 2;
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (locked) {
        ctx.strokeStyle = "rgba(47,224,138,0.22)";
        ctx.lineWidth = 10;
        ctx.stroke();
        ctx.strokeStyle = "rgba(120,255,200,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1.5;
      const cx = sw / 2, cy = sh / 2, w = sw * 0.62, h = sh * 0.7;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    }

    if (!state.hintShown && state.pages.length === 0) ui.hint.hidden = locked || !q;
    else ui.hint.hidden = true;
  }

  ui.torch.addEventListener("click", async () => {
    if (!state.track) return;
    try {
      state.torchOn = !state.torchOn;
      await state.track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
      ui.torch.classList.toggle("accent", state.torchOn);
    } catch (e) {
      state.torchOn = false;
      toast("Licht nicht steuerbar");
    }
  });

  ui.stage.addEventListener("pointerdown", (e) => {
    ui.stage.setPointerCapture(e.pointerId);
    state.gestures.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.gestures.size === 2) {
      const p = [...state.gestures.values()];
      state.pinchStart = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      state.pinchZoom = state.zoom;
    }
  });

  ui.stage.addEventListener("pointermove", (e) => {
    const g = state.gestures.get(e.pointerId);
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.x = e.clientX;
    g.y = e.clientY;
    if (state.gestures.size === 2) {
      const p = [...state.gestures.values()];
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      state.zoom = clamp((state.pinchZoom || 1) * (d / (state.pinchStart || d)), 1, 4);
      applyStageTransform();
    } else if (state.zoom > 1.001) {
      state.panX += dx;
      state.panY += dy;
      applyStageTransform();
    }
  });

  const endGesture = (e) => {
    state.gestures.delete(e.pointerId);
    if (state.gestures.size < 2) state.pinchStart = 0;
  };
  ui.stage.addEventListener("pointerup", endGesture);
  ui.stage.addEventListener("pointercancel", endGesture);

  ui.stage.addEventListener("dblclick", () => {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    applyStageTransform();
  });

  ui.shutter.addEventListener("click", () => capture());

  function setScreen(name) {
    el("cameraScreen").classList.toggle("is-active", name === "camera");
    ui.review.classList.toggle("is-active", name === "review");
  }

  async function capture() {
    const v = ui.cam;
    if (!v.videoWidth) return;
    const max = 3000;
    const k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * k);
    const h = Math.round(v.videoHeight * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const found = detectFromRGBA(d.data, w, h, 420);
    setScreen("review");
    openReview({ rgba: d.data, w, h }, found || insetQuad(w, h, 0.06), null, !!found);
  }

  function rectify(quad, maxDim) {
    const size = Vision.outputSize(quad, maxDim);
    const rgba = Vision.warp(state.editing.base.rgba, state.editing.base.w, state.editing.base.h, quad, size.w, size.h);
    if (!rgba) return null;
    return { rgba, w: size.w, h: size.h };
  }

  function rectOf(view) {
    return [0, 0, view.w, 0, view.w, view.h, 0, view.h];
  }

  function openReview(base, quad, pageId, trim) {
    state.editing = { base, quad: Float32Array.from(quad), pageId, filter: "original", trim: !!trim };
    if (pageId != null) {
      const p = state.pages.find((x) => x.id === pageId);
      if (p) state.editing.filter = p.filter;
    }
    state.drag = null;
    ui.loupe.hidden = true;
    setScreen("review");
    rebuild();
  }

  function rebuild() {
    const e = state.editing;
    const view = rectify(e.quad, 1100);
    state.view = view;
    state.preview = { base: view, map: null, quad: Float32Array.from(e.quad) };
    renderFilterStrip();
    layout();
  }

  function layout() {
    const e = state.editing;
    const view = state.view;
    if (!view) return;
    const rect = ui.reviewStage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = ui.reviewCanvas;
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, rect.width, rect.height);

    const s = Math.min(rect.width / view.w, rect.height / view.h);
    const dw = view.w * s;
    const dh = view.h * s;
    const dx = (rect.width - dw) / 2;
    const dy = (rect.height - dh) / 2;
    state.preview.map = { s, dx, dy };

    const filtered = applyPreviewFilter(view, e.filter);
    const src = clampBox(filtered.rgba, filtered.w, filtered.h);
    ctx.drawImage(src, dx, dy, dw, dh);

    ctx.strokeStyle = "rgba(47,224,138,0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    positionHandles();
  }

  function baseToRect(q) {
    const view = state.preview.base;
    const H = Vision.homography(rectOf(view), state.preview.quad);
    if (!H) return null;
    return Vision.invert3(H);
  }

  function rectToBase(p) {
    const view = state.preview.base;
    const H = Vision.homography(rectOf(view), state.preview.quad);
    if (!H) return null;
    return Vision.applyH(H, p[0], p[1]);
  }

  function handlePoints() {
    const e = state.editing;
    const b2r = baseToRect();
    if (!b2r) return null;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const p = Vision.applyH(b2r, e.quad[i * 2], e.quad[i * 2 + 1]);
      pts.push(p);
    }
    return pts;
  }

  function positionHandles() {
    const pts = handlePoints();
    const map = state.preview.map;
    ui.handles.forEach((h, i) => {
      if (!pts) { h.hidden = true; return; }
      const p = pts[i];
      const x = map.dx + p[0] * map.s;
      const y = map.dy + p[1] * map.s;
      h.hidden = false;
      h.style.left = x + "px";
      h.style.top = y + "px";
    });
  }

  function overlayQuadInDisplay() {
    const pts = handlePoints();
    if (!pts) return null;
    const map = state.preview.map;
    return pts.map((p) => [map.dx + p[0] * map.s, map.dy + p[1] * map.s]);
  }

  function drawCropOutline() {
    const view = state.view;
    const rect = ui.reviewStage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = ui.reviewCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const filtered = applyPreviewFilter(view, state.editing.filter);
    const src = clampBox(filtered.rgba, filtered.w, filtered.h);
    const map = state.preview.map;
    ctx.drawImage(src, map.dx, map.dy, view.w * map.s, view.h * map.s);
    const pts = overlayQuadInDisplay();
    if (!pts) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.strokeStyle = "rgba(47,224,138,0.95)";
    ctx.shadowColor = "rgba(47,224,138,0.8)";
    ctx.shadowBlur = 12;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  let filterCache = { view: null, out: {} };

  function applyPreviewFilter(view, id) {
    if (filterCache.view !== view) filterCache = { view, out: {} };
    const hit = filterCache.out[id];
    if (hit) return hit;
    const max = 900;
    const k = Math.min(1, max / Math.max(view.w, view.h));
    const w = Math.max(1, Math.round(view.w * k));
    const h = Math.max(1, Math.round(view.h * k));
    const small = clampBox(view.rgba, view.w, view.h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(small, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const out = { rgba: Vision.applyFilter(d.data, w, h, id, {}), w, h };
    filterCache.out[id] = out;
    return out;
  }

  function renderFilterStrip() {
    ui.strip.innerHTML = "";
    const view = state.view;
    for (const f of Vision.FILTERS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "filter" + (state.editing.filter === f.id ? " is-active" : "");
      b.dataset.id = f.id;
      const c = document.createElement("canvas");
      const cw = 52, ch = 72;
      c.width = cw * 2;
      c.height = ch * 2;
      const k = Math.max(cw / view.w, ch / view.h);
      const dw = view.w * k;
      const dh = view.h * k;
      const filtered = applyPreviewFilter(view, f.id);
      const src = clampBox(filtered.rgba, filtered.w, filtered.h);
      c.getContext("2d").drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      b.appendChild(c);
      b.appendChild(document.createTextNode(f.label));
      b.title = f.hint || f.label;
      b.addEventListener("click", () => {
        state.editing.filter = f.id;
        renderFilterStrip();
        layout();
      });
      ui.strip.appendChild(b);
    }
  }

  let dragHandle = null;

  ui.handles.forEach((h) => {
    h.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      h.setPointerCapture(ev.pointerId);
      dragHandle = { i: +h.dataset.i, node: h, pid: ev.pointerId };
      h.classList.add("is-active");
      showLoupe();
    });
    h.addEventListener("pointermove", (ev) => {
      if (!dragHandle || dragHandle.pid !== ev.pointerId) return;
      const rect = ui.reviewStage.getBoundingClientRect();
      const map = state.preview.map;
      const rp = [(ev.clientX - rect.left - map.dx) / map.s, (ev.clientY - rect.top - map.dy) / map.s];
      const bp = rectToBase(rp);
      if (!bp) return;
      const q = state.editing.quad;
      q[dragHandle.i * 2] = clamp(bp[0], -0.02 * state.editing.base.w, 1.02 * state.editing.base.w);
      q[dragHandle.i * 2 + 1] = clamp(bp[1], -0.02 * state.editing.base.h, 1.02 * state.editing.base.h);
      positionHandles();
      drawCropOutline();
      showLoupe();
    });
    const finish = (ev) => {
      if (!dragHandle || dragHandle.pid !== ev.pointerId) return;
      dragHandle.node.classList.remove("is-active");
      ui.loupe.hidden = true;
      dragHandle = null;
      rebuild();
    };
    h.addEventListener("pointerup", finish);
    h.addEventListener("pointercancel", finish);
  });

  function showLoupe() {
    if (!dragHandle) return;
    const e = state.editing;
    const i = dragHandle.i;
    const cx = e.quad[i * 2];
    const cy = e.quad[i * 2 + 1];
    const src = clampBox(e.base.rgba, e.base.w, e.base.h);
    const size = 128;
    const scale = 3;
    const half = size / 2 / scale;
    const c = ui.loupe;
    if (!c.width) {
      c.width = size * 2;
      c.height = size * 2;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, cx - half, cy - half, half * 2, half * 2, 0, 0, size * 2, size * 2);
    ctx.strokeStyle = "rgba(47,224,138,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(size - 8, size);
    ctx.lineTo(size, size - 8);
    ctx.moveTo(size - 22, size);
    ctx.lineTo(size, size - 22);
    ctx.stroke();

    const rect = ui.reviewStage.getBoundingClientRect();
    const node = dragHandle.node;
    const lx = clamp(parseFloat(node.style.left) - size / 2, 8, rect.width - size - 8);
    const ly = clamp(parseFloat(node.style.top) - size / 2 - 26, 8, rect.height - size - 8);
    c.style.left = lx + "px";
    c.style.top = ly + "px";
    c.hidden = false;
  }

  el("btnAuto").addEventListener("click", () => {
    const b = state.editing.base;
    const q = detectFromRGBA(b.rgba, b.w, b.h, 460);
    state.editing.quad = Float32Array.from(q || insetQuad(b.w, b.h, 0.06));
    state.editing.trim = !!q;
    rebuild();
    toast(q ? "Kanten neu erkannt" : "Keine Kanten gefunden, bitte Ecken ziehen");
  });

  el("btnRotate").addEventListener("click", () => {
    const b = state.editing.base;
    state.editing.quad = Vision.rotateQuad(state.editing.quad, 90, b.w, b.h);
    rebuild();
  });

  async function afterReview() {
    if (state.importQueue.length && (await openNextImport())) return;
    setScreen("camera");
    startCamera();
  }

  el("btnReviewBack").addEventListener("click", () => {
    state.editing = null;
    state.view = null;
    state.preview = null;
    ui.loupe.hidden = true;
    afterReview();
  });

  el("btnAccept").addEventListener("click", async () => {
    const e = state.editing;
    if (!e) return;
    busy("Seite wird übernommen", 0.3);
    const quad = e.trim ? Vision.shrinkQuad(e.quad, 0.008) : e.quad;
    const size = Vision.outputSize(quad, 2400);
    const rgba = Vision.warp(e.base.rgba, e.base.w, e.base.h, quad, size.w, size.h);
    busyHide();
    if (!rgba) { toast("Zuschneiden fehlgeschlagen"); return; }
    const out = Vision.applyFilter(rgba, size.w, size.h, e.filter, {});
    const src = toDataUrl(out, size.w, size.h, 0.92);
    const thumb = await makeThumb(src);
    if (e.pageId != null) {
      const p = state.pages.find((x) => x.id === e.pageId);
      if (p) {
        p.src = src;
        p.w = size.w;
        p.h = size.h;
        p.filter = e.filter;
        p.thumb = thumb;
        p.text = null;
        p.words = null;
      }
    } else {
      state.pages.push({
        id: Date.now() + Math.random().toString(36).slice(2, 6),
        src,
        w: size.w,
        h: size.h,
        filter: e.filter,
        thumb,
        text: null
      });
    }
    state.hintShown = true;
    ui.hint.hidden = true;
    state.editing = null;
    state.view = null;
    state.preview = null;
    renderCounts();
    persist();
    afterReview();
  });

  function makeThumb(src) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const k = 300 / Math.max(img.width, img.height);
        const w = Math.max(1, Math.round(img.width * k));
        const h = Math.max(1, Math.round(img.height * k));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        res(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => res(src);
      img.src = src;
    });
  }

  function renderCounts() {
    const n = state.pages.length;
    ui.count.textContent = n === 1 ? "1 Seite" : n + " Seiten";
    ui.pagesBadge.hidden = n === 0;
    ui.pagesBadge.textContent = String(n);
    if (n) {
      ui.lastPreview.src = state.pages[n - 1].thumb || state.pages[n - 1].src;
    } else {
      ui.lastPreview.removeAttribute("src");
    }
  }

  function updateSheetButtons() {
    const empty = !state.pages.length;
    ["btnMakePdf", "btnSharePdf", "btnPrint", "btnOcr"].forEach((id) => (el(id).disabled = empty));
  }

  function openSheet() {
    renderGrid();
    ui.docName.value = state.docName || defaultDocName();
    ui.pagesSheet.hidden = false;
    updateSheetButtons();
  }

  ui.docName.addEventListener("input", () => {
    state.docName = ui.docName.value;
    persist();
  });

  let newDocArmed = 0;
  let newDocTimer = null;
  const resetNewDocButton = () => {
    newDocArmed = 0;
    ui.newDoc.textContent = "Neu";
    ui.newDoc.classList.remove("danger");
  };

  ui.newDoc.addEventListener("click", () => {
    if (state.pages.length && Date.now() - newDocArmed > 3000) {
      newDocArmed = Date.now();
      ui.newDoc.textContent = "Alle Seiten löschen?";
      ui.newDoc.classList.add("danger");
      clearTimeout(newDocTimer);
      newDocTimer = setTimeout(resetNewDocButton, 3000);
      return;
    }
    clearTimeout(newDocTimer);
    resetNewDocButton();
    state.pages = [];
    state.docName = defaultDocName();
    ui.docName.value = state.docName;
    renderGrid();
    renderCounts();
    updateSheetButtons();
    persist();
    toast("Neues Dokument");
  });

  const closeSheet = () => (ui.pagesSheet.hidden = true);

  ui.btnPages.addEventListener("click", openSheet);
  el("btnSheetClose").addEventListener("click", closeSheet);
  ui.pagesSheet.addEventListener("click", (e) => {
    if (e.target === ui.pagesSheet) closeSheet();
  });

  function updateIndices() {
    [...ui.grid.children].forEach((cell, i) => {
      if (!cell.dataset || cell.dataset.i == null) return;
      cell.dataset.i = String(i);
      const num = cell.querySelector(".cell-num");
      if (num) num.textContent = String(i + 1);
    });
  }

  function renderGrid() {
    ui.grid.innerHTML = "";
    if (!state.pages.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Noch keine Seiten";
      ui.grid.appendChild(p);
      return;
    }
    state.pages.forEach((page, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.i = String(i);
      const img = document.createElement("img");
      img.src = page.thumb || page.src;
      img.alt = "Seite " + (i + 1);
      const num = document.createElement("span");
      num.className = "cell-num";
      num.textContent = String(i + 1);
      const del = document.createElement("button");
      del.className = "cell-btn del";
      del.type = "button";
      del.textContent = "✕";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const k = indexOfPage(page);
        if (k < 0) return;
        state.pages.splice(k, 1);
        renderGrid();
        renderCounts();
        updateSheetButtons();
        persist();
      });
      const rot = document.createElement("button");
      rot.className = "cell-btn rot";
      rot.type = "button";
      rot.textContent = "↻";
      rot.title = "Seite drehen";
      rot.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await rotatePage(page);
      });
      const one = document.createElement("button");
      one.className = "cell-btn img";
      one.type = "button";
      one.textContent = "↓";
      one.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await savePageImage(page);
      });
      cell.appendChild(img);
      cell.appendChild(num);
      cell.appendChild(del);
      cell.appendChild(rot);
      cell.appendChild(one);
      ui.grid.appendChild(cell);
    });
  }

  ui.grid.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell || e.target.closest(".cell-btn")) return;
    cell.setPointerCapture(e.pointerId);
    state.drag = { i: +cell.dataset.i, cell, x: e.clientX, y: e.clientY, on: false, pid: e.pointerId };
  });

  ui.grid.addEventListener("pointermove", (e) => {
    const d = state.drag;
    if (!d || d.pid !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.on) {
      if (Math.hypot(dx, dy) < 12) return;
      d.on = true;
      d.cell.classList.add("is-dragging");
      return;
    }
    d.cell.style.transform = `translate(${dx}px, ${dy}px)`;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest ? over.closest(".cell") : null;
    if (!target || target === d.cell) return;
    const to = +target.dataset.i;
    const from = d.i;
    if (Number.isNaN(to) || to === from) return;
    const before = d.cell.getBoundingClientRect();
    const moved = state.pages.splice(from, 1)[0];
    state.pages.splice(to, 0, moved);
    const after = d.cell.getBoundingClientRect();
    if (from < to) target.after(d.cell);
    else target.before(d.cell);
    updateIndices();
    d.i = to;
    d.x += after.left - before.left;
    d.y += after.top - before.top;
  });

  const endDrag = (e) => {
    const d = state.drag;
    if (!d || d.pid !== e.pointerId) return;
    d.cell.classList.remove("is-dragging");
    d.cell.style.transform = "";
    const moved = d.on;
    state.drag = null;
    if (moved) {
      state.suppressClick = true;
      setTimeout(() => (state.suppressClick = false), 50);
      renderGrid();
      renderCounts();
      persist();
    }
  };
  ui.grid.addEventListener("pointerup", endDrag);
  ui.grid.addEventListener("pointercancel", endDrag);

  ui.grid.addEventListener("click", (e) => {
    if (state.suppressClick) return;
    const cell = e.target.closest(".cell");
    if (!cell || e.target.closest(".cell-btn")) return;
    editPage(state.pages[+cell.dataset.i]);
  });

  async function editPage(page) {
    if (!page) return;
    closeSheet();
    busy("Seite wird geladen", 0.2);
    try {
      const img = await loadImage(page.src);
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      busyHide();
      stopCamera();
      openReview({ rgba: d.data, w: c.width, h: c.height }, insetQuad(c.width, c.height, 0), page.id, false);
    } catch (e) {
      busyHide();
      toast("Seite nicht lesbar");
    }
  }

  async function pageDataUrl(page, maxDim) {
    const img = await loadImage(page.src);
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { url: c.toDataURL("image/jpeg", 0.9), w, h };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function savePageImage(page) {
    const n = indexOfPage(page) + 1;
    const { url } = await pageDataUrl(page, 2600);
    const res = await fetch(url);
    download(await res.blob(), `${fileBase()} - Seite ${n}.jpg`);
    toast("Seite gespeichert");
  }

  async function rotatePage(page) {
    busy("Seite wird gedreht");
    try {
      const img = await loadImage(page.src);
      const c = document.createElement("canvas");
      c.width = img.naturalHeight;
      c.height = img.naturalWidth;
      const ctx = c.getContext("2d");
      ctx.translate(c.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      page.src = c.toDataURL("image/jpeg", 0.92);
      page.w = c.width;
      page.h = c.height;
      page.thumb = await makeThumb(page.src);
      page.text = null;
      page.words = null;
      busyHide();
      renderGrid();
      renderCounts();
      persist();
    } catch (e) {
      busyHide();
      toast("Drehen fehlgeschlagen");
    }
  }

  function addTextLayer(doc, page, geom) {
    const words = page.words && page.words.length ? page.words : null;
    if (!words && !page.text) return;
    doc.setFont("helvetica", "normal");
    if (!words) {
      doc.setFontSize(9);
      doc.text(String(page.text), geom.dx + 1, geom.dy + 4, {
        renderingMode: "invisible",
        maxWidth: Math.max(10, geom.dw - 2),
        lineHeightFactor: 1.2
      });
      return;
    }
    const ow = page.ocrW || geom.ow;
    const oh = page.ocrH || geom.oh;
    const sx = geom.dw / Math.max(1, ow);
    const sy = geom.dh / Math.max(1, oh);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const x = geom.dx + w.x0 * sx;
      const y = geom.dy + w.y1 * sy;
      const boxW = Math.max(0.2, (w.x1 - w.x0) * sx);
      const boxH = Math.max(0.2, (w.y1 - w.y0) * sy);
      const fs = Math.max(1, Math.min(200, (boxH * 72) / 25.4));
      doc.setFontSize(fs);
      const natural = doc.getTextWidth(w.text);
      const hs = natural > 0.01 ? Math.max(0.2, Math.min(4, boxW / natural)) : 1;
      doc.text(w.text, x, y, { renderingMode: "invisible", horizontalScale: hs });
    }
  }

  async function buildPdf() {
    if (!state.pages.length) return null;
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (let i = 0; i < state.pages.length; i++) {
      const { url, w, h } = await pageDataUrl(state.pages[i], 2200);
      const landscape = w > h;
      if (!doc) doc = new jsPDF({ unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" });
      else doc.addPage("a4", landscape ? "landscape" : "portrait");
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const m = 7;
      const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h);
      const geom = { dx: (pw - w * s) / 2, dy: (ph - h * s) / 2, dw: w * s, dh: h * s, ow: w, oh: h };
      doc.addImage(url, "JPEG", geom.dx, geom.dy, geom.dw, geom.dh, undefined, "FAST");
      addTextLayer(doc, state.pages[i], geom);
      busy(`PDF Seite ${i + 1} von ${state.pages.length}`, (i + 1) / (state.pages.length + 1));
    }
    return doc.output("blob");
  }

  el("btnMakePdf").addEventListener("click", async () => {
    busy("PDF wird erstellt");
    try {
      const blob = await buildPdf();
      busyHide();
      if (!blob) return;
      download(blob, `${fileBase()}.pdf`);
      toast("PDF gespeichert");
    } catch (e) {
      busyHide();
      toast("PDF fehlgeschlagen");
    }
  });

  el("btnSharePdf").addEventListener("click", async () => {
    busy("PDF wird erstellt");
    try {
      const blob = await buildPdf();
      busyHide();
      if (!blob) return;
      const file = new File([blob], `${fileBase()}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fileBase() });
      } else {
        download(blob, file.name);
        toast("PDF gespeichert (Teilen nicht verfügbar)");
      }
    } catch (e) {
      busyHide();
      if (e && e.name !== "AbortError") toast("Teilen fehlgeschlagen");
    }
  });

  el("btnPrint").addEventListener("click", async () => {
    busy("Druckansicht wird vorbereitet");
    try {
      const imgs = [];
      for (let i = 0; i < state.pages.length; i++) {
        const { url } = await pageDataUrl(state.pages[i], 1800);
        imgs.push(url);
        busy(`Seite ${i + 1} von ${state.pages.length}`, i / state.pages.length);
      }
      busyHide();
      if (!imgs.length) return;
      const w = window.open("", "_blank");
      if (!w) { toast("Popup blockiert"); return; }
      const html =
        "<!doctype html><html><head><meta charset='utf-8'><title>" + fileBase().replace(/[<>&]/g, "") + "</title><style>@page{margin:8mm}body{margin:0}img{width:100%;page-break-after:always;display:block}@media screen{img{max-width:100%;margin-bottom:8px}}</style></head><body>" +
        imgs.map((u) => `<img src="${u}">`).join("") +
        "</body></html>";
      w.document.write(html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 900);
    } catch (e) {
      busyHide();
      toast("Drucken fehlgeschlagen");
    }
  });

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => res();
      s.onerror = () => rej(new Error("Laden fehlgeschlagen: " + src));
      document.head.appendChild(s);
    });
  }

  function corePath() {
    const ok =
      typeof WebAssembly !== "undefined" &&
      WebAssembly.validate &&
      WebAssembly.validate(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
      );
    return ok ? "vendor/tesseract-core-simd-lstm.wasm.js" : "vendor/tesseract-core.wasm.js";
  }

  async function getOcr() {
    if (state.tesseract) return state.tesseract;
    await loadScript("vendor/tesseract.min.js");
    const worker = await window.Tesseract.createWorker("deu+eng", 1, {
      workerPath: "vendor/tesseract-worker.min.js",
      corePath: corePath(),
      langPath: "vendor/tessdata",
      gzip: true,
      logger: () => {}
    });
    state.tesseract = worker;
    return worker;
  }

  function collectOcrWords(data) {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      const kids = [];
      if (Array.isArray(node.blocks)) kids.push.apply(kids, node.blocks);
      if (Array.isArray(node.paragraphs)) kids.push.apply(kids, node.paragraphs);
      if (Array.isArray(node.lines)) kids.push.apply(kids, node.lines);
      if (Array.isArray(node.words)) kids.push.apply(kids, node.words);
      if (kids.length) {
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
        return;
      }
      const b = node.bbox;
      const t = String(node.text == null ? "" : node.text).replace(/\s+/g, " ").trim();
      if (!t || !b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) return;
      out.push({ text: t, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    };
    visit(data);
    return out;
  }

  el("btnOcr").addEventListener("click", async () => {
    if (!state.pages.length) return;
    let worker;
    busy("Sprachdaten werden vorbereitet");
    try {
      worker = await getOcr();
    } catch (e) {
      busyHide();
      toast("Texterkennung nicht verfügbar");
      return;
    }
    let withWords = 0;
    try {
      for (let i = 0; i < state.pages.length; i++) {
        const page = state.pages[i];
        if (page.text != null && page.words) {
          if (page.words.length) withWords++;
          continue;
        }
        busy(`Text wird erkannt ${i + 1} von ${state.pages.length}`, i / state.pages.length);
        const img = await pageDataUrl(page, 2000);
        const res = await worker.recognize(img.url, {}, { text: true, blocks: true });
        const data = (res && res.data) || {};
        const text = String(data.text == null ? "" : data.text).trim();
        const words = collectOcrWords(data);
        page.text = text;
        page.words = words;
        page.ocrW = img.w;
        page.ocrH = img.h;
        if (words.length) withWords++;
      }
      busyHide();
      persist();
      showText(withWords);
    } catch (e) {
      busyHide();
      toast("Texterkennung fehlgeschlagen");
    }
  });

  function allText() {
    if (state.pages.length === 1) return String(state.pages[0].text || "").trim();
    return state.pages
      .map((p, i) => `--- Seite ${i + 1} ---\n${String(p.text || "").trim() || "(kein Text erkannt)"}`)
      .join("\n\n");
  }

  function showText(withWords) {
    ui.textOut.value = allText();
    ui.textNote.textContent = withWords
      ? "Der Text liegt jetzt auch unsichtbar im PDF. Das PDF ist dadurch durchsuchbar."
      : "Es wurde kein Text erkannt.";
    closeSheet();
    ui.textSheet.hidden = false;
  }

  el("btnTextClose").addEventListener("click", () => {
    ui.textSheet.hidden = true;
    openSheet();
  });

  el("btnCopyText").addEventListener("click", async () => {
    const t = ui.textOut.value;
    try {
      await navigator.clipboard.writeText(t);
      toast("Text kopiert");
    } catch (e) {
      ui.textOut.focus();
      ui.textOut.select();
      try {
        document.execCommand("copy");
        toast("Text kopiert");
      } catch (e2) {
        toast("Kopieren nicht möglich, Text ist markiert");
      }
    }
  });

  el("btnSaveText").addEventListener("click", () => {
    const blob = new Blob([ui.textOut.value], { type: "text/plain;charset=utf-8" });
    download(blob, `${fileBase()}.txt`);
    toast("Textdatei gespeichert");
  });

  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => decodeViaImg(file));
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    const url = URL.createObjectURL(file);
    return loadImage(url).finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
  }

  async function openNextImport() {
    while (state.importQueue.length) {
      const file = state.importQueue.shift();
      busy("Bild wird geladen");
      try {
        const img = await decodeImage(file);
        const iw = img.width || img.naturalWidth;
        const ih = img.height || img.naturalHeight;
        if (!iw || !ih) throw new Error("leer");
        const k = Math.min(1, 3000 / Math.max(iw, ih));
        const w = Math.max(1, Math.round(iw * k));
        const h = Math.max(1, Math.round(ih * k));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        if (img.close) img.close();
        const d = ctx.getImageData(0, 0, w, h);
        const found = detectFromRGBA(d.data, w, h, 420);
        busyHide();
        stopCamera();
        openReview({ rgba: d.data, w, h }, found || insetQuad(w, h, 0), null, !!found);
        const left = state.importQueue.length;
        toast(found ? "Blatt erkannt" + (left ? ` · noch ${left}` : "") : "Ganzes Bild übernommen, Ecken bei Bedarf ziehen" + (left ? ` · noch ${left}` : ""), 2600);
        return true;
      } catch (e) {
        busyHide();
        toast("Bild nicht lesbar: " + String(file.name || "").slice(0, 40), 3000);
      }
    }
    return false;
  }

  const pickImages = () => ui.fileInput.click();
  ui.importBtn.addEventListener("click", pickImages);
  ui.importBig.addEventListener("click", pickImages);

  ui.fileInput.addEventListener("change", async () => {
    const files = Array.from(ui.fileInput.files || []).filter((f) => !f.type || f.type.startsWith("image/"));
    ui.fileInput.value = "";
    if (!files.length) {
      toast("Bitte Bilddateien wählen (JPG, PNG, WebP)");
      return;
    }
    state.importQueue.push.apply(state.importQueue, files);
    if (!state.editing) await openNextImport();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if (!ui.review.classList.contains("is-active") && ui.pagesSheet.hidden && ui.textSheet.hidden) startCamera();
  });
  window.addEventListener("pagehide", stopCamera);
  window.addEventListener("resize", () => {
    if (state.editing && state.view) layout();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  state.docName = defaultDocName();
  renderCounts();
  startCamera();
  restore().then(() => {
    renderCounts();
    if (!ui.pagesSheet.hidden) renderGrid();
  });
})();
