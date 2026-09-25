import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

// Wire layouts (src/point-formats.ts). The overlay receives whatever the publisher
// sent (xyz_rgb_i_v1 at 18 B or xyzi_q4_v2 at 7 B, local frame + pose); the base
// layer is requested as q8_chunk_v2 (7 B, chunk-relative) and falls back to v1.
const STRIDE = 18;
const Q4_STRIDE = 7;
const Q4_METERS = 0.004;
const Q8_STRIDE = 7;
const BASE_FORMAT = 'q8_chunk_v2';

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

// Points and helpers live in separate scenes: with EDL on, points render into an
// offscreen target whose alpha carries depth, and helpers are drawn afterwards against
// the depth the EDL pass restores. No scene.background — it would fill that alpha.
const BACKGROUND = new THREE.Color(0x0b0e13);
const scene = new THREE.Scene();
const helperScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 5000);
camera.up.set(0, 0, 1); // lidar data is Z-up
camera.position.set(6, -6, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Reference grid on the XY plane + world axes.
const grid = new THREE.GridHelper(40, 40, 0x2a3550, 0x18202f);
grid.rotation.x = Math.PI / 2;
helperScene.add(grid);
helperScene.add(new THREE.AxesHelper(1));

// ------------------------------------------------------------ splat material
// Round splats sized in world units from the served LOD spacing: a chunk at level L
// carries points on a spacing_m grid, so a disc of ~1.4 × spacing (the cell diagonal)
// closes the surface at any distance without over-painting. The server already picks
// the level so that spacing projects to a few pixels; min/max px clamp the extremes.
// spacing 0 means "no known spacing" (the raw live overlay) → a fixed pixel size.
// Colour is written as-is (the u8 values are already display sRGB) and alpha carries
// log2 view depth for the EDL pass; 0 alpha means "no point here".
const splatUniforms = {
  uProjScale: { value: 1 }, // drawing-buffer px per metre at 1 m depth
  uScale: { value: 1.4 },
  uMinPx: { value: 1.5 },
  uMaxPx: { value: 48 },
  uFixedPx: { value: 2 },
};
const SPLAT_VERTEX = /* glsl */ `
  uniform float uProjScale, uScale, uMinPx, uMaxPx, uFixedPx, uSpacing;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vLogDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(-mv.z, 1e-4);
    gl_PointSize = uSpacing > 0.0
      ? clamp(uScale * uSpacing * uProjScale / depth, uMinPx, uMaxPx)
      : uFixedPx;
    vColor = color;
    vLogDepth = log2(depth) + 16.0; // > 0 for any depth past 15 µm
  }
`;
const SPLAT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vLogDepth;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
    gl_FragColor = vec4(vColor, vLogDepth);
  }
