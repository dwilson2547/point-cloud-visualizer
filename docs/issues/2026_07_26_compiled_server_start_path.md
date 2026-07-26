# Compiled server start script targets a nonexistent file, preventing production startup

**Date:** 2026-07-26  
**Component:** `package.json` — `scripts.start`  
**Severity:** Low — development startup still worked, but the documented compiled-server command failed immediately.

---

## Observed symptom

Running `npm start` after a successful `npm run build` exited with
`Cannot find module 'dist/server.js'`. TypeScript had emitted the server at `dist/src/server.js`, so
the compiled server could not be used for the KISS-ICP integration test.

---

## Root cause

### The start script did not match the TypeScript output layout

The TypeScript configuration preserves the source directory under `dist`, while the package script
assumed source files were emitted directly at the root:

```json
"start": "node dist/server.js"
```

---

## Troubleshooting steps taken

1. **Ran the compiled server** — reproduced the missing-module error immediately after a successful build.

2. **Inspected the build output** — confirmed that `dist/src/server.js` existed and `dist/server.js` did not.

3. **Started the corrected target** — confirmed the server responded successfully on `/healthz`.

---

## Fix

### `package.json` — align `scripts.start` with the compiler output

The start target now points at the generated server file:

```json
"start": "node dist/src/server.js"
```

---

## Files changed

- `package.json` — `scripts.start`
