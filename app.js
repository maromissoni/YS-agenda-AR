// YS Forum AR - lo-fi web app.
// Flow: Start -> agenda on the poster -> tap a session -> brief -> directions.
//       Agenda -> scavenger hunt -> find an object -> video + fact -> claim points -> leaderboard.
// Image tracking: MindAR (MIT). 3D/CSS rendering: three.js (MIT). Both are in /lib, no CDN needed.

import { MindARThree } from './lib/mindar/mindar-image-three.prod.js';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const AGENDA_TARGET = 0; // index of agenda_poster in targets.mind
const POSTER_HEIGHT_PX = 1414; // poster height when its width is 1000px (A-series ratio)

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
let agendaRoot = null;
let briefRoot = null;
let agendaVisible = false;
let agendaClosed = false;
let selectedSession = -1;
let currentSheet = null; // { kind, id }
const huntVisible = new Set();
const huntBadges = new Map();
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

async function start() {
  const button = $('#btn-start');
  if (!window.isSecureContext) {
    setStatus('The camera only works on a secure address (https://). Open the GitHub Pages link instead of the file.', true);
    return;
  }
  button.disabled = true;
  setStatus('Starting the camera...');

  try {
    content = content || await loadContent();
  } catch (e) {
    setStatus('Could not load the agenda (content.json). Check that all files were uploaded.', true);
    button.disabled = false;
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

  buildAgendaAnchor();
  buildHuntAnchors();

  try {
    await mindar.start();
  } catch (e) {
    setStatus('The camera did not start. Allow camera access for this site in your browser settings, then reload.', true);
    button.disabled = false;
    return;
  }

  const { renderer, cssRenderer, scene, cssScene, camera } = mindar;
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    cssRenderer.render(cssScene, camera);
  });

  $('#start').hidden = true;
  $('#bar').hidden = false;
  updateChrome();
}

// ---------------------------------------------------------------- agenda on the poster

function buildAgendaAnchor() {
  const anchor = mindar.addCSSAnchor(AGENDA_TARGET);

  agendaRoot = el('div', { class: 'ar-panel ar-agenda' },
    el('h1', {}, `${content.forumTitle} - Agenda`),
    el('p', { class: 'muted' }, content.dayLabel),
  );
  content.sessions.forEach((s, i) => {
    agendaRoot.append(el('button', { class: 'ar-session', 'data-index': i, onclick: () => showBrief(i) },
      el('span', { class: 'time' }, s.time),
      el('span', { class: 'title' }, s.title),
      el('span', { class: 'room' }, s.room),
    ));
  });
  agendaRoot.append(
    el('div', { class: 'ar-spacer' }),
    el('button', { class: 'ar-btn primary', onclick: openHunt }, 'Scavenger hunt'),
    el('button', { class: 'ar-btn', onclick: closeAgenda }, 'Close agenda'),
  );

  briefRoot = el('div', { class: 'ar-panel ar-brief is-closed' });

  const agendaObj = new CSS3DObject(agendaRoot);
  const briefObj = new CSS3DObject(briefRoot);
  // 1000px = poster width. The brief sits to the right of the poster, top-aligned.
  briefObj.position.set(500 + 60 + 400, 0, 0);
  anchor.group.add(agendaObj);
  anchor.group.add(briefObj);

  anchor.onTargetFound = () => { agendaVisible = true; updateChrome(); };
  anchor.onTargetLost = () => { agendaVisible = false; updateChrome(); };
}

function showBrief(index) {
  const s = content.sessions[index];
  selectedSession = index;
  agendaRoot.querySelectorAll('.ar-session').forEach((b) => b.classList.toggle('selected', Number(b.dataset.index) === index));

  briefRoot.replaceChildren(
    el('h2', {}, s.title),
    el('p', { class: 'muted' }, `${s.time}  |  ${s.room}`),
    el('p', {}, `Speaker: ${s.speaker}`),
    el('p', {}, s.brief),
    el('div', { class: 'ar-spacer' }),
    el('button', { class: 'ar-btn primary', onclick: () => openDirections(index) }, 'Directions to the room'),
    el('button', { class: 'ar-btn', onclick: closeBrief }, 'Close brief'),
  );
  briefRoot.classList.remove('is-closed');
  updateChrome();
}

