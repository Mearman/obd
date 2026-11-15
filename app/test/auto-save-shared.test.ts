import { afterEach, describe, expect, it, vi } from "vitest";
import { readAutoSaveShared, storeAutoSaveShared } from "../src/settings/auto-save-shared";
import {
  AUTO_SAVED_LIMIT,
  fragmentDigest,
  recordAutoSaved,
  wasAutoSaved,
} from "../src/share/auto-saved";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the automatic saving setting", () => {
  it("is on until it is stored as off, and comes back on when stored as on", () => {
    expect(readAutoSaveShared()).toBe(true);
    storeAutoSaveShared(false);
    expect(readAutoSaveShared()).toBe(false);
    storeAutoSaveShared(true);
    expect(readAutoSaveShared()).toBe(true);
  });

  it("reads as on and does not throw when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAutoSaveShared()).toBe(true);
    expect(() => {
      storeAutoSaveShared(false);
    }).not.toThrow();
  });
});

describe("the record of automatically saved links", () => {
  it("digests a fragment as 64 hex characters, the same each time", async () => {
    const digest = await fragmentDigest("share=1.abc");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await fragmentDigest("share=1.abc")).toBe(digest);
    expect(await fragmentDigest("share=1.abd")).not.toBe(digest);
  });

  it("remembers a digest and forgets the oldest past the limit", () => {
    for (let index = 0; index <= AUTO_SAVED_LIMIT; index += 1) recordAutoSaved(`d${String(index)}`);
    expect(wasAutoSaved("d0")).toBe(false);
    expect(wasAutoSaved("d1")).toBe(true);
    expect(wasAutoSaved(`d${String(AUTO_SAVED_LIMIT)}`)).toBe(true);
  });

  it("reads corrupt storage as empty", () => {
    localStorage.setItem("obd-read.auto-saved-links", "{not json");
    expect(wasAutoSaved("x")).toBe(false);
    recordAutoSaved("x");
    expect(wasAutoSaved("x")).toBe(true);
  });
});
