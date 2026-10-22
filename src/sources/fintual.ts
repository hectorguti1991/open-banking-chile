import type { Page } from "puppeteer-core";
import type { AccountBalance, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── Fintual ─────────────────────────────────────────────────────
// Lee el saldo de cada objetivo con la sesión web. El token de la API que se pide solo con correo y clave
// ya no deja leer datos (Fintual pide verificación en dos pasos), pero /api/goals responde con la sesión
// del sitio. Con un perfil de Chrome persistente la sesión se recuerda; cuando expira, Fintual manda un
// código por correo y el usuario lo escribe en la ventana, que por eso siempre es visible.

const GOALS_URL = "https://fintual.cl/app/goals";
const CODE_TIMEOUT = 5 * 60_000;

/** Un saldo por objetivo con plata, desde la respuesta de `/api/goals`. */
export function goalsFromApi(body: unknown): AccountBalance[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((g) => {
    const a = (g as { attributes?: { name?: unknown; nav?: unknown } })?.attributes;
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    const nav = a?.nav;
    return name && typeof nav === "number" && Number.isFinite(nav) && nav > 0
      ? [{ label: name, balance: Math.round(nav), movements: [] }]
      : [];
  });
}

/** Pide los objetivos con la sesión de la página: `null` si no hay sesión. */
async function fetchGoals(page: Page): Promise<unknown | null> {
  return page
    .evaluate(async () => {
      const r = await fetch("/api/goals", { credentials: "include", headers: { Accept: "application/json" } });
      return r.ok ? r.json() : null;
    })
    .catch(() => null);
}

const EMAIL_INPUT = 'input[type="email"], input[name*="email" i], input[autocomplete="username"]';

/**
 * Escribe el correo y la clave si la página muestra el formulario de ingreso, en un paso o en dos (primero el
 * correo y después la clave). Devuelve `false` si no reconoce el formulario: el usuario puede entrar a mano.
 */
async function fillLogin(page: Page, email: string, password: string, debugLog: string[]): Promise<boolean> {
  const emailInput = await page.$(EMAIL_INPUT);
  if (!emailInput) return false;
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 40 });
  let passwordInput = await page.$('input[type="password"]');
  if (!passwordInput) {
    debugLog.push("   Ingreso en dos pasos: envío el correo primero");
    await emailInput.press("Enter");
    passwordInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15_000 }).catch(() => null);
    if (!passwordInput) return false;
  }
  await passwordInput.type(password, { delay: 40 });
  await passwordInput.press("Enter");
  return true;
}

async function scrapeFintual(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "fintual", accounts: [], error, debug: debugLog.join("\n") });

  progress("Abriendo Fintual…");
  debugLog.push("1. Abriendo tus objetivos...");
  await page.goto(GOALS_URL, { waitUntil: "networkidle2", timeout: 45_000 }).catch(() => {});
  await delay(1500);
  await screenshot(page, "01-inicio");

  let body = await fetchGoals(page);
  if (!body) {
    debugLog.push("2. Sin sesión: escribo correo y clave...");
    progress("Entrando a Fintual…");
    if (await fillLogin(page, options.rut.trim(), options.password, debugLog)) {
      await delay(3000);
      await screenshot(page, "02-despues-de-ingresar");
    } else {
      debugLog.push("   No reconocí el formulario de ingreso: espero que entres en la ventana");
    }
    progress("Si Fintual te mandó un código por correo, escríbelo en la ventana de Chrome (o entra tú ahí).");
    debugLog.push("3. Esperando la sesión (código por correo, si lo pide)...");
    const until = Date.now() + CODE_TIMEOUT;
    while (!body && Date.now() < until) {
      await delay(3000);
      body = await fetchGoals(page);
    }
  }
  if (!body) {
    await screenshot(page, "03-sin-sesion");
    return fail("No pude entrar a Fintual. Si pidió un código, escríbelo en la ventana antes de 5 minutos.");
  }

  const accounts = goalsFromApi(body);
  debugLog.push(`4. Objetivos con saldo: ${accounts.length}`);
  // Sin "Cerrar sesión" al terminar: la sesión guardada en el perfil evita pedir el código cada vez.
  await page.goto("about:blank").catch(() => {});
  if (accounts.length === 0) return fail("Fintual no mostró objetivos con saldo.");
  progress("Listo");
  return { success: true, bank: "fintual", accounts, debug: debugLog.join("\n") };
}

const fintual: BankScraper = {
  id: "fintual",
  name: "Fintual",
  url: "https://fintual.cl/",
  // Siempre visible: cuando la sesión expira, el usuario escribe el código que Fintual manda por correo.
  scrape: (options) => runScraper("fintual", options, { forceHeadful: true }, scrapeFintual),
};

export default fintual;
