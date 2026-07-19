import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// Wire layout of the xyz_rgb_i_v1 point (must match src/protocol.ts POINT_STRIDE_BYTES):
//   0..11  x,y,z   float32 LE
//   12..14 r,g,b   uint8
//   15..16 intensity uint16 LE
//   17     padding
const STRIDE = 18;

// Live-overlay ring capacity. The overlay holds the newest chunk_update points at low
// latency; the accumulated, LOD'd world lives in the per-chunk base layer instead, so
// this only needs to cover what arrives between base refreshes. Oldest points wrap.
const CAPACITY = 1_000_000;

// ---------------------------------------------------------------- three setup
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false });
// Cap pixel ratio: point clouds are fill-rate bound, and rendering at full HiDPI
// (2x+) multiplies overdraw for little visual gain.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 5000);
camera.up.set(0, 0, 1); // lidar data is Z-up
camera.position.set(6, -6, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Reference grid on the XY plane + world axes.
const grid = new THREE.GridHelper(40, 40, 0x2a3550, 0x18202f);
grid.rotation.x = Math.PI / 2;
scene.add(grid);
scene.add(new THREE.AxesHelper(1));

// Fixed screen-space point size (no distance attenuation) keeps fill cost flat and
// bounded regardless of camera distance. Shared by the overlay and every base chunk.
const material = new THREE.PointsMaterial({ size: 2.0, sizeAttenuation: false, vertexColors: true });

const bounds = new THREE.Box3().makeEmpty();

// ------------------------------------------------------- live overlay (ring buffer)
const overlayPositions = new Float32Array(CAPACITY * 3);
const overlayColors = new Uint8Array(CAPACITY * 3);
const overlayGeometry = new THREE.BufferGeometry();
const overlayPosAttr = new THREE.BufferAttribute(overlayPositions, 3);
const overlayColAttr = new THREE.BufferAttribute(overlayColors, 3, true); // normalized u8 -> 0..1
overlayPosAttr.setUsage(THREE.DynamicDrawUsage);
overlayColAttr.setUsage(THREE.DynamicDrawUsage);
overlayGeometry.setAttribute('position', overlayPosAttr);
overlayGeometry.setAttribute('color', overlayColAttr);
overlayGeometry.setDrawRange(0, 0);
const overlay = new THREE.Points(overlayGeometry, material);
overlay.frustumCulled = false; // spans the whole world; culled manually
scene.add(overlay);

let overlayHead = 0; // next write slot (points)
let overlayFilled = 0; // valid points, min(written, CAPACITY)
let overlayDirty = false;

// Reused scratch to avoid per-point allocation.
const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const t = new THREE.Vector3();
const s = new THREE.Vector3(1, 1, 1);

// chunk_update carries local-frame points + a pose; chunk_bootstrap is world-frame
// (identity). Both feed the overlay ring.
function ingestOverlay(header, buffer) {
  const view = new DataView(buffer);
  const count = header.point_count;
  if (header.pose) {
    q.set(...header.pose.rotation_xyzw);
    t.set(...header.pose.translation_m);
    m.compose(t, q, s);
  } else {
    m.identity();
  }
  const e = m.elements;
  const startSlot = overlayHead;
  let wrapped = false;

  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const lx = view.getFloat32(o, true);
    const ly = view.getFloat32(o + 4, true);
    const lz = view.getFloat32(o + 8, true);
    const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];

    const p = overlayHead * 3;
    overlayPositions[p] = wx;
    overlayPositions[p + 1] = wy;
    overlayPositions[p + 2] = wz;
    overlayColors[p] = view.getUint8(o + 12);
    overlayColors[p + 1] = view.getUint8(o + 13);
    overlayColors[p + 2] = view.getUint8(o + 14);

    bounds.expandByPoint(t.set(wx, wy, wz));

    overlayHead = (overlayHead + 1) % CAPACITY;
    if (overlayHead === 0) wrapped = true;
    if (overlayFilled < CAPACITY) overlayFilled += 1;
  }

  if (wrapped) {
    overlayPosAttr.addUpdateRange(0, CAPACITY * 3);
    overlayColAttr.addUpdateRange(0, CAPACITY * 3);
  } else {
    overlayPosAttr.addUpdateRange(startSlot * 3, count * 3);
    overlayColAttr.addUpdateRange(startSlot * 3, count * 3);
  }
  overlayPosAttr.needsUpdate = true;
  overlayColAttr.needsUpdate = true;
  overlayGeometry.setDrawRange(0, overlayFilled);
  overlayDirty = true;

  if (header.type === 'chunk_update') {
    stats.batches += 1;
    stats.lastSeq = header.sequence;
  }
  stats.windowPoints += count;
}

// ------------------------------------------------------------- LOD base layer
// One THREE.Points per chunk_key, replaced whole on chunk_lod and disposed on
// chunk_drop. Frustum-culled per object (draw-cost win) since each spans one chunk.
const baseChunks = new Map(); // chunk_key -> THREE.Points (userData.count)
let basePointCount = 0;

function ingestBaseChunk(header, buffer) {
  const count = header.point_count;
  const view = new DataView(buffer);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    positions[i * 3] = view.getFloat32(o, true); // already world-frame
    positions[i * 3 + 1] = view.getFloat32(o + 4, true);
    positions[i * 3 + 2] = view.getFloat32(o + 8, true);
    colors[i * 3] = view.getUint8(o + 12);
    colors[i * 3 + 1] = view.getUint8(o + 13);
    colors[i * 3 + 2] = view.getUint8(o + 14);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere(); // needed for per-object frustum culling
  if (geometry.boundingBox) bounds.union(geometry.boundingBox);

  disposeBaseChunk(header.chunk_key);
  const points = new THREE.Points(geometry, material);
  points.userData.count = count;
  baseChunks.set(header.chunk_key, points);
  scene.add(points);
  basePointCount += count;
}

