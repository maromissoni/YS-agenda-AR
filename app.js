// Youth Speak AR - web app.
// Flow: Start -> point at the floor, then aim where the wall meets the floor and tap "Place here" -> the logo animates in, pinned in the room, and loops
//       -> tap the logo -> the agenda opens -> tap a session -> brief -> directions.
//       Portal (bottom bar): rings burst out of the logo; when the camera sees a person they fly over and swirl
//       around them (person-worker.js, MoveNet); take a photo.
//       Scavenger hunt: point the camera at the real pen -> a trained image model recognises it -> claim points.
//
// World tracking: 8th Wall XR Engine (lib/xr). This product includes the XR Engine software developed by
// Niantic Spatial, Inc. Copyright (c) 2026 Niantic Spatial, Inc. Licensed under the XR Engine License Agreement
// (lib/xr/LICENSE), which also contains the disclaimer of warranties.
// 3D: three.js (MIT). Object recognition: TensorFlow.js (Apache 2.0).

import * as THREE from 'three';

window.THREE = THREE; // the XR engine's three.js module looks for THREE here

const APP_VERSION = 'v13';

// Size: when placed, the agenda card fills this share of the screen width (0.5 = half).
// Larger = bigger agenda. With the brief open, card + brief together fill about twice this.
const FIT_WIDTH = 0.5;
const DEFAULT_DISTANCE_M = 1.5;
const EYE_HEIGHT_M = 1.5; // height the phone is assumed to start at; sets the scale of the room

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- storage (points stay on this phone)

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: progress not saved */ }
  },
};
const foundMap = () => store.get('ysf_found', {});
const score = () => store.get('ysf_score', 0);
const isFound = (item) => Boolean(foundMap()[item.id]);

function claim(item) {
  if (isFound(item)) return false;
  const f = foundMap();
  f[item.id] = true;
  store.set('ysf_found', f);
  store.set('ysf_score', score() + item.points);
  return true;
}

function resetProgress() {
  store.set('ysf_found', {});
  store.set('ysf_score', 0);
}

// ---------------------------------------------------------------- tiny DOM helper (text is always set as text, never HTML)

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

// ---------------------------------------------------------------- state

let content = null;
let logo = null;          // the animated logo (see createLogo)
let placedGroup = null;   // pinned in the room
let xrCamera = null;
let cameraVideo = null;   // the live camera picture (used by the pen detector)
let renderedFrames = 0;

let running = false;      // camera + tracking started
let placed = false;
let tracking = 'LIMITED'; // NORMAL once the engine has a good lock on the room
let inView = false;
let lastSeenAt = 0;
let agendaOpen = false;
let selectedSession = -1;
let currentSheet = null;  // { kind, id }
const discoveryCooldown = new Map();

// ---------------------------------------------------------------- start

async function loadContent() {
  const res = await fetch('content.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('content.json could not be loaded');
  return res.json();
}

function setStatus(text, isError = false) {
  const s = $('#start-status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function waitForXR8(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (window.XR8) { resolve(window.XR8); return; }
    const timer = setTimeout(() => reject(new Error('xr-timeout')), timeoutMs);
    window.addEventListener('xrloaded', () => { clearTimeout(timer); resolve(window.XR8); }, { once: true });
  });
}

function sizeCanvas() {
  const canvas = $('#xr');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

async function start() {
  const button = $('#btn-start');
  if (!window.isSecureContext) {
    setStatus('The camera only works on a secure address (https://). Open the GitHub Pages link.', true);
    return;
  }

  // These must happen inside the tap, before anything is awaited:
  // iPhone asks for motion access (needed to track the room), and the logo videos get permission to play.
  const motionAsks = [];
  for (const E of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
    if (E && typeof E.requestPermission === 'function') motionAsks.push(E.requestPermission().catch(() => 'denied'));
  }
  logo = logo || createLogo();
  logo.prime();

  button.disabled = true;
  setStatus('Starting the camera...');
  const slowNote = setTimeout(() => setStatus('Still loading the AR engine... this can take up to 20 seconds on the first visit.'), 6000);
  const fail = (text) => { clearTimeout(slowNote); setStatus(text, true); button.disabled = false; };

  let XR8;
  try {
    content = content || await loadContent();
    await loadFonts();
    const answers = await Promise.all(motionAsks);
    if (answers.includes('denied')) {
      fail('Motion access is needed to pin the agenda in the room. Close Safari completely, open the link again and tap Allow.');
      return;
    }
    XR8 = await waitForXR8();
  } catch (e) {
    fail(e && e.message === 'xr-timeout'
      ? 'The AR engine did not load. Check your connection and reload the page.'
      : 'Could not load the agenda (content.json). Check that all files were uploaded.');
    return;
  }

  buildStage();
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);

  XR8.XrController.configure({ scale: 'responsive', disableWorldTracking: false });
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(), // draws the camera picture
    XR8.Threejs.pipelineModule(),           // a three.js camera that follows the phone
    XR8.XrController.pipelineModule(),      // world tracking
    {
      name: 'youthspeak',
      onStart: () => {
        const { scene, camera, renderer } = XR8.Threejs.xrScene();
        xrCamera = camera;
        camera.position.set(0, EYE_HEIGHT_M, 0);
        XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
        attachStage(scene, renderer);
        buildPortal(scene);
        running = true;
        runningSince = Date.now();
        clearTimeout(slowNote);
        $('#start').hidden = true;
        updateChrome();
      },
      onCameraStatusChange: ({ status, video }) => {
        if (status === 'hasVideo' && video) cameraVideo = video;
        if (status === 'failed') fail('The camera did not start. Allow camera access for this site in your browser settings, then reload.');
      },
      // Runs after the engine has moved the three.js camera and before it draws the frame,
      // so the agenda is drawn in exactly the same frame as the camera picture.
      onUpdate: ({ processCpuResult }) => {
        const reality = processCpuResult && processCpuResult.reality;
        if (reality && reality.trackingStatus && reality.trackingStatus !== tracking) {
          tracking = reality.trackingStatus;
          normalSince = tracking === 'NORMAL' ? Date.now() : 0;
          updateChrome();
        }
        const ready = trackingReady();
        if (ready !== wasReady) { wasReady = ready; updateChrome(); }
        if (!xrCamera) return;
        logo.draw();
        updateStage();
        updateInView();
        updateAimLabel();
      },
      onRender: () => {
        if (!xrCamera) return;
        renderedFrames++;
        if (photoWanted) capturePhoto();
        if (personFinding) grabPersonFrame();
        if (scanning) grabScanFrame();
      },
      onException: (e) => {
        if (e && e.type === 'permission') fail('Camera and motion access are needed. Allow them for this site, then reload.');
      },
    },
  ]);
  XR8.run({ canvas: $('#xr'), allowedDevices: XR8.XrConfig.device().ANY });
}
let wasReady = false;

// ---------------------------------------------------------------- the stage, pinned in the room
// The logo, the agenda card and the brief are drawn with WebGL in the same picture as the camera,
// in the same frame. (In v10 they were web page elements laid over the camera, which lag a frame
// behind the camera picture and seem to swim.)
// Everything is laid out in the pixels of the agenda design: the stage is 1231 x 1727, the card
// 1089 wide at (0, 367), the logo on its top-right corner, the brief to its right.
// When placed, the stage is sized so the card fills FIT_WIDTH of the screen width.

const STAGE_W = 1231, STAGE_H = 1727;
const CARD_BOX = { x: 0, y: 367, w: 1089 };
const BACK_CARD_X = STAGE_W - CARD_BOX.w;         // the back is the front mirrored
const LOGO_BOX = { x: 845.5, y: -14.5, w: 368.5, h: 440.6 };
const BACK_LOGO_X = 17;
const BRIEF_BOX = { x: 1149, w: 900 };
const SOLO = { dx: -414, dy: 658, scale: 1.9 };   // logo alone: big, in the middle of the stage
const SLIDE_PX = (BRIEF_BOX.x + BRIEF_BOX.w - STAGE_W) / 2; // shift so card + brief are centred
const OPEN_MS = 600, BRIEF_MS = 380;

const FONT = 'Lato, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const font = (weight, size) => `${weight} ${size}px ${FONT}`;

let stage = null;     // meshes, canvases and tap areas (see buildStage)
let openT = 0;        // 0 = logo alone, 1 = agenda open (animated)
let briefT = 0;       // 0 = no brief, 1 = brief shown (animated)
let lastFrameAt = 0;

// Design pixels (y down, origin top-left of the stage) -> stage space (y up, origin in the middle).
const sx = (px) => px - STAGE_W / 2;
const sy = (py) => STAGE_H / 2 - py;

function loadFonts() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const sample = 'AaZz09ČčĆćĐđŠšŽž';
  const all = Promise.all(['300', '400', '900'].map((w) => document.fonts.load(font(w, 40), sample).catch(() => null)));
  return Promise.race([all, new Promise((r) => setTimeout(r, 4000))]);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The purple card of the design: a 140° gradient with a grey glow in the bottom-left corner.