`;
const splatMaterials = new Map(); // spacing_m -> material; uniforms shared by reference
function splatMaterial(spacing) {
  let material = splatMaterials.get(spacing);
  if (!material) {
    material = new THREE.ShaderMaterial({
      uniforms: { ...splatUniforms, uSpacing: { value: spacing } },
      vertexShader: SPLAT_VERTEX,
      fragmentShader: SPLAT_FRAGMENT,
    });
    splatMaterials.set(spacing, material);
  }
  return material;
}

function updateProjScale() {
  const heightPx = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  splatUniforms.uProjScale.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
updateProjScale();

// ------------------------------------------------------- eye-dome lighting
// Potree's EDL: shade each pixel by how much nearer it is than its neighbours in log
// depth, which outlines silhouettes and brings out surface relief without normals.
// Points render into a float target (colour + log depth in alpha, plus a depth
// texture); a full-screen pass shades and composites it, writing the stored depth
// back so helpers drawn afterwards are occluded correctly.
const edl = {
  enabled: false,
  target: null,
  material: new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.4 },
      uStrength: { value: 1.0 },
      uBackground: { value: BACKGROUND },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor, tDepth;
      uniform vec2 uTexel;
      uniform float uRadius, uStrength;
      uniform vec3 uBackground;
      varying vec2 vUv;
      const vec2 NEIGHBOURS[8] = vec2[8](
        vec2(1.0, 0.0), vec2(0.7071, 0.7071), vec2(0.0, 1.0), vec2(-0.7071, 0.7071),
        vec2(-1.0, 0.0), vec2(-0.7071, -0.7071), vec2(0.0, -1.0), vec2(0.7071, -0.7071));
      void main() {
        vec4 centre = texture2D(tColor, vUv);
        float sum = 0.0;
        for (int i = 0; i < 8; i++) {
          float d = texture2D(tColor, vUv + NEIGHBOURS[i] * uRadius * uTexel).a;
          if (d > 0.0) sum += centre.a > 0.0 ? max(0.0, centre.a - d) : 100.0;
        }
        float shade = exp(-(sum / 8.0) * 300.0 * uStrength);
        if (centre.a > 0.0) {
          gl_FragColor = vec4(centre.rgb * shade, 1.0);
          gl_FragDepth = texture2D(tDepth, vUv).r;
        } else {
          if (sum == 0.0) discard; // open background: leave the clear colour
          gl_FragColor = vec4(uBackground * shade, 1.0); // silhouette halo
          gl_FragDepth = 1.0;
        }
      }
    `,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
  }),
};
const edlQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edl.material);
edlQuad.frustumCulled = false;
const edlScene = new THREE.Scene();
edlScene.add(edlQuad);
const edlCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// Float colour targets need EXT_color_buffer_float (near-universal on desktop WebGL2);
// without it EDL stays off and points render straight to the canvas.
const edlSupported = renderer.extensions.has('EXT_color_buffer_float');

function resizeEdlTarget() {
  if (!edl.target) return;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  edl.target.setSize(size.x, size.y);
  edl.material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
}

function setEdl(enabled) {
  edl.enabled = enabled && edlSupported;
  if (edl.enabled && !edl.target) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    edl.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
    });
    edl.material.uniforms.tColor.value = edl.target.texture;
    edl.material.uniforms.tDepth.value = edl.target.depthTexture;
    resizeEdlTarget();
  }
}

