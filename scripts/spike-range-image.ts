// SPIKE (throwaway): does range-image + video codec beat xyzi_q4_v2 + deflate for
// VLP-16 ingest, and at what precision cost?
//
// Background: docs/decisions/0007 kept "D. Range-image ingest with an image/video
// codec" on the list; architecture.md:142 has it as deferred. A spinning lidar's
// native output IS a range image — src/vlp16-packet.ts receives
// (laserIndex, azimuth, distanceRaw@2mm, intensity) and throws that structure away
// when it converts to cartesian. This measures what keeping it would buy.
//
// The honest question is not "what ratio" but "what ratio at what error", because
// libx264 cannot carry 16-bit gray (only gray/gray10le), so full 2 mm precision
// needs either FFV1 (not WebCodecs-decodable) or an MSB/LSB plane split.
//
// Run: npx tsx scripts/spike-range-image.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- sensor geometry

// VLP-16: 16 lasers, -15°..+15° in 2° steps. Firing order is interleaved, which is
// why row order is a variable here and not a constant.
const FIRING_ORDER_DEG = [-15, 1, -13, 3, -11, 5, -9, 7, -7, 9, -5, 11, -3, 13, -1, 15];
const RINGS = 16;
const AZIMUTH_BINS = 1800; // 0.2° at 10 Hz
const DISTANCE_SCALE_M = 0.002; // matches vlp16-packet.ts
const MAX_RANGE_M = 100;

const SPINS = Number.parseInt(process.env.SPINS ?? '20', 10);

// --------------------------------------------------------------------- scene

// Axis-aligned boxes. The room is an inside-out box; the rest are obstacles. A room
// is the right test case: flat walls give the smooth gradients a video codec eats,
// while box edges give the hard discontinuities that punish it.
interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const ROOM: Box = { min: [-6, -5, -1.5], max: [6, 5, 1.8] };
const OBSTACLES: Box[] = [
  { min: [-3.2, -1.0, -1.5], max: [-2.0, 1.4, 0.3] }, // cabinet
  { min: [0.6, -2.6, -1.5], max: [2.8, -1.0, -0.7] }, // desk
  { min: [1.2, 1.0, -1.5], max: [1.9, 1.7, 0.1] }, // pillar
  { min: [-1.0, 2.6, -1.5], max: [1.6, 3.4, -0.9] }, // bench
  { min: [3.4, 0.2, -1.5], max: [4.0, 0.8, 1.2] }, // post
  { min: [-4.6, -3.8, -1.5], max: [-3.6, -2.8, -0.5] }, // crate
];

// Slab intersection for a ray starting inside the room. Returns distance to the
// nearest wall along dir.
function hitRoomInside(o: [number, number, number], d: [number, number, number]): number {
  let best = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) continue;
    for (const bound of [ROOM.min[a], ROOM.max[a]]) {
      const t = (bound - o[a]) / d[a];
      if (t <= 0) continue;
      const p0 = o[(a + 1) % 3] + t * d[(a + 1) % 3];
      const p1 = o[(a + 2) % 3] + t * d[(a + 2) % 3];
      const a1 = (a + 1) % 3;
      const a2 = (a + 2) % 3;
      if (p0 >= ROOM.min[a1] - 1e-6 && p0 <= ROOM.max[a1] + 1e-6 && p1 >= ROOM.min[a2] - 1e-6 && p1 <= ROOM.max[a2] + 1e-6) {
        if (t < best) best = t;
      }
    }
  }
  return best;
}

// Standard slab test for a ray against a solid box from outside.
function hitBox(o: [number, number, number], d: [number, number, number], b: Box): number {
  let tmin = 0;
  let tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return Infinity;
      continue;
    }
    const inv = 1 / d[a];
    let t0 = (b.min[a] - o[a]) * inv;
    let t1 = (b.max[a] - o[a]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return Infinity;
  }
  return tmin > 0 ? tmin : Infinity;
}

interface Spin {
  range: Uint16Array; // RINGS * AZIMUTH_BINS, raw units of 2 mm
  intensity: Uint8Array;
}