function paintCard(ctx, w, h) {
  ctx.save();
  roundRect(ctx, 0, 0, w, h, 112);
  ctx.clip();
  const a = (140 * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const g = ctx.createLinearGradient(w / 2 - (dx * len) / 2, h / 2 - (dy * len) / 2, w / 2 + (dx * len) / 2, h / 2 + (dy * len) / 2);
  g.addColorStop(0, '#9d85eb');
  g.addColorStop(0.44, '#7854cf');
  g.addColorStop(0.72, '#5a3bb2');
  g.addColorStop(1, '#442997');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.translate(0, h);
  ctx.scale(1.2 * w, 0.9 * h);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  glow.addColorStop(0, 'rgba(120, 120, 150, 0.35)');
  glow.addColorStop(0.55, 'rgba(120, 120, 150, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

// Text on one line, shrunk if it is wider than maxWidth.
function fitText(ctx, text, x, y, weight, size, maxWidth) {
  let s = size;
  ctx.font = font(weight, s);
  while (s > 12 && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = font(weight, s);
  }
  ctx.fillText(text, x, y);
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function pill(ctx, x, y, w, h, fill, border, label, weight, size) {
  roundRect(ctx, x, y, w, h, 56);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, label, x + w / 2, y + h / 2 + 1, weight, size, w - 40);
}

function cardHeight() {
  const n = content.sessions.length;
  return Math.max(1360, 373 + n * 131 + Math.max(0, n - 1) * 47 + 76 + 122 + 123);
}

function drawCard() {
  const { cardCanvas: cv } = stage;
  const w = CARD_BOX.w, h = cardHeight();
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  paintCard(ctx, w, h);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, content.forumTitle, w / 2, 150, 900, 104, w - 90);
  ctx.font = font(300, 62);
  ctx.fillText('AGENDA', w / 2, 241);

  const areas = [];
  let y = 373;
  content.sessions.forEach((s, i) => {
    const x = 173, pw = w - 173 - 134, ph = 131;
    const selected = i === selectedSession;
    roundRect(ctx, x, y, pw, ph, 56);
    ctx.fillStyle = selected ? 'rgba(255, 255, 255, 0.26)' : 'rgba(104, 52, 132, 0.2)';
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeStyle = selected ? '#fff' : 'rgba(255, 255, 255, 0.22)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    fitText(ctx, s.title, x + pw / 2, y + 45.5, 900, 48, pw - 80);
    fitText(ctx, `${s.room}  |  ${s.time}`, x + pw / 2, y + 94.5, 300, 30, pw - 80);
    areas.push({ x, y, w: pw, h: ph, name: `session${i}`, tap: () => showBrief(i) });
    y += ph + 47;
  });
  y += 76 - 47;
  pill(ctx, 208, y, 340, 122, 'rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.24)', 'Close agenda', 300, 30);
  pill(ctx, 579, y, 340, 122, '#6c4ebf', 'rgba(255, 255, 255, 0.24)', 'Scavenger Hunt', 900, 30);
  areas.push({ x: 208, y, w: 340, h: 122, name: 'close', tap: closeAgenda });
  areas.push({ x: 579, y, w: 340, h: 122, name: 'hunt', tap: openHunt });
  stage.cardAreas = areas;
  stage.cardH = h;
  refreshTexture('card', cv);
}

function drawBrief(index) {
  const s = content.sessions[index];
  const { briefCanvas: cv } = stage;
  const w = BRIEF_BOX.w, pad = 84, inner = w - pad * 2;
  const measure = cv.getContext('2d');
  // Lay the text out first to know how tall the brief must be.
  const blocks = [
    { text: s.title, weight: 900, size: 76, lh: 84 },
    { text: `${s.room}  |  ${s.time}`, weight: 300, size: 46, lh: 58 },
    { text: `Speaker: ${s.speaker}`, weight: 400, size: 42, lh: 58 },
    { text: s.brief, weight: 400, size: 42, lh: 58 },
  ].map((b) => { measure.font = font(b.weight, b.size); return { ...b, lines: wrapLines(measure, b.text, inner) }; });
  const textH = blocks.reduce((sum, b) => sum + b.lines.length * b.lh, 0) + 30 * (blocks.length - 1);
  const buttonsH = 122 + 30 + 122;
  const h = Math.max(stage.cardH, 98 + textH + 50 + buttonsH + 100);

  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  paintCard(ctx, w, h);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let y = 98;
  for (const b of blocks) {
    ctx.font = font(b.weight, b.size);
    for (const line of b.lines) { ctx.fillText(line, pad, y + b.lh / 2); y += b.lh; }
    y += 30;
  }
  const yClose = h - 100 - 122, yDirs = yClose - 30 - 122;
  pill(ctx, pad, yDirs, inner, 122, '#6c4ebf', 'rgba(255, 255, 255, 0.24)', 'Directions to the room', 900, 40);
  pill(ctx, pad, yClose, inner, 122, 'rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.24)', 'Close brief', 300, 40);
  stage.briefAreas = [
    { x: pad, y: yDirs, w: inner, h: 122, name: 'directions', tap: () => openDirections(index) },
    { x: pad, y: yClose, w: inner, h: 122, name: 'closeBrief', tap: closeBrief },
  ];
  stage.briefH = h;
  refreshTexture('brief', cv);
}

function drawBackCard() {
  const cv = stage.backCanvas;
  const w = CARD_BOX.w, h = stage.cardH;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  paintCard(ctx, w, h);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, content.forumTitle, w / 2, h / 2, 900, 104, w - 90);
  refreshTexture('back', cv);
}

function makeTexture(canvas, mipmaps = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = mipmaps;
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (stage.maxAniso) t.anisotropy = Math.min(8, stage.maxAniso);
  return t;
}

// A canvas that changed size needs a new texture; one that only changed its pixels just a re-upload.
function refreshTexture(key, canvas) {
  const mesh = stage[`${key}Mesh`];
  const old = mesh.material.map;
  if (old && old.image === canvas && old.userData.w === canvas.width && old.userData.h === canvas.height) {
    old.needsUpdate = true;
    return;
  }
  if (old) old.dispose();
  const t = makeTexture(canvas);
  t.userData = { w: canvas.width, h: canvas.height };
  mesh.material.map = t;
  mesh.material.needsUpdate = true;
}

function plane(renderOrder) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide, toneMapped: false }),
  );
  m.renderOrder = renderOrder;
  m.visible = false;
  return m;
}

function buildStage() {
  const mk = () => document.createElement('canvas');
  stage = { cardCanvas: mk(), briefCanvas: mk(), backCanvas: mk(), cardAreas: [], briefAreas: [], cardH: 1360, briefH: 1360 };

  stage.front = new THREE.Group();   // logo, card, brief: seen from the front
  stage.back = new THREE.Group();    // seen when you walk behind it
  stage.back.rotation.y = Math.PI;
  stage.back.position.z = -2;

  stage.cardMesh = plane(1);
  stage.briefMesh = plane(1);
  stage.logoMesh = plane(2);
  stage.backMesh = plane(1);
  stage.backLogoMesh = plane(2);
  stage.front.add(stage.cardMesh, stage.briefMesh, stage.logoMesh);
  stage.back.add(stage.backMesh, stage.backLogoMesh);

  stage.cardMesh.userData.onTap = (uv) => tapArea(stage.cardAreas, uv, CARD_BOX.w, stage.cardH);
  stage.briefMesh.userData.onTap = (uv) => tapArea(stage.briefAreas, uv, BRIEF_BOX.w, stage.briefH);
  stage.logoMesh.userData.onTap = () => { toggleAgenda(); return true; };
  stage.backLogoMesh.userData.onTap = stage.logoMesh.userData.onTap;

  placedGroup = new THREE.Group();
  placedGroup.add(stage.front, stage.back);
  placedGroup.visible = false;
}

// Called once the XR engine has made its three.js scene.
function attachStage(scene, renderer) {
  stage.maxAniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;
  drawCard();
  drawBackCard();
  const logoTex = makeTexture(logo.canvas, false);
  stage.logoTex = logoTex;
  stage.logoMesh.material.map = logoTex;
  stage.backLogoMesh.material.map = logoTex;
  scene.add(placedGroup);
}

