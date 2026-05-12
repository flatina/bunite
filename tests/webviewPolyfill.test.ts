import { describe, test, expect } from "bun:test";
import { isBlockedSrc } from "../package/src/shared/webviewPolyfill";

describe("isBlockedSrc — scheme guard", () => {
  test.each([
    ["javascript:alert(1)", true],
    ["JavaScript:alert(1)", true],
    ["  javascript:alert(1)", true], // leading whitespace
    ["\tjavascript:alert(1)", true],
    ["data:text/html,<script>", true],
    ["vbscript:msgbox", true],
    ["file:///etc/passwd", true],
    ["about:blank", true],
    ["about:srcdoc", true],
    // WHATWG URL normalization bypass attempts — embedded controls + leading C0
    ["java\nscript:alert(1)", true],
    ["java\tscript:alert(1)", true],
    ["java\rscript:alert(1)", true],
    ["da\tta:text/html,foo", true],
    ["\x00javascript:alert(1)", true],
    ["\x01\x02javascript:alert(1)", true],
    ["\x00\tjavascript:alert(1)", true],
    ["https://example.com", false],
    ["http://example.com", false],
    ["//example.com", false],
    ["/path/relative", false],
    ["./relative", false],
    ["", false],
    ["https://evil.com#javascript:alert(1)", false], // hash fragment, not scheme
    ["https://example.com?next=javascript:foo", false], // query param, not scheme
    ["mailto:user@example.com", false],
    ["tel:+1234567890", false],
    ["appres://app.internal/index.html", false],
  ])("classifies %j as blocked=%s", (input, expected) => {
    expect(isBlockedSrc(input)).toBe(expected);
  });

  test("null and undefined are not blocked", () => {
    expect(isBlockedSrc(null)).toBe(false);
    expect(isBlockedSrc(undefined)).toBe(false);
  });
});
