import type { Page } from "puppeteer-core";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── Racional ────────────────────────────────────────────────────
// Lee lo invertido más la "Billetera" (efectivo sin invertir) del inicio de la app web. Racional 2.0 lo muestra en el
// recuadro "Resumen" (una línea por producto); Racional 1.0, como "Total Inversiones".
// Con un perfil de Chrome persistente y "Mantener sesión" marcado, la sesión se recuerda; si Racional pide un
// código, el usuario lo escribe en la ventana, que por eso siempre es visible.

const HOME_URL = "https://app.racional.cl/home";
const LOGIN_URL = "https://app.racional.cl/login";
const LOGIN_TIMEOUT = 5 * 60_000;

export interface RacionalAmount {
  currency: "USD" | "CLP";
  value: number;
}

/** `"US$277,59"`, `"USD 276,17"`, `"CLP 250.000"`, `"$50.000"` → moneda y monto. Una ganancia (`"+USD 1,00"`) → `null`. */
export function parseAmount(text: string): RacionalAmount | null {
  const m = /^(US\$|USD|CLP|\$)\s*(\d[\d.]*(?:,\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return { currency: m[1] === "CLP" || m[1] === "$" ? "CLP" : "USD", value: Number(m[2].replace(/\./g, "").replace(",", ".")) };
}

/** Los textos del inicio: las líneas del "Resumen" (2.0), "Total Inversiones" (1.0) y la billetera. */
export interface RacionalHome {
  summary: Array<{ label: string; amount: string }>;
  invested: string | null;
  wallet: string | null;
}

/**
 * Lo invertido más la billetera, un total por moneda, con 2 decimales. Las monedas en cero no aparecen (salvo que
 * todo esté en cero). Sin lo invertido no hay total.
 */
export function racionalBalances(home: RacionalHome): Array<{ currency: "USD" | "CLP"; balance: number }> | null {
  const invested = (home.summary.length > 0
    ? home.summary.filter((r) => !/ganancia/i.test(r.label)).map((r) => parseAmount(r.amount))
    : [home.invested ? parseAmount(home.invested) : null]
  ).filter((a): a is RacionalAmount => a !== null);
  if (invested.length === 0) return null;
  const wallet = home.wallet ? parseAmount(home.wallet) : null;
  const totals = new Map<"USD" | "CLP", number>();
  for (const a of wallet ? [...invested, wallet] : invested) totals.set(a.currency, (totals.get(a.currency) ?? 0) + a.value);
  const all = [...totals].map(([currency, v]) => ({ currency, balance: Math.round(v * 100) / 100 }));
  const nonZero = all.filter((t) => t.balance !== 0);
  return nonZero.length > 0 ? nonZero : all.slice(0, 1);
}

/** El inicio con la sesión iniciada: `/tabs/…` en Racional 1.0, `/home` en 2.0. */
export function isHomeUrl(url: string): boolean {
  try {
    return /^\/(tabs\/|home\b)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function readHome(page: Page): Promise<RacionalHome> {
  return page
    .evaluate(() => {
      const leaves = (label: RegExp) =>
        Array.from(document.querySelectorAll("p, span, div, h1, h2, h3, h4")).filter((e) => e.childElementCount === 0 && label.test(e.textContent?.trim() ?? ""));
      // El monto más cercano a una etiqueta; la misma etiqueta puede estar también en el menú, sin monto.
      const near = (label: RegExp): string | null => {
        for (const el of leaves(label)) {
          let box: Element | null = el;
          for (let i = 0; box && i < 3; i++) {
            box = box.parentElement;
            const amount = Array.from(box?.querySelectorAll("*") ?? []).find((e) => /^(US\$|USD|CLP)\s*\d[\d.,]*$/.test(e.textContent?.trim() ?? ""));
            if (amount) return amount.textContent!.trim();
          }
        }
        return null;
      };
      // "Resumen": filas de dos textos, etiqueta y monto.
      const box = leaves(/^Resumen$/i)[0]?.parentElement;
      const summary = Array.from(box?.querySelectorAll("*") ?? [])
        .filter((e) => e.children.length === 2 && Array.from(e.children).every((c) => c.childElementCount === 0))
        .map((e) => ({ label: e.children[0].textContent?.trim() ?? "", amount: e.children[1].textContent?.trim() ?? "" }));
      return { summary, invested: near(/^Total Inversiones$/i), wallet: near(/^Billetera$/i) };
    })
    .catch(() => ({ summary: [], invested: null, wallet: null }));
}

type Balances = NonNullable<ReturnType<typeof racionalBalances>>;

/** Los montos se animan al cargar: se leen hasta que dos lecturas seguidas coinciden. */
async function readStableBalances(page: Page, timeout: number): Promise<Balances | null> {
  const until = Date.now() + timeout;
  let last: string | null = null;
  while (Date.now() < until) {
    const balances = racionalBalances(await readHome(page));
    const key = balances ? JSON.stringify(balances) : null;
    if (key !== null && key === last) return balances;
    last = key;
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
      const cb = document.querySelector('ion-checkbox, [role="checkbox"], input[type="checkbox"]') as (HTMLElement & { checked?: boolean }) | null;
      if (cb && !cb.checked && cb.getAttribute("aria-checked") !== "true") cb.click();
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

  let balances = isHomeUrl(page.url()) ? await readStableBalances(page, 15_000) : null;
  if (balances === null) {
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
    while (balances === null && Date.now() < until) {
      await delay(3000);
      if (isHomeUrl(page.url())) balances = await readStableBalances(page, 10_000);
    }
  }
  await screenshot(page, "03-final");
  if (balances === null) return fail("No pude leer tu saldo en Racional. Si pidió un código, escríbelo en la ventana antes de 5 minutos.");

  debugLog.push(`4. Total leído (${balances.map((b) => b.currency).join(", ")})`);
  // Sin "Cerrar sesión" al terminar: la sesión guardada en el perfil evita pedir datos cada vez.
  await page.goto("about:blank").catch(() => {});
  progress("Listo");
  return { success: true, bank: "racional", accounts: balances.map((b) => ({ label: b.currency === "USD" ? "Racional" : "Racional (pesos)", balance: b.balance, currency: b.currency, movements: [] })), debug: debugLog.join("\n") };
}

const racional: BankScraper = {
  id: "racional",
  name: "Racional",
  url: "https://racional.cl/",
  scrape: (options) => runScraper("racional", options, { forceHeadful: true }, scrapeRacional),
};

export default racional;