function tapArea(areas, uv, w, h) {
  const x = uv.x * w, y = (1 - uv.y) * h;
  const hit = areas.find((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h);
  if (hit) hit.tap();
  return true; // a tap on the card itself is used up even if it missed a button
}

const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const mix = (a, b, t) => a + (b - a) * t;

// Puts a mesh with its top-left corner at design pixel (x, y), size w x h, scaled s around point (ox, oy).
function layout(mesh, x, y, w, h, z, s = 1, ox = x + w / 2, oy = y + h / 2) {
  const cx = ox + (x + w / 2 - ox) * s, cy = oy + (y + h / 2 - oy) * s;
  mesh.position.set(sx(cx), sy(cy), z);
  mesh.scale.set(w * s, h * s, 1);
}

// Every frame: animate opening and closing, and keep the logo picture up to date.
function updateStage() {
  const now = performance.now();
  const dt = lastFrameAt ? Math.min(100, now - lastFrameAt) : 16;
  lastFrameAt = now;
  updatePortal(dt);
  openT = Math.min(1, Math.max(0, openT + (agendaOpen ? 1 : -1) * (dt / OPEN_MS)));
  const briefWanted = agendaOpen && selectedSession >= 0;
  briefT = Math.min(1, Math.max(0, briefT + (briefWanted ? 1 : -1) * (dt / BRIEF_MS)));
  const e = ease(openT), b = ease(briefT);

  if (logo.takeDirty()) stage.logoTex.needsUpdate = true;
  if (!placed) return;

  // Logo: big in the middle when alone, on the card's corner when the agenda is open.
  const ls = mix(SOLO.scale, 1, e);
  const lx = LOGO_BOX.x + mix(SOLO.dx, 0, e), ly = LOGO_BOX.y + mix(SOLO.dy, 0, e);
  layout(stage.logoMesh, lx, ly, LOGO_BOX.w, LOGO_BOX.h, 4, ls);
  stage.logoMesh.visible = logo.phase !== 'hidden';
  const blx = BACK_LOGO_X + mix(-SOLO.dx, 0, e);
  layout(stage.backLogoMesh, blx, ly, LOGO_BOX.w, LOGO_BOX.h, 4, ls);
  stage.backLogoMesh.visible = stage.logoMesh.visible;

  // Card: grows out of the logo's corner.
  const ch = stage.cardH;
  layout(stage.cardMesh, CARD_BOX.x, CARD_BOX.y, CARD_BOX.w, ch, 0, mix(0.15, 1, e), CARD_BOX.x + 0.94 * CARD_BOX.w, CARD_BOX.y + 0.02 * ch);
  stage.cardMesh.material.opacity = Math.min(1, e * 1.6);
  stage.cardMesh.visible = openT > 0.02;
  layout(stage.backMesh, BACK_CARD_X, CARD_BOX.y, CARD_BOX.w, ch, 0);
  stage.backMesh.material.opacity = e;
  stage.backMesh.visible = openT > 0.02;

  // Brief: fades in on the right, and everything slides left so card + brief stay centred.
  layout(stage.briefMesh, BRIEF_BOX.x, CARD_BOX.y, BRIEF_BOX.w, stage.briefH, 0);
  stage.briefMesh.material.opacity = b;
  stage.briefMesh.visible = briefT > 0.02;
  stage.front.position.x = -SLIDE_PX * b;
}

// ---------------------------------------------------------------- placing it

// The engine needs about a second of steady tracking before anything is pinned, or it drifts.
let normalSince = 0;
let runningSince = 0;
const TRACKING_SETTLE_MS = 1000;
const TRACKING_GIVE_UP_MS = 12000; // after this, placing is allowed anyway
let wasSteady = false; // once tracking has been steady, placing stays allowed even if it flickers
function trackingReady() {
  if (wasSteady) return true;
  const now = Date.now();
  if (tracking === 'NORMAL' && normalSince && now - normalSince >= TRACKING_SETTLE_MS) wasSteady = true;
  return wasSteady || (runningSince > 0 && now - runningSince > TRACKING_GIVE_UP_MS);
}

// Pin the stage upright, facing you, on the wall you are aiming at, sized to fit the screen.
function placeHere() {
  if (!running || !xrCamera) return;
  if (!placed && !trackingReady()) { updateChrome(); return; }
  const pos = xrCamera.position.clone();
  const forward = new THREE.Vector3();
  xrCamera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
  forward.normalize();

  // How far the wall is. Best: the dot is on the line where the wall meets the floor, and the floor
  // (which the engine tracks well) gives the exact distance. Then the agenda sits ON the wall and
  // does not slide against it when you move. Otherwise: real points straight ahead, or 1.5 m.
  const aim = wallDistance();
  const distance = aim.distance;

  // How wide the screen is at that distance, from the camera's field of view.
  const e0 = xrCamera.projectionMatrix.elements[0] || 3.4;
  const screenWidthM = (2 * distance) / e0;
  const metresPerPx = (FIT_WIDTH * screenWidthM) / CARD_BOX.w;

  placedGroup.position.set(pos.x + forward.x * distance, pos.y - 0.05, pos.z + forward.z * distance);
  placedGroup.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
  placedGroup.scale.setScalar(metresPerPx);
  placedGroup.updateMatrixWorld(true);
  placedGroup.visible = true;
  placedInfo = { distance: Number(distance.toFixed(2)), how: aim.how, cardWidthM: Number((CARD_BOX.w * metresPerPx).toFixed(2)) };

  placed = true;
  agendaOpen = false;
  portalOpen = false;
  portalT = 0;
  if (portal) portal.group.visible = false;
  selectedSession = -1;
  openT = 0;
  briefT = 0;
  drawCard();
  inView = true;
  lastSeenAt = Date.now();
  logo.appear();
  updateStage();
  updateChrome();
}
let placedInfo = null;

const _aimRay = new THREE.Raycaster();
const _centre = new THREE.Vector2(0, 0);
function wallDistance() {
  const pos = xrCamera.position;
  xrCamera.updateMatrixWorld();
  xrCamera.projectionMatrixInverse.copy(xrCamera.projectionMatrix).invert();
  _aimRay.setFromCamera(_centre, xrCamera);
  const ground = floorPoint(_aimRay.ray.origin, _aimRay.ray.direction);
  if (ground) {
    const d = Math.hypot(ground.x - pos.x, ground.z - pos.z);
    if (d > 0.5 && d < 8) return { distance: d - 0.02, how: 'floor' };
  }
  try {
    const hits = window.XR8.XrController.hitTest(0.5, 0.5, ['FEATURE_POINT']) || [];
    const ahead = hits
      .map((h) => Math.hypot(h.position.x - pos.x, h.position.z - pos.z))
      .filter((d) => d > 0.6 && d < 6)
      .sort((a, b) => a - b);
    if (ahead.length) return { distance: ahead[0] - 0.03, how: 'points' };
  } catch { /* fall back to the fixed distance */ }
  return { distance: DEFAULT_DISTANCE_M, how: 'guess' };
}

// Before placing: show under the dot how far the wall is.
let lastAimLabel = 0;
function updateAimLabel() {
  const label = $('#reticle-label');
  if (!label || placed || !trackingReady() || Date.now() - lastAimLabel < 150) return;
  lastAimLabel = Date.now();
  const aim = wallDistance();
  label.textContent = aim.how === 'floor' ? `wall at ${aim.distance.toFixed(1)} m` : 'aim lower: where the wall meets the floor';
  $('#reticle').classList.toggle('locked', aim.how === 'floor');
}

// ---------------------------------------------------------------- tapping it

const raycaster = new THREE.Raycaster();
const tapPoint = new THREE.Vector2();
let pressAt = null;

function tapTargets() {
  return [stage.logoMesh, stage.backLogoMesh, stage.briefMesh, stage.cardMesh]
    .filter((m) => m.visible && (m.material.opacity > 0.5 || m === stage.logoMesh || m === stage.backLogoMesh));
}

function onStageTap(clientX, clientY) {
  if (!placed || !xrCamera || currentSheet) return false;
  tapPoint.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  xrCamera.updateMatrixWorld();
  xrCamera.projectionMatrixInverse.copy(xrCamera.projectionMatrix).invert();
  placedGroup.updateMatrixWorld(true);
  raycaster.setFromCamera(tapPoint, xrCamera);
  for (const hit of raycaster.intersectObjects(tapTargets(), false)) {
    const handler = hit.object.userData.onTap;
    if (handler && handler(hit.uv)) return true;
  }
  return false;
}

// Screen position of a part of the stage (used by the automated tests to tap it).
function screenPointOf(name) {
  let mesh = null, px = 0, py = 0;
  if (name === 'logo') {
    mesh = stage.logoMesh;
  } else {
    const inBrief = stage.briefAreas.find((a) => a.name === name);
    const inCard = stage.cardAreas.find((a) => a.name === name);
    const a = inBrief || inCard;
    if (!a) return null;
    mesh = inBrief ? stage.briefMesh : stage.cardMesh;
    const w = inBrief ? BRIEF_BOX.w : CARD_BOX.w, h = inBrief ? stage.briefH : stage.cardH;
    px = (a.x + a.w / 2) / w - 0.5;
    py = 0.5 - (a.y + a.h / 2) / h;
  }
  const v = new THREE.Vector3(px, py, 0);
  mesh.updateMatrixWorld(true);
  mesh.localToWorld(v);
  v.project(xrCamera);
  return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 };
}

// ---------------------------------------------------------------- in view or not

// Replays the logo intro when you come back to it after looking away, and saves battery while it is off-screen.
// Points of the stage (design pixels) used to decide whether any part of it is on screen.
const VIEW_PX = [[615, 863], [0, 367], [1089, 367], [0, 1727], [1089, 1727], [1030, 206]];
const BRIEF_PX = [[1599, 1047], [2049, 367], [2049, 1727]];
const projected = new THREE.Vector3();
function anyPointOnScreen() {
  const pts = briefT > 0.5 ? VIEW_PX.concat(BRIEF_PX) : VIEW_PX;
  for (const [x, y] of pts) {
    projected.set(sx(x), sy(y), 0);
    stage.front.localToWorld(projected);
    projected.project(xrCamera);
    if (projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1) return true;
  }
  return false;
}

function updateInView() {
  if (!placed) return;
  const now = Date.now();
  const visible = anyPointOnScreen();
  if (visible && !inView) {
    inView = true;
    if (!agendaOpen && now - lastSeenAt > 3000) logo.appear(); else logo.wake();
    updateChrome();
  } else if (!visible && inView) {
    inView = false;
    logo.sleep();
    updateChrome();
  }
  if (visible) lastSeenAt = now;
}

function openAgenda() {
  if (portalOpen) closePortal();
  agendaOpen = true;
  updateChrome();
}

function closeAgenda() {
  agendaOpen = false;
  updateChrome();
}

function toggleAgenda() {
  if (logo.phase === 'hidden') return;
  if (agendaOpen) closeAgenda(); else openAgenda();
}

function showBrief(index) {
  selectedSession = index;
  drawCard();
  drawBrief(index);
  updateChrome();
}

function closeBrief() {
  selectedSession = -1;
  drawCard();
  updateChrome();
}

// ---------------------------------------------------------------- the portal
// "Portal" in the bottom bar: rings in the Youth Speak colours burst out of the logo and form a tunnel
// in the room, big enough to stand in. They stay pinned like the agenda, so you can walk around and
// through them. "Take photo" saves the view with a small Youth Speak frame.

