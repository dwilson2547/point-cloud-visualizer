// Headless LOD viewer that holds a wide view of a session and meters what it receives:
// keyframe bytes, delta bytes, what the same refreshes would have cost as whole-chunk
// re-sends, and live-overlay bytes. Usage: npm run meter:viewer -- ws://host:8080 <session> [seconds]
import { WebSocket } from 'ws';
const [url, session, seconds] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? '15')];
const ws = new WebSocket(`${url}/ws/view?session_id=${session}&lod=1`);
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
  if (h.type === 'chunk_lod') { key += bytes; keyMsgs++; held.set(h.chunk_key, h.point_count); }
  else if (h.type === 'chunk_delta') { delta += bytes; deltaMsgs++; const n = (held.get(h.chunk_key) ?? 0) + h.point_count; held.set(h.chunk_key, n); wouldBeFull += n * 18; }
  else if (h.type === 'chunk_update') overlay += bytes;
});
setTimeout(() => {
  const mb = (b: number) => (b / 1e6).toFixed(2);
  console.log(`base layer over ${seconds}s: keyframes ${mb(key)} MB (${keyMsgs}), deltas ${mb(delta)} MB (${deltaMsgs}); the same refreshes as whole-chunk re-sends would have been ${mb(wouldBeFull)} MB`);
  console.log(`live overlay over the same window: ${mb(overlay)} MB`);
  ws.close(); process.exit(0);
}, seconds * 1000);
