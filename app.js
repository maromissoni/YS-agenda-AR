// Youth Speak AR - web app.
// Flow: Start -> the wall marker is recognised (or the logo is placed on a wall) -> the logo animates in and loops
//       -> tap the logo -> the agenda opens -> tap a session -> brief -> directions.
//       Agenda -> scavenger hunt -> find an object -> video + fact -> claim points -> leaderboard.
// Image tracking: MindAR (MIT). 3D/CSS rendering: three.js (MIT). Both are in /lib, no CDN needed.

import { MindARThree } from './lib/mindar/mindar-image-three.prod.js';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { Group, Quaternion, Euler, Vector3, MathUtils } from 'three';

const AGENDA_TARGET = 0; // index of agenda_poster in targets.mind

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
let mindar = null;
let stageEl = null;   // everything pinned to the wall: logo, agenda card, brief
let stageObj = null;
let briefRoot = null;
let logo = null;      // the animated logo (see createLogo)
let stageVisible = false; // the marker is in view, or the logo is placed on a wall
let agendaOpen = false;
let lastLostAt = 0;
let selectedSession = -1;
let currentSheet = null; // { kind, id }
const huntVisible = new Set();
const huntBadges = new Map();
const discoveryCooldown = new Map();

// "Place agenda here" (no poster): the agenda is pinned in the direction the phone pointed,
// using the phone's motion sensors. It stays put when you turn, but does not get closer when you walk.
let wallMode = false;
let wallGroup = null;
let wallHolder = null;
let qNow = null;   // current phone orientation
let qPlace = null; // phone orientation when the agenda was placed
let orientationListening = false;
let orientationAsked = false;
const zAxis = new Vector3(0, 0, 1);
const eulerTmp = new Euler();
const qTmp = new Quaternion();
const qScreenFix = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out of the back of the phone

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

const APP_VERSION = 'v5';

function askMotionAccess() {
  // iPhone asks for motion access; the request must come straight from a tap, before anything is awaited.
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function' && !orientationAsked) {
    orientationAsked = true;
    DOE.requestPermission().catch(() => { /* no motion access: the agenda stays fixed on the screen */ });
  }
  listenOrientation(); // readings arrive once motion access is allowed
}

function startWithoutPoster() {
  askMotionAccess();
  start(true);
}

async function start(placeOnWall = false) {
  // Still inside the tap: lets the phone play the logo animation later without another tap.
  logo = logo || createLogo();
  logo.prime();

  const buttons = [$('#btn-start'), $('#btn-start-wall')];
  const setButtons = (disabled) => buttons.forEach((b) => { if (b) b.disabled = disabled; });
  if (!window.isSecureContext) {
    setStatus('The camera only works on a secure address (https://). Open the GitHub Pages link instead of the file.', true);
    return;
  }
  setButtons(true);
  setStatus('Starting the camera...');
  const slowNote = setTimeout(() => setStatus('Still loading the image tracker... this can take up to 20 seconds on the first visit.'), 6000);

  try {
    content = content || await loadContent();
  } catch (e) {
    clearTimeout(slowNote);
    setStatus('Could not load the agenda (content.json). Check that all files were uploaded.', true);
    setButtons(false);
    return;
  }

  mindar = new MindARThree({
    container: $('#ar'),
    imageTargetSrc: 'targets.mind',
    maxTrack: 1,
    uiLoading: 'no',
    uiScanning: 'no',
    uiError: 'no',
  });

  buildStage();
  buildHuntAnchors();

  try {
    await mindar.start();
  } catch (e) {
    clearTimeout(slowNote);
    setStatus('The camera did not start. Allow camera access for this site in your browser settings, then reload.', true);
    setButtons(false);
    return;
  }
  clearTimeout(slowNote);

  const { renderer, cssRenderer, scene, cssScene, camera } = mindar;
  wallGroup = new Group();
  wallHolder = new Group();
  wallGroup.add(wallHolder);
  cssScene.add(wallGroup);

  renderer.setAnimationLoop(() => {
    updateWall();
    logo.draw();
    renderer.render(scene, camera);
    cssRenderer.render(cssScene, camera);
  });

  $('#start').hidden = true;
  $('#bar').hidden = false;
  if (placeOnWall) placeOnWallHere();
  updateChrome();
}