const PORTAL_RINGS = 9;
const PORTAL_OPEN_MS = 1700, PORTAL_CLOSE_MS = 700;
const PORTAL_FRONT_M = 0.8;      // how far the tunnel reaches out from the wall
const PORTAL_CENTRE_M = 1.05;    // height of the tunnel's middle near you (a standing person fits inside)
const RING_PALETTE = {
  purple: '#7551cc', light: '#9d85eb', deep: '#442997', mid: '#5a3bb2',
  ink: '#2b1a66', lavender: '#e6dff8', white: '#ffffff',
};
// Front to back, these are the patterns. Each ring: pattern, inner hole (share of the radius), colours.
const RING_DESIGNS = [
  { kind: 'checker', hole: 0.72, a: RING_PALETTE.ink, b: RING_PALETTE.white },
  { kind: 'flower', hole: 0.66, a: RING_PALETTE.light, b: RING_PALETTE.white },
  { kind: 'text', hole: 0.8, a: RING_PALETTE.deep, b: RING_PALETTE.white },
  { kind: 'sunburst', hole: 0.62, a: RING_PALETTE.purple, b: RING_PALETTE.lavender },
  { kind: 'logos', hole: 0.7, a: RING_PALETTE.white, b: RING_PALETTE.purple },
  { kind: 'zigzag', hole: 0.68, a: RING_PALETTE.mid, b: RING_PALETTE.white },
  { kind: 'stripes', hole: 0.6, a: RING_PALETTE.ink, b: RING_PALETTE.light },
  { kind: 'dots', hole: 0.7, a: RING_PALETTE.purple, b: RING_PALETTE.white },
  { kind: 'checker', hole: 0.64, a: RING_PALETTE.deep, b: RING_PALETTE.lavender },
];

let portal = null;        // { group, rings: [{ mesh, from, to, size, spin, delay }] }
let portalOpen = false;
let portalT = 0;          // 0 = closed, 1 = fully out (animated)
let photoWanted = false;
let lastPhoto = null;     // { url, blob }

const logoStill = new Image();
logoStill.src = 'logo/logo.png';

// Paths for one wedge of an annulus.
function wedge(ctx, c, r0, r1, a0, a1) {
  ctx.beginPath();
  ctx.arc(c, c, r1, a0, a1);
  ctx.arc(c, c, r0, a1, a0, true);
  ctx.closePath();
}