function closeBrief() {
  selectedSession = -1;
  briefRoot.classList.add('is-closed');
  agendaRoot.querySelectorAll('.ar-session').forEach((b) => b.classList.remove('selected'));
  updateChrome();
}

function closeAgenda() {
  agendaClosed = true;
  agendaRoot.classList.add('is-closed');
  briefRoot.classList.add('is-closed');
  updateChrome();
}

function showAgenda() {
  agendaClosed = false;
  agendaRoot.classList.remove('is-closed');
  if (selectedSession >= 0) briefRoot.classList.remove('is-closed');
  updateChrome();
}

// ---------------------------------------------------------------- hunt objects

function buildHuntAnchors() {
  for (const item of content.hunt) {
    const anchor = mindar.addCSSAnchor(item.target);
    const badge = el('div', { class: 'ar-panel ar-badge' }, '');
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
  const steps = ['Stand with your back to the agenda poster.'];
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
  for (let gx = Math.ceil(minX); gx <= maxX; gx++) map.append(svg('line', { x1: X(gx), y1: 0, x2: X(gx), y2: H, stroke: '#ececea', 'stroke-width': 1 }));
  for (let gy = Math.ceil(minY); gy <= maxY; gy++) map.append(svg('line', { x1: 0, y1: Y(gy), x2: W, y2: Y(gy), stroke: '#ececea', 'stroke-width': 1 }));
  // wall with the poster
  map.append(svg('line', { x1: 0, y1: Y(0), x2: W, y2: Y(0), stroke: '#141414', 'stroke-width': 3 }));
  map.append(svg('rect', { x: X(0) - 14, y: Y(0) - 3, width: 28, height: 9, fill: '#141414' }));
  const posterLabel = svg('text', { x: X(0), y: Y(0) + 24, 'text-anchor': 'middle', 'font-size': 12, fill: '#5d5d5d' });
  posterLabel.textContent = 'Agenda poster (start)';
  map.append(posterLabel);

  // route
  const s = content.sessions[target];
  const route = `M${X(0)} ${Y(0.6)} L${X(0)} ${Y(s.ahead || 0)} L${X(s.side || 0)} ${Y(s.ahead || 0)}`;
  map.append(svg('path', { d: route, fill: 'none', stroke: '#1f5fd1', 'stroke-width': 4, 'stroke-dasharray': '8 6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  map.append(svg('circle', { cx: X(0), cy: Y(0.6), r: 6, fill: '#1f5fd1' }));

  // rooms
  content.sessions.forEach((r, i) => {
    const on = i === target;
    map.append(svg('circle', { cx: X(r.side || 0), cy: Y(r.ahead || 0), r: on ? 9 : 6, fill: on ? '#1f5fd1' : '#a9a9a5' }));
    const label = svg('text', { x: X(r.side || 0), y: Y(r.ahead || 0) - 14, 'text-anchor': 'middle', 'font-size': on ? 14 : 12, 'font-weight': on ? 700 : 400, fill: on ? '#141414' : '#5d5d5d' });
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
    if (agendaVisible && !agendaClosed && selectedSession < 0) hint = 'Tap a session to see its brief';
    else if (agendaVisible && !agendaClosed && selectedSession >= 0) hint = 'The brief is to the right of the agenda \u2192';
    else if (!agendaVisible && huntVisible.size === 0) hint = 'Point the camera at the agenda poster or a hunt object';
  }
  banner.hidden = hint === null;
  if (hint) banner.textContent = hint;

  $('#bar').hidden = !mindar || Boolean(currentSheet);
  $('#btn-show-agenda').hidden = !agendaClosed;
}

// ---------------------------------------------------------------- wire up

$('#btn-start').addEventListener('click', start);
$('#btn-show-agenda').addEventListener('click', showAgenda);
$('#btn-hunt').addEventListener('click', openHunt);

loadContent()
  .then((c) => { content = c; $('#start-title').textContent = `${c.forumTitle} AR`; })
  .catch(() => { /* retried on Start */ });

// Expose a small hook for automated testing.
window.__ysf = { get state() { return { agendaVisible, agendaClosed, selectedSession, sheet: currentSheet, score: score(), found: foundMap() }; } };