// ---------------------------------------------------------------- animated logo
// The logo is one flat colour, so each video stores only its shape (white = logo, black = see-through).
// Every frame is copied to a canvas as "brand purple, with the video's brightness as opacity".
// That gives a transparent animation on iPhone and Android alike.

const LOGO_W = 460, LOGO_H = 550;
const LOGO_RGB = [117, 81, 204];

function createLogo() {
  const canvas = el('canvas', { width: LOGO_W, height: LOGO_H });
  const ctx = canvas.getContext('2d');
  const scratch = document.createElement('canvas');
  scratch.width = LOGO_W;
  scratch.height = LOGO_H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const out = ctx.createImageData(LOGO_W, LOGO_H);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = LOGO_RGB[0];
    out.data[i + 1] = LOGO_RGB[1];
    out.data[i + 2] = LOGO_RGB[2];
  }

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
        sctx.drawImage(v, 0, 0, LOGO_W, LOGO_H);
        src = sctx.getImageData(0, 0, LOGO_W, LOGO_H).data;
      } catch { showStill(); return; }
      const dst = out.data;
      for (let i = 0; i < src.length; i += 4) {
        const a = src[i];
        dst[i + 3] = a < 12 ? 0 : a > 243 ? 255 : a;
      }
      ctx.putImageData(out, 0, 0);
      drewFrame = true;
    },
  };
}

// ---------------------------------------------------------------- the stage: logo -> tap -> agenda

// The stage is laid out in the pixels of the agenda design (1231 x 1727).
const STAGE_W = 1231;
// On a printed marker the agenda card is drawn about 1.5x as wide as the marker, so it is easy to read.
const STAGE_SCALE = 1.4;

function buildStage() {
  const anchor = mindar.addCSSAnchor(AGENDA_TARGET);

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
  stageObj = new CSS3DObject(stageEl);
  stageEl.style.pointerEvents = 'none'; // only the logo, the card and the brief take taps
  stageObj.scale.setScalar(STAGE_SCALE * 1000 / 1089);
  anchor.group.add(stageObj);

  anchor.onTargetFound = () => { if (!wallMode) onStageFound(); };
  anchor.onTargetLost = () => {
    if (wallMode) return;
    stageVisible = false;
    lastLostAt = Date.now();
    logo.sleep();
    updateChrome();
  };
}

// The marker came into view (or the logo was placed on a wall).
function onStageFound(forceIntro = false) {
  const wasAway = Date.now() - lastLostAt > 3000;
  stageVisible = true;
  stageEl.classList.add('has-logo');
  // Replay the intro when the wall is recognised again, but not on a short tracking flicker
  // and not while someone is reading the agenda.
  if (forceIntro || logo.phase === 'hidden' || (!agendaOpen && wasAway)) logo.appear();
  else logo.wake();
  updateChrome();
}

function openAgenda() {
  agendaOpen = true;
  stageEl.classList.remove('solo');
  updateChrome();
}

function closeAgenda() {
  agendaOpen = false;
  stageEl.classList.add('solo');
  updateChrome();
}

function toggleAgenda() {
  if (logo.phase === 'hidden') return;
  if (agendaOpen) closeAgenda(); else openAgenda();
}

// ---------------------------------------------------------------- agenda on any wall (no poster)

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const screenAngle = (screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle : (window.orientation || 0);
  eulerTmp.set(MathUtils.degToRad(e.beta), MathUtils.degToRad(e.alpha), -MathUtils.degToRad(e.gamma), 'YXZ');
  if (!qNow) qNow = new Quaternion();
  qNow.setFromEuler(eulerTmp);
  qNow.multiply(qScreenFix);
  qNow.multiply(qTmp.setFromAxisAngle(zAxis, -MathUtils.degToRad(screenAngle)));
  // First reading after placing: pin the logo where it is on screen right now.
  if (wallMode && !qPlace) qPlace = qNow.clone();
}

function listenOrientation() {
  if (orientationListening) return;
  orientationListening = true;
  window.addEventListener('deviceorientation', onOrientation);
}

