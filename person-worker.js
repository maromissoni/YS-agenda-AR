// Youth Speak AR - person finder for the portal, running in a background worker.
// MoveNet Lightning (Google, Apache 2.0) finds 17 body points of one person in a 192 x 192 picture.
// It runs on the processor (WebAssembly), so it never competes with the AR camera.
// Pictures stay on the phone: nothing is sent anywhere or stored.
/* global tf */
importScripts('lib/tf/tf.min.js?v=13', 'lib/tf/tf-backend-wasm.min.js?v=13');

let model = null;
const SIZE = 192;

async function load({ base, wasmBase }) {
  tf.wasm.setWasmPaths(wasmBase);
  if (!(await tf.setBackend('wasm'))) await tf.setBackend('cpu');
  await tf.ready();
  model = await tf.loadGraphModel(`${base}model.json`);
  tf.tidy(() => model.execute(tf.zeros([1, SIZE, SIZE, 3], 'int32'))); // warm up
  postMessage({ type: 'ready', size: SIZE, backend: tf.getBackend() });
}

function detect({ pixels, id }) {
  const t0 = performance.now();
  const image = new ImageData(new Uint8ClampedArray(pixels), SIZE, SIZE);
  const out = tf.tidy(() => model.execute(tf.browser.fromPixels(image).expandDims(0)));
  const points = Array.from(out.dataSync()); // 17 x [y, x, score], each 0..1
  out.dispose();
  postMessage({ type: 'pose', points, id, ms: Math.round(performance.now() - t0) });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg).catch((err) => postMessage({ type: 'error', message: String(err && err.message || err) }));
  } else if (msg.type === 'detect' && model) {
    try { detect(msg); } catch (err) { postMessage({ type: 'error', message: String(err && err.message || err), during: 'detect' }); }
  }
};