function disposeBaseChunk(chunkKey) {
  const existing = baseChunks.get(chunkKey);
  if (!existing) return;
  scene.remove(existing);
  existing.geometry.dispose();
  basePointCount -= existing.userData.count ?? 0;
  baseChunks.delete(chunkKey);
}

// ------------------------------------------------------------------- recenter
function recenter() {
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).length() || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(size * 0.4, -size * 0.4, size * 0.3));
  controls.update();
}

// ------------------------------------------------------------------ websocket
let ws = null;
let pendingHeader = null;
let currentSession = null;

function connect(sessionId) {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  resetCloud();
  currentSession = sessionId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // lod=1 → view-driven base layer (chunk_lod/chunk_drop) instead of a full bootstrap.
  ws = new WebSocket(`${proto}://${location.host}/ws/view?session_id=${encodeURIComponent(sessionId)}&lod=1`);
  ws.binaryType = 'arraybuffer';
  setStatus('connecting', false);
  els.session.textContent = sessionId;

  ws.onopen = () => {
    setStatus('connected', true);
    sendView(); // ask for the base layer around the current camera right away
  };
  ws.onclose = () => setStatus('disconnected', false);
  ws.onerror = () => setStatus('error', false);
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'chunk_update' || msg.type === 'chunk_bootstrap' || msg.type === 'chunk_lod') {
        pendingHeader = msg; // binary payload follows next
      } else if (msg.type === 'chunk_drop') {
        disposeBaseChunk(msg.chunk_key);
      } else if (msg.type === 'viewer_session_state') {
        stats.lastSeq = msg.last_sequence ?? '—';
      } else if (msg.type === 'error') {
        setStatus(`error: ${msg.message}`, false);
      }
      return;
    }
    const header = pendingHeader;
    pendingHeader = null;
    if (!header) return;
    if (header.type === 'chunk_lod') {
      ingestBaseChunk(header, ev.data);
    } else {
      ingestOverlay(header, ev.data); // chunk_update or chunk_bootstrap
    }
  };
}

function resetCloud() {
  overlayHead = 0;
  overlayFilled = 0;
  overlayGeometry.setDrawRange(0, 0);
  overlayPosAttr.needsUpdate = true;
  for (const chunkKey of [...baseChunks.keys()]) disposeBaseChunk(chunkKey);
  bounds.makeEmpty();
  stats.batches = 0;
  stats.windowPoints = 0;
  stats.lastSeq = '—';
}

// -------------------------------------------------------------- view reporting
const viewDir = new THREE.Vector3();
let viewDirty = true;

function sendView() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentSession) return;
  camera.getWorldDirection(viewDir);
  ws.send(
    JSON.stringify({
      type: 'viewer_view',
      session_id: currentSession,
      position: [camera.position.x, camera.position.y, camera.position.z],
      forward: [viewDir.x, viewDir.y, viewDir.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
      fov_y_rad: (camera.fov * Math.PI) / 180,
      viewport_px: [window.innerWidth, window.innerHeight],
      near_m: camera.near,
      far_m: camera.far,
    }),
  );
  viewDirty = false;
}

controls.addEventListener('change', () => {
  viewDirty = true;
});
// Throttle view updates to ~5 Hz: the base layer only needs to track the camera as it
// settles, not every damped frame.
setInterval(() => {
  if (viewDirty) sendView();
}, 200);

// ------------------------------------------------------------------------ HUD
const els = {
  status: document.getElementById('status'),
  dot: document.getElementById('dot'),
  session: document.getElementById('s-session'),
  points: document.getElementById('s-points'),
  batches: document.getElementById('s-batches'),
  rate: document.getElementById('s-rate'),
  seq: document.getElementById('s-seq'),
};
const stats = { batches: 0, lastSeq: '—', windowPoints: 0 };
let firstData = true;

function setStatus(text, on) {
  els.status.textContent = text;
  els.dot.classList.toggle('on', on);
}

setInterval(() => {
  els.rate.textContent = `${stats.windowPoints.toLocaleString()} pts/s`;
  stats.windowPoints = 0;
}, 1000);

// --------------------------------------------------------------- render + wiring
function animate() {
  requestAnimationFrame(animate);
  const total = basePointCount + overlayFilled;
  if (firstData && total > 0) {
    firstData = false;
    recenter();
  }
  controls.update();
  renderer.render(scene, camera);
  if (overlayDirty) {
    overlayPosAttr.clearUpdateRanges();
    overlayColAttr.clearUpdateRanges();
    overlayDirty = false;
  }
  els.points.textContent = total.toLocaleString();
  els.batches.textContent = String(baseChunks.size);
  els.seq.textContent = String(stats.lastSeq);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  viewDirty = true;
});

const sessionInput = document.getElementById('session');
const urlSession = new URLSearchParams(location.search).get('session_id');
sessionInput.value = urlSession ?? 'synthetic-demo';
document.getElementById('connect').addEventListener('click', () => {
  firstData = true;
  connect(sessionInput.value.trim());
});
document.getElementById('recenter').addEventListener('click', recenter);

connect(sessionInput.value.trim());