function placeOnWallHere() {
  askMotionAccess();

  wallMode = true;
  qPlace = qNow ? qNow.clone() : null;

  // Size it so the whole stage fills most of the screen width, a fixed distance in front of the camera.
  const cam = mindar.camera;
  const distance = Math.min(Math.max(1000, cam.near * 4), cam.far / 4);
  const visibleWidth = 2 * distance * Math.tan(MathUtils.degToRad(cam.fov) / 2) * cam.aspect;
  wallHolder.position.set(0, 0, -distance);
  wallHolder.scale.setScalar((0.94 * visibleWidth) / (STAGE_W * stageObj.scale.x));

  wallHolder.add(stageObj); // moves the stage off the marker anchor
  stageEl.style.visibility = 'visible';
  agendaOpen = false;
  stageEl.classList.add('solo');
  onStageFound(true);
}

function updateWall() {
  if (!wallGroup) return;
  if (wallMode && qNow && qPlace) {
    // Turn the pinned agenda opposite to how the phone has turned since placing it.
    wallGroup.quaternion.copy(qNow).invert().multiply(qPlace);
  } else {
    wallGroup.quaternion.identity();
  }
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

// ---------------------------------------------------------------- hunt objects

function buildHuntAnchors() {
  for (const item of content.hunt) {
    const anchor = mindar.addCSSAnchor(item.target);
    const badge = el('div', { class: 'ar-badge' }, '');
    const obj = new CSS3DObject(badge);
    obj.position.set(0, 500 + 140, 0); // just above the card
    anchor.group.add(obj);
    huntBadges.set(item.id, badge);
    refreshBadge(item);

    anchor.onTargetFound = () => {
      huntVisible.add(item.id);
      refreshBadge(item);
      onHuntObjectFound(item);
      updateChrome();
    };
    anchor.onTargetLost = () => { huntVisible.delete(item.id); updateChrome(); };
  }
}

function refreshBadge(item) {
  const badge = huntBadges.get(item.id);
  if (badge) badge.textContent = isFound(item) ? `Found: ${item.name}` : `You found: ${item.name}!`;
}

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
          refreshBadge(item);
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
    el('p', {}, 'Find the hidden objects around the venue and scan them with your camera.'),
    el('p', { class: 'big' }, `Your points: ${score()}   |   Found: ${found} of ${content.hunt.length}`),
    list,
    el('button', { class: 'btn primary', onclick: closeSheet }, 'Find the objects (start scanning)'),
    el('button', { class: 'btn', onclick: openLeaderboard }, 'Live leaderboard'),
    el('button', { class: 'btn', onclick: closeSheet }, 'Close'),
    el('button', { class: 'btn small', onclick: () => { resetProgress(); content.hunt.forEach(refreshBadge); openHunt(); } }, 'Reset progress (testing)'),
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
  const steps = [wallMode ? 'Stand with your back to the wall where you placed the agenda.' : 'Stand with your back to the agenda on the wall.'];
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

  const map = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'map', role: 'img', 'aria-label': `Map from the poster to ${content.sessions[target].room}` });
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
  if (!currentSheet && mindar) {
    if (stageVisible && !agendaOpen) hint = 'Tap the logo to open the agenda';
    else if (stageVisible && selectedSession < 0) hint = 'Tap a session to see its brief';
    else if (stageVisible) hint = wallMode ? 'The brief is to the right: turn the phone right \u2192' : 'The brief is to the right of the agenda \u2192';
    else if (huntVisible.size === 0) hint = 'Point the camera at the Youth Speak marker, or tap "Place on a wall"';
  }
  banner.hidden = hint === null;
  if (hint) banner.textContent = hint;

  $('#bar').hidden = !mindar || Boolean(currentSheet);
}

// ---------------------------------------------------------------- wire up

$('#btn-start').addEventListener('click', () => start(false));
$('#btn-start-wall').addEventListener('click', startWithoutPoster);
$('#app-version').textContent = APP_VERSION;
$('#btn-place').addEventListener('click', placeOnWallHere);
$('#btn-hunt').addEventListener('click', openHunt);

loadContent()
  .then((c) => { content = c; })
  .catch(() => { /* retried on Start */ });

// Expose a small hook for automated testing.
window.__ysf = { get state() { return { wallMode, placed: Boolean(qPlace), stageVisible, agendaOpen, logo: logo ? logo.phase : null, selectedSession, sheet: currentSheet, score: score(), found: foundMap() }; } };
