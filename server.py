#!/usr/bin/env python3
"""Minimal local server for Mitos Config WebUI with auto-load/save of ~/.config/mitos/config.toml
and automatic default keymap syncing from the installed `ms` binary's exact git commit."""
import copy
import json
import os
import re
import subprocess
import tempfile
import tomllib
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("MITOS_CONFIG", "~/.config/mitos/config.toml")).expanduser()
USER_THEMES_DIR = CONFIG_PATH.parent / "themes"
DEFAULTS_CACHE_PATH = Path(__file__).resolve().parent / "mitos-defaults.json"
THEMES_CACHE_DIR = Path(__file__).resolve().parent / ".theme-cache"
PORT = int(os.environ.get("PORT", "8000"))
MITOS_REPO = os.environ.get("MITOS_REPO", "mitos-editor/mitos")


def _deep_merge(base, over):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def parse_mitos_default_rs(src):
    """Parse mitos crates/term/src/keymap/default.rs into {'normal', 'select', 'insert'} dicts."""
    # Strip // line comments outside string literals
    cleaned_lines = []
    for line in src.splitlines():
        in_str = False
        esc = False
        cut = len(line)
        for i, ch in enumerate(line):
            if esc:
                esc = False
                continue
            if ch == "\\" and in_str:
                esc = True
            elif ch == '"':
                in_str = not in_str
            elif not in_str and ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
                cut = i
                break
        cleaned_lines.append(line[:cut])
    text = "\n".join(cleaned_lines)

    # Tokenize strings, symbols, identifiers
    token_re = re.compile(r'"(?:\\.|[^"\\])*"|=>|[{}()|,;]|sticky|[A-Za-z_][A-Za-z0-9_]*')
    tokens = token_re.findall(text)

    def unquote(s):
        return json.loads(s)

    def parse_map(idx, env):
        assert tokens[idx] == "{"
        idx += 1
        # Optional title string at start of keymap block: { "Normal mode" ... }
        if idx < len(tokens) and tokens[idx].startswith('"') and (
            idx + 1 >= len(tokens) or tokens[idx + 1] not in ("|", "=>")
        ):
            idx += 1
        result = {}
        while idx < len(tokens) and tokens[idx] != "}":
            if tokens[idx] == ",":
                idx += 1
                continue
            keys = []
            while idx < len(tokens) and tokens[idx].startswith('"'):
                keys.append(unquote(tokens[idx]))
                idx += 1
                if idx < len(tokens) and tokens[idx] == "|":
                    idx += 1
            if idx >= len(tokens) or tokens[idx] != "=>":
                idx += 1
                continue
            idx += 1  # skip =>
            if tokens[idx] == "{":
                val, idx = parse_map(idx, env)
            elif tokens[idx] == "(":
                idx += 1
                ref_name = tokens[idx]
                while idx < len(tokens) and tokens[idx] != ")":
                    idx += 1
                idx += 1  # skip )
                val = copy.deepcopy(env.get(ref_name, {}))
            else:
                val = tokens[idx]
                idx += 1
            for k in keys:
                result[k] = copy.deepcopy(val)
            if idx < len(tokens) and tokens[idx] == ",":
                idx += 1
        if idx < len(tokens) and tokens[idx] == "}":
            idx += 1
        return result, idx

    env = {}
    i = 0
    n = len(tokens)
    while i < n:
        # Match: let [mut] <name> = keymap!({ ... })
        if tokens[i] == "let":
            j = i + 1
            if j < n and tokens[j] == "mut":
                j += 1
            if j + 1 < n:
                var = tokens[j]
                # Check for `<var> = <other>.clone()`
                if j + 3 < n and tokens[j + 1] == "clone":
                    pass
                # Find keymap!({ or <other>.clone() before `;`
                k = j + 1
                while k < n and tokens[k] != ";":
                    if tokens[k] == "keymap" and k + 2 < n and tokens[k + 1] == "(" and tokens[k + 2] == "{":
                        val, k = parse_map(k + 2, env)
                        env[var] = val
                        break
                    if tokens[k] == "clone" and k >= 1 and tokens[k - 1] in env:
                        env[var] = copy.deepcopy(env[tokens[k - 1]])
                        break
                    k += 1
                i = k + 1
                continue
        # Match: <var>.merge_nodes(keymap!({ ... }))
        if i + 1 < n and tokens[i] in env and tokens[i + 1] == "merge_nodes":
            var = tokens[i]
            k = i + 2
            while k < n and tokens[k] != ";":
                if tokens[k] == "keymap" and k + 2 < n and tokens[k + 1] == "(" and tokens[k + 2] == "{":
                    over, k = parse_map(k + 2, env)
                    env[var] = _deep_merge(env[var], over)
                    break
                k += 1
            i = k + 1
            continue
        i += 1

    return {
        "normal": env.get("normal", {}),
        "select": env.get("select", {}),
        "insert": env.get("insert", {}),
    }


