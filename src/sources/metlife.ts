import type { ElementHandle, Frame, Page } from "puppeteer-core";
import type { BankScraper, LoanBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── MetLife (créditos hipotecarios) ─────────────────────────────
// Portal de Clientes: ingreso por el SSO de MetLife (RUT sin puntos ni guion y Clave de Acceso). El portal
// carga lento, puede abrir una ventana emergente que se cierra pinchando fuera, y muestra todo dentro de un
// marco (/csp_home). Cada "Mutuo Hipotecario Flexible" se abre con "Ver mi producto"; su "Deuda pendiente"
// en UF es el saldo que se debe.

const LOGIN_URL = "https://portaldeclientes.metlife.cl/PIP/login";
const PORTAL_HOST = "portaldeclientes.metlife.cl";
const LOGIN_TIMEOUT = 60_000;
const LOAD_TIMEOUT = 45_000;

/** `"UF 2.107,41"` → `2107.41`; lo que no es un monto en UF → `null`. */
export function parseUf(text: string): number | null {
  const m = /^UF\s*([\d.]+(?:,\d+)?)$/i.exec(text.trim());
  return m ? Number(m[1].replace(/\./g, "").replace(",", ".")) : null;
}

/** Un crédito con su deuda pendiente; `null` si la deuda todavía no se muestra. */
export function metlifeLoan(d: { credit: string | null; debt: string | null; installment: string | null }): LoanBalance | null {
  const balance = d.debt ? parseUf(d.debt) : null;
  if (balance === null) return null;
  const id = (d.credit ?? "").trim();
  const loan: LoanBalance = { label: `Mutuo Hipotecario${id ? ` ****${id.slice(-4)}` : ""}`, currency: "UF", balance };
  const n = d.installment ? /^(\d+)\s*\/\s*(\d+)$/.exec(d.installment.trim()) : null;
  if (n) loan.installments = `${n[1]}/${n[2]}`;
  return loan;
}

/** El marco donde el portal muestra los productos (o la página, si algún día deja de usarlo). */
function portalFrame(page: Page): Frame {
  return page.frames().find((f) => f.url().includes("/csp_home")) ?? page.mainFrame();
}

async function frameText(page: Page): Promise<string> {
  return portalFrame(page).evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

/** Espera a que el texto del marco cumpla la condición. */
async function waitForText(page: Page, test: (text: string) => boolean, timeout: number): Promise<string | null> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const text = await frameText(page);
    if (test(text)) return text;
    await delay(1500);
  }
  return null;
}

/** La ventana emergente se cierra pinchando fuera de ella (en el margen izquierdo, que está vacío). */
async function dismissPopup(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(15, 500).catch(() => {});
  await delay(800);
}

/**
 * Los "Ver mi producto" de cada crédito. No son enlaces ni botones, así que se busca el elemento más profundo
 * con ese texto y se pincha con el mouse.
 */
async function productLinks(page: Page) {
  const frame = portalFrame(page);
  const count = await frame
    .evaluate(() => {
      const starts = (e: Element) => (e.textContent ?? "").trim().startsWith("Ver mi producto");
      const deepest = Array.from(document.querySelectorAll("body *")).filter((e) => starts(e) && !Array.from(e.children).some(starts));
      deepest.forEach((e, i) => e.setAttribute("data-mf-producto", String(i)));
      return deepest.length;
    })
    .catch(() => 0);
  const links = [];
  for (let i = 0; i < count; i++) {
    const el = await frame.$(`[data-mf-producto="${i}"]`);
    if (el) links.push(el);
  }
  return links;
}

function readDetail(text: string): { credit: string | null; debt: string | null; installment: string | null } {
  const credit = /Cr[eé]dito:\s*([0-9A-Z]+)/i.exec(text)?.[1] ?? null;
  const debt = /Deuda pendiente\s*(UF\s*[\d.]+(?:,\d+)?)/i.exec(text)?.[1] ?? null;
  const installment = /Cuota\s*(?:\$[\d.]+\s*)?(\d+\s*\/\s*\d+)/i.exec(text)?.[1] ?? null;
  return { credit, debt, installment };
}

