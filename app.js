// Youth Speak AR - web app.
// Flow: Start -> aim at a wall and tap "Place here" -> the logo animates in, pinned in the room, and loops
//       -> tap the logo -> the agenda opens -> tap a session -> brief -> directions.
//       Scavenger hunt: point the camera at the real pen -> a trained image model recognises it -> claim points.
//
// World tracking: 8th Wall XR Engine (lib/xr). This product includes the XR Engine software developed by
// Niantic Spatial, Inc. Copyright (c) 2026 Niantic Spatial, Inc. Licensed under the XR Engine License Agreement
// (lib/xr/LICENSE), which also contains the disclaimer of warranties.
// 3D maths and the HTML-in-3D renderer: three.js (MIT). Object recognition: TensorFlow.js (Apache 2.0).

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

window.THREE = THREE; // the XR engine's three.js module looks for THREE here

const APP_VERSION = 'v9';

// Real-world sizes, in metres. The agenda card in the design is 1360 px tall.
const CARD_HEIGHT_M = 1.0;
const PX_TO_M = CARD_HEIGHT_M / 1360;
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
let stageEl = null;       // front: logo, agenda card, brief
let backEl = null;        // what you see from behind
let briefRoot = null;
let stageObj = null;
let backObj = null;
let placedGroup = null;   // pinned in the room
let cssScene = null;
let cssRenderer = null;
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
  if (cssRenderer) cssRenderer.setSize(window.innerWidth, window.innerHeight);
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
        const { camera } = XR8.Threejs.xrScene();
        xrCamera = camera;
        camera.position.set(0, EYE_HEIGHT_M, 0);
        XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });
        running = true;
        clearTimeout(slowNote);
        setTimeout(ensureModel, 1500); // load the pen detector in the background
        $('#start').hidden = true;
        updateChrome();
      },
      onCameraStatusChange: ({ status, video }) => {
        if (status === 'hasVideo' && video) cameraVideo = video;
        if (status === 'failed') fail('The camera did not start. Allow camera access for this site in your browser settings, then reload.');
      },
      onUpdate: ({ processCpuResult }) => {
        const reality = processCpuResult && processCpuResult.reality;
        if (reality && reality.trackingStatus && reality.trackingStatus !== tracking) {
          tracking = reality.trackingStatus;
          updateChrome();
        }
      },
      onRender: () => {
        if (!xrCamera) return;
        renderedFrames++;
        updateInView();
        logo.draw();
        cssRenderer.render(cssScene, xrCamera);
        if (scanning) grabScanFrame();
      },
      onCanvasSizeChange: () => { if (cssRenderer) cssRenderer.setSize(window.innerWidth, window.innerHeight); },
      onException: (e) => {
        if (e && e.type === 'permission') fail('Camera and motion access are needed. Allow them for this site, then reload.');
      },
    },
  ]);
  XR8.run({ canvas: $('#xr'), allowedDevices: XR8.XrConfig.device().ANY });
}

// ---------------------------------------------------------------- the stage, pinned in the room
// Laid out in the pixels of the agenda design (1231 x 1727) and shrunk to metres.

function buildStage() {
  const sessions = el('div', { class: 'ar-sessions' });
  content.sessions.forEach((s, i) => {
    sessions.append(el('button', { class: 'ar-session', 'data-index': i, onclick: () => showBrief(i) },
      el('span', { class: 'title' }, s.title),
      el('span', { class: 'meta' }, `${s.room}  |  ${s.time}`),
    ));
  });

  const card = el('div', { class: 'ar-card' },
    el('div', { class: 'ar-head' },
      el('h1', {}, content.forumTitle),
      el('p', {}, 'AGENDA'),
    ),
    sessions,
    el('div', { class: 'ar-actions' },
      el('button', { class: 'ar-pill ghost', onclick: closeAgenda }, 'Close agenda'),
      el('button', { class: 'ar-pill solid', onclick: openHunt }, 'Scavenger Hunt'),
    ),
  );

  const logoButton = el('button', { class: 'ar-logo', 'aria-label': 'Open the agenda', onclick: toggleAgenda }, logo.canvas);
  briefRoot = el('div', { class: 'ar-brief is-closed' });
  stageEl = el('div', { class: 'ar-stage solo' }, card, briefRoot, logoButton);

  // The back: seen when you walk behind it. Mirrored, so the logo stays on the same side of the room.
  backEl = el('div', { class: 'ar-back solo' },
    el('div', { class: 'back-card' }, el('p', {}, content.forumTitle)),
    el('img', { class: 'back-logo', src: 'logo/logo.png', alt: '' }),
  );

  cssScene = new THREE.Scene();
  cssRenderer = new CSS3DRenderer();
  cssRenderer.setSize(window.innerWidth, window.innerHeight);
  $('#css3d').append(cssRenderer.domElement);

  stageObj = new CSS3DObject(stageEl);
  backObj = new CSS3DObject(backEl);
  backObj.rotation.y = Math.PI;
  for (const o of [stageObj, backObj]) {
    o.scale.setScalar(PX_TO_M);
    o.visible = false;
  }
  placedGroup = new THREE.Group();
  placedGroup.add(stageObj, backObj);
  cssScene.add(placedGroup);
}

