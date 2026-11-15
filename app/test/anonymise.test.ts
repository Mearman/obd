import { describe, expect, it } from "vitest";
import {
  MAX_FRAMES,
  MAX_MESSAGE_LENGTH,
  scrubIdentifiers,
  scrubMessage,
  scrubName,
  scrubStack,
  scrubText,
  summariseBrowser,
  type ScrubContext,
} from "../src/report/anonymise";

const CONTEXT: ScrubContext = {
  appOrigin: "https://example.test",
  basePath: "/obd/",
  known: [],
};

/** A deterministic generator, so a failing case can be reproduced from its index. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = 300;
const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const WORDS = ["failed", "while", "reading", "the", "frame", "from", "unit", "at", "retry", "ok"];

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
}

function chars(random: () => number, alphabet: string, length: number): string {
  return Array.from({ length }, () => pick(random, [...alphabet])).join("");
}

function vin(random: () => number): string {
  const body = chars(random, VIN_ALPHABET, 15);
  const text = `${pick(random, [..."ABCDEFGHJKLMNPRSTUVWXYZ"])}${pick(random, [..."0123456789"])}${body}`;
  return text;
}

function hexRun(random: () => number): string {
  return chars(random, HEX, 8 + Math.floor(random() * 33));
}

function byteGroup(random: () => number): string {
  return chars(random, HEX, 2);
}

function mac(random: () => number): string {
  const separator = pick(random, [":", "-"]);
  return Array.from({ length: 6 }, () => byteGroup(random)).join(separator);
}

function ipv4(random: () => number): string {
  return Array.from({ length: 4 }, () => String(Math.floor(random() * 256))).join(".");
}

function ipv6(random: () => number): string {
  const group = () => chars(random, HEX, 1 + Math.floor(random() * 4));
  return pick(random, [
    `${group()}::${group()}`,
    `fe80::${group()}:${group()}:${group()}:${group()}`,
    Array.from({ length: 8 }, group).join(":"),
  ]);
}

function email(random: () => number): string {
  return `${chars(random, "abcdefghij.", 6)}@${chars(random, "klmnopq", 5)}.${pick(random, ["com", "co.uk", "org"])}`;
}

function url(random: () => number): { readonly text: string; readonly secrets: string[] } {
  const token = chars(random, "abcdefghij0123456789", 12);
  const query = `token=${token}`;
  const fragment = `share=1.${token}`;
  const host = pick(random, ["example.test", "elsewhere.example", "evil.example:8080"]);
  return {
    text: `https://${host}/obd/app?${query}#${fragment}`,
    secrets: [query, fragment],
  };
}

function unixPath(random: () => number): string {
  const segments = Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
    chars(random, "abcdefghijklmnop", 3 + Math.floor(random() * 6)),
  );
  return `${pick(random, ["/Users/", "/home/", "/var/", "/"])}${segments.join("/")}`;
}

function windowsPath(random: () => number): string {
  const segments = Array.from({ length: 2 + Math.floor(random() * 2) }, () =>
    chars(random, "abcdefghijklmnop", 3 + Math.floor(random() * 6)),
  );
  return `${pick(random, ["C", "D"])}:\\${segments.join("\\")}`;
}

function fileName(random: () => number): string {
  return `${chars(random, "abcdefghijklmnop", 4 + Math.floor(random() * 6))}.${pick(random, ["json", "csv", "txt", "log", "sqlite3", "zip"])}`;
}

/** `value` among harmless words, so it is found by its shape and not by its position. */
function embedded(random: () => number, value: string): string {
  const before = Array.from({ length: Math.floor(random() * 4) }, () => pick(random, WORDS));
  const after = Array.from({ length: Math.floor(random() * 4) }, () => pick(random, WORDS));
  return [...before, value, ...after].join(" ");
}

/** Checks `make` over many random cases: no case may keep what it embedded. */
function neverSurvives(make: (random: () => number) => string, seed: number): void {
  const random = generator(seed);
  for (let index = 0; index < CASES; index += 1) {
    const secret = make(random);
    const input = embedded(random, secret);
    const output = scrubText(input, CONTEXT);
    expect(output, `case ${String(index)}: ${input}`).not.toContain(secret);
  }
}