async function scrapeMetlife(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "metlife", accounts: [], error, debug: debugLog.join("\n") });

  progress("Entrando a MetLife…");
  debugLog.push("1. Abriendo el ingreso...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOAD_TIMEOUT }).catch(() => {});
  const username = await page.waitForSelector("#username", { visible: true, timeout: 30_000 }).catch(() => null);
  if (username) {
    await screenshot(page, "01-ingreso");
    debugLog.push("2. Escribiendo RUT y clave...");
    await username.click({ clickCount: 3 });
    await username.type(options.rut.replace(/[^0-9kK]/g, "").toUpperCase(), { delay: 50 });
    const password = await page.$("#password");
    if (!password) return fail("No encontré el campo de clave de MetLife.");
    await password.type(options.password, { delay: 50 });
    let clicked = false;
    for (const b of await page.$$("button, a, input[type=submit]")) {
      const t = await b.evaluate((e) => (e.textContent || (e as HTMLInputElement).value || "").trim().toUpperCase());
      if (t === "CONTINUAR") {
        await b.click().catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) await password.press("Enter");
  }

  debugLog.push("3. Esperando el portal...");
  const until = Date.now() + LOGIN_TIMEOUT;
  while (!page.url().includes(PORTAL_HOST) || page.url().includes("login")) {
    if (Date.now() > until) {
      await screenshot(page, "02-sin-ingreso");
      const message = await page.evaluate(() => Array.from(document.querySelectorAll(".ping-error, .error, [role=alert]")).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(" ")).catch(() => "");
      return fail(message ? `MetLife: ${message.slice(0, 160)}` : "No pude entrar a MetLife. Revisa el RUT y la clave.");
    }
    await delay(1000);
  }

  progress("Esperando tus créditos…");
  if (!(await waitForText(page, (t) => /Ver mi producto/i.test(t), LOAD_TIMEOUT))) {
    await screenshot(page, "03-sin-productos");
    return fail("El portal de MetLife no mostró tus productos.");
  }
  await dismissPopup(page);
  await screenshot(page, "03-productos");

  const loans: LoanBalance[] = [];
  const seen = new Set<string>();
  const count = (await productLinks(page)).length;
  debugLog.push(`4. Productos: ${count}`);
  for (let i = 0; i < count; i++) {
    progress(`Leyendo crédito ${i + 1} de ${count}…`);
    const links = await productLinks(page);
    if (!links[i]) break;
    await links[i].click().catch(() => {});
    const text = await waitForText(page, (t) => metlifeLoan(readDetail(t)) !== null, LOAD_TIMEOUT);
    await screenshot(page, `04-credito-${i + 1}`);
    const detail = text ? readDetail(text) : null;
    const loan = detail ? metlifeLoan(detail) : null;
    if (loan && !seen.has(detail!.credit ?? loan.label)) {
      seen.add(detail!.credit ?? loan.label);
      loans.push(loan);
    }
    debugLog.push(`   Crédito ${i + 1}: ${loan ? "deuda leída" : "sin deuda pendiente"}`);
    // De vuelta a "Mis productos" para abrir el siguiente.
    if (i < count - 1) {
      const back = await portalFrame(page)
        .evaluateHandle(() => {
          const all = Array.from(document.querySelectorAll("body *"));
          return all.find((e) => e.childElementCount === 0 && (e.textContent ?? "").trim().toUpperCase() === "MIS PRODUCTOS") ?? null;
        })
        .catch(() => null);
      const el = back?.asElement();
      if (el) await (el as ElementHandle<Element>).click().catch(() => {});
      await waitForText(page, (t) => /Ver mi producto/i.test(t), LOAD_TIMEOUT);
      await dismissPopup(page);
    }
  }

  if (loans.length === 0) return fail("No encontré la deuda pendiente de tus créditos MetLife.");
  progress("Listo");
  return { success: true, bank: "metlife", accounts: [], loans, debug: debugLog.join("\n") };
}

const metlife: BankScraper = {
  id: "metlife",
  name: "MetLife (hipotecario)",
  url: LOGIN_URL,
  scrape: (options) => runScraper("metlife", options, {}, scrapeMetlife),
};

export default metlife;
