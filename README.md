# AutoscopAI

A browser-native, platform-independent rewrite of [AutoReview](https://github.com/NielsLinnemann/autoreview): the same multi-agent, dialectical academic-article review panel, but with no server and no separate Python install. The whole engine — PDF/text extraction, prompt orchestration, HTTP calls to your model provider — runs as real Python inside your browser via [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly), in a Web Worker. Settings and run history live in this browser's IndexedDB. The desktop build wraps the same static site in a small native window via [Tauri](https://tauri.app).

AutoscopAI v0.1 is experimental educational software for trying review workflows. It makes no guarantees about correctness, completeness, fitness for publication decisions, costs, privacy, or availability.

## How it's different from AutoReview

AutoReview (the original) runs a local Python backend process and a browser UI talking to it over `127.0.0.1`. AutoscopAI removes the backend entirely:

- The review engine (`web/autoscop_engine.py`, a browser-adapted port of AutoReview's `review.py` + `dialect_review.py`) runs inside Pyodide in `web/worker.js`, so a run keeps going even while you switch tabs.
- PDF extraction uses `pypdf`, installed at runtime via `micropip` (pure-Python wheel, no compilation needed).
- HTTP calls to your model provider go through `pyodide.http.pyfetch`, straight from the browser to the provider — no proxy in between.
- Settings (provider, API key, agent organigram) and run history live in this browser's IndexedDB (`web/db.js`), not a server-side SQLite database or per-user config files.
- "Export all" produces a real `.zip` built client-side (`web/zip-lite.js`, a small dependency-free ZIP writer) instead of a server-generated one.

Everything else — the organigram editor, agent import/export, mode presets, the safe custom markdown renderer, the third-party-data warning — is carried over from AutoReview mostly unchanged, since it was already pure client-side code.

## Known trade-offs (read before relying on this)

**A run does not survive closing the tab or browser.** Unlike AutoReview's backend process, a review job only runs as long as this page's Worker is alive. Backgrounding the tab is fine (the Worker keeps running, just possibly throttled); closing the tab or quitting the app stops the run with no automatic resume. A "Most suitable" run with slow reasoning models can take many minutes — keep the tab/window open until it finishes.

**The API key lives in browser JavaScript, not a server process.** It's stored in this browser's IndexedDB and sent directly from page JS to your chosen provider on every call. This was checked for the obvious injection risk — all LLM-generated review text is HTML-escaped before rendering (see `inlineMarkdown` in `web/app.js`), so there's no XSS path from a malicious article into the page. But it's still a different trust boundary than AutoReview's backend-only key, worth knowing if you ever host this somewhere other than your own machine.

**CORS is provider-dependent.** OpenRouter (`Access-Control-Allow-Origin: *`) and the OpenAI API (reflects any origin) were verified directly to allow calls from a browser page. A custom OpenAI-compatible endpoint may or may not allow this — if it doesn't, calls will fail with an opaque network error, not a clear CORS message.

**Requires internet on first load.** Pyodide (~10s to load, one-time per session) and `pypdf` load from `cdn.jsdelivr.net` at runtime. Fully offline/bundled Pyodide is possible (vendor the distribution into `web/vendor/pyodide/` and point `worker.js` at it) but isn't done here.

**Document metadata detection is simplified.** AutoReview's `extract_document_metadata` has an elaborate PDF-layout heuristic fallback; AutoscopAI's `guessDocumentMetadata` only reads LaTeX `\title{}`/`\author{}` and otherwise falls back to the filename. History entries for non-LaTeX articles will show the filename as the title.

## Running it

This is a static site with a build-free frontend (no npm, no bundler) — the only non-trivial dependency is the Rust/Tauri toolchain for the desktop wrapper.

### In a browser

Any static file server works, since `worker.js` needs to load as a module Worker (won't work from a plain `file://` URL in most browsers):

```bash
cd web
python3 -m http.server 8910
```

Then open `http://127.0.0.1:8910/`.

### As a desktop app (Tauri)

Requires Rust (`rustup`) and the Tauri CLI (`cargo install tauri-cli`). No Node/npm needed — the frontend has no build step.

```bash
cargo tauri build
```

This produces a native `.app`/`.dmg` (macOS), `.exe`/`.msi` (Windows), or `.AppImage`/`.deb` (Linux) under `src-tauri/target/release/bundle/`, depending on the host OS. Cross-compiling a Windows build from macOS isn't supported by Tauri's toolchain — see `.github/workflows/build.yml` for a CI matrix that builds all three platforms on their native runners.

For local development with hot reload:

```bash
cd web && python3 -m http.server 8910   # in one terminal
cargo tauri dev                          # in another
```

## Project layout

```text
web/
  index.html            app shell
  styles.css            visual design
  app.js                UI logic: organigram, agent editor, settings, history, run orchestration
  worker.js             loads Pyodide + pypdf, drives the staged review pipeline
  autoscop_engine.py     the ported review engine (prompts, model-fallback, HTTP calls)
  db.js                 tiny IndexedDB wrapper (replaces AutoReview's SQLite + per-user files)
  zip-lite.js            dependency-free ZIP writer (replaces AutoReview's server-side zipfile export)
  assets/                mascot icon + bundled default agent/preset config (reviewers.json, dialect_reviewers.json, mode_presets.json)
src-tauri/               Tauri desktop wrapper (native window around web/)
.github/workflows/       CI: cross-platform Tauri builds (macOS/Windows/Linux)
```

## AI Acknowledgment

This project, including its code and documentation, was built with the assistance of AI coding agents (OpenAI Codex and Anthropic Claude Code). It is a rewrite of, and shares its review logic and UI design with, [AutoReview](https://github.com/NielsLinnemann/autoreview).