describe("scrubText: random strings never keep what identifies", () => {
  it("VIN-shaped words, in either case", () => {
    neverSurvives(vin, 1);
    neverSurvives((random) => vin(random).toLowerCase(), 2);
  });

  it("long hexadecimal runs, with or without 0x, and inside longer words", () => {
    neverSurvives(hexRun, 3);
    neverSurvives((random) => `0x${hexRun(random)}`, 4);
    neverSurvives((random) => hexRun(random).toUpperCase(), 5);
  });

  it("spaced hexadecimal bytes as an adapter prints them", () => {
    neverSurvives(
      (random) =>
        Array.from({ length: 4 + Math.floor(random() * 8) }, () => byteGroup(random))
          .join(" ")
          .toUpperCase(),
      6,
    );
  });

  it("MAC addresses, IPv4 and IPv6 addresses", () => {
    neverSurvives(mac, 7);
    neverSurvives(ipv4, 8);
    neverSurvives(ipv6, 9);
  });

  it("email addresses", () => {
    neverSurvives(email, 10);
  });

  it("file paths and file names", () => {
    neverSurvives(unixPath, 11);
    neverSurvives(windowsPath, 12);
    neverSurvives(fileName, 13);
  });

  it("the query and fragment of any URL, and the whole of an outside URL", () => {
    const random = generator(14);
    for (let index = 0; index < CASES; index += 1) {
      const { text, secrets } = url(random);
      const output = scrubText(embedded(random, text), CONTEXT);
      for (const secret of secrets)
        expect(output, `case ${String(index)}: ${text}`).not.toContain(secret);
      if (!text.startsWith("https://example.test")) expect(output).not.toContain("https://");
    }
  });

  it("fault codes and identifiers a browser gives a device", () => {
    neverSurvives(
      (random) =>
        `${pick(random, ["P", "C", "B", "U"])}${pick(random, ["0", "1", "2", "3"])}${chars(random, "0123456789ABCDEF", 3)}`,
      15,
    );
    neverSurvives(
      (random) =>
        `${chars(random, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 22)}A1==`,
      16,
    );
  });

  it("anything quoted, and registered values in any case", () => {
    const random = generator(17);
    for (let index = 0; index < CASES; index += 1) {
      const name =
        chars(random, "abcdefghijklmnopqrstuvwxyz ", 5 + Math.floor(random() * 10)).trim() ||
        "adapter";
      const quoted = scrubText(embedded(random, `device "${name}" lost`), CONTEXT);
      expect(quoted).not.toContain(name);
      const known = scrubText(embedded(random, name.toUpperCase()), { ...CONTEXT, known: [name] });
      expect(known).not.toContain(name.toUpperCase());
    }
  });
});

describe("scrubText: what is kept", () => {
  it("keeps the app's origin and path and drops its query and fragment", () => {
    expect(
      scrubText("loaded https://example.test/obd/assets/app.js?v=1#share=1.abc", CONTEXT),
    ).toBe("loaded https://example.test/obd/assets/app.js");
  });

  it("replaces a URL of any other origin, including extension and blob URLs", () => {
    expect(scrubText("see https://other.example/path?x=1", CONTEXT)).toBe("see [url]");
    expect(scrubText("from chrome-extension://abcdefghijklmnop/page.js", CONTEXT)).toBe(
      "from [url]",
    );
    expect(scrubText("blob:https://example.test/1234", CONTEXT)).toBe("[url]");
  });

  it("keeps the property name of the common TypeError and ordinary words", () => {
    expect(scrubText("Cannot read properties of undefined (reading 'map')", CONTEXT)).toBe(
      "Cannot read properties of undefined (reading 'map')",
    );
    expect(scrubText("the scan failed on and/or retry", CONTEXT)).toBe(
      "the scan failed on and/or retry",
    );
    expect(scrubText("at 12:30:45 on 3/4/2026", CONTEXT)).toBe("at 12:30:45 on 3/4/2026");
  });

  it("never leaves a backtick that could end a code fence", () => {
    expect(scrubText("a ``` b `", CONTEXT)).not.toContain("`");
  });

  it("scrubs identifiers in a name that is code", () => {
    expect(scrubIdentifiers("decodeWDB2110202B121724")).toContain("decode");
    expect(scrubIdentifiers("decodeWDB2110202B121724")).not.toContain("WDB2110202B121724");
    expect(scrubName("TypeError")).toBe("TypeError");
    expect(scrubName("my error with spaces")).toBe("Error");
  });

  it("puts a message on one line and cuts it", () => {
    expect(scrubMessage("one\n two\t three", CONTEXT)).toBe("one two three");
    expect(scrubMessage("x".repeat(MAX_MESSAGE_LENGTH + 50), CONTEXT)).toHaveLength(
      MAX_MESSAGE_LENGTH + 3,
    );
  });
});

