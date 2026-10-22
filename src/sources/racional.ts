import type { Page } from "puppeteer-core";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── Racional ────────────────────────────────────────────────────
// Lee "Total Inversiones" más la "Billetera" (efectivo sin invertir), en dólares, del inicio de la app web.
// Con un perfil de Chrome persistente y "Mantener sesión" marcado, la sesión se recuerda; si Racional pide un
// código, el usuario lo escribe en la ventana, que por eso siempre es visible.

const HOME_URL = "https://app.racional.cl/tabs/home";
const LOGIN_URL = "https://app.racional.cl/login";
const LOGIN_TIMEOUT = 5 * 60_000;

/** `"US$277,59"` → `277.59`; lo que no es un monto en dólares → `null`. */
export function parseUsd(text: string): number | null {
  const m = /^US\$\s*([\d.]+(?:,\d+)?)$/.exec(text.trim());
  return m ? Number(m[1].replace(/\./g, "").replace(",", ".")) : null;
}

/** Lo invertido más la billetera, con 2 decimales. Sin lo invertido no hay total. */
export function racionalTotal(texts: { invested: string | null; wallet: string | null }): number | null {
  const invested = texts.invested ? parseUsd(texts.invested) : null;
  if (invested === null) return null;
  const wallet = texts.wallet ? parseUsd(texts.wallet) ?? 0 : 0;
  return Math.round((invested + wallet) * 100) / 100;
}

/** El monto que acompaña a una etiqueta del inicio ("Total Inversiones", "Billetera"). */
async function readAmounts(page: Page): Promise<{ invested: string | null; wallet: string | null }> {
  return page
    .evaluate(() => {
      const near = (label: RegExp): string | null => {
        const el = Array.from(document.querySelectorAll("p, span, div")).find((e) => e.childElementCount === 0 && label.test(e.textContent?.trim() ?? ""));
        let box: Element | null = el ?? null;
        for (let i = 0; box && i < 3; i++) {
          box = box.parentElement;
          const amount = Array.from(box?.querySelectorAll("*") ?? []).find((e) => /^US\$\s*[\d.,]+$/.test(e.textContent?.trim() ?? ""));
          if (amount) return amount.textContent!.trim();
        }
        return null;
      };
      return { invested: near(/^Total Inversiones$/i), wallet: near(/^Billetera$/i) };
    })
    .catch(() => ({ invested: null, wallet: null }));
}

/** Los montos se animan al cargar: se leen hasta que dos lecturas seguidas coinciden. */
async function readStableTotal(page: Page, timeout: number): Promise<number | null> {
  const until = Date.now() + timeout;
  let last: number | null = null;
  while (Date.now() < until) {
    const total = racionalTotal(await readAmounts(page));
    if (total !== null && total === last) return total;
    last = total;
    await delay(1500);
  }
  return null;
}

async function clickButton(page: Page, text: string): Promise<boolean> {
  for (const b of await page.$$("button, ion-button")) {
    if ((await b.evaluate((el) => el.textContent?.trim())) === text) {
      await b.click().catch(() => {});
      return true;
    }
  }
  return false;
}

/** Escribe lo que pide el formulario: correo y clave (/login) o solo la clave (usuario recordado). */
async function fillLogin(page: Page, email: string, password: string, debugLog: string[]): Promise<boolean> {
  if (page.url().includes("/start")) await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
  const passwordInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15_000 }).catch(() => null);
  if (!passwordInput) return false;
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 40 });
  } else {
    debugLog.push("   Usuario recordado: solo la clave");
  }
  await passwordInput.type(password, { delay: 40 });
  // "Mantener sesión", para que el perfil recuerde la sesión la próxima vez.
  await page
    .evaluate(() => {
      const cb = document.querySelector("ion-checkbox") as (HTMLElement & { checked?: boolean }) | null;
      if (cb && !cb.checked) cb.click();
    })
    .catch(() => {});
  if (!(await clickButton(page, "Iniciar sesión")) && !(await clickButton(page, "Ingresar"))) await passwordInput.press("Enter");
  return true;
}

async function scrapeRacional(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "racional", accounts: [], error, debug: debugLog.join("\n") });

  progress("Abriendo Racional…");
  debugLog.push("1. Abriendo el inicio...");
  await page.goto(HOME_URL, { waitUntil: "networkidle2", timeout: 45_000 }).catch(() => {});
  await delay(3000);
  await screenshot(page, "01-inicio");

  let total = page.url().includes("/tabs/") ? await readStableTotal(page, 15_000) : null;
  if (total === null) {
    debugLog.push("2. Sin sesión: escribo los datos de ingreso...");
    progress("Entrando a Racional…");
    if (!(await fillLogin(page, options.rut.trim(), options.password, debugLog))) {
      debugLog.push("   No reconocí el formulario de ingreso: espero que entres en la ventana");
    }
    await delay(3000);
    await screenshot(page, "02-despues-de-ingresar");
    progress("Si Racional te pidió un código, escríbelo en la ventana de Chrome (o entra tú ahí).");
    debugLog.push("3. Esperando el inicio...");
    const until = Date.now() + LOGIN_TIMEOUT;
    while (total === null && Date.now() < until) {
      await delay(3000);
      if (page.url().includes("/tabs/")) total = await readStableTotal(page, 10_000);
    }
  }
  await screenshot(page, "03-final");
  if (total === null) return fail("No pude leer tu saldo en Racional. Si pidió un código, escríbelo en la ventana antes de 5 minutos.");

  debugLog.push("4. Total leído");
  // Sin "Cerrar sesión" al terminar: la sesión guardada en el perfil evita pedir datos cada vez.
  await page.goto("about:blank").catch(() => {});
  progress("Listo");
  return { success: true, bank: "racional", accounts: [{ label: "Racional", balance: total, currency: "USD", movements: [] }], debug: debugLog.join("\n") };
}

const racional: BankScraper = {
  id: "racional",
  name: "Racional",
  url: "https://racional.cl/",
  scrape: (options) => runScraper("racional", options, { forceHeadful: true }, scrapeRacional),
};

export default racional;
