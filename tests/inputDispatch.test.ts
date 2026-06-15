import { describe, expect, test } from "bun:test";
import { encodeModifiers, resolveKey } from "../package/src/host/core/inputDispatch";

describe("encodeModifiers", () => {
  test("empty / undefined → 0", () => {
    expect(encodeModifiers(undefined)).toBe(0);
    expect(encodeModifiers([])).toBe(0);
  });
  test("single modifiers — CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8)", () => {
    expect(encodeModifiers(["alt"])).toBe(1);
    expect(encodeModifiers(["ctrl"])).toBe(2);
    expect(encodeModifiers(["meta"])).toBe(4);
    expect(encodeModifiers(["shift"])).toBe(8);
  });
  test("combinations OR together", () => {
    expect(encodeModifiers(["shift", "ctrl"])).toBe(10);
    expect(encodeModifiers(["alt", "meta", "shift"])).toBe(13);
  });
});

describe("resolveKey", () => {
  test("empty key", () => {
    const r = resolveKey("");
    expect(r.windowsVkCode).toBe(0);
    expect(r.macKeyCode).toBe(0);
    expect(r.character).toBe("");
  });

  test("named keys carry VK + DOM code, no character (except space/tab/enter)", () => {
    const enter = resolveKey("Enter");
    expect(enter.windowsVkCode).toBe(0x0d);
    expect(enter.macKeyCode).toBe(0x24);
    expect(enter.code).toBe("Enter");
    expect(enter.character).toBe("\r");

    const tab = resolveKey("Tab");
    expect(tab.windowsVkCode).toBe(0x09);
    expect(tab.character).toBe("\t");

    const left = resolveKey("ArrowLeft");
    expect(left.windowsVkCode).toBe(0x25);
    expect(left.macKeyCode).toBe(0x7b);
    expect(left.code).toBe("ArrowLeft");
    expect(left.character).toBe("");
  });

  test("space — both 'Space' name and ' ' literal map identically", () => {
    const named = resolveKey("Space");
    const literal = resolveKey(" ");
    expect(named.windowsVkCode).toBe(0x20);
    expect(named.character).toBe(" ");
    expect(literal.windowsVkCode).toBe(0x20);
    expect(literal.character).toBe(" ");
    expect(literal.code).toBe("Space");
  });

  test("ASCII letters — VK = upper-ASCII, mac keyCode = US layout, code = KeyX", () => {
    const a = resolveKey("a");
    expect(a.windowsVkCode).toBe(0x41);
    expect(a.macKeyCode).toBe(0x00);
    expect(a.code).toBe("KeyA");
    expect(a.character).toBe("a");

    const Z = resolveKey("Z");
    expect(Z.windowsVkCode).toBe(0x5a);
    expect(Z.macKeyCode).toBe(0x06);
    expect(Z.code).toBe("KeyZ");
    expect(Z.character).toBe("Z");
  });

  test("digits — VK = ASCII, code = DigitN", () => {
    const five = resolveKey("5");
    expect(five.windowsVkCode).toBe(0x35);
    expect(five.macKeyCode).toBe(0x17);
    expect(five.code).toBe("Digit5");
    expect(five.character).toBe("5");
  });

  test("F-keys", () => {
    expect(resolveKey("F1").windowsVkCode).toBe(0x70);
    expect(resolveKey("F12").windowsVkCode).toBe(0x7b);
  });

  test("non-ASCII single codepoint → character-only, VK = 0", () => {
    const han = resolveKey("한");
    expect(han.windowsVkCode).toBe(0);
    expect(han.macKeyCode).toBe(0);
    expect(han.character).toBe("한");
  });
});