function drawRingTexture(design) {
  const S = 512, c = S / 2, R = 250, r = R * design.hole;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const { a, b } = design;
  const band = R - r;

  switch (design.kind) {
    case 'checker': {
      const segs = 28, rows = 2;
      for (let row = 0; row < rows; row++) {
        const r0 = r + (band * row) / rows, r1 = r + (band * (row + 1)) / rows;
        for (let s = 0; s < segs; s++) {
          ctx.fillStyle = (s + row) % 2 ? a : b;
          wedge(ctx, c, r0, r1, (s / segs) * Math.PI * 2, ((s + 1) / segs) * Math.PI * 2 + 0.002);
          ctx.fill();
        }
      }
      break;
    }
    case 'sunburst': {
      const segs = 40;
      for (let s = 0; s < segs; s++) {
        ctx.fillStyle = s % 2 ? a : b;
        wedge(ctx, c, r, R, (s / segs) * Math.PI * 2, ((s + 1) / segs) * Math.PI * 2 + 0.002);
        ctx.fill();
      }
      ctx.lineWidth = 6;
      ctx.strokeStyle = RING_PALETTE.ink;
      for (const rr of [r + 3, R - 3]) { ctx.beginPath(); ctx.arc(c, c, rr, 0, Math.PI * 2); ctx.stroke(); }
      break;
    }
    case 'stripes': {
      const n = 7;
      for (let i = n - 1; i >= 0; i--) {
        ctx.fillStyle = i % 2 ? a : b;
        ctx.beginPath();
        ctx.arc(c, c, r + (band * (i + 1)) / n, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    }
    case 'flower': {
      const petals = 14, pr = band * 0.42;
      ctx.fillStyle = a;
      ctx.beginPath(); ctx.arc(c, c, R - pr, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < petals; i++) {
        const ang = (i / petals) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(c + Math.cos(ang) * (R - pr), c + Math.sin(ang) * (R - pr), pr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = b;
      for (let i = 0; i < petals; i++) {
        const ang = (i / petals) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(c + Math.cos(ang) * (R - pr), c + Math.sin(ang) * (R - pr), pr * 0.32, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = RING_PALETTE.deep;
      ctx.beginPath(); ctx.arc(c, c, r + band * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    }
    case 'zigzag': {
      ctx.fillStyle = a;
      wedge(ctx, c, r, R, 0, Math.PI * 2); ctx.fill();
      const teeth = 30, mid = r + band / 2, h = band * 0.34;
      ctx.fillStyle = b;
      ctx.beginPath();
      for (let i = 0; i <= teeth * 2; i++) {
        const ang = (i / (teeth * 2)) * Math.PI * 2;
        const rr = i % 2 ? mid + h : mid - h;
        const x = c + Math.cos(ang) * rr, y = c + Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = teeth * 2; i >= 0; i--) {
        const ang = (i / (teeth * 2)) * Math.PI * 2 + 0.06;
        const rr = (i % 2 ? mid + h : mid - h) - band * 0.16;
        ctx.lineTo(c + Math.cos(ang) * rr, c + Math.sin(ang) * rr);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'dots': {
      ctx.fillStyle = a;
      wedge(ctx, c, r, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b;
      for (const [rr, n, size, off] of [[r + band * 0.3, 22, band * 0.13, 0], [r + band * 0.72, 30, band * 0.12, 0.5]]) {
        for (let i = 0; i < n; i++) {
          const ang = ((i + off) / n) * Math.PI * 2;
          ctx.beginPath(); ctx.arc(c + Math.cos(ang) * rr, c + Math.sin(ang) * rr, size, 0, Math.PI * 2); ctx.fill();
        }
      }
      break;
    }
    case 'text': {
      ctx.fillStyle = a;
      wedge(ctx, c, r, R, 0, Math.PI * 2); ctx.fill();
      const words = `${content.forumTitle}  •  `.repeat(3);
      const size = band * 0.62;
      ctx.font = font(900, size);
      ctx.fillStyle = b;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rr = r + band / 2;
      const total = ctx.measureText(words).width;
      const fit = (Math.PI * 2 * rr) / total; // squeeze or stretch the letters to go exactly once around
      let ang = -Math.PI / 2;
      for (const ch of words) {
        const w = ctx.measureText(ch).width * fit;
        ang += w / rr / 2;
        ctx.save();
        ctx.translate(c + Math.cos(ang) * rr, c + Math.sin(ang) * rr);
        ctx.rotate(ang + Math.PI / 2);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
        ang += w / rr / 2;
      }
      break;
    }
    case 'logos': {
      ctx.fillStyle = a;
      wedge(ctx, c, r, R, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = b;
      for (const rr of [r + 4, R - 4]) { ctx.beginPath(); ctx.arc(c, c, rr, 0, Math.PI * 2); ctx.stroke(); }
      const n = 11, h = band * 0.78, w = h * (LOGO_W / LOGO_H);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        ctx.save();
        ctx.translate(c + Math.cos(ang) * (r + band / 2), c + Math.sin(ang) * (r + band / 2));
        ctx.rotate(ang + Math.PI / 2);
        if (logoStill.complete && logoStill.naturalWidth) ctx.drawImage(logoStill, -w / 2, -h / 2, w, h);
        else { ctx.fillStyle = b; ctx.beginPath(); ctx.arc(0, 0, h / 3, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      break;
    }
    default: break;
  }
  return cv;
}

async function buildPortal(scene) {
  try { await logoStill.decode(); } catch { /* the logo ring falls back to dots */ }
  const group = new THREE.Group(); // the rings live directly in the room
  group.visible = false;
  const rings = RING_DESIGNS.slice(0, PORTAL_RINGS).map((design, i) => {
    const tex = makeTexture(drawRingTexture(design));
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    mesh.renderOrder = 3;
    group.add(mesh);
    return { mesh, index: i, hole: design.hole, spin: (i % 2 ? -1 : 1) * (0.25 + ((i * 37) % 10) / 16), angle: i * 0.7 };
  });

  // An invisible stand-in for the person's body. It hides the parts of the rings that pass behind them,
  // so the rings look like they go around the person.
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PERSON_RADIUS_M, 1, 6, 16),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  body.renderOrder = -1;
  body.visible = false;

  scene.add(group, body);
  portal = { group, rings, body, wall: new THREE.Object3D(), logoHeight: 1.45 };
}

// The tunnel's shape: from the logo on the wall (small, high) out to you (big, at the height of a person).
// Positions are in the wall's own frame: x along the wall, y = height above the floor, z = out from the wall.
function ringTarget(i, n, logoHeight) {
  const t = n === 1 ? 1 : i / (n - 1);              // 0 = at the wall, 1 = nearest to you
  const front = n - 1 - i;                          // RING_DESIGNS is listed front first
  return {
    z: 0.08 + t * (PORTAL_FRONT_M - 0.08),
    y: mix(logoHeight, PORTAL_CENTRE_M, Math.pow(t, 0.8)),
    x: Math.sin(front * 1.9) * 0.14 * t,
    tiltX: Math.sin(front * 2.3 + 1) * 0.32,   // rings lean a little in different directions,
    tiltY: Math.cos(front * 1.7) * 0.42,       // like the loose stack in the reference video
    size: mix(0.55, 1.95, t),
  };
}

function openPortal() {
  if (!placed || !portal) return;
  if (agendaOpen) closeAgenda();
  selectedSession = -1;
  // The tunnel starts at the logo and points out of the wall, towards where you placed it from.
  portal.wall.position.set(placedGroup.position.x, 0, placedGroup.position.z);
  portal.wall.rotation.set(0, placedGroup.rotation.y, 0);
  portal.wall.updateMatrixWorld(true);
  portal.logoHeight = placedGroup.position.y;
  portal.group.visible = true;
  portalOpen = true;
  startPersonFinder();
  updateChrome();
}

function closePortal() {
  portalOpen = false;
  stopPersonFinder();
  updateChrome();
}

function togglePortal() {
  if (portalOpen) closePortal(); else openPortal();
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_Z = new THREE.Vector3(0, 0, 1);

// Where each ring sits in the tunnel (world position + rotation).
function tunnelPose(ring, e, out) {
  const n = portal.rings.length;
  const order = n - 1 - ring.index;
  const goal = ringTarget(order, n, portal.logoHeight);
  const sway = Math.sin(performance.now() / 900 + ring.index) * 0.06;
  _v.set(goal.x * e, mix(portal.logoHeight, goal.y, e), mix(0.03, goal.z, e));
  out.pos.copy(portal.wall.localToWorld(_v));
  _e.set((goal.tiltX + sway) * e, (goal.tiltY - sway) * e, ring.angle);
  out.quat.copy(portal.wall.quaternion).multiply(_q.setFromEuler(_e));
  out.size = goal.size;
}

// Where each ring sits around the person: hoops at different heights that tilt, wobble and circle around them.
function orbitPose(ring, now, out) {
  const n = portal.rings.length;
  const k = ring.index;
  const h = person.height;
  const t = now / 1000;
  const base = 0.2 + (k / (n - 1)) * (h - 0.15);
  const y = Math.min(h + 0.15, Math.max(0.08, base + Math.sin(t * 1.1 + k * 0.8) * 0.16));
  out.pos.set(person.pos.x, y, person.pos.z);
  // Hoop size: the hole must be wider than the body.
  const outer = Math.max(0.95, (PERSON_RADIUS_M + 0.12) * 2 / ring.hole) + (k % 3) * 0.12;
  out.size = outer;
  const precess = t * (0.5 + (k % 4) * 0.12) * (k % 2 ? -1 : 1) + k * 1.3;
  const tilt = 0.28 + 0.14 * Math.sin(t * 0.8 + k);
  out.quat.setFromAxisAngle(AXIS_Y, precess)
    .multiply(_q.setFromAxisAngle(AXIS_X, tilt))
    .multiply(_q2.setFromAxisAngle(AXIS_X, -Math.PI / 2))
    .multiply(_q.setFromAxisAngle(AXIS_Z, ring.angle));
}

const poseA = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 1 };
const poseB = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 1 };

function updatePortal(dt) {
  if (!portal) return;
  const now = performance.now();
  portalT = Math.min(1, Math.max(0, portalT + (portalOpen ? dt / PORTAL_OPEN_MS : -dt / PORTAL_CLOSE_MS)));
  updatePerson(dt, now);
  const wantOrbit = portalOpen && person.found;
  orbitT = Math.min(1, Math.max(0, orbitT + (wantOrbit ? dt / ORBIT_IN_MS : -dt / ORBIT_OUT_MS)));

  portal.body.visible = portalT > 0 && orbitT > 0.3 && person.found;
  if (portal.body.visible) {
    portal.body.position.set(person.pos.x, person.height / 2, person.pos.z);
    portal.body.scale.set(1, person.height / (1 + 2 * PERSON_RADIUS_M), 1);
  }

  if (portalT === 0) {
    portal.group.visible = false;
    return;
  }
  portal.group.visible = true;
  const n = portal.rings.length;
  for (const ring of portal.rings) {
    // Rings are listed front first; the ones nearest the wall come out first.
    const order = n - 1 - ring.index;
    const delay = (order / n) * 0.45;
    const local = Math.min(1, Math.max(0, (portalT - delay) / (1 - delay)));
    const e = portalOpen ? easeOutBack(local) : ease(local);
    ring.angle += (ring.spin * dt) / 1000 * (1 + (1 - local) * 6 + orbitT * 1.5); // spin faster while flying and swirling

    tunnelPose(ring, e, poseA);
    let pos = poseA.pos, quat = poseA.quat, size = poseA.size;
    if (orbitT > 0) {
      orbitPose(ring, now, poseB);
      // Each ring leaves at a slightly different moment, and flies in an arc.
      const stagger = (ring.index / n) * 0.35;
      const f = ease(Math.min(1, Math.max(0, (orbitT - stagger) / (1 - stagger))));
      pos = _v2.copy(poseA.pos).lerp(poseB.pos, f);
      pos.y += Math.sin(Math.PI * f) * 0.35;
      quat = _q2.copy(poseA.quat).slerp(poseB.quat, f);
      size = mix(poseA.size, poseB.size, f);
    }
    ring.mesh.position.copy(pos);
    ring.mesh.quaternion.copy(quat);
    const s = Math.max(0.001, size * mix(0.12, 1, Math.max(e, orbitT)));
    ring.mesh.scale.set(s, s, 1);
    ring.mesh.material.opacity = Math.min(1, local * 3);
    ring.mesh.visible = local > 0;
  }
}

function easeOutBack(t) {
  const k = 1.4;
  const u = t - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
}

// ---------------------------------------------------------------- finding a person for the portal
// While the portal is open, a few times a second the camera picture goes to a body-point model
// (MoveNet, person-worker.js). When it sees a person, the rings fly over and swirl around them,
// and follow them as they move. Where the person stands is worked out from their feet on the floor
// (or, if the feet are out of the picture, from how wide their shoulders look).

const PERSON_RADIUS_M = 0.19;      // the body stand-in that hides ring parts behind the person
const PERSON_EVERY_MS = 110;
const PERSON_LOST_MS = 1500;       // rings go back to the wall after this long without seeing anyone
const ORBIT_IN_MS = 1300, ORBIT_OUT_MS = 1100;
const SHOULDER_WIDTH_M = 0.38;
const KP = { nose: 0, lShoulder: 5, rShoulder: 6, lHip: 11, rHip: 12, lAnkle: 15, rAnkle: 16 };

const person = {
  found: false, lastSeen: 0, pos: new THREE.Vector3(), target: new THREE.Vector3(),
  height: 1.7, targetHeight: 1.7, score: 0, ms: 0, how: '', screen: null,
};
let orbitT = 0;
let personWorker = null;
let personState = 'none'; // none | loading | ready | error
let personFinding = false;
let personBusy = false;
let personBusySince = 0;
let personLastGrab = 0;
let personScratch = null;
let personRequest = null;   // camera + picture layout at the moment the picture was taken
let personRequestId = 0;

function startPersonFinder() {
  personFinding = true;
  if (personState === 'none' || personState === 'error') loadPersonFinder();
}

function stopPersonFinder() {
  personFinding = false;
  person.found = false;
}

function loadPersonFinder() {
  if (personWorker) personWorker.terminate();
  personState = 'loading';
  try {
    personWorker = new Worker('person-worker.js?v=13');
  } catch (e) {
    console.warn('Person finder:', e);
    personState = 'error';
    return;
  }
  personWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') { personState = 'ready'; updateChrome(); }
    else if (msg.type === 'error') {
      console.warn('Person finder:', msg.message);
      personBusy = false;
      if (msg.during !== 'detect') { personState = 'error'; updateChrome(); }
    } else if (msg.type === 'pose') {
      personBusy = false;
      handlePose(msg);
    }
  };
  personWorker.onerror = (e) => { console.warn('Person worker error:', e.message); personState = 'error'; updateChrome(); };
  personWorker.postMessage({ type: 'load', base: new URL('person-model/', location.href).href, wasmBase: new URL('lib/tf/', location.href).href });
}

// The whole camera picture as shown on screen, fitted into the model's 192 x 192 square.
function grabPersonFrame() {
  const now = Date.now();
  if (personBusy && now - personBusySince > 3000) personBusy = false;
  if (!personFinding || personState !== 'ready' || personBusy || now - personLastGrab < PERSON_EVERY_MS) return;
  const v = cameraVideo;
  if (!v || v.readyState < 2 || !v.videoWidth || !xrCamera) return;
  personLastGrab = now;
  const W = window.innerWidth, H = window.innerHeight, vw = v.videoWidth, vh = v.videoHeight;
  const scale = Math.max(W / vw, H / vh);
  const sw = W / scale, sh = H / scale;           // the part of the video that is on screen
  const S = 192, fit = S / Math.max(sw, sh);
  const dw = sw * fit, dh = sh * fit, ox = (S - dw) / 2, oy = (S - dh) / 2;
  if (!personScratch) { personScratch = document.createElement('canvas'); personScratch.width = personScratch.height = S; }
  const ctx = personScratch.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, ox, oy, dw, dh);
  const pixels = ctx.getImageData(0, 0, S, S).data.buffer;
  xrCamera.updateMatrixWorld();
  personRequest = {
    id: ++personRequestId, ox, oy, dw, dh, S,
    world: xrCamera.matrixWorld.clone(),
    projInv: xrCamera.projectionMatrix.clone().invert(),
    camPos: new THREE.Vector3().setFromMatrixPosition(xrCamera.matrixWorld),
  };
  personBusy = true;
  personBusySince = now;
  personWorker.postMessage({ type: 'detect', pixels, id: personRequest.id }, [pixels]);
}

// A body point (model coordinates) -> a ray from the camera into the room, as the camera was when the picture was taken.
function pointRay(req, points, index) {
  const y = points[index * 3] * req.S, x = points[index * 3 + 1] * req.S;
  const nx = ((x - req.ox) / req.dw) * 2 - 1, ny = -(((y - req.oy) / req.dh) * 2 - 1);
  const p = new THREE.Vector3(nx, ny, 0.5).applyMatrix4(req.projInv).applyMatrix4(req.world);
  return { dir: p.sub(req.camPos).normalize(), score: points[index * 3 + 2], sx: (nx + 1) / 2, sy: (1 - ny) / 2 };
}

function floorPoint(origin, dir, floorY = 0) {
  if (dir.y > -0.02) return null;
  const t = (floorY - origin.y) / dir.y;
  return t > 0 ? origin.clone().addScaledVector(dir, t) : null;
}

function handlePose({ points, id, ms }) {
  const req = personRequest;
  if (!req || req.id !== id || !personFinding) return;
  person.ms = ms;
  const r = (k) => pointRay(req, points, k);
  const ls = r(KP.lShoulder), rs = r(KP.rShoulder), lh = r(KP.lHip), rh = r(KP.rHip);
  const torso = (ls.score + rs.score + lh.score + rh.score) / 4;
  person.score = torso;
  window.__lastPose = { torso: Number(torso.toFixed(2)), ms };
  if (torso < 0.3 || ls.score < 0.25 || rs.score < 0.25) return; // no clear person in view

  const cam = req.camPos;
  const la = r(KP.lAnkle), ra = r(KP.rAnkle), nose = r(KP.nose);
  const feet = [la, ra].filter((a) => a.score > 0.3);
  let ground = null;
  if (feet.length) {
    const dir = feet.reduce((acc, a) => acc.add(a.dir), new THREE.Vector3()).normalize();
    ground = floorPoint(cam, dir);
    if (ground && Math.hypot(ground.x - cam.x, ground.z - cam.z) > 12) ground = null;
  }
  let how = 'feet';
  if (!ground) {
    // Feet not visible: judge the distance by how wide the shoulders look.
    how = 'shoulders';
    const angle = ls.dir.angleTo(rs.dir);
    const dist = Math.min(8, Math.max(0.6, SHOULDER_WIDTH_M / Math.max(angle, 0.01)));
    const mid = ls.dir.clone().add(rs.dir).normalize();
    const p = cam.clone().addScaledVector(mid, dist);
    ground = new THREE.Vector3(p.x, 0, p.z);
  }
  // Height: where the nose ray passes above the spot the person stands on.
  let height = 1.7;
  if (how === 'feet' && nose.score > 0.3) {
    const horiz = Math.hypot(ground.x - cam.x, ground.z - cam.z);
    const dh = Math.hypot(nose.dir.x, nose.dir.z);
    if (dh > 0.05) height = Math.min(2.1, Math.max(1.0, cam.y + nose.dir.y * (horiz / dh) + 0.12));
  }

  person.target.set(ground.x, 0, ground.z);
  person.targetHeight = height;
  if (!person.found) { person.pos.copy(person.target); person.height = height; }
  person.found = true;
  person.lastSeen = performance.now();
  person.how = how;
  person.screen = { x: Number(((ls.sx + rs.sx) / 2).toFixed(2)), y: Number(((ls.sy + lh.sy) / 2).toFixed(2)) };
  updateChrome();
}

function updatePerson(dt, now) {
  if (person.found && now - person.lastSeen > PERSON_LOST_MS) { person.found = false; updateChrome(); }
  if (!person.found) return;
  const f = 1 - Math.exp(-dt / 180); // glide towards the newest position, so the rings move smoothly
  person.pos.lerp(person.target, f);
  person.height += (person.targetHeight - person.height) * f;
}

// ---------------------------------------------------------------- taking a photo

function takePhoto() {
  if (!running) return;
  photoWanted = true; // the picture is copied right after the next frame is drawn (see onRender)
}

function capturePhoto() {
  photoWanted = false;
  const src = $('#xr');
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  try { ctx.drawImage(src, 0, 0, w, h); } catch (e) { console.warn('Photo:', e); return; }

  // A small Youth Speak frame along the bottom.
  const u = w / 390;
  const barH = 64 * u;
  const g = ctx.createLinearGradient(0, h - barH * 1.8, 0, h);
  g.addColorStop(0, 'rgba(43, 26, 102, 0)');
  g.addColorStop(1, 'rgba(43, 26, 102, 0.75)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h - barH * 1.8, w, barH * 1.8);
  const lh = 46 * u, lw = lh * (LOGO_W / LOGO_H);
  if (logoStill.complete && logoStill.naturalWidth) ctx.drawImage(logoStill, 16 * u, h - barH + (barH - lh) / 2 - 6 * u, lw, lh);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(900, 22 * u);
  ctx.fillText(content.forumTitle, 16 * u + lw + 10 * u, h - barH / 2 - 6 * u);

  const url = out.toDataURL('image/jpeg', 0.9);
  out.toBlob((blob) => {
    lastPhoto = { url, blob };
    showPhoto();
  }, 'image/jpeg', 0.9);
}

function showPhoto() {
  if (!lastPhoto) return;
  const file = lastPhoto.blob ? new File([lastPhoto.blob], 'youth-speak-portal.jpg', { type: 'image/jpeg' }) : null;
  const canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
  openSheet('photo', null,
    el('h2', {}, 'Your portal photo'),
    el('img', { class: 'photo', src: lastPhoto.url, alt: 'Photo of the Youth Speak portal' }),
    canShare
      ? el('button', { class: 'btn primary', onclick: () => navigator.share({ files: [file], title: content.forumTitle }).catch(() => {}) }, 'Share or save')
      : el('a', { class: 'btn primary link-btn', href: lastPhoto.url, download: 'youth-speak-portal.jpg' }, 'Download'),
    el('p', { class: 'muted' }, 'You can also press and hold the photo to save it.'),
    el('button', { class: 'btn', onclick: closeSheet }, 'Back to the portal'),
  );
}

// ---------------------------------------------------------------- animated logo
// Phone browsers cannot play a video with a see-through background, so each logo video stores two
// black-and-white shapes side by side: left = where the purple goes, right = where the white megaphone goes.
// Every frame is rebuilt on a canvas from those two shapes, which gives a transparent animation
// on iPhone and Android alike.

const LOGO_W = 460, LOGO_H = 550;
const LOGO_RGB = [117, 81, 204];

function createLogo() {
  const canvas = el('canvas', { width: LOGO_W, height: LOGO_H });
  const ctx = canvas.getContext('2d');
  const scratch = document.createElement('canvas');
  scratch.width = LOGO_W * 2;
  scratch.height = LOGO_H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const out = ctx.createImageData(LOGO_W, LOGO_H);
  const level = (v) => (v < 12 ? 0 : v > 243 ? 255 : v); // cleans up video compression noise

  const ext = document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401F"') ? 'mp4' : 'webm';
  const makeVideo = (name, loops) => {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.loop = loops;
    v.src = `logo/${name}.${ext}`;
    return v;
  };
  const intro = makeVideo('intro', false); // plays once when the wall is recognised
  const loop = makeVideo('loop', true);    // then this one repeats
  const still = new Image();               // fallback if the phone refuses to play the videos
  still.src = 'logo/logo.png';

  let phase = 'hidden'; // hidden | intro | loop | still
  let dirty = false;    // the picture changed since the 3D view last copied it
  let lastTime = -1;
  let drewFrame = false;
  let watchdog = 0;

  const isActive = (v) => (phase === 'intro' && v === intro) || (phase === 'loop' && v === loop);

  function showStill() {
    if (phase === 'hidden') return;
    phase = 'still';
    intro.pause();
    loop.pause();
    const paint = () => { ctx.clearRect(0, 0, LOGO_W, LOGO_H); ctx.drawImage(still, 0, 0, LOGO_W, LOGO_H); dirty = true; };
    if (still.complete && still.naturalWidth) paint(); else still.onload = paint;
  }

  function startLoop() {
    phase = 'loop';
    lastTime = -1;
    if (loop.error) { showStill(); return; }
    try { loop.currentTime = 0; } catch { /* not loaded yet: starts at 0 anyway */ }
    loop.play().catch(showStill);
  }

  intro.addEventListener('ended', () => { if (phase === 'intro') startLoop(); });
  intro.addEventListener('error', () => { if (phase === 'intro') showStill(); });
  loop.addEventListener('error', () => { if (phase === 'loop') showStill(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isActive(loop)) loop.play().catch(() => {});
  });

  return {
    canvas,
    get phase() { return phase; },
    takeDirty() { const d = dirty; dirty = false; return d; },

    prime() {
      for (const v of [intro, loop]) {
        const p = v.play();
        if (p) p.then(() => { if (!isActive(v)) v.pause(); }).catch(() => {});
      }
    },

    // Play the intro once, then the loop.
    appear() {
      phase = 'intro';
      lastTime = -1;
      drewFrame = false;
      ctx.clearRect(0, 0, LOGO_W, LOGO_H);
      dirty = true;
      loop.pause();
      if (intro.error) { showStill(); return; }
      try { intro.currentTime = 0; } catch { /* not loaded yet */ }
      intro.play().catch(showStill);
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { if (phase === 'intro' && !drewFrame) showStill(); }, 2500);
    },

    sleep() { if (phase === 'loop') loop.pause(); },
    wake() { if (phase === 'loop') loop.play().catch(() => {}); },

    // Called every frame from the render loop.
    draw() {
      const v = phase === 'intro' ? intro : phase === 'loop' ? loop : null;
      if (!v || v.readyState < 2) return;
      const t = v.currentTime;
      if (t === lastTime) return;
      lastTime = t;
      let src;
      try {
        sctx.drawImage(v, 0, 0, LOGO_W * 2, LOGO_H);
        src = sctx.getImageData(0, 0, LOGO_W * 2, LOGO_H).data;
      } catch { showStill(); return; }
      const dst = out.data;
      const [pr, pg, pb] = LOGO_RGB;
      for (let y = 0, o = 0; y < LOGO_H; y++) {
        let i = y * LOGO_W * 8;      // this row in the left half (purple shape)
        let j = i + LOGO_W * 4;      // same row in the right half (white shape)
        for (let x = 0; x < LOGO_W; x++, i += 4, j += 4, o += 4) {
          const a = level(src[i]);
          const w = level(src[j]);
          if (w === 0) {
            dst[o] = pr; dst[o + 1] = pg; dst[o + 2] = pb; dst[o + 3] = a;
          } else {
            const t = a + w;
            dst[o] = (pr * a + 255 * w) / t;
            dst[o + 1] = (pg * a + 255 * w) / t;
            dst[o + 2] = (pb * a + 255 * w) / t;
            dst[o + 3] = t > 255 ? 255 : t;
          }
        }
      }
      ctx.putImageData(out, 0, 0);
      drewFrame = true;
      dirty = true;
    },
  };
}

// ---------------------------------------------------------------- recognising the real pen
// An image model in the Teachable Machine format (pen-model/): MobileNetV2 image features plus a small
// part trained on videos of the pen and of the room without it. It runs in a background worker
// (pen-worker.js) on the processor, so it cannot slow down or freeze the AR view. A few times a second
// the middle of the camera picture is sent to it. Its classes are named after the hunt objects
// (e.g. "Pen") plus a "Nothing" class. See README: "The pen detector".

const SCAN_EVERY_MS = 350;
const LOAD_TIMEOUT_MS = 45000;
let scanning = false;
let modelState = 'none'; // none | loading | ready | missing | error
let modelLabels = [];
let modelSize = 224;
let worker = null;
let loadTimer = 0;
let lastGrab = 0;
let inferring = false;
let inferringSince = 0;
const streaks = new Map();
let scratch = null;

function modelBase() {
  const base = content.huntModel || 'pen-model/';
  return new URL(base.endsWith('/') ? base : `${base}/`, location.href).href;
}

function setModelState(state) {
  modelState = state;
  if (currentSheet && currentSheet.kind === 'hunt') openHunt();
  updateChrome();
}

function ensureModel() {
  if (!content || modelState === 'loading' || modelState === 'ready') return;
  if (worker) worker.terminate();
  modelState = 'loading';
  updateChrome();
  try {
    worker = new Worker('pen-worker.js?v=13');
  } catch (e) {
    console.warn('Hunt worker:', e);
    setModelState('error');
    return;
  }
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      clearTimeout(loadTimer);
      modelLabels = msg.labels;
      modelSize = msg.size;
      setModelState('ready');
    } else if (msg.type === 'missing') {
      clearTimeout(loadTimer);
      setModelState('missing');
    } else if (msg.type === 'error') {
      console.warn('Hunt detector:', msg.message);
      inferring = false;
      if (msg.during !== 'classify') { clearTimeout(loadTimer); setModelState('error'); }
    } else if (msg.type === 'result') {
      inferring = false;
      handlePrediction(msg.probs, msg.ms);
    }
  };
  worker.onerror = (e) => { console.warn('Hunt worker error:', e.message); clearTimeout(loadTimer); setModelState('error'); };
  worker.postMessage({ type: 'load', base: modelBase(), wasmBase: new URL('lib/tf/', location.href).href });
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => { if (modelState === 'loading') setModelState('error'); }, LOAD_TIMEOUT_MS);
}

function startScanning() {
  closeSheet();
  streaks.clear();
  scanning = true;
  if (modelState !== 'ready') ensureModel();
  updateChrome();
}

function stopScanning() {
  scanning = false;
  streaks.clear();
  updateChrome();
}

// The middle square of what the screen shows, taken from the camera video (cheap, no graphics read-back).
function grabScanFrame() {
  const now = Date.now();
  if (inferring && now - inferringSince > 3000) inferring = false; // never wait forever for an answer
  if (modelState !== 'ready' || inferring || now - lastGrab < SCAN_EVERY_MS) return;
  const v = cameraVideo;
  if (!v || v.readyState < 2 || !v.videoWidth) return;
  lastGrab = now;
  const vw = v.videoWidth, vh = v.videoHeight;
  // The video fills the screen and is cropped at the sides or the top and bottom.
  const scale = Math.max(window.innerWidth / vw, window.innerHeight / vh);
  const side = Math.min(window.innerWidth, window.innerHeight) / scale;
  if (!scratch) scratch = document.createElement('canvas');
  scratch.width = scratch.height = modelSize;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, modelSize, modelSize);
  const pixels = ctx.getImageData(0, 0, modelSize, modelSize).data.buffer;
  inferring = true;
  inferringSince = now;
  worker.postMessage({ type: 'classify', pixels }, [pixels]);
}

function handlePrediction(probs, ms) {
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  const label = String(modelLabels[best] || '').trim().toLowerCase();
  window.__lastPrediction = { label, p: probs[best], ms };
  if (!scanning) return;
  const item = content.hunt.find((h) => String(h.modelClass || '').trim().toLowerCase() === label);
  const threshold = content.huntConfidence || 0.9;
  if (item && probs[best] >= threshold) {
    const n = (streaks.get(item.id) || 0) + 1;
    streaks.clear();
    streaks.set(item.id, n);
    if (n >= 3) { // seen in 3 checks in a row (about one second) to avoid false alarms
      stopScanning();
      onHuntObjectFound(item);
    }
  } else {
    streaks.clear();
  }
}

// ---------------------------------------------------------------- scavenger hunt

function onHuntObjectFound(item) {
  if (currentSheet && currentSheet.kind === 'discovery') return;
  if (currentSheet && currentSheet.kind !== 'hunt') return; // don't interrupt directions or the leaderboard
  const until = discoveryCooldown.get(item.id) || 0;
  if (Date.now() < until) return;
  showDiscovery(item);
}

function showDiscovery(item) {
  const already = isFound(item);
  const videoBox = el('div', { class: 'video-box' });
  const video = el('video', { src: item.video, playsinline: true, controls: true, muted: true, autoplay: true, preload: 'auto' });
  video.muted = true;
  video.addEventListener('error', () => {
    videoBox.replaceChildren(`Video placeholder: add ${item.video}`);
  });
  videoBox.append(video);
  video.play().catch(() => { /* autoplay blocked: the controls let people start it */ });

  const actions = el('div', { class: 'sheet-actions' });
  const renderActions = () => {
    actions.replaceChildren();
    actions.style.display = 'flex';
    actions.style.flexDirection = 'column';
    actions.style.gap = '10px';
    if (isFound(item)) {
      actions.append(el('button', { class: 'btn primary', onclick: () => continueHunt(item) }, 'Continue the hunt'));
    } else {
      actions.append(el('button', {
        class: 'btn primary',
        onclick: () => {
          claim(item);
          actions.replaceChildren(
            el('p', { class: 'big' }, `+${item.points} points! Total: ${score()}`),
            el('button', { class: 'btn primary', onclick: () => continueHunt(item) }, 'Continue the hunt'),
          );
        },
      }, `Claim ${item.points} points`));
    }
    actions.append(el('button', { class: 'btn', onclick: () => { cooldown(item); closeSheet(); } }, 'Close'));
  };
  renderActions();

  openSheet('discovery', item.id,
    el('h2', {}, already ? `Already found: ${item.name}` : `You found: ${item.name}`),
    videoBox,
    el('p', { class: 'muted' }, 'Tap the video for sound.'),
    el('p', { class: 'quote' }, `"${item.line}"`),
    el('p', {}, item.fact),
    actions,
  );
}

function cooldown(item) {
  discoveryCooldown.set(item.id, Date.now() + 10000);
}

function continueHunt(item) {
  cooldown(item);
  openHunt();
}

function openHunt() {
  const found = content.hunt.filter(isFound).length;
  if (modelState === 'none') ensureModel(); // start loading early, without blocking the sheet
  const list = el('ul', { class: 'list' });
  for (const item of content.hunt) {
    const done = isFound(item);
    list.append(el('li', { class: done ? 'done' : '' },
      el('span', {}, `${done ? '✓' : '?'}  ${item.name}`),
      el('span', { class: 'pts' }, `${item.points} pts`),
    ));
  }
  openSheet('hunt', null,
    el('h2', {}, 'Scavenger hunt'),
    el('p', {}, 'Find the hidden objects around the venue and point your camera at them.'),
    el('p', { class: 'big' }, `Your points: ${score()}   |   Found: ${found} of ${content.hunt.length}`),
    list,
    modelState === 'missing'
      ? el('p', { class: 'note' }, 'The object detector has not been added yet. See the README: "Train the pen detector".')
      : modelState === 'error'
        ? el('button', { class: 'btn primary', onclick: () => { modelState = 'none'; startScanning(); } }, 'Try loading the object detector again')
        : el('button', { class: 'btn primary', onclick: startScanning }, 'Find the objects (start scanning)'),
    el('button', { class: 'btn', onclick: openLeaderboard }, 'Live leaderboard'),
    el('button', { class: 'btn', onclick: closeSheet }, 'Close'),
    el('button', { class: 'btn small', onclick: () => { resetProgress(); openHunt(); } }, 'Reset progress (testing)'),
  );
}

function openLeaderboard() {
  const rows = [...content.sampleLeaderboard.map((r) => ({ ...r, you: false })), { name: 'You', points: score(), you: true }];
  rows.sort((a, b) => (b.points - a.points) || (Number(b.you) - Number(a.you)));
  const list = el('ul', { class: 'list' });
  rows.forEach((r, i) => list.append(el('li', { class: r.you ? 'you done' : '' },
    el('span', {}, `${i + 1}.  ${r.name}`),
    el('span', { class: 'pts' }, `${r.points} pts`),
  )));
  openSheet('leaderboard', null,
    el('h2', {}, 'Live leaderboard'),
    el('p', { class: 'muted' }, 'Sample players for now. The live version needs a free Firebase project.'),
    list,
    el('button', { class: 'btn primary', onclick: openHunt }, 'Back to the hunt'),
    el('button', { class: 'btn', onclick: closeSheet }, 'Close'),
  );
}

// ---------------------------------------------------------------- directions (2D map + steps)

function directionSteps(s) {
  const steps = ['Stand with your back to the agenda.'];
  if (s.ahead > 0) steps.push(`Walk about ${s.ahead} m straight ahead.`);
  if (s.side) steps.push(`${s.ahead > 0 ? 'Turn' : 'Go'} ${s.side > 0 ? 'right' : 'left'} and walk about ${Math.abs(s.side)} m.`);
  steps.push(`${s.room} is there.`);
  return steps;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function buildMap(target) {
  const pts = content.sessions.map((s) => ({ x: s.side || 0, y: s.ahead || 0 }));
  const xs = [0, ...pts.map((p) => p.x)];
  const ys = [0, ...pts.map((p) => p.y)];
  const minX = Math.min(...xs) - 3, maxX = Math.max(...xs) + 3;
  const maxY = Math.max(...ys) + 2.5, minY = -1.5;
  const W = 340, scale = W / (maxX - minX), H = Math.round((maxY - minY) * scale);
  const X = (x) => (x - minX) * scale;
  const Y = (y) => H - (y - minY) * scale;

  const map = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'map', role: 'img', 'aria-label': `Map from the agenda to ${content.sessions[target].room}` });
  // 1 m grid
  for (let gx = Math.ceil(minX); gx <= maxX; gx++) map.append(svg('line', { x1: X(gx), y1: 0, x2: X(gx), y2: H, stroke: '#ece8f8', 'stroke-width': 1 }));
  for (let gy = Math.ceil(minY); gy <= maxY; gy++) map.append(svg('line', { x1: 0, y1: Y(gy), x2: W, y2: Y(gy), stroke: '#ece8f8', 'stroke-width': 1 }));
  // wall with the poster
  map.append(svg('line', { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: '#2b1a66', 'stroke-width': 3 }));
  map.append(svg('rect', { x: X(0) - 14, y: Y(0) - 3, width: 28, height: 9, fill: '#2b1a66' }));
  const posterLabel = svg('text', { x: X(0), y: Y(0) + 24, 'text-anchor': 'middle', 'font-size': 12, fill: '#6b6585' });
  posterLabel.textContent = 'Agenda (start)';
  map.append(posterLabel);

  // route
  const s = content.sessions[target];
  const route = `M${X(0)} ${Y(0.6)} L${X(0)} ${Y(s.ahead || 0)} L${X(s.side || 0)} ${Y(s.ahead || 0)}`;
  map.append(svg('path', { d: route, fill: 'none', stroke: '#7551cc', 'stroke-width': 4, 'stroke-dasharray': '8 6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  map.append(svg('circle', { cx: X(0), cy: Y(0.6), r: 6, fill: '#7551cc' }));

  // rooms
  content.sessions.forEach((r, i) => {
    const on = i === target;
    map.append(svg('circle', { cx: X(r.side || 0), cy: Y(r.ahead || 0), r: on ? 9 : 6, fill: on ? '#7551cc' : '#b9b0d6' }));
    const label = svg('text', { x: X(r.side || 0), y: Y(r.ahead || 0) - 14, 'text-anchor': 'middle', 'font-size': on ? 14 : 12, 'font-weight': on ? 700 : 400, fill: on ? '#2b1a66' : '#6b6585' });
    label.textContent = r.room;
    map.append(label);
  });
  return map;
}

function openDirections(index) {
  const s = content.sessions[index];
  const distance = Math.round(Math.abs(s.ahead || 0) + Math.abs(s.side || 0));
  const steps = el('ol', { class: 'steps' }, ...directionSteps(s).map((t) => el('li', {}, t)));
  openSheet('directions', index,
    el('h2', {}, `Directions to ${s.room}`),
    el('p', { class: 'muted' }, `${s.title}  |  ${s.time}  |  about ${distance} m`),
    buildMap(index),
    steps,
    el('button', { class: 'btn primary', onclick: closeSheet }, 'Done'),
  );
}

// ---------------------------------------------------------------- sheet + chrome

function openSheet(kind, id, ...children) {
  const body = $('#sheet-body');
  body.querySelectorAll('video').forEach((v) => v.pause());
  body.replaceChildren(...children);
  body.scrollTop = 0;
  currentSheet = { kind, id };
  $('#sheet').hidden = false;
  updateChrome();
}

function closeSheet() {
  const body = $('#sheet-body');
  body.querySelectorAll('video').forEach((v) => v.pause());
  body.replaceChildren();
  currentSheet = null;
  $('#sheet').hidden = true;
  updateChrome();
}

function updateChrome() {
  const banner = $('#banner');
  let hint = null;
  if (running && !currentSheet) {
    if (scanning) {
      hint = modelState === 'loading' ? 'Loading the object detector... (a few seconds the first time)'
        : modelState === 'error' ? 'The object detector could not load. Tap "Stop scanning" and try again.'
        : 'Point the camera at the hidden object';
    } else if (!placed) {
      hint = trackingReady()
        ? 'Aim the dot where the wall meets the floor, then tap "Place here"'
        : 'Point the camera at the floor and move the phone slowly from side to side';
    } else if (tracking !== 'NORMAL') {
      hint = 'Lost track of the room: point at the floor or furniture and move slowly';
    } else if (portalOpen) {
      hint = person.found ? 'The rings found someone! Tap "Take photo"'
        : personState === 'loading' ? 'Getting the portal ready... (a few seconds the first time)'
        : 'Point the camera at a friend: the rings will fly over and swirl around them';
    } else if (!inView) {
      hint = 'Look around to find the agenda';
    } else if (!agendaOpen) {
      hint = 'Tap the logo to open the agenda';
    } else if (selectedSession < 0) {
      hint = 'Tap a session to see its brief';
    } else {
      hint = 'The brief is to the right of the agenda →';
    }
  }
  banner.hidden = hint === null;
  if (hint) banner.textContent = hint;

  $('#bar').hidden = !running || Boolean(currentSheet);
  $('#reticle').hidden = !running || placed || scanning || Boolean(currentSheet);
  $('#scan-frame').hidden = !running || !scanning || Boolean(currentSheet);
  $('#btn-place').hidden = scanning || portalOpen;
  $('#btn-portal').hidden = !placed || scanning;
  $('#btn-portal').textContent = portalOpen ? 'Close portal' : 'Portal';
  $('#btn-photo').hidden = !portalOpen || scanning;
  $('#btn-hunt').hidden = portalOpen;
  $('#btn-place').textContent = placed ? 'Move here' : 'Place here';
  $('#btn-place').disabled = !placed && !trackingReady();
  $('#btn-stop-scan').hidden = !scanning;
}

// ---------------------------------------------------------------- wire up

$('#btn-start').addEventListener('click', start);
// iPhone ignores "no zoom" in the page settings: block pinch and double-tap zoom so the view stays put.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
$('#btn-place').addEventListener('click', placeHere);
// Taps on the agenda: the screen point is traced into the room to see what it hits.
$('#xr').addEventListener('pointerdown', (e) => { pressAt = { x: e.clientX, y: e.clientY, t: Date.now() }; });
$('#xr').addEventListener('pointerup', (e) => {
  const p = pressAt;
  pressAt = null;
  if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 20 || Date.now() - p.t > 800) return;
  onStageTap(e.clientX, e.clientY);
});
$('#btn-hunt').addEventListener('click', openHunt);
$('#btn-portal').addEventListener('click', togglePortal);
$('#btn-photo').addEventListener('click', takePhoto);
$('#btn-stop-scan').addEventListener('click', stopScanning);
$('#app-version').textContent = APP_VERSION;

loadContent()
  .then((c) => { content = c; })
  .catch(() => { /* retried on Start */ });

// A small hook for automated testing.
window.__ysf = {
  get state() {
    return { running, placed, tracking, ready: trackingReady(), inView, agendaOpen, logo: logo ? logo.phase : null, selectedSession,
      sheet: currentSheet, scanning, modelState, frames: renderedFrames, score: score(), found: foundMap(),
      placedInfo, openT: Number(openT.toFixed(2)), briefT: Number(briefT.toFixed(2)),
      portal: portalOpen, portalT: Number(portalT.toFixed(2)), portalBuilt: Boolean(portal),
      orbitT: Number(orbitT.toFixed(2)), personState,
      person: { found: person.found, how: person.how, score: Number(person.score.toFixed(2)), ms: person.ms, screen: person.screen,
        pos: person.pos.toArray().map((n) => Number(n.toFixed(2))), height: Number(person.height.toFixed(2)) },
      photo: lastPhoto ? { bytes: lastPhoto.blob ? lastPhoto.blob.size : 0, length: lastPhoto.url.length } : null };
  },
  togglePortal,
  takePhoto,
  placeHere,
  screenPointOf,
  turn(radians) { if (placedGroup) placedGroup.rotation.y += radians; }, // lets a test look at the back
  // Lets a test "step back": moves the agenda and the portal further away.
  away(metres) {
    for (const g of [placedGroup, portal && portal.group]) {
      if (!g) continue;
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(g.quaternion).multiplyScalar(metres);
      g.position.add(back);
    }
  },
};
