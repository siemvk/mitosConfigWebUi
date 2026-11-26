// Minimal bidirectional TOML parser & serializer for Mitos config.toml.
// Preserves all non-[keys.*] content verbatim while giving structured read/write access to `keys`.
(function (root) {
  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function stripComment(line) {
    let inBasic = false;
    let inLiteral = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBasic) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else {
        if (ch === '"') inBasic = true;
        else if (ch === "'") inLiteral = true;
        else if (ch === "#") return line.slice(0, i);
      }
    }
    return line;
  }

  function unescapeBasicString(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) {
        const next = s[++i];
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else if (next === '"') out += '"';
        else if (next === "\\") out += "\\";
        else out += next;
      } else {
        out += s[i];
      }
    }
    return out;
  }

  // Parse a dotted key path like `keys.normal."C-w"."["` into ["keys", "normal", "C-w", "["]
  function parseKeyPath(str) {
    const parts = [];
    let i = 0;
    const n = str.length;
    while (i < n) {
      while (i < n && (str[i] === " " || str[i] === "\t")) i++;
      if (i >= n) break;
      if (str[i] === '"') {
        i++;
        let buf = "";
        while (i < n && str[i] !== '"') {
          if (str[i] === "\\" && i + 1 < n) {
            buf += str[i] + str[i + 1];
            i += 2;
          } else {
            buf += str[i++];
          }
        }
        if (str[i] !== '"') throw new Error("Unterminated quoted key: " + str);
        i++;
        parts.push(unescapeBasicString(buf));
      } else if (str[i] === "'") {
        i++;
        let buf = "";
        while (i < n && str[i] !== "'") buf += str[i++];
        if (str[i] !== "'") throw new Error("Unterminated literal key: " + str);
        i++;
        parts.push(buf);
      } else {
        let buf = "";
        while (i < n && str[i] !== "." && str[i] !== " " && str[i] !== "\t") {
          buf += str[i++];
        }
        if (buf.length) parts.push(buf);
      }
      while (i < n && (str[i] === " " || str[i] === "\t")) i++;
      if (str[i] === ".") i++;
    }
    return parts;
  }

  // Split key = value at top-level '='
  function splitKeyValue(line) {
    let inBasic = false;
    let inLiteral = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBasic) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else {
        if (ch === '"') inBasic = true;
        else if (ch === "'") inLiteral = true;
        else if (ch === "=") return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      }
    }
    return null;
  }

  // Recursive descent parser for TOML values (strings, arrays, inline tables, primitives)
  function parseValue(src) {
    let i = 0;
    const n = src.length;

    function skipWs() {
      while (i < n && /\s/.test(src[i])) i++;
    }

    function readValue() {
      skipWs();
      if (i >= n) return "";
      const ch = src[i];
      if (ch === '"') return readBasicString();
      if (ch === "'") return readLiteralString();
      if (ch === "[") return readArray();
      if (ch === "{") return readInlineTable();
      // Bare primitive (bool/number)
      let start = i;
      while (i < n && src[i] !== "," && src[i] !== "]" && src[i] !== "}" && !/\s/.test(src[i])) {
        i++;
      }
      const token = src.slice(start, i);
      if (token === "true") return true;
      if (token === "false") return false;
      if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
      return token;
    }

    function readBasicString() {
      i++; // skip "
      let buf = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          buf += src[i] + src[i + 1];
          i += 2;
        } else {
          buf += src[i++];
        }
      }
      if (src[i] !== '"') throw new Error("Unterminated string: " + src);
      i++;
      return unescapeBasicString(buf);
    }

    function readLiteralString() {
      i++; // skip '
      let buf = "";
      while (i < n && src[i] !== "'") buf += src[i++];
      if (src[i] !== "'") throw new Error("Unterminated literal string: " + src);
      i++;
      return buf;
    }

    function readArray() {
      i++; // skip [
      const arr = [];
      skipWs();
      while (i < n && src[i] !== "]") {
        arr.push(readValue());
        skipWs();
        if (src[i] === ",") { i++; skipWs(); }
      }
      if (src[i] !== "]") throw new Error("Unterminated array: " + src);
      i++;
      return arr;
    }

    function readInlineTable() {
      i++; // skip {
      const obj = {};
      skipWs();
      while (i < n && src[i] !== "}") {
        // Read key up to '='
        let keyStart = i;
        let inBasic = false;
        let inLiteral = false;
        while (i < n) {
          const c = src[i];
          if (inBasic) {
            if (c === "\\") { i += 2; continue; }
            if (c === '"') inBasic = false;
          } else if (inLiteral) {
            if (c === "'") inLiteral = false;
          } else {
            if (c === '"') inBasic = true;
            else if (c === "'") inLiteral = true;
            else if (c === "=") break;
          }
          i++;
        }
        const keyStr = src.slice(keyStart, i).trim();
        if (src[i] !== "=") throw new Error("Expected '=' in inline table: " + src);
        i++; // skip =
        const val = readValue();
        const path = parseKeyPath(keyStr);
        setNested(obj, path, val);
        skipWs();
        if (src[i] === ",") { i++; skipWs(); }
      }
      if (src[i] !== "}") throw new Error("Unterminated inline table: " + src);
      i++;
      return obj;
    }

    return readValue();
  }

  function setNested(rootObj, path, value) {
    let cur = rootObj;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (!isPlainObject(cur[seg])) cur[seg] = {};
      cur = cur[seg];
    }
    cur[path[path.length - 1]] = value;
  }

  // Count unbalanced brackets/braces outside strings so multi-line arrays/inline tables join cleanly.
  function bracketDelta(line) {
    let delta = 0;
    let inBasic = false;
    let inLiteral = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inBasic) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inBasic = false;
      } else if (inLiteral) {
        if (ch === "'") inLiteral = false;
      } else {
        if (ch === '"') inBasic = true;
        else if (ch === "'") inLiteral = true;
        else if (ch === "[" || ch === "{") delta++;
        else if (ch === "]" || ch === "}") delta--;
      }
    }
    return delta;
  }

  const MENU_COMMENT_RE = /^#\s*mitos-webui:menu\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))\s*$/;

  function menuPathKey(pathParts) {
    return pathParts.join("\0");
  }

  // Parse a Mitos config.toml into { keys: {...}, preservedLines: [...], menuGroups: {...} }.
  // All non-`keys` sections and top-level settings are kept verbatim in `preservedLines`.
  // ponytail: assumes standard single-line or multi-line array/inline-table TOML (no """ heredocs inside [keys.*]).
  function parseMitosConfig(text) {
    const rawLines = text.replace(/\r\n/g, "\n").split("\n");
    const keys = {};
    const preservedLines = [];
    const menuGroups = {};
    let currentSection = [];
    let inKeysSection = false;
    let pendingMenu = null;

    for (let idx = 0; idx < rawLines.length; idx++) {
      const raw = rawLines[idx];
      const trimmedRaw = raw.trim();
      const menuMatch = trimmedRaw.match(MENU_COMMENT_RE);
      if (menuMatch) {
        pendingMenu = menuMatch[1] !== undefined
          ? unescapeBasicString(menuMatch[1])
          : (menuMatch[2] !== undefined ? menuMatch[2] : menuMatch[3]);
        continue;
      }

      const stripped = stripComment(raw).trim();

      if (!stripped) {
        if (!inKeysSection) preservedLines.push(raw);
        continue;
      }

      // Section header [foo.bar] (not [[array-of-tables]])
      if (stripped.startsWith("[") && !stripped.startsWith("[[") && stripped.endsWith("]")) {
        const inner = stripped.slice(1, -1).trim();
        currentSection = parseKeyPath(inner);
        inKeysSection = currentSection[0] === "keys";
        if (inKeysSection) {
          // Ensure empty table exists (e.g. [keys.normal.q] with no entries yet)
          if (currentSection.length > 1) {
            let cur = keys;
            for (let s = 1; s < currentSection.length; s++) {
              if (!isPlainObject(cur[currentSection[s]])) cur[currentSection[s]] = {};
              cur = cur[currentSection[s]];
            }
          }
          if (pendingMenu && currentSection.length >= 3) {
            menuGroups[menuPathKey(currentSection.slice(1))] = pendingMenu;
          }
        } else {
          preservedLines.push(raw);
        }
        pendingMenu = null;
        continue;
      }

      pendingMenu = null;

      // Array-of-tables header [[...]]
      if (stripped.startsWith("[[")) {
        currentSection = [];
        inKeysSection = false;
        preservedLines.push(raw);
        continue;
      }

      // Top-level `keys.normal.x = ...` outside a [keys.*] header
      const kv = splitKeyValue(stripped);
      const keyPath = kv ? parseKeyPath(kv[0]) : null;
      const isInlineKeysLine = !inKeysSection && currentSection.length === 0 && keyPath && keyPath[0] === "keys";

      if (!inKeysSection && !isInlineKeysLine) {
        preservedLines.push(raw);
        continue;
      }

      if (!kv) continue;

      let rhs = kv[1];
      let balance = bracketDelta(rhs);
      while (balance > 0 && idx + 1 < rawLines.length) {
        idx++;
        const nextStripped = stripComment(rawLines[idx]).trim();
        rhs += " " + nextStripped;
        balance += bracketDelta(nextStripped);
      }

      const fullPath = isInlineKeysLine
        ? keyPath.slice(1)
        : currentSection.slice(1).concat(keyPath);

      if (fullPath.length === 0) continue;
      const val = parseValue(rhs);
      setNested(keys, fullPath, val);
    }

    // Trim trailing blank lines from preservedLines
    while (preservedLines.length && preservedLines[preservedLines.length - 1].trim() === "") {
      preservedLines.pop();
    }

    return { keys, preservedLines, menuGroups };
  }

  function formatKey(key) {
    if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
    return '"' + key.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function formatString(str) {
    return '"' + str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t") + '"';
  }

  function formatValue(val) {
    if (Array.isArray(val)) {
      return "[" + val.map(formatValue).join(", ") + "]";
    }
    if (typeof val === "string") return formatString(val);
    if (typeof val === "boolean" || typeof val === "number") return String(val);
    return formatString(String(val));
  }

  function serializeKeyTable(path, obj, outBlocks, menuGroups) {
    const scalars = [];
    const subtables = [];
    for (const [k, v] of Object.entries(obj)) {
      if (isPlainObject(v)) subtables.push([k, v]);
      else scalars.push([k, v]);
    }
    const menuName = menuGroups && path.length >= 3 ? menuGroups[menuPathKey(path.slice(1))] : null;
    if (scalars.length > 0 || (subtables.length === 0 && path.length > 2) || menuName) {
      const header = "[" + path.map(formatKey).join(".") + "]";
      const lines = [];
      if (menuName) lines.push(`# mitos-webui:menu = ${formatString(menuName)}`);
      lines.push(header);
      for (const [k, v] of scalars) {
        lines.push(`${formatKey(k)} = ${formatValue(v)}`);
      }
      outBlocks.push(lines.join("\n"));
    }
    for (const [k, v] of subtables) {
      serializeKeyTable(path.concat([k]), v, outBlocks, menuGroups);
    }
  }

  function serializeMitosConfig(keys, preservedLines, menuGroups) {
    const parts = [];
    if (preservedLines && preservedLines.length > 0) {
      parts.push(preservedLines.join("\n"));
    }
    const keyBlocks = [];
    // Emit normal, select, insert first if present, then any other modes
    const preferred = ["normal", "select", "insert"];
    const modeNames = [
      ...preferred.filter((m) => isPlainObject(keys[m])),
      ...Object.keys(keys).filter((m) => !preferred.includes(m) && isPlainObject(keys[m])),
    ];
    for (const mode of modeNames) {
      serializeKeyTable(["keys", mode], keys[mode], keyBlocks, menuGroups);
    }
    if (keyBlocks.length > 0) {
      parts.push(keyBlocks.join("\n\n"));
    }
    return parts.join("\n\n") + (parts.length ? "\n" : "");
  }

  // Read all non-key settings from preservedLines into a nested object (top-level keys + [section.*]).
  function readGeneralSettings(preservedLines) {
    const out = {};
    let section = [];
    for (const raw of preservedLines || []) {
      const stripped = stripComment(raw).trim();
      if (!stripped) continue;
      if (stripped.startsWith("[[")) { section = []; continue; }
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        section = parseKeyPath(stripped.slice(1, -1).trim());
        continue;
      }
      const kv = splitKeyValue(stripped);
      if (!kv) continue;
      const keyPath = section.concat(parseKeyPath(kv[0]));
      if (keyPath.length) setNested(out, keyPath, parseValue(kv[1]));
    }
    return out;
  }

  // Update or insert a setting inside preservedLines while keeping comments & other sections intact.
  // `sectionPath` is e.g. [] for top-level (`theme`) or ["editor", "rainbow-brackets"].
  function setGeneralSetting(preservedLines, sectionPath, key, value) {
    const lines = (preservedLines || []).slice();
    const targetSec = sectionPath.join(".");
    const formattedLine = `${formatKey(key)} = ${formatValue(value)}`;

    let curSec = "";
    let sectionHeaderIdx = -1;
    let sectionEndIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const stripped = stripComment(lines[i]).trim();
      if (!stripped) continue;
      if (stripped.startsWith("[[")) {
        if (curSec === targetSec && sectionEndIdx === -1) sectionEndIdx = i;
        curSec = "\0";
        continue;
      }
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        if (curSec === targetSec && sectionEndIdx === -1) sectionEndIdx = i;
        curSec = parseKeyPath(stripped.slice(1, -1).trim()).join(".");
        if (curSec === targetSec) sectionHeaderIdx = i;
        continue;
      }
      if (curSec === targetSec) {
        const kv = splitKeyValue(stripped);
        if (kv) {
          const kp = parseKeyPath(kv[0]);
          if (kp.length === 1 && kp[0] === key) {
            lines[i] = formattedLine;
            return lines;
          }
        }
      }
    }

    if (targetSec === "") {
      // Insert before first [section] header
      const firstSec = lines.findIndex((l) => stripComment(l).trim().startsWith("["));
      if (firstSec === -1) lines.push(formattedLine);
      else lines.splice(firstSec, 0, formattedLine);
      return lines;
    }

    if (sectionHeaderIdx !== -1) {
      let insertAt = sectionEndIdx === -1 ? lines.length : sectionEndIdx;
      while (insertAt > sectionHeaderIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
      lines.splice(insertAt, 0, formattedLine);
      return lines;
    }

    // Append new section
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("[" + sectionPath.map(formatKey).join(".") + "]");
    lines.push(formattedLine);
    return lines;
  }

  function removeGeneralSetting(preservedLines, sectionPath, key) {
    const lines = (preservedLines || []).slice();
    const targetSec = sectionPath.join(".");
    let curSec = "";
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripComment(lines[i]).trim();
      if (!stripped) continue;
      if (stripped.startsWith("[[")) { curSec = "\0"; continue; }
      if (stripped.startsWith("[") && stripped.endsWith("]")) {
        curSec = parseKeyPath(stripped.slice(1, -1).trim()).join(".");
        continue;
      }
      if (curSec === targetSec) {
        const kv = splitKeyValue(stripped);
        if (kv) {
          const kp = parseKeyPath(kv[0]);
          if (kp.length === 1 && kp[0] === key) {
            lines.splice(i, 1);
            return lines;
          }
        }
      }
    }
    return lines;
  }

  const api = {
    parseMitosConfig,
    serializeMitosConfig,
    readGeneralSettings,
    setGeneralSetting,
    removeGeneralSetting,
    parseKeyPath,
    formatKey,
    menuPathKey,
    isPlainObject,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MitosToml = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