describe("scrubStack", () => {
  const V8 = [
    "TypeError: nope",
    "    at decode (https://example.test/obd/assets/index-AbC123.js:10:20)",
    "    at async Object.run (https://example.test/obd/assets/index-AbC123.js:30:5)",
    "    at https://example.test/obd/assets/chunk.js:7:1",
    "    at fromExtension (chrome-extension://abcdef/content.js:1:1)",
    "    at lib (https://cdn.example/lib.js:5:5)",
    "    at Array.map (<anonymous>)",
  ].join("\n");

  it("keeps function name, app-relative file and line of app frames, and counts the rest", () => {
    expect(scrubStack(V8, CONTEXT)).toEqual({
      frames: [
        { name: "decode", file: "assets/index-AbC123.js", line: 10 },
        { name: "async Object.run", file: "assets/index-AbC123.js", line: 30 },
        { name: "<anonymous>", file: "assets/chunk.js", line: 7 },
      ],
      omitted: 3,
    });
  });

  it("reads the Firefox and Safari format", () => {
    const stack = [
      "decode@https://example.test/obd/assets/a.js:3:9",
      "@https://example.test/obd/assets/a.js:4:1",
      "x@moz-extension://id/y.js:1:1",
    ].join("\n");
    expect(scrubStack(stack, CONTEXT)).toEqual({
      frames: [
        { name: "decode", file: "assets/a.js", line: 3 },
        { name: "<anonymous>", file: "assets/a.js", line: 4 },
      ],
      omitted: 1,
    });
  });

  it("drops a frame whose file is not a plain path, and keeps at most MAX_FRAMES", () => {
    const odd = "    at f (https://example.test/obd/a b/c.js?x=1:3:4)";
    expect(scrubStack(odd, CONTEXT).frames).toEqual([]);
    const many = Array.from(
      { length: MAX_FRAMES + 5 },
      () => "    at f (https://example.test/obd/a.js:1:1)",
    ).join("\n");
    const result = scrubStack(many, CONTEXT);
    expect(result.frames).toHaveLength(MAX_FRAMES);
    expect(result.omitted).toBe(5);
  });

  it("handles no stack", () => {
    expect(scrubStack(undefined, CONTEXT)).toEqual({ frames: [], omitted: 0 });
  });

  it("scrubs a function name that carries a VIN", () => {
    const stack = "    at read_WDB2110202B121724 (https://example.test/obd/a.js:1:1)";
    expect(scrubStack(stack, CONTEXT).frames[0]?.name).not.toContain("WDB2110202B121724");
  });
});

describe("summariseBrowser", () => {
  const CASES_UA: readonly (readonly [string, number, string, string])[] = [
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      0,
      "Chrome 142",
      "macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.2535.51",
      0,
      "Edge 141",
      "Windows",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      0,
      "Firefox 130",
      "Linux",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      0,
      "Safari 18",
      "macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      5,
      "Safari 18",
      "iOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
      5,
      "Chrome 142",
      "Android",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      5,
      "Safari 18",
      "iOS",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      0,
      "Chrome 142",
      "ChromeOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36",
      0,
      "Chrome 145",
      "macOS",
    ],
    ["curl/8.0", 0, "Unknown browser", "Unknown OS"],
  ];

  it.each(CASES_UA)("%s", (userAgent, touch, browser, os) => {
    const summary = summariseBrowser(userAgent, touch);
    expect(summary).toEqual({ browser, os });
    // Nothing of the original beyond the family and major version survives.
    expect(`${summary.browser} ${summary.os}`).not.toMatch(/\d+\.\d+|Pixel|Build|Intel/);
  });
});
