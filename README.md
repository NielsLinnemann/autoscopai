# AutoscopAI

AutoscopAI is a desktop app that runs a panel of AI reviewers on an academic article draft: several independent reviewers each give feedback, an editor combines their comments, then a second round of agents checks whether the first round's criticisms were actually fair, before a final editor writes up the verdict. You provide your own API key for a model provider (OpenRouter or OpenAI); the app does the rest.

AutoscopAI v0.1 is experimental educational software for trying review workflows. It makes no guarantees about correctness, completeness, fitness for publication decisions, costs, privacy, or availability. Treat everything it produces as fallible feedback, not as an authority.

## Download and install

Get the app from the [Releases page](https://github.com/NielsLinnemann/autoscopai/releases) — look for the latest release, then download the file for your system:

- **Mac**: the `.dmg` file
- **Windows**: the `.exe` (or `.msi`) file

### Opening it the first time

Because this app isn't (yet) registered with Apple or Microsoft, your computer will show a security warning the first time you open it. This is normal for a small, independently made app — here's how to get past it:

**On a Mac:**
1. Double-click the downloaded `.dmg`, then drag AutoscopAI into your Applications folder.
2. Double-click it there. You'll very likely see a message that it **"is damaged and can't be opened."** This is a misleading message — the app isn't actually damaged, it's just unrecognized. Don't move it to the Trash.
3. Open **Terminal** (press `Cmd+Space`, type `Terminal`, press Return — it's a built-in Mac app, in Applications → Utilities).
4. Paste this line into the Terminal window and press Return:
   ```bash
   xattr -cr /Applications/AutoscopAI.app
   ```
   This just tells your Mac "I trust this, stop treating it as a fresh unknown download" — it doesn't change or install anything else.
5. Now double-click AutoscopAI in Applications again — it opens normally.

**On Windows:**
1. Double-click the downloaded `.exe` (or `.msi`) and run through the installer.
2. If you see a blue "Windows protected your PC" screen, click **More info**, then click **Run anyway**.

You only need to do this once per download — after that, it launches normally like any other app.

## What it does, briefly

Drop your article in (PDF, LaTeX, Markdown, or plain text), pick a cost mode (Cheapest / Balanced / Most suitable), add your API key in Settings, and click **Run Full Review**. You can click on any reviewer in the diagram to change its focus, its model, or its instructions. Past runs are kept in the History panel on the right, and you can export everything as a zip file at any time.

---

## How it works (for the curious, and for developers)

AutoscopAI is browser-native and platform-independent: there is no server process and no separate Python install. The whole engine — PDF/text extraction, prompt orchestration, HTTP calls to your model provider — runs as real Python inside a Web Worker, via [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). Settings and run history live in the browser's IndexedDB. The desktop build wraps that same static site in a small native window via [Tauri](https://tauri.app).

Concretely:

- The review engine (`web/autoscop_engine.py`) runs inside Pyodide in `web/worker.js`, so a run keeps going even while you switch tabs.
- PDF extraction uses `pypdf`, installed at runtime via `micropip` (pure-Python wheel, no compilation needed).
- HTTP calls to your model provider go through `pyodide.http.pyfetch`, straight from the browser to the provider — no proxy in between.
- Settings (provider, API key, agent organigram) and run history live in the browser's IndexedDB (`web/db.js`), with no backend database.
- "Export all" produces a real `.zip` built client-side (`web/zip-lite.js`, a small dependency-free ZIP writer).
- The organigram editor, agent import/export, mode presets, a safe custom markdown renderer, and a third-party-data warning round out the UI — all pure client-side code.

## Known trade-offs (read before relying on this)

**A run does not survive closing the tab or browser.** A review job only runs as long as this page's Worker is alive. Backgrounding the tab is fine (the Worker keeps running, just possibly throttled); closing the tab or quitting the app stops the run with no automatic resume. A "Most suitable" run with slow reasoning models can take many minutes — keep the tab/window open until it finishes.

**The API key lives in browser JavaScript, not a server process.** It's stored in the browser's IndexedDB and sent directly from page JS to your chosen provider on every call. This was checked for the obvious injection risk — all LLM-generated review text is HTML-escaped before rendering (see `inlineMarkdown` in `web/app.js`), so there's no XSS path from a malicious article into the page. Still, worth knowing if you ever host this somewhere other than your own machine.

**CORS is provider-dependent.** OpenRouter (`Access-Control-Allow-Origin: *`) and the OpenAI API (reflects any origin) were verified directly to allow calls from a browser page. A custom OpenAI-compatible endpoint may or may not allow this — if it doesn't, calls will fail with an opaque network error, not a clear CORS message.

**Pyodide is bundled, not fetched from a CDN.** The Python runtime (`web/vendor/pyodide/`, ~13MB) ships inside the app so it works offline after install and avoids a class of loading failures specific to running inside a packaged desktop webview. `pypdf` itself is still installed at first run via `micropip` from PyPI, which needs internet the first time.

**Document metadata detection is simplified.** History entries only pick up a title/author when the article is LaTeX with `\title{}`/`\author{}` commands; otherwise the filename is shown instead.

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

This produces a native `.app`/`.dmg` (macOS), `.exe`/`.msi` (Windows), or `.AppImage`/`.deb` (Linux) under `src-tauri/target/release/bundle/`, depending on the host OS. Cross-compiling a Windows build from macOS isn't supported by Tauri's toolchain — see `.github/workflows/build.yml` for a CI matrix that builds all three on their native runners.

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
  autoscop_engine.py     the review engine (prompts, model-fallback, HTTP calls)
  db.js                 tiny IndexedDB wrapper for settings and run history
  zip-lite.js            dependency-free ZIP writer for the "Export all" feature
  vendor/pyodide/        bundled Pyodide runtime (Python-in-WebAssembly)
  assets/                mascot icon + bundled default agent/preset config (reviewers.json, dialect_reviewers.json, mode_presets.json)
src-tauri/               Tauri desktop wrapper (native window around web/)
.github/workflows/       CI: Tauri builds (macOS/Linux)
```

## AI Acknowledgment

This project, including its code and documentation, was built with the assistance of AI coding agents (OpenAI Codex and Anthropic Claude Code).