// Sensor path: a slow circle with yaw, the same shape synthetic-publisher.ts uses, so
// consecutive spins are highly correlated. That correlation is the whole point — it is
// what inter-frame prediction gets to exploit and what the current per-batch wire
// format cannot use at all.
function sensorPose(spin: number): { origin: [number, number, number]; yaw: number } {
  const t = spin / 10; // 10 Hz
  return { origin: [1.6 * Math.cos(t * 0.35), 1.6 * Math.sin(t * 0.35), 0.15 * Math.sin(t * 0.9)], yaw: t * 0.5 };
}

function renderSpin(spin: number, rowOrderDeg: number[]): Spin {
  const { origin, yaw } = sensorPose(spin);
  const range = new Uint16Array(RINGS * AZIMUTH_BINS);
  const intensity = new Uint8Array(RINGS * AZIMUTH_BINS);

  for (let r = 0; r < RINGS; r++) {
    const el = (rowOrderDeg[r] * Math.PI) / 180;
    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    for (let c = 0; c < AZIMUTH_BINS; c++) {
      const az = ((c / AZIMUTH_BINS) * 2 * Math.PI) + yaw;
      const d: [number, number, number] = [cosEl * Math.cos(az), cosEl * Math.sin(az), sinEl];

      let dist = hitRoomInside(origin, d);
      for (const b of OBSTACLES) {
        const t = hitBox(origin, d, b);
        if (t < dist) dist = t;
      }

      const i = r * AZIMUTH_BINS + c;
      if (!Number.isFinite(dist) || dist > MAX_RANGE_M) {
        range[i] = 0; // 0 == no return, same convention as the VLP-16 packet
        intensity[i] = 0;
        continue;
      }
      // Mild range-dependent falloff plus a little sensor noise, so the intensity
      // plane is not artificially smooth.
      const falloff = Math.max(0, 1 - dist / 40);
      const noise = (Math.sin(i * 12.9898 + spin * 78.233) * 43758.5453) % 1;
      range[i] = Math.min(65535, Math.round(dist / DISTANCE_SCALE_M));
      intensity[i] = Math.max(0, Math.min(255, Math.round(40 + 180 * falloff + noise * 12)));
    }
  }
  return { range, intensity };
}

// ------------------------------------------------------------------- baselines

// What the wire costs today: xyzi_q4_v2 is 7 B per returned point, then
// permessage-deflate level 1 on top (protocol-v1.md "Compression").
function baselineQ4Bytes(spins: Spin[], rowOrderDeg: number[]): { raw: number; deflated: number; points: number } {
  let raw = 0;
  let deflated = 0;
  let points = 0;
  for (let s = 0; s < spins.length; s++) {
    const { range, intensity } = spins[s];
    const { yaw } = sensorPose(s);
    const buf = Buffer.allocUnsafe(range.length * 7);
    let w = 0;
    for (let r = 0; r < RINGS; r++) {
      const el = (rowOrderDeg[r] * Math.PI) / 180;
      for (let c = 0; c < AZIMUTH_BINS; c++) {
        const i = r * AZIMUTH_BINS + c;
        if (range[i] === 0) continue;
        const dist = range[i] * DISTANCE_SCALE_M;
        const az = ((c / AZIMUTH_BINS) * 2 * Math.PI) + yaw;
        const xy = dist * Math.cos(el);
        buf.writeInt16LE(Math.round((xy * Math.cos(az)) / 0.004), w);
        buf.writeInt16LE(Math.round((xy * Math.sin(az)) / 0.004), w + 2);
        buf.writeInt16LE(Math.round((dist * Math.sin(el)) / 0.004), w + 4);
        buf[w + 6] = intensity[i];
        w += 7;
        points++;
      }
    }
    const payload = buf.subarray(0, w);
    raw += payload.byteLength;
    deflated += zlib.deflateSync(payload, { level: 1 }).byteLength;
  }
  return { raw, deflated, points };
}

// --------------------------------------------------------------- codec harness

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-spike-'));

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

interface Result {
  name: string;
  bytes: number;
  encodeMs: number;
  rmseM: number;
  maxErrM: number;
  lostPoints: number;
  decodable: string;
}

