import { describe, it, expect, vi, beforeEach } from "vitest";

const launch = vi.fn();
vi.mock("puppeteer-core", () => ({ default: { launch: (...args: unknown[]) => launch(...args) } }));

const { launchBrowser } = await import("./browser.js");

const fakePage = { setViewport: vi.fn(), setUserAgent: vi.fn(), evaluateOnNewDocument: vi.fn() };

describe("launchBrowser", () => {
  beforeEach(() => {
    launch.mockReset();
    fakePage.setUserAgent.mockReset();
    launch.mockResolvedValue({ newPage: async () => fakePage, userAgent: async () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.8059.85 Safari/537.36" });
  });

  it("uses a persistent profile when userDataDir is given, so banks remember the device", async () => {
    await launchBrowser({ chromePath: process.execPath, userDataDir: "/tmp/profile-bci" }, false);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ userDataDir: "/tmp/profile-bci" }));
  });

  it("keeps the throwaway profile by default", async () => {
    await launchBrowser({ chromePath: process.execPath }, false);
    expect(launch.mock.calls[0][0]).not.toHaveProperty("userDataDir");
  });

  it("se presenta con la versión real de Chrome, sin la marca de headless", async () => {
    await launchBrowser({ chromePath: process.execPath }, false);
    expect(fakePage.setUserAgent).toHaveBeenCalledWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.85 Safari/537.36");
  });
});
