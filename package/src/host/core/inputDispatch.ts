// Input dispatch helpers — modifier encoding + DOM `key` → Win32 VK + macOS
// Quartz key code + DOM `code` + char. Backends translate the FFI bitmask
// (Alt=1, Ctrl=2, Meta=4, Shift=8) to native form. Stage B keymap covers
// ASCII + the named keys Playwright-style automation relies on.

import type { Modifier } from "../../rpc/framework";

export function encodeModifiers(mods: Modifier[] | undefined): number {
  if (!mods) return 0;
  let bits = 0;
  for (const m of mods) {
    if (m === "alt") bits |= 1;
    else if (m === "ctrl") bits |= 2;
    else if (m === "meta") bits |= 4;
    else if (m === "shift") bits |= 8;
  }
  return bits;
}

export interface ResolvedKey {
  windowsVkCode: number;
  macKeyCode: number;
  /** DOM `KeyboardEvent.key` — pass-through; native dispatchers forward to engines. */
  key: string;
  /** DOM `KeyboardEvent.code` — derived from US keyboard mapping. */
  code: string;
  /** Text payload for the CHAR / insertText event; empty = skip char. */
  character: string;
  /** Win scancode 0xE0 prefix: nav cluster (Arrow/Insert/Delete/Home/End/
   *  PageUp/PageDown/Meta/ContextMenu) AND Numpad-Enter. Distinct from
   *  `location` — most extended keys are NOT numpad (location 0). */
  extended: boolean;
  /** DOM `KeyboardEvent.location`: 0=standard, 1=left mod, 2=right mod,
   *  3=numpad. WV2 CDP uses this; CEF derives from scancode 0xE0 prefix. */
  location: 0 | 1 | 2 | 3;
}

/** Maps a DOM `KeyboardEvent.key` value to backend-neutral identifiers. */
export function resolveKey(domKey: string): ResolvedKey {
  if (domKey.length === 0) {
    return { windowsVkCode: 0, macKeyCode: 0, key: "", code: "", character: "", extended: false, location: 0 };
  }

  // Named key (Enter, Tab, ArrowLeft …).
  const named = NAMED_KEYS[domKey];
  if (named) {
    return {
      windowsVkCode: named.win,
      macKeyCode: named.mac,
      key: domKey,
      code: named.code,
      // Space/Tab/Enter generate text in CDP automatically; we pass an explicit
      // character so DOM `keypress` fires consistently across engines.
      character: named.character ?? "",
      extended: named.ext === true,
      location: named.loc ?? 0,
    };
  }

  // Single Unicode codepoint — letter / digit / printable / extended.
  if ([...domKey].length === 1) {
    const cp = domKey.codePointAt(0)!;
    // ASCII A-Z / a-z → matching Win VK + mac keyCode + DOM code "KeyX".
    if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) {
      const upper = cp & ~0x20;  // strip lowercase bit
      return {
        windowsVkCode: upper,
        macKeyCode: MAC_KEY_LETTER[upper - 0x41],
        key: domKey,
        code: `Key${String.fromCharCode(upper)}`,
        character: domKey,
        extended: false,
        location: 0,
      };
    }
    // ASCII 0-9.
    if (cp >= 0x30 && cp <= 0x39) {
      return {
        windowsVkCode: cp,
        macKeyCode: MAC_KEY_DIGIT[cp - 0x30],
        key: domKey,
        code: `Digit${domKey}`,
        character: domKey,
        extended: false,
        location: 0,
      };
    }
    // Other printable codepoint — char event only, no virtual key.
    return { windowsVkCode: 0, macKeyCode: 0, key: domKey, code: "", character: domKey, extended: false, location: 0 };
  }

  // Multi-codepoint string we don't recognise as a named key — pass-through.
  return { windowsVkCode: 0, macKeyCode: 0, key: domKey, code: "", character: "", extended: false, location: 0 };
}

// Win32 VK_* + Quartz Event Services kVK_* + DOM code + literal character +
// LPARAM extended-key flag. `ext: true` for nav-cluster keys (separate from
// numpad equivalents) and Numpad-Enter — Chromium derives `KeyboardEvent.code`
// from LPARAM scancode + extended bit. Sources:
//   learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
//   chromium/ui/events/keycodes/dom/keycode_converter_data.inc
type NamedKey = { win: number; mac: number; code: string; character?: string; ext?: true; loc?: 1 | 2 | 3 };
const NAMED_KEYS: Record<string, NamedKey> = {
  Backspace:    { win: 0x08, mac: 0x33, code: "Backspace" },
  Tab:          { win: 0x09, mac: 0x30, code: "Tab", character: "\t" },
  Enter:        { win: 0x0D, mac: 0x24, code: "Enter", character: "\r" },
  NumpadEnter:  { win: 0x0D, mac: 0x4C, code: "NumpadEnter", character: "\r", ext: true, loc: 3 },
  Escape:       { win: 0x1B, mac: 0x35, code: "Escape" },
  " ":          { win: 0x20, mac: 0x31, code: "Space", character: " " },
  Space:        { win: 0x20, mac: 0x31, code: "Space", character: " " },
  PageUp:       { win: 0x21, mac: 0x74, code: "PageUp", ext: true },
  PageDown:     { win: 0x22, mac: 0x79, code: "PageDown", ext: true },
  End:          { win: 0x23, mac: 0x77, code: "End", ext: true },
  Home:         { win: 0x24, mac: 0x73, code: "Home", ext: true },
  ArrowLeft:    { win: 0x25, mac: 0x7B, code: "ArrowLeft", ext: true },
  ArrowUp:      { win: 0x26, mac: 0x7E, code: "ArrowUp", ext: true },
  ArrowRight:   { win: 0x27, mac: 0x7C, code: "ArrowRight", ext: true },
  ArrowDown:    { win: 0x28, mac: 0x7D, code: "ArrowDown", ext: true },
  Insert:       { win: 0x2D, mac: 0x72, code: "Insert", ext: true },
  Delete:       { win: 0x2E, mac: 0x75, code: "Delete", ext: true },
  Meta:         { win: 0x5B, mac: 0x37, code: "MetaLeft", ext: true },
  ContextMenu:  { win: 0x5D, mac: 0x6E, code: "ContextMenu", ext: true },
  F1:  { win: 0x70, mac: 0x7A, code: "F1" },
  F2:  { win: 0x71, mac: 0x78, code: "F2" },
  F3:  { win: 0x72, mac: 0x63, code: "F3" },
  F4:  { win: 0x73, mac: 0x76, code: "F4" },
  F5:  { win: 0x74, mac: 0x60, code: "F5" },
  F6:  { win: 0x75, mac: 0x61, code: "F6" },
  F7:  { win: 0x76, mac: 0x62, code: "F7" },
  F8:  { win: 0x77, mac: 0x64, code: "F8" },
  F9:  { win: 0x78, mac: 0x65, code: "F9" },
  F10: { win: 0x79, mac: 0x6D, code: "F10" },
  F11: { win: 0x7A, mac: 0x67, code: "F11" },
  F12: { win: 0x7B, mac: 0x6F, code: "F12" },
};

// US keyboard layout — Quartz hardware key code per ASCII letter (A → 0x00, …, Z → 0x06).
const MAC_KEY_LETTER = [
  // A    B    C    D    E    F    G    H    I    J    K    L    M
  0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E,
  // N    O    P    Q    R    S    T    U    V    W    X    Y    Z
  0x2D, 0x1F, 0x23, 0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06,
];
// US keyboard layout — Quartz hardware key code per digit (0 → 0x1D, 1 → 0x12 …).
const MAC_KEY_DIGIT = [
  0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19,
];
