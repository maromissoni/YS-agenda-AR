// Youth Speak AR - pen detector, running in a background worker.
// It uses the processor (WebAssembly), not the graphics chip, so it never competes with the AR camera
// and can never freeze the screen.
/* global tf */
importScripts('lib/tf/tf.min.js?v=11', 'lib/tf/tf-backend-wasm.min.js?v=11');

let model = null;
let size = 224;

async function load({ base, wasmBase }) {
  tf.wasm.setWasmPaths(wasmBase);
  if (!(await tf.setBackend('wasm'))) await tf.setBackend('cpu');
  await tf.ready();

  const res = await fetch(`${base}metadata.json`, { cache: 'no-cache' });
  if (!res.ok) {
    postMessage({ type: 'missing' });
    return;
  }
  const meta = await res.json();
  model = await tf.loadLayersModel(`${base}model.json`);
  size = meta.imageSize || 224;
  tf.tidy(() => model.predict(tf.zeros([1, size, size, 3]))); // warm up
  postMessage({ type: 'ready', labels: meta.labels || [], size, backend: tf.getBackend() });
}

function classify({ pixels, id }) {
  const t0 = performance.now();
  const image = new ImageData(new Uint8ClampedArray(pixels), size, size);
  const out = tf.tidy(() => model.predict(tf.browser.fromPixels(image).toFloat().div(127).sub(1).expandDims(0)));
  const probs = Array.from(out.dataSync());
  out.dispose();
  postMessage({ type: 'result', probs, id, ms: Math.round(performance.now() - t0) });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg).catch((err) => postMessage({ type: 'error', message: String(err && err.message || err) }));
  } else if (msg.type === 'classify' && model) {
    try { classify(msg); } catch (err) { postMessage({ type: 'error', message: String(err && err.message || err), during: 'classify' }); }
  }
};