// Pin the stage upright, facing you, on the wall you are aiming at.
function placeHere() {
  if (!running || !xrCamera) return;
  const pos = xrCamera.position.clone();
  const forward = new THREE.Vector3();
  xrCamera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
  forward.normalize();

  // A plain wall has almost nothing to measure, so use a fixed distance unless the engine
  // found real points on the wall straight ahead.
  let distance = DEFAULT_DISTANCE_M;
  try {
    const hits = window.XR8.XrController.hitTest(0.5, 0.5, ['FEATURE_POINT']) || [];
    const ahead = hits
      .map((h) => Math.hypot(h.position.x - pos.x, h.position.z - pos.z))
      .filter((d) => d > 0.6 && d < 4)
      .sort((a, b) => a - b);
    if (ahead.length) distance = ahead[0] - 0.03;
  } catch { /* keep the fixed distance */ }

  placedGroup.position.set(pos.x + forward.x * distance, pos.y - 0.1, pos.z + forward.z * distance);
  placedGroup.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
  placedGroup.updateMatrixWorld(true);
  stageObj.visible = true;
  backObj.visible = false;

  placed = true;
  closeAgenda();
  inView = true;
  lastSeenAt = Date.now();
  stageEl.classList.add('has-logo');
  logo.appear();
  updateChrome();
}

// Shows the front or the back depending on which side of it you are standing,
// replays the logo intro when you come back to it after looking away, and saves battery while it is off-screen.
// Points (in metres, relative to the centre of the stage) used to decide whether any part of it is on screen.
const VIEW_POINTS = [[0, 0], [-0.4, 0.5], [0.4, 0.5], [-0.4, -0.5], [0.4, -0.5], [0.15, 0.6]];
const BRIEF_POINTS = [[0.75, -0.1], [0.75, 0.4], [0.75, -0.6]];
const projected = new THREE.Vector3();
const facing = new THREE.Vector3();
function anyPointOnScreen() {
  const pts = selectedSession >= 0 && agendaOpen ? VIEW_POINTS.concat(BRIEF_POINTS) : VIEW_POINTS;
  for (const [x, y] of pts) {
    projected.set(x, y, 0);
    placedGroup.localToWorld(projected);
    projected.project(xrCamera);
    if (projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1) return true;
  }
  return false;
}
function updateInView() {
  if (!placed) return;
  facing.set(0, 0, 1).applyQuaternion(placedGroup.quaternion);
  const inFront = projected.copy(xrCamera.position).sub(placedGroup.position).dot(facing) >= 0;
  if (stageObj.visible !== inFront) { stageObj.visible = inFront; backObj.visible = !inFront; }
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
  agendaOpen = true;
  stageEl.classList.remove('solo');
  backEl.classList.remove('solo');
  updateChrome();
}

function closeAgenda() {
  agendaOpen = false;
  stageEl.classList.add('solo');
  backEl.classList.add('solo');
  updateChrome();
}

function toggleAgenda() {
  if (logo.phase === 'hidden') return;
  if (agendaOpen) closeAgenda(); else openAgenda();
}

function showBrief(index) {
  const s = content.sessions[index];
  selectedSession = index;
  stageEl.querySelectorAll('.ar-session').forEach((b) => b.classList.toggle('selected', Number(b.dataset.index) === index));

  briefRoot.replaceChildren(
    el('h2', {}, s.title),
    el('p', { class: 'meta' }, `${s.room}  |  ${s.time}`),
    el('p', {}, `Speaker: ${s.speaker}`),
    el('p', {}, s.brief),
    el('div', { class: 'ar-spacer' }),
    el('button', { class: 'ar-pill solid wide', onclick: () => openDirections(index) }, 'Directions to the room'),
    el('button', { class: 'ar-pill ghost wide', onclick: closeBrief }, 'Close brief'),
  );
  briefRoot.classList.remove('is-closed');
  updateChrome();
}

function closeBrief() {
  selectedSession = -1;
  briefRoot.classList.add('is-closed');
  stageEl.querySelectorAll('.ar-session').forEach((b) => b.classList.remove('selected'));
  updateChrome();
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
  let lastTime = -1;
  let drewFrame = false;
  let watchdog = 0;

  const isActive = (v) => (phase === 'intro' && v === intro) || (phase === 'loop' && v === loop);

  function showStill() {
    if (phase === 'hidden') return;
    phase = 'still';
    intro.pause();
    loop.pause();
    const paint = () => { ctx.clearRect(0, 0, LOGO_W, LOGO_H); ctx.drawImage(still, 0, 0, LOGO_W, LOGO_H); };
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
    worker = new Worker('pen-worker.js?v=9');
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
      hint = tracking === 'NORMAL'
        ? 'Aim at the wall, about 1.5 m away, and tap "Place here"'
        : 'Move your phone slowly from side to side';
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
  $('#btn-place').hidden = scanning;
  $('#btn-place').textContent = placed ? 'Move here' : 'Place here';
  $('#btn-stop-scan').hidden = !scanning;
}

// ---------------------------------------------------------------- wire up

$('#btn-start').addEventListener('click', start);
// iPhone ignores "no zoom" in the page settings: block pinch and double-tap zoom so the view stays put.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
$('#btn-place').addEventListener('click', placeHere);
$('#btn-hunt').addEventListener('click', openHunt);
$('#btn-stop-scan').addEventListener('click', stopScanning);
$('#app-version').textContent = APP_VERSION;

loadContent()
  .then((c) => { content = c; })
  .catch(() => { /* retried on Start */ });

// A small hook for automated testing.
window.__ysf = {
  get state() {
    return { running, placed, tracking, inView, agendaOpen, logo: logo ? logo.phase : null, selectedSession,
      sheet: currentSheet, scanning, modelState, frames: renderedFrames, score: score(), found: foundMap() };
  },
  placeHere,
  turn(radians) { if (placedGroup) placedGroup.rotation.y += radians; }, // lets a test look at the back
};
