import { describe, it, expect } from "vitest";
import { findChrome } from "./utils.js";

describe("findChrome on native Windows", () => {
  const env = {
    PROGRAMFILES: String.raw`C:\Program Files`,
    "PROGRAMFILES(X86)": String.raw`C:\Program Files (x86)`,
    LOCALAPPDATA: String.raw`C:\Users\me\AppData\Local`,
  };

  it.each([
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Users\me\AppData\Local\Google\Chrome\Application\chrome.exe`,
  ])("finds %s", (installed) => {
    expect(findChrome(undefined, { platform: "win32", env, exists: (p) => p === installed })).toBe(installed);
  });

  it("returns null when Chrome is not installed", () => {
    expect(findChrome(undefined, { platform: "win32", env, exists: () => false })).toBeNull();
  });

  it("does not probe Windows paths on other platforms", () => {
    const probed: string[] = [];
    findChrome(undefined, { platform: "linux", env, exists: (p) => { probed.push(p); return false; } });
    expect(probed.some((p) => p.includes("AppData"))).toBe(false);
  });

  it("prefers an explicit chromePath that exists", () => {
    expect(findChrome("/opt/chrome", { platform: "win32", env, exists: (p) => p === "/opt/chrome" })).toBe("/opt/chrome");
  });
});
