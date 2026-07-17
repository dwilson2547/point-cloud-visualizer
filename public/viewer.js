import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// Wire layout of the xyz_rgb_i_v1 point (must match src/protocol.ts POINT_STRIDE_BYTES):
//   0..11  x,y,z   float32 LE (local sensor frame)
//   12..14 r,g,b   uint8
//   15..16 intensity uint16 LE
//   17     padding
const STRIDE = 18;

// Rolling capacity. The live cloud is a ring buffer until server-side voxel
// fusion + LOD (phase 2) bound density properly; oldest points are overwritten.
// Kept modest so a single draw call stays cheap on modest/software GPUs.
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

// ---------------------------------------------------------- point cloud buffers
const positions = new Float32Array(CAPACITY * 3);
const colors = new Uint8Array(CAPACITY * 3);

const geometry = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(positions, 3);
const colAttr = new THREE.BufferAttribute(colors, 3, true); // normalized u8 -> 0..1
posAttr.setUsage(THREE.DynamicDrawUsage);
colAttr.setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('position', posAttr);
geometry.setAttribute('color', colAttr);
geometry.setDrawRange(0, 0);

// Fixed screen-space point size (no distance attenuation) keeps fill cost flat and
// bounded regardless of how close the camera gets — the single biggest perf lever
// for a dense cloud. Distance-aware/adaptive sizing comes with the LOD work.
const material = new THREE.PointsMaterial({ size: 2.0, sizeAttenuation: false, vertexColors: true });
const cloud = new THREE.Points(geometry, material);
cloud.frustumCulled = false; // we manage bounds manually; points span the whole world
scene.add(cloud);

let head = 0; // next write slot (points)
let filled = 0; // valid points, min(written, CAPACITY)
let dirty = false;
const bounds = new THREE.Box3().makeEmpty();

// Reused scratch to avoid per-point allocation.
const m = new THREE.Matrix4();
const q = new THREE.Quaternion();
const t = new THREE.Vector3();
const s = new THREE.Vector3(1, 1, 1);

function ingestBatch(header, buffer) {
  const view = new DataView(buffer);
  const count = header.point_count;
  const [tx, ty, tz] = header.pose.translation_m;
  const [qx, qy, qz, qw] = header.pose.rotation_xyzw;
  q.set(qx, qy, qz, qw);
  t.set(tx, ty, tz);
  m.compose(t, q, s);
  const e = m.elements;

  const startSlot = head;
  let wrapped = false;

  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const lx = view.getFloat32(o, true);
    const ly = view.getFloat32(o + 4, true);
    const lz = view.getFloat32(o + 8, true);
    // world = M * local (column-major elements)
    const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];

    const p = head * 3;
    positions[p] = wx;
    positions[p + 1] = wy;
    positions[p + 2] = wz;
    colors[p] = view.getUint8(o + 12);
    colors[p + 1] = view.getUint8(o + 13);
    colors[p + 2] = view.getUint8(o + 14);

    bounds.expandByPoint(t.set(wx, wy, wz));

    head = (head + 1) % CAPACITY;
    if (head === 0) wrapped = true;
    if (filled < CAPACITY) filled += 1;
  }

  // Upload only the touched slots (whole buffer if the write wrapped the ring).
  if (wrapped) {
    posAttr.addUpdateRange(0, CAPACITY * 3);
    colAttr.addUpdateRange(0, CAPACITY * 3);
  } else {
    posAttr.addUpdateRange(startSlot * 3, count * 3);
    colAttr.addUpdateRange(startSlot * 3, count * 3);
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  geometry.setDrawRange(0, filled);
  dirty = true;
  stats.points = filled;
  stats.batches += 1;
  stats.lastSeq = header.sequence;
  stats.windowPoints += count;
}

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

function connect(sessionId) {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  resetCloud();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/view?session_id=${encodeURIComponent(sessionId)}`);
  ws.binaryType = 'arraybuffer';
  setStatus('connecting', false);
  els.session.textContent = sessionId;

  ws.onopen = () => setStatus('connected', true);
  ws.onclose = () => setStatus('disconnected', false);
  ws.onerror = () => setStatus('error', false);
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'chunk_update') {
        pendingHeader = msg; // binary payload follows next
      } else if (msg.type === 'viewer_session_state') {
        stats.batches = msg.point_batches;
        stats.lastSeq = msg.last_sequence ?? '—';
      } else if (msg.type === 'error') {
        setStatus(`error: ${msg.message}`, false);
      }
      return;
    }
    // binary payload for the previously received chunk_update header
    if (pendingHeader) {
      const header = pendingHeader;
      pendingHeader = null;
      ingestBatch(header, ev.data);
    }
  };
}

function resetCloud() {
  head = 0;
  filled = 0;
  bounds.makeEmpty();
  geometry.setDrawRange(0, 0);
  posAttr.needsUpdate = true;
  stats.points = 0;
  stats.batches = 0;
  stats.windowPoints = 0;
  stats.lastSeq = '—';
}

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
const stats = { points: 0, batches: 0, lastSeq: '—', windowPoints: 0 };
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
  if (firstData && filled > 0) {
    firstData = false;
    recenter();
  }
  controls.update();
  renderer.render(scene, camera);
  if (dirty) {
    posAttr.clearUpdateRanges();
    colAttr.clearUpdateRanges();
    dirty = false;
  }
  els.points.textContent = stats.points.toLocaleString();
  els.batches.textContent = String(stats.batches);
  els.seq.textContent = String(stats.lastSeq);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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
