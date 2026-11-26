const assert = require("assert");
const {
  parseMitosConfig,
  serializeMitosConfig,
  readGeneralSettings,
  setGeneralSetting,
  removeGeneralSetting,
} = require("./toml.js");
const { MITOS_DEFAULTS, mirrorCommandForMode } = require("./defaults.js");

const input = `theme = "modus-vivendi"

[editor]
line-number = "relative"

[keys.normal]
C-s = ":write"
";" = ["collapse_selection", "normal_mode"]

[keys.normal.q]
w = ":write"
q = ":quit"

[keys.normal.space]
h = ":toggle soft-wrap.enable"
`;

// 1. Parse preserves non-key config and parses nested q + something binds
const parsed = parseMitosConfig(input);
assert.strictEqual(parsed.keys.normal["C-s"], ":write");
assert.deepStrictEqual(parsed.keys.normal[";"], ["collapse_selection", "normal_mode"]);
assert.strictEqual(parsed.keys.normal.q.w, ":write");
assert.strictEqual(parsed.keys.normal.q.q, ":quit");
assert.strictEqual(parsed.keys.normal.space.h, ":toggle soft-wrap.enable");
assert.ok(parsed.preservedLines.some((l) => l.includes('theme = "modus-vivendi"')));
assert.ok(parsed.preservedLines.some((l) => l.includes('line-number = "relative"')));

// 2. Inline table sub-keymap (e.g. q = { w = ":write", f = { a = "file_picker" } })
const inlineParsed = parseMitosConfig(`[keys.normal]\nq = { w = ":write", f = { a = "file_picker" } }\n`);
assert.strictEqual(inlineParsed.keys.normal.q.w, ":write");
assert.strictEqual(inlineParsed.keys.normal.q.f.a, "file_picker");

// 3. Round-trip serialization preserves editor settings & quotes special keys
const out = serializeMitosConfig(parsed.keys, parsed.preservedLines);
assert.ok(out.includes('theme = "modus-vivendi"'));
assert.ok(out.includes('[keys.normal.q]'));
assert.ok(out.includes('";" = ["collapse_selection", "normal_mode"]'));
const reparsed = parseMitosConfig(out);
assert.deepStrictEqual(reparsed.keys, parsed.keys);

// 4. Defaults sanity check
assert.strictEqual(MITOS_DEFAULTS.normal.h, "move_char_left");
assert.strictEqual(MITOS_DEFAULTS.normal.space.f, "file_picker");
assert.strictEqual(MITOS_DEFAULTS.insert.esc, "normal_mode");
assert.strictEqual(MITOS_DEFAULTS.normal["-"], undefined);
assert.strictEqual(MITOS_DEFAULTS.normal["A-minus"], "merge_selections");

// 5. Shared menu comment round-trip (3 keys bound to the same menu) + minus / equals keys
const sharedInput = `
[keys.normal]
minus = "decrement"
"=" = "increment"

# mitos-webui:menu = "quicklist"
[keys.normal.q]
q = "quicklist_picker"
w = "goto_next_quicklist"

# mitos-webui:menu = "quicklist"
[keys.normal.b]
q = "quicklist_picker"
w = "goto_next_quicklist"

# mitos-webui:menu = "quicklist"
[keys.normal.minus]
q = "quicklist_picker"
w = "goto_next_quicklist"
`;
const sp = parseMitosConfig(sharedInput);
assert.strictEqual(sp.keys.normal.minus.q, "quicklist_picker");
assert.strictEqual(sp.keys.normal["="], "increment");
assert.strictEqual(sp.menuGroups["normal\0q"], "quicklist");
assert.strictEqual(sp.menuGroups["normal\0b"], "quicklist");
assert.strictEqual(sp.menuGroups["normal\0minus"], "quicklist");
const serializedShared = serializeMitosConfig(sp.keys, sp.preservedLines, sp.menuGroups);
assert.strictEqual((serializedShared.match(/# mitos-webui:menu = "quicklist"/g) || []).length, 3);
const reparsedShared = parseMitosConfig(serializedShared);
assert.deepStrictEqual(reparsedShared.menuGroups, sp.menuGroups);

// 6. Normal <-> Select expected behavior mirroring
assert.strictEqual(mirrorCommandForMode("move_previous_word_start", "select"), "extend_previous_word_start");
assert.strictEqual(mirrorCommandForMode("move_char_left", "select"), "extend_char_left");
assert.strictEqual(mirrorCommandForMode("select_mode", "select"), "normal_mode");
assert.strictEqual(mirrorCommandForMode("goto_line_start", "select"), "extend_to_line_start");
assert.strictEqual(mirrorCommandForMode("yank", "select"), "yank");
assert.strictEqual(mirrorCommandForMode("extend_next_word_start", "normal"), "move_next_word_start");
assert.strictEqual(mirrorCommandForMode("normal_mode", "normal"), "select_mode");

// 7. General (non-keybind) settings read / set / remove round-trip
let lines = parsed.preservedLines;
const gen = readGeneralSettings(lines);
assert.strictEqual(gen.theme, "modus-vivendi");
assert.strictEqual(gen.editor["line-number"], "relative");
lines = setGeneralSetting(lines, [], "theme", "dark_plus");
lines = setGeneralSetting(lines, ["editor"], "cursorline", true);
lines = setGeneralSetting(lines, ["editor", "soft-wrap"], "enable", true);
const gen2 = readGeneralSettings(lines);
assert.strictEqual(gen2.theme, "dark_plus");
assert.strictEqual(gen2.editor.cursorline, true);
assert.strictEqual(gen2.editor["soft-wrap"].enable, true);
lines = removeGeneralSetting(lines, ["editor"], "cursorline");
assert.strictEqual(readGeneralSettings(lines).editor.cursorline, undefined);

console.log("All checks passed.");