// Encode a plane sequence, decode it back, and report both size and the error it
// introduced. Ratio without distortion is meaningless for a lidar.
// `inPixFmt` is how the planes are laid out in memory; `encArgs` decides what the
// encoder actually stores. These differ on purpose: this x264 build has no i400
// (monochrome) support and silently falls back to yuv420p, whose limited 16-235
// range destroys the low bits. yuvj420p (full-range) round-trips the Y plane
// exactly and is still plain H.264 to a hardware decoder.
function runCodec(
  name: string,
  planes: Buffer,
  inPixFmt: string,
  width: number,
  height: number,
  encArgs: string[],
  container: string,
  decodable: string,
  toRange: (decoded: Buffer, i: number) => number,
  truth: Uint16Array[],
): Result {
  const inFile = path.join(TMP, `${name}.raw`);
  const outFile = path.join(TMP, `${name}.${container}`);
  const backFile = path.join(TMP, `${name}.back.raw`);
  fs.writeFileSync(inFile, planes);

  const t0 = process.hrtime.bigint();
  ffmpeg([
    '-f', 'rawvideo', '-pix_fmt', inPixFmt, '-s', `${width}x${height}`, '-r', '10', '-i', inFile,
    ...encArgs, outFile,
  ]);
  const encodeMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Decode back into the same memory layout the planes were built in.
  ffmpeg(['-i', outFile, '-f', 'rawvideo', '-pix_fmt', inPixFmt, backFile]);
  const back = fs.readFileSync(backFile);

  // Error against ground truth, in metres, over returned points only.
  let sumSq = 0;
  let n = 0;
  let maxErr = 0;
  let lost = 0;
  const perFrame = truth[0].length;
  for (let f = 0; f < truth.length; f++) {
    for (let i = 0; i < perFrame; i++) {
      const t = truth[f][i];
      if (t === 0) continue;
      const got = toRange(back, f * perFrame + i);
      if (got === 0) { lost++; continue; }
      const e = Math.abs(got - t) * DISTANCE_SCALE_M;
      sumSq += e * e;
      n++;
      if (e > maxErr) maxErr = e;
    }
  }
  return {
    name,
    bytes: fs.statSync(outFile).size,
    encodeMs,
    rmseM: n ? Math.sqrt(sumSq / n) : 0,
    maxErrM: maxErr,
    lostPoints: lost,
    decodable,
  };
}

// ------------------------------------------------------------------------ main