function render() {
  renderer.autoClear = false;
  if (edl.enabled) {
    renderer.setRenderTarget(edl.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(BACKGROUND, 1);
    renderer.clear();
    renderer.render(edlScene, edlCamera);
  } else {
    renderer.setClearColor(BACKGROUND, 1);
    renderer.clear();
    renderer.render(scene, camera);
  }
  renderer.render(helperScene, camera);
}

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
const overlay = new THREE.Points(overlayGeometry, splatMaterial(0));
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
  const q4 = header.point_format === 'xyzi_q4_v2';

  for (let i = 0; i < count; i++) {
    let lx, ly, lz, r, g, b;
    if (q4) {
      const o = i * Q4_STRIDE;
      lx = view.getInt16(o, true) * Q4_METERS;
      ly = view.getInt16(o + 2, true) * Q4_METERS;
      lz = view.getInt16(o + 4, true) * Q4_METERS;
      r = g = b = view.getUint8(o + 6);
    } else {
      const o = i * STRIDE;
      lx = view.getFloat32(o, true);
      ly = view.getFloat32(o + 4, true);
      lz = view.getFloat32(o + 8, true);
      r = view.getUint8(o + 12);
      g = view.getUint8(o + 13);
      b = view.getUint8(o + 14);
    }
    const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
    const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
    const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];

    const p = overlayHead * 3;
    overlayPositions[p] = wx;
    overlayPositions[p + 1] = wy;
    overlayPositions[p + 2] = wz;
    overlayColors[p] = r;
    overlayColors[p + 1] = g;
    overlayColors[p + 2] = b;

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
// One THREE.Points per chunk_key with a growable buffer: chunk_lod replaces it (a
// keyframe), chunk_delta appends the voxels added since, chunk_drop disposes it.
// Frustum-culled per object (draw-cost win) since each spans one chunk.
const baseChunks = new Map(); // chunk_key -> { points, positions, colors, count, capacity, box }
let basePointCount = 0;

function decodePoints(buffer, count, positions, colors, offset, header) {
  const view = new DataView(buffer);
  if (header.point_format === BASE_FORMAT) {
    const [ox, oy, oz] = header.origin;
    const q = header.quantum;
    for (let i = 0; i < count; i++) {
      const o = i * Q8_STRIDE;
      const p = (offset + i) * 3;
      positions[p] = ox + (view.getUint8(o) + 0.5) * q; // cell centre, world-frame
      positions[p + 1] = oy + (view.getUint8(o + 1) + 0.5) * q;
      positions[p + 2] = oz + (view.getUint8(o + 2) + 0.5) * q;
      colors[p] = view.getUint8(o + 3);
      colors[p + 1] = view.getUint8(o + 4);
      colors[p + 2] = view.getUint8(o + 5);
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    const p = (offset + i) * 3;
    positions[p] = view.getFloat32(o, true); // already world-frame
    positions[p + 1] = view.getFloat32(o + 4, true);
    positions[p + 2] = view.getFloat32(o + 8, true);
    colors[p] = view.getUint8(o + 12);
    colors[p + 1] = view.getUint8(o + 13);
    colors[p + 2] = view.getUint8(o + 14);
  }
}

function extendBox(box, positions, from, to) {
  for (let i = from; i < to; i++) {
    box.expandByPoint(t.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  }
}

function attachBuffers(entry) {
  const geometry = entry.points.geometry;
  const posAttr = new THREE.BufferAttribute(entry.positions, 3);
  const colAttr = new THREE.BufferAttribute(entry.colors, 3, true);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
}

function updateBounds(entry) {
  const geometry = entry.points.geometry;
  geometry.setDrawRange(0, entry.count);
  // Bounds from the used range only: the spare capacity is zeros at the origin and
  // would otherwise inflate the bounding sphere used for culling.
  geometry.boundingBox = entry.box.clone();
  geometry.boundingSphere = entry.box.getBoundingSphere(new THREE.Sphere());
  bounds.union(entry.box);
}

function ingestBaseChunk(header, buffer) {
  const count = header.point_count;
  disposeBaseChunk(header.chunk_key);
  const capacity = Math.max(64, Math.ceil(count * 1.5));
  const entry = {
    points: new THREE.Points(new THREE.BufferGeometry(), splatMaterial(header.spacing_m ?? 0)),
    positions: new Float32Array(capacity * 3),
    colors: new Uint8Array(capacity * 3),
    count,
    capacity,
    box: new THREE.Box3().makeEmpty(),
  };
  decodePoints(buffer, count, entry.positions, entry.colors, 0, header);
  extendBox(entry.box, entry.positions, 0, count);
  attachBuffers(entry);
  updateBounds(entry);
  baseChunks.set(header.chunk_key, entry);
  scene.add(entry.points);
  basePointCount += count;
  stats.keyframeBytes += buffer.byteLength;
}

function appendBaseChunk(header, buffer) {
  const entry = baseChunks.get(header.chunk_key);
  if (!entry) {
    ingestBaseChunk(header, buffer); // never saw the keyframe: treat as one
    return;
  }
  const added = header.point_count;
  const needed = entry.count + added;
  if (needed > entry.capacity) {
    const capacity = Math.max(needed, entry.capacity * 2);
    const positions = new Float32Array(capacity * 3);
    const colors = new Uint8Array(capacity * 3);
    positions.set(entry.positions.subarray(0, entry.count * 3));
    colors.set(entry.colors.subarray(0, entry.count * 3));
    entry.positions = positions;
    entry.colors = colors;
    entry.capacity = capacity;
    attachBuffers(entry);
  }
  decodePoints(buffer, added, entry.positions, entry.colors, entry.count, header);
  extendBox(entry.box, entry.positions, entry.count, needed);
  const geometry = entry.points.geometry;
  geometry.getAttribute('position').needsUpdate = true;
  geometry.getAttribute('color').needsUpdate = true;
  entry.count = needed;
  updateBounds(entry);
  basePointCount += added;
  stats.deltaBytes += buffer.byteLength;
}

function disposeBaseChunk(chunkKey) {
  const existing = baseChunks.get(chunkKey);
  if (!existing) return;
  scene.remove(existing.points);
  existing.points.geometry.dispose();
  basePointCount -= existing.count;
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
  ws = new WebSocket(`${proto}://${location.host}/ws/view?session_id=${encodeURIComponent(sessionId)}&lod=1&fmt=${BASE_FORMAT}`);
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
      if (msg.type === 'chunk_update' || msg.type === 'chunk_bootstrap' || msg.type === 'chunk_lod' || msg.type === 'chunk_delta') {
        pendingHeader = msg; // binary payload follows next
      } else if (msg.type === 'chunk_drop') {
        disposeBaseChunk(msg.chunk_key);
      } else if (msg.type === 'session_rebuilt') {
        // Pose corrections changed: everything held is in the old frame. Clear both
        // layers and ask for the base layer again from the current camera.
        resetCloud();
        firstData = true;
        viewDirty = true;
        setStatus(`rebuilt (${msg.batches} batches)`, true);
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
    } else if (header.type === 'chunk_delta') {
      appendBaseChunk(header, ev.data);
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
  stats.keyframeBytes = 0;
  stats.deltaBytes = 0;
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
      // Observation filter for the base layer (docs/observation-filter.md). The live
      // overlay is never filtered: it shows the raw batches as they arrive.
      filter: {
        min_hits: Math.max(1, Number.parseInt(els.minHits.value, 10) || 1),
        min_ratio: Math.min(1, Math.max(0, Number.parseFloat(els.minRatio.value) || 0)),
      },
      // Live overlay: the server culls each batch to this view; the cap thins it further
      // for slow links (0 = uncapped).
      overlay: els.overlay.checked,
      overlay_max_points: Math.max(0, Number.parseInt(els.overlayMax.value, 10) || 0),
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
  overlay: document.getElementById('overlay'),
  overlayMax: document.getElementById('overlay-max'),
  minHits: document.getElementById('min-hits'),
  minRatio: document.getElementById('min-ratio'),
  status: document.getElementById('status'),
  dot: document.getElementById('dot'),
  session: document.getElementById('s-session'),
  points: document.getElementById('s-points'),
  batches: document.getElementById('s-batches'),
  rate: document.getElementById('s-rate'),
  seq: document.getElementById('s-seq'),
  base: document.getElementById('s-base'),
};
const stats = { batches: 0, lastSeq: '—', windowPoints: 0, keyframeBytes: 0, deltaBytes: 0 };
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
  render();
  if (overlayDirty) {
    overlayPosAttr.clearUpdateRanges();
    overlayColAttr.clearUpdateRanges();
    overlayDirty = false;
  }
  els.points.textContent = total.toLocaleString();
  els.batches.textContent = String(baseChunks.size);
  els.seq.textContent = String(stats.lastSeq);
  els.base.textContent = `${(stats.keyframeBytes / 1e6).toFixed(1)} MB key + ${(stats.deltaBytes / 1e6).toFixed(1)} MB delta`;
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateProjScale();
  resizeEdlTarget();
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
const splatScaleInput = document.getElementById('splat-scale');
const edlInput = document.getElementById('edl');
const edlStrengthInput = document.getElementById('edl-strength');
function applyRenderControls() {
  splatUniforms.uScale.value = Math.max(0.1, Number.parseFloat(splatScaleInput.value) || 1.4);
  edl.material.uniforms.uStrength.value = Math.max(0, Number.parseFloat(edlStrengthInput.value) || 0);
  setEdl(edlInput.checked);
  if (edlInput.checked && !edlSupported) {
    edlInput.checked = false;
    edlInput.disabled = true;
    edlInput.title = 'EDL needs float render targets (EXT_color_buffer_float)';
  }
}
for (const input of [splatScaleInput, edlInput, edlStrengthInput]) {
  input.addEventListener('input', applyRenderControls);
}
applyRenderControls();

for (const input of [els.minHits, els.minRatio, els.overlay, els.overlayMax]) {
  input.addEventListener('change', () => {
    viewDirty = true; // next view update carries the new filter; the server re-sends
  });
}

connect(sessionInput.value.trim());
