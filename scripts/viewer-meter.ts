// Headless LOD viewer that holds a wide view of a session and meters what it receives:
// keyframe bytes, delta bytes, what the same refreshes would have cost as whole-chunk
// re-sends, and live-overlay bytes, plus what permessage-deflate would make of each
// stream. Usage: npm run meter:viewer -- ws://host:8080 <session> [seconds] [fmt]
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
const [url, session, seconds, fmt] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? '15'), process.argv[5] ?? 'xyz_rgb_i_v1'];
const ws = new WebSocket(`${url}/ws/view?session_id=${session}&lod=1&fmt=${fmt}`, { perMessageDeflate: false });
const zsize = (b: Buffer) => zlib.deflateRawSync(b, { level: 1 }).byteLength;
let keyZ = 0, deltaZ = 0, overlayZ = 0;
ws.binaryType = 'arraybuffer';
let pending: any = null;
let key = 0, delta = 0, overlay = 0, wouldBeFull = 0, keyMsgs = 0, deltaMsgs = 0;
const held = new Map<string, number>(); // chunk -> points held
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'viewer_view', session_id: session, position: [5, 4, 12], forward: [0, 0, -1], up: [0, 1, 0], fov_y_rad: 1.2, viewport_px: [1600, 1200], near_m: 0.05, far_m: 100 }));
});
ws.on('message', (data, isBinary) => {
  if (!isBinary) { pending = JSON.parse(data.toString()); return; }
  const bytes = (data as Buffer).byteLength;
  const h = pending; pending = null;
  if (!h) return;
  const buf = data as Buffer;
  if (h.type === 'chunk_lod') { key += bytes; keyZ += zsize(buf); keyMsgs++; held.set(h.chunk_key, h.point_count); }
  else if (h.type === 'chunk_delta') { delta += bytes; deltaZ += zsize(buf); deltaMsgs++; const n = (held.get(h.chunk_key) ?? 0) + h.point_count; held.set(h.chunk_key, n); wouldBeFull += n * 18; }
  else if (h.type === 'chunk_update') { overlay += bytes; overlayZ += zsize(buf); }
});
setTimeout(() => {
  const mb = (b: number) => (b / 1e6).toFixed(2);
  console.log(`format ${fmt}, ${seconds}s`);
  console.log(`base layer: keyframes ${mb(key)} MB (${keyMsgs}, deflated ${mb(keyZ)}), deltas ${mb(delta)} MB (${deltaMsgs}, deflated ${mb(deltaZ)}); the same refreshes as whole-chunk 18 B re-sends would have been ${mb(wouldBeFull)} MB`);
  console.log(`live overlay: ${mb(overlay)} MB (deflated ${mb(overlayZ)})`);
  ws.close(); process.exit(0);
}, seconds * 1000);
