import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { leftLoginForm } from "./login.js";

/** Fake page whose password field disappears after `pressesToLeave` Enter presses. */
function fakePage(pressesToLeave: number) {
  let presses = 0;
  const field = { focus: vi.fn(async () => {}), press: vi.fn(async () => { presses++; }) };
  const page = {
    $: vi.fn(async (sel: string) => (sel === "#inputPassword" && presses < pressesToLeave ? field : null)),
  };
  return { page: page as unknown as Page, field };
}

describe("leftLoginForm", () => {
  it("returns true right away when the password field is gone", async () => {
    const { page, field } = fakePage(0);
    expect(await leftLoginForm(page, ["#inputPassword"], [], 0)).toBe(true);
    expect(field.press).not.toHaveBeenCalled();
  });

  it("presses Enter on the password field when the click did not submit", async () => {
    const { page, field } = fakePage(1);
    const log: string[] = [];
    expect(await leftLoginForm(page, ["#inputPassword"], log, 0)).toBe(true);
    expect(field.press).toHaveBeenCalledWith("Enter");
    expect(log).toContain("  Login form still visible, pressing Enter");
  });

  it("returns false when the form is still there after Enter", async () => {
    const { page } = fakePage(99);
    expect(await leftLoginForm(page, ["#inputPassword"], [], 0)).toBe(false);
  });
});

describe("leftLoginForm with the generic password selector", () => {
  it("also looks for input[type=password], the selector fillPassword falls back to", async () => {
    let presses = 0;
    const field = { focus: vi.fn(async () => {}), press: vi.fn(async () => { presses++; }) };
    const page = { $: vi.fn(async (sel: string) => (sel === 'input[type="password"]' && presses < 1 ? field : null)) } as unknown as Page;
    expect(await leftLoginForm(page, ["#inputPassword"], [], 0)).toBe(true);
    expect(field.press).toHaveBeenCalledWith("Enter");
  });
});
