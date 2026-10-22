import type { Page } from "puppeteer-core";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { delay, formatRut } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── AFC (seguro de cesantía) ────────────────────────────────────
// Sucursal virtual de afiliados: RUT y contraseña AFC (no ClaveÚnica). Tiene reCAPTCHA invisible: si muestra
// un desafío, lo resuelve el usuario en la ventana visible (opción headful). En el inicio, "Saldo Total" viene
// oculto ("$ ****") hasta pinchar el ojo.

const LOGIN_URL = "https://personas.afc.cl/auth/login";
const LOGIN_TIMEOUT = 60_000;

/** `"12.345.678"` → `12345678`; oculto (`"****"`) o vacío → `null`. */
export function parseAfcAmount(text: string): number | null {
  const t = text.trim();
  return /^[\d.]+$/.test(t) ? Number(t.replace(/\./g, "")) : null;
}

/** Lo que quedó escrito en el campo RUT. */
async function rutValue(page: Page): Promise<string> {
  return page.$eval("#rut", (el) => (el as HTMLInputElement).value).catch(() => "");
}

/**
 * Escribe el RUT y revisa que quedó: primero solo números y dígito verificador (la página pone los puntos),
 * y en el último intento con puntos y guion.
 */
async function typeRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const clean = rut.replace(/[^0-9kK]/g, "").toUpperCase();
  const attempts = [clean, clean, formatRut(clean)];
  for (const [i, text] of attempts.entries()) {
    const input = await page.$("#rut");
    if (!input) return false;
    await input.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await input.type(text, { delay: 60 });
    await delay(700);
    const value = await rutValue(page);
    if (value.replace(/[^0-9kK]/g, "").length >= clean.length - 1) return true;
    debugLog.push(`   El RUT no quedó escrito (intento ${i + 1}, largo ${value.length})`);
    await delay(1500);
  }
  return false;
}

/** Texto del monto de "Saldo Total" (`null` si todavía no aparece). */
async function readSaldo(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const label = Array.from(document.querySelectorAll("span, p, div")).find((e) => e.childElementCount === 0 && e.textContent?.trim() === "Saldo Total");
      let box: Element | null = label ?? null;
      for (let i = 0; box && i < 3; i++) {
        box = box.parentElement;
        const amount = box?.querySelector(".headlineL");
        if (amount) return amount.textContent?.trim() ?? null;
      }
      return null;
    })
    .catch(() => null);
}

async function showSaldo(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const eye = document.querySelector(".eye-button") as HTMLElement | null;
      if (eye && eye.textContent?.trim() === "visibility") eye.click();
    })
    .catch(() => {});
}

async function scrapeAfc(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "afc", accounts: [], error, debug: debugLog.join("\n") });

  progress("Entrando a AFC…");
  debugLog.push("1. Abriendo el ingreso...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 45_000 }).catch(() => {});
  await delay(2000);
  await screenshot(page, "01-ingreso");

  if (!page.url().includes("/home")) {
    if (!(await page.waitForSelector("#rut", { visible: true, timeout: 15_000 }).catch(() => null))) {
      return fail("No encontré el formulario de ingreso de AFC.");
    }
    // La página se vuelve a dibujar al abrir y borra lo que se escribió antes: se espera y se revisa.
    await delay(3000);
    debugLog.push("2. Escribiendo RUT y contraseña...");
    if (!(await typeRut(page, options.rut, debugLog))) return fail("No pude escribir el RUT en el formulario de AFC.");
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) return fail("No encontré el campo de contraseña de AFC.");
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(options.password, { delay: 50 });
    await delay(500);
    // Si al escribir la contraseña la página borró el RUT, se escribe otra vez.
    if (!(await rutValue(page))) await typeRut(page, options.rut, debugLog);
    let clicked = false;
    for (const b of await page.$$("button")) {
      if ((await b.evaluate((el) => el.textContent?.trim())) === "Ingresar con contraseña AFC") {
        await b.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) await passwordInput.press("Enter");

    debugLog.push("3. Esperando el inicio...");
    const until = Date.now() + LOGIN_TIMEOUT;
    while (!page.url().includes("/home") && Date.now() < until) await delay(1000);
    if (!page.url().includes("/home")) {
      await screenshot(page, "02-sin-ingreso");
      const message = await page
        .evaluate(() => Array.from(document.querySelectorAll('[role="alert"], .error, .mat-error, .alert')).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(" "))
        .catch(() => "");
      return fail(message ? `AFC: ${message.slice(0, 160)}` : "No pude entrar a AFC. Revisa el RUT y la contraseña AFC.");
    }
  }

  progress("Leyendo saldo…");
  debugLog.push("4. Leyendo Saldo Total...");
  const until = Date.now() + 30_000;
  let last: number | null = null;
  let saldo: number | null = null;
  while (saldo === null && Date.now() < until) {
    await showSaldo(page);
    await delay(1000);
    const text = await readSaldo(page);
    const value = text ? parseAfcAmount(text) : null;
    // Dos lecturas iguales seguidas: el monto ya cargó.
    if (value !== null && value === last) saldo = value;
    last = value;
  }
  await screenshot(page, "03-inicio");
  if (saldo === null) return fail("No encontré el saldo de AFC.");

  debugLog.push("   Saldo Total leído");
  progress("Listo");
  return { success: true, bank: "afc", accounts: [{ label: "AFC", balance: saldo, movements: [] }], debug: debugLog.join("\n") };
}

const afc: BankScraper = {
  id: "afc",
  name: "AFC (seguro de cesantía)",
  url: "https://personas.afc.cl/",
  scrape: (options) => runScraper("afc", options, {}, scrapeAfc),
};

export default afc;