def detect_mitos_version():
    try:
        out = subprocess.check_output(["ms", "--version"], text=True, timeout=3).strip()
        m = re.search(r"\(([0-9a-f]{7,40})\)", out)
        return out, (m.group(1) if m else "HEAD")
    except Exception:
        return None, "HEAD"


def fetch_mitos_defaults(force=False):
    version_str, ref = detect_mitos_version()
    cached = None
    if DEFAULTS_CACHE_PATH.exists():
        try:
            cached = json.loads(DEFAULTS_CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            cached = None

    # Use local copy unless forced or installed `ms` commit changed
    if not force and cached and cached.get("ref") == ref and cached.get("defaults"):
        return cached

    url = f"https://raw.githubusercontent.com/{MITOS_REPO}/{ref}/crates/term/src/keymap/default.rs"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mitos-config-webui"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            src = resp.read().decode("utf-8")
    except Exception:
        if cached and cached.get("defaults"):
            return cached
        raise

    payload = {
        "version": version_str or f"github:{ref}",
        "ref": ref,
        "source": url,
        "defaults": parse_mitos_default_rs(src),
    }
    DEFAULTS_CACHE_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def _read_theme_toml(name, ref):
    safe = Path(name).name
    if not safe or safe in (".", ".."):
        return None
    # 1. User's ~/.config/mitos/themes/<name>.toml
    local_path = USER_THEMES_DIR / f"{safe}.toml"
    if local_path.exists():
        return tomllib.loads(local_path.read_text(encoding="utf-8"))
    # 2. Local cache of built-in Mitos theme for this ref
    cache_path = THEMES_CACHE_DIR / ref / f"{safe}.toml"
    if cache_path.exists():
        return tomllib.loads(cache_path.read_text(encoding="utf-8"))
    # 3. Fetch built-in theme from mitos-editor/mitos at installed ref
    url = f"https://raw.githubusercontent.com/{MITOS_REPO}/{ref}/runtime/themes/{urllib.parse.quote(safe)}.toml"
    req = urllib.request.Request(url, headers={"User-Agent": "mitos-config-webui"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            text = resp.read().decode("utf-8")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
        return tomllib.loads(text)
    except Exception:
        return None


def _resolve_theme_raw(name, ref, seen=None):
    seen = seen or set()
    if name in seen:
        return {}
    seen.add(name)
    data = _read_theme_toml(name, ref)
    if not data:
        return {}
    parent = data.get("inherits")
    if isinstance(parent, str) and parent:
        base = _resolve_theme_raw(parent, ref, seen)
        merged = _deep_merge(base, data)
        return merged
    return data


def _resolve_color(val, palette):
    if not isinstance(val, str):
        return None
    val = val.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", val):
        return val
    if re.fullmatch(r"#[0-9a-fA-F]{3}", val):
        return "#" + "".join(c * 2 for c in val[1:])
    if val in palette and isinstance(palette[val], str):
        return _resolve_color(palette[val], palette)
    return None


def _lookup_theme_key(theme, key):
    if key in theme:
        return theme[key]
    # Also support unquoted dotted keys parsed as nested dicts by tomllib
    cur = theme
    for part in key.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _pick_style_color(theme, keys, prop, palette):
    for k in keys:
        entry = _lookup_theme_key(theme, k)
        if isinstance(entry, str) and prop == "fg":
            c = _resolve_color(entry, palette)
            if c:
                return c
        elif isinstance(entry, dict) and prop in entry:
            c = _resolve_color(entry[prop], palette)
            if c:
                return c
    return None


def _hex_to_rgb(hex_color):
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _is_light_hex(hex_color):
    r, g, b = _hex_to_rgb(hex_color)
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150


def _saturation(hex_color):
    r, g, b = [c / 255.0 for c in _hex_to_rgb(hex_color)]
    hi, lo = max(r, g, b), min(r, g, b)
    return 0.0 if hi == 0 else (hi - lo) / hi


def _shift_hex(hex_color, delta):
    r, g, b = _hex_to_rgb(hex_color)
    clamp = lambda x: max(0, min(255, int(round(x))))
    return f"#{clamp(r + delta):02x}{clamp(g + delta):02x}{clamp(b + delta):02x}"


def _pick_neutral_bg(theme, keys, palette, bg):
    bg_sat = _saturation(bg)
    for k in keys:
        c = _pick_style_color(theme, [k], "bg", palette)
        if c and _saturation(c) <= max(0.35, bg_sat + 0.15) and c.lower() != bg.lower():
            return c
    return None


def _pick_accent_fg(theme, keys, palette, used=None):
    used = {c.lower() for c in (used or ())}
    for k in keys:
        c = _pick_style_color(theme, [k], "fg", palette)
        if c and _saturation(c) >= 0.2 and c.lower() not in used:
            return c
    return None


def load_theme_colors(name):
    _, ref = detect_mitos_version()
    theme = _resolve_theme_raw(name, ref)
    if not theme:
        return None
    palette = theme.get("palette") if isinstance(theme.get("palette"), dict) else {}

    bg = (
        _pick_style_color(theme, ["ui.background"], "bg", palette)
        or _resolve_color(palette.get("background"), palette)
        or "#1e1e1e"
    )
    light = _is_light_hex(bg)
    step = -10 if light else 10

    # Match Mitos's actual UI depth hierarchy:
    # - bg:       ui.background (main editor canvas)
    # - surface:  ui.statusline.inactive / ui.bufferline (inset chrome: header, panels, keyboard deck)
    # - surface2: ui.popup / ui.menu (raised widgets: keycaps, buttons, popups)
    # - border:   palette.borders / ui.menu.selected / ui.selection (borders & hover)
    surface = (
        _pick_neutral_bg(theme, ["ui.statusline.inactive", "ui.bufferline", "ui.bufferline.background"], palette, bg)
        or _resolve_color(palette.get("inset"), palette)
        or _pick_neutral_bg(theme, ["ui.popup", "ui.menu"], palette, bg)
        or _shift_hex(bg, -step)
    )
    surface2 = (
        _pick_neutral_bg(theme, ["ui.popup", "ui.menu", "ui.help", "ui.cursorline.primary"], palette, bg)
        or _resolve_color(palette.get("widget"), palette)
        or _shift_hex(bg, step)
    )
    border = (
        _resolve_color(palette.get("borders"), palette)
        or _pick_neutral_bg(theme, ["ui.menu.selected", "ui.selection", "ui.virtual.indent-guide"], palette, bg)
        or _pick_style_color(theme, ["ui.window"], "fg", palette)
        or _shift_hex(surface2, step)
    )
    text = (
        _pick_style_color(theme, ["ui.text"], "fg", palette)
        or _resolve_color(palette.get("text"), palette)
        or ("#1e1e1e" if light else "#d4d4d4")
    )
    muted = (
        _pick_style_color(theme, ["ui.text.inactive", "comment", "ui.linenr"], "fg", palette)
        or ("#666b78" if light else "#858585")
    )
    accent = (
        _pick_accent_fg(theme, ["keyword", "ui.bufferline.active", "ui.text.directory", "info", "function"], palette)
        or text
    )
    override = (
        _pick_accent_fg(theme, ["type", "string", "constant.numeric", "warning", "function"], palette, [accent])
        or accent
    )
    prefix = (
        _pick_accent_fg(theme, ["keyword.control", "special", "constructor", "constant", "function"], palette, [accent, override])
        or accent
    )
    danger = (
        _pick_accent_fg(theme, ["error", "diagnostic.error", "diff.minus", "warning"], palette)
        or override
    )

    contrast_on = lambda c: (bg if not light else text) if _is_light_hex(c) else (text if not light else bg)

    return {
        "name": name,
        "colors": {
            "light": light,
            "bg": bg,
            "surface": surface,
            "surface2": surface2,
            "border": border,
            "text": text,
            "muted": muted,
            "accent": accent,
            "onAccent": contrast_on(accent),
            "override": override,
            "onOverride": contrast_on(override),
            "prefix": prefix,
            "onPrefix": contrast_on(prefix),
            "danger": danger,
        },
    }


def list_available_themes():
    _, ref = detect_mitos_version()
    local_themes = sorted(p.stem for p in USER_THEMES_DIR.glob("*.toml")) if USER_THEMES_DIR.exists() else []
    list_cache = THEMES_CACHE_DIR / ref / "_list.json"
    builtin = []
    if list_cache.exists():
        try:
            builtin = json.loads(list_cache.read_text(encoding="utf-8"))
        except Exception:
            builtin = []
    if not builtin:
        url = f"https://api.github.com/repos/{MITOS_REPO}/contents/runtime/themes?ref={ref}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "mitos-config-webui"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                items = json.loads(resp.read().decode("utf-8"))
            builtin = sorted(it["name"][:-5] for it in items if it.get("name", "").endswith(".toml"))
            list_cache.parent.mkdir(parents=True, exist_ok=True)
            list_cache.write_text(json.dumps(builtin), encoding="utf-8")
        except Exception:
            builtin = []
    seen = set()
    merged = []
    for name in local_themes + builtin:
        if name not in seen:
            seen.add(name)
            merged.append(name)
    return {"themes": merged, "local": local_themes}


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if route == "/api/config":
            try:
                exists = CONFIG_PATH.exists()
                text = CONFIG_PATH.read_text(encoding="utf-8") if exists else ""
                self._send_json(200, {"path": str(CONFIG_PATH), "exists": exists, "text": text})
            except OSError as exc:
                self._send_json(500, {"error": str(exc), "path": str(CONFIG_PATH)})
            return
        if route == "/api/defaults":
            try:
                force = qs.get("refresh") == ["1"]
                self._send_json(200, fetch_mitos_defaults(force=force))
            except Exception as exc:
                self._send_json(500, {"error": str(exc)})
            return
        if route == "/api/themes":
            self._send_json(200, list_available_themes())
            return
        if route == "/api/theme":
            name = (qs.get("name") or [""])[0].strip()
            if not name:
                self._send_json(400, {"error": "missing name"})
                return
            res = load_theme_colors(name)
            if not res:
                self._send_json(404, {"error": f"theme '{name}' not found"})
                return
            self._send_json(200, res)
            return
        super().do_GET()

    def do_PUT(self):
        if self.path.split("?", 1)[0] == "/api/config":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                text = self.rfile.read(length).decode("utf-8")
                CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
                tmp = CONFIG_PATH.with_suffix(".toml.tmp")
                tmp.write_text(text, encoding="utf-8")
                os.replace(tmp, CONFIG_PATH)
                self._send_json(200, {"ok": True, "path": str(CONFIG_PATH)})
            except OSError as exc:
                self._send_json(500, {"error": str(exc), "path": str(CONFIG_PATH)})
            return
        self.send_error(404)


if __name__ == "__main__":
    print(f"Serving Mitos Config WebUI at http://127.0.0.1:{PORT}/ (config: {CONFIG_PATH})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
