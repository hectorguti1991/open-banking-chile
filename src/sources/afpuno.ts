import type { ElementHandle, Page } from "puppeteer-core";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── AFP UNO ─────────────────────────────────────────────────────
// Solo lee el "Total ahorrado" del portal UNOnline. La portada tiene un reCAPTCHA invisible: si
// muestra un desafío, lo resuelve el usuario en la ventana visible (opción headful).

const HOME_URL = "https://www.uno.cl/";
const PORTAL_HOST = "portal.uno.cl";
const LOGIN_TIMEOUT = 60_000;
const BALANCE_TIMEOUT = 30_000;

/** `"$56.702.988"` → `56702988`; un monto oculto (`"$ ••••"`) o vacío → `null`. */
export function parseTotalAhorrado(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");
  if (!/\d/.test(text) || !/^\s*\$?\s*[\d.]+\s*$/.test(text)) return null;
  return Number(digits);
}

/** RUN como lo pide UNOnline: sin puntos ni guion, con la K en mayúscula. */
export function cleanRut(rut: string): string {
  return rut.replace(/[.\-\s]/g, "").toUpperCase();
}

async function clickByText(page: Page, selector: string, text: string): Promise<boolean> {
  return page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === t);
      el?.click();
      return Boolean(el);
    },
    selector,
    text,
  );
}

async function findSubmit(page: Page): Promise<ElementHandle<HTMLButtonElement> | null> {
  for (const b of await page.$$("#form-login button")) {
    const text = await b.evaluate((el) => el.textContent?.trim() ?? "");
    if (text === "Iniciar sesión") return b as ElementHandle<HTMLButtonElement>;
  }
  return null;
}

/** Texto del monto que sigue al título "Total ahorrado", o `null` si todavía no aparece. */
async function readTotalText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const title = [...document.querySelectorAll("p")].find((p) => p.textContent?.trim() === "Total ahorrado");
    return title?.nextElementSibling?.textContent?.trim() ?? null;
  });
}

/**
 * Lee el monto hasta que tenga un saldo. Mientras carga, la página muestra `$0`: eso no es un saldo y se
 * sigue esperando. Con el monto oculto (sin cifras) no tiene sentido esperar.
 */
export async function waitForTotal(
  read: () => Promise<string | null>,
  opts: { attempts: number; sleep: () => Promise<void> },
): Promise<{ text: string | null; amount: number | null }> {
  let text: string | null = null;
  for (let i = 0; i < opts.attempts; i++) {
    text = await read().catch(() => null);
    const amount = text ? parseTotalAhorrado(text) : null;
    if (amount !== null && amount > 0) return { text, amount };
    if (text && !/\d/.test(text)) return { text, amount: null };
    await opts.sleep();
  }
  return { text, amount: null };
}

async function loginError(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const nodes = document.querySelectorAll<HTMLElement>('#form-login [role="alert"], #form-login [class*="error"]');
      const text = [...nodes].map((n) => n.innerText.trim()).filter(Boolean).join(" ");
      return text || null;
    })
    .catch(() => null);
}

async function scrapeAfpUno(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "afpuno", accounts: [], error, debug: debugLog.join("\n") });

  progress("Entrando a AFP UNO…");
  debugLog.push("1. Abriendo la portada...");
  await page.goto(HOME_URL, { waitUntil: "networkidle2", timeout: 45_000 });
  await screenshot(page, "01-portada");

  debugLog.push("2. Abriendo UNOnline...");
  if (!(await clickByText(page, "button", "UNOnline"))) return fail("No encontré el botón UNOnline en uno.cl.");
  try {
    await page.waitForSelector("#form-login #username", { visible: true, timeout: 15_000 });
  } catch {
    await screenshot(page, "02-sin-formulario");
    return fail("No se abrió el formulario de ingreso de AFP UNO.");
  }

  debugLog.push("3. Escribiendo RUN y clave...");
  await page.type("#form-login #username", cleanRut(options.rut), { delay: 50 });
  await page.type("#form-login #password", options.password, { delay: 50 });
  await delay(500);
  await screenshot(page, "03-formulario");
  // El botón se habilita cuando la página valida el formulario. Un clic por DOM (`el.click()`) no
  // alcanza: hace falta un clic de mouse real sobre el botón habilitado.
  const submit = await findSubmit(page);
  if (!submit) return fail("No encontré el botón Iniciar sesión.");
  await page
    .waitForFunction((b) => !(b as HTMLButtonElement).disabled, { timeout: 10_000 }, submit)
    .catch(() => debugLog.push("   El botón siguió deshabilitado; pruebo igual"));
  await submit.click().catch(() => debugLog.push("   No se pudo hacer clic en el botón"));

  debugLog.push("4. Esperando el portal...");
  const until = Date.now() + LOGIN_TIMEOUT;
  const retryAt = Date.now() + 10_000;
  let retried = false;
  while (!page.url().includes(PORTAL_HOST) && Date.now() < until) {
    if (!retried && Date.now() > retryAt) {
      // Si el clic no avanzó, Enter en la clave envía el formulario.
      retried = true;
      debugLog.push("   Sigue en el formulario: presiono Enter");
      await page.focus("#form-login #password").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }
    await delay(1000);
  }
  if (!page.url().includes(PORTAL_HOST)) {
    await screenshot(page, "04-sin-ingreso");
    const message = await loginError(page);
    return fail(message ? `AFP UNO: ${message}` : "No pude entrar a AFP UNO. Revisa el RUT y la clave.");
  }

  progress("Leyendo saldo…");
  debugLog.push("5. Leyendo Total ahorrado...");
  const waitOnPage = (ms: number) => waitForTotal(() => readTotalText(page), { attempts: Math.ceil(ms / 1000), sleep: () => delay(1000) });
  let total = await waitOnPage(BALANCE_TIMEOUT);
  if (total.amount === null && (await clickByText(page, "p, span, button", "Mostrar monto"))) {
    debugLog.push("   Monto oculto: pinché Mostrar monto");
    await delay(1000);
    total = await waitOnPage(10_000);
  }
  await screenshot(page, "05-portal");
  if (total.amount === null) {
    return fail(total.text && /\d/.test(total.text) ? "AFP UNO mostró el saldo en $0. Intenta de nuevo en un rato." : "No encontré el saldo de AFP UNO.");
  }

  debugLog.push("   Total ahorrado leído");
  progress("Listo");
  return {
    success: true,
    bank: "afpuno",
    accounts: [{ label: "AFP UNO", balance: total.amount, movements: [] }],
    debug: debugLog.join("\n"),
  };
}

const afpuno: BankScraper = {
  id: "afpuno",
  name: "AFP UNO",
  url: HOME_URL,
  scrape: (options) => runScraper("afpuno", options, {}, scrapeAfpUno),
};

export default afpuno;
