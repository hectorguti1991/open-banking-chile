import { describe, it, expect, vi, beforeEach } from "vitest";

const launch = vi.fn();
vi.mock("puppeteer-core", () => ({ default: { launch: (...args: unknown[]) => launch(...args) } }));

const { launchBrowser } = await import("./browser.js");

const fakePage = { setViewport: vi.fn(), setUserAgent: vi.fn(), evaluateOnNewDocument: vi.fn() };

describe("launchBrowser", () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockResolvedValue({ newPage: async () => fakePage });
  });

  it("uses a persistent profile when userDataDir is given, so banks remember the device", async () => {
    await launchBrowser({ chromePath: process.execPath, userDataDir: "/tmp/profile-bci" }, false);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ userDataDir: "/tmp/profile-bci" }));
  });

  it("keeps the throwaway profile by default", async () => {
    await launchBrowser({ chromePath: process.execPath }, false);
    expect(launch.mock.calls[0][0]).not.toHaveProperty("userDataDir");
  });
});