function main(): void {
  const elevationSorted = [...FIRING_ORDER_DEG].sort((a, b) => a - b);

  console.log(`VLP-16 spike: ${RINGS}x${AZIMUTH_BINS} range images, ${SPINS} spins @10Hz\n`);

  // Row order matters: firing order interleaves elevations, destroying vertical
  // correlation. Measure both rather than assuming.
  for (const [label, order] of [['elevation-sorted', elevationSorted], ['firing-order', FIRING_ORDER_DEG]] as const) {
    const spins = Array.from({ length: SPINS }, (_, s) => renderSpin(s, order));
    const truth = spins.map((s) => s.range);

    if (label === 'elevation-sorted') {
      const base = baselineQ4Bytes(spins, order);
      const perSpin = base.deflated / SPINS;
      console.log('BASELINE (current wire format)');
      console.log(`  points/spin            ${Math.round(base.points / SPINS)}`);
      console.log(`  xyzi_q4_v2 raw         ${fmt(base.raw / SPINS)}/spin  (7 B/pt)`);
      console.log(`  + deflate level 1      ${fmt(perSpin)}/spin  -> ${fmt(perSpin * 10)}/s\n`);
      (globalThis as Record<string, unknown>).__baseline = perSpin;
    }

    // gray8: range scaled to 0..255 across MAX_RANGE_8, the cheapest browser path.
    const MAX_RANGE_8 = 40; // metres; beyond this clamps
    const g8 = Buffer.alloc(spins.length * RINGS * AZIMUTH_BINS);
    // gray10le: 1024 levels over the same span.
    const g10 = Buffer.alloc(spins.length * RINGS * AZIMUTH_BINS * 2);
    // gray16le: native 2 mm units, full precision.
    const g16 = Buffer.alloc(spins.length * RINGS * AZIMUTH_BINS * 2);
    // MSB/LSB split: two 8-bit rows-stacked planes, full precision, x264-compatible.
    const split = Buffer.alloc(spins.length * RINGS * 2 * AZIMUTH_BINS);

    for (let f = 0; f < spins.length; f++) {
      const r = spins[f].range;
      for (let i = 0; i < r.length; i++) {
        const o = f * r.length + i;
        const metres = r[i] * DISTANCE_SCALE_M;
        g8[o] = Math.min(255, Math.round((metres / MAX_RANGE_8) * 255));
        g10.writeUInt16LE(Math.min(1023, Math.round((metres / MAX_RANGE_8) * 1023)), o * 2);
        g16.writeUInt16LE(r[i], o * 2);
      }
      // MSB plane then LSB plane, stacked vertically into one 16*2-row image.
      const planeBase = f * RINGS * 2 * AZIMUTH_BINS;
      for (let i = 0; i < r.length; i++) {
        split[planeBase + i] = r[i] >> 8;
        split[planeBase + RINGS * AZIMUTH_BINS + i] = r[i] & 0xff;
      }
    }

    const results: Result[] = [];
    const W = AZIMUTH_BINS;
    const H = RINGS;

    results.push(runCodec('x264-8bit-lossless', g8, 'gray', W, H,
      ['-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuvj420p'], 'mp4', 'WebCodecs (hw)',
      (b, i) => Math.round((b[i] / 255) * MAX_RANGE_8 / DISTANCE_SCALE_M), truth));

    results.push(runCodec('x264-8bit-crf18', g8, 'gray', W, H,
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuvj420p'], 'mp4', 'WebCodecs (hw)',
      (b, i) => Math.round((b[i] / 255) * MAX_RANGE_8 / DISTANCE_SCALE_M), truth));

    results.push(runCodec('x265-8bit-lossless', g8, 'gray', W, H,
      ['-c:v', 'libx265', '-preset', 'veryfast', '-x265-params', 'lossless=1', '-pix_fmt', 'gray'], 'mp4', 'WebCodecs (HEVC, patchy)',
      (b, i) => Math.round((b[i] / 255) * MAX_RANGE_8 / DISTANCE_SCALE_M), truth));

    results.push(runCodec('x264-msb-lsb-lossless', split, 'gray', W, H * 2,
      ['-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuvj420p'], 'mp4', 'WebCodecs (hw)',
      (b, i) => {
        const perFrame = RINGS * AZIMUTH_BINS;
        const f = Math.floor(i / perFrame);
        const j = i % perFrame;
        const base = f * perFrame * 2;
        return (b[base + j] << 8) | b[base + perFrame + j];
      }, truth));

    // Intra-only (-g 1): every spin a keyframe, i.e. the independence the current
    // per-batch protocol has. The gap between this and the GOP run above is exactly
    // what inter-frame prediction is worth, and the cost of that gap is that a
    // mid-stream joiner needs a keyframe before it can decode.
    results.push(runCodec('x264-msb-lsb-INTRA-only', split, 'gray', W, H * 2,
      ['-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-g', '1', '-pix_fmt', 'yuvj420p'], 'mp4', 'WebCodecs (hw)',
      (b, i) => {
        const perFrame = RINGS * AZIMUTH_BINS;
        const f = Math.floor(i / perFrame);
        const j = i % perFrame;
        const base = f * perFrame * 2;
        return (b[base + j] << 8) | b[base + perFrame + j];
      }, truth));

    results.push(runCodec('ffv1-gray16-lossless', g16, 'gray16le', W, H,
      ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gray16le'], 'mkv', 'NOT in browser',
      (b, i) => b.readUInt16LE(i * 2), truth));

    const baseline = (globalThis as Record<string, unknown>).__baseline as number;
    console.log(`ROW ORDER: ${label}`);
    console.log('  codec                       bytes/spin  vs base    RMSE   max err   lost   enc/spin  decode');
    for (const r of results) {
      const perSpin = r.bytes / SPINS;
      const ratio = baseline / perSpin;
      console.log(
        `  ${r.name.padEnd(25)} ${fmt(perSpin).padStart(10)} ${(ratio.toFixed(2) + '×').padStart(7)}` +
        ` ${(r.rmseM * 1000).toFixed(1).padStart(7)}mm ${(r.maxErrM * 1000).toFixed(0).padStart(6)}mm` +
        ` ${String(r.lostPoints).padStart(6)} ${(r.encodeMs / SPINS).toFixed(1).padStart(8)}ms  ${r.decodable}`,
      );
    }
    console.log();
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}

function fmt(bytes: number): string {
  return bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes)} B`;
}

main();
