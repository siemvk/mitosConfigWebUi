# Mitos Config WebUI

> [!WARNING]
> **AI Slop Warning:** This project was vibe-coded with an AI assistant. It works, has zero dependencies, and preserves your non-key TOML settings — but back up your `~/.config/mitos/config.toml` before saving just in case.

A local web UI for viewing and editing your [Mitos](https://mitos.computer) keybindings (`~/.config/mitos/config.toml`) on a Mac keyboard layout.

## Usage

**With auto-load & direct save to `~/.config/mitos/config.toml`:**

```bash
python3 server.py
```

Then open [http://127.0.0.1:8000/](http://127.0.0.1:8000/). (Set `MITOS_CONFIG=/path/to/config.toml` or `PORT=8080` to override defaults.)

**Static / no server:**

Open `index.html` directly in your browser and drag-and-drop or open your `config.toml`.

## Features

- **MacBook US ANSI keyboard** — Click `⌃`, `⌥`, `⇧` directly on the keyboard to switch modifier layers.
- **Defaults + Hide Defaults** — Unbound keys fall back to Mitos defaults, with a toggle in the `⋯` menu to hide them.
- **Sub-keymaps & Shared Menus** — Double-click any prefix key (e.g. `q`, `space`, `g`) to edit nested chords. Link multiple keys (and/or `normal` + `select` modes) to the same menu via `# mitos-webui:menu = "<name>"` comments.
- **Friendly names & hover docs** — Readable labels, searchable command dropdown, and hover explanations.
- **Normal ↔ Select mirroring** — Optional checkbox to mirror `move_*` ↔ `extend_*` bindings automatically.
- **Safety** — `⌘Z` / `⇧⌘Z` undo/redo and unsaved-changes close/reload warning.

## Self-check

```bash
node test.js
```
