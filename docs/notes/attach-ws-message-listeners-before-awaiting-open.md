---
title: Attach ws message listeners before awaiting open
date: 2026-09-18
tags: websocket,ws,nodejs,race,testing
source: tools/point-cloud-visualizer/test/helpers.ts
---

In Node's ws client a frame that arrives in the same read as the 101 handshake is emitted from the process.nextTick queue, which runs before the promise continuation after 'await once(ws, open)'. A message listener attached only after that await misses the frame silently. Symptom: a socket whose server speaks first (viewer sockets get viewer_session_state on connect) intermittently receives nothing, so tests hang or time out under CPU load. Fix: attach the listener (or a buffering queue) synchronously at construction, before any await; the visualizer's test helper connect() does this and messagesOf() returns that queue.
