import type { Page } from "puppeteer-core";
import type { BankScraper, LoanBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── BICE Hipotecaria (créditos hipotecarios) ────────────────────
// Portal de clientes (Angular). El ingreso es de Auth0 en login.bicehipotecaria.cl: RUT (la página pone el
// guion) y contraseña, con un hCaptcha que resuelve el usuario en la ventana, que por eso siempre es visible.
// El portal guarda la sesión en el perfil de Chrome, así que casi siempre entra sin pedir nada.
// En Consultas → Antecedentes Crédito, un selector "N° de Operación" lista cada crédito; cada operación
// muestra un panel por crédito (el principal y, si hay, el complementario) con su "Saldo Insoluto" en UF.

const CREDIT_URL = "https://portal.bicehipotecaria.cl/portal/consultas/antecedentes-credito";
const LOGIN_HOST = "login.bicehipotecaria.cl";
const LOGIN_TIMEOUT = 5 * 60_000;
const LOAD_TIMEOUT = 45_000;

/** `"1.055,617756"` → `1055.617756`; lo que no es un monto → `null`. */
export function parseBiceUf(text: string): number | null {
  const m = /^([\d.]+(?:,\d+)?)(?:\s*UF)?$/i.exec(text.trim());
  return m ? Number(m[1].replace(/\./g, "").replace(",", ".")) : null;
}

/** El número de operación al inicio del texto (`"32689 MH CLASICO COMPLEMENTARIO"` → `"32689"`). */
export function operationNumber(text: string): string | null {
  return /^\s*(\d{3,})\b/.exec(text)?.[1] ?? null;
}

/** El crédito de un panel abierto; `null` si todavía no muestra el saldo insoluto. */
export function biceLoan(panelText: string): LoanBalance | null {
  const saldo = /Saldo Insoluto\s*([\d.]+(?:,\d+)?)/i.exec(panelText)?.[1];
  const balance = saldo ? parseBiceUf(saldo) : null;
  if (balance === null) return null;
  const op = operationNumber(panelText);
  const kind = /COMPLEMENTARIO/i.test(panelText.split("\n")[0] ?? "") ? "Complementario" : "Hipotecario";
  const loan: LoanBalance = { label: `${kind} BICE${op ? ` ${op}` : ""}`, currency: "UF", balance };
  const paid = /Dividendos (?:Pagados|Cancelados)\s*(\d+)/i.exec(panelText)?.[1];
  const total = /Dividendos Total\s*(\d+)/i.exec(panelText)?.[1];
  if (paid && total) loan.installments = `${paid}/${total}`;
  return loan;
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

/** Los títulos de los paneles de crédito de la operación que se ve. */
async function panelHeaders(page: Page): Promise<string[]> {
  return page
    .evaluate(() => Array.from(document.querySelectorAll("mat-expansion-panel-header")).map((h) => (h as HTMLElement).innerText.trim()))
    .catch(() => [] as string[]);
}

/** Abre el panel `i` (si está cerrado) y devuelve su texto. */
async function openPanel(page: Page, i: number): Promise<string> {
  return page
    .evaluate((i) => {
      const p = document.querySelectorAll("mat-expansion-panel")[i] as HTMLElement | undefined;
      if (!p) return "";
      if (!p.classList.contains("mat-expanded")) (p.querySelector("mat-expansion-panel-header") as HTMLElement | null)?.click();
      return p.innerText;
    }, i)
    .catch(() => "");
}

/** Las opciones del selector "N° de Operación" (vacío si el portal no lo muestra). */
async function operationOptions(page: Page): Promise<string[]> {
  await page.evaluate(() => (document.querySelector("mat-select") as HTMLElement | null)?.click()).catch(() => {});
  await delay(1000);
  const options = await page
    .evaluate(() => Array.from(document.querySelectorAll("mat-option")).map((o) => (o as HTMLElement).innerText.trim()))
    .catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => {});
  await delay(500);
  return options;
}

async function selectOperation(page: Page, i: number): Promise<void> {
  await page.evaluate(() => (document.querySelector("mat-select") as HTMLElement | null)?.click()).catch(() => {});
  await delay(1000);
  await page.evaluate((i) => (document.querySelectorAll("mat-option")[i] as HTMLElement | undefined)?.click(), i).catch(() => {});
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeout: number): Promise<T | null> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await read();
    if (ok(v)) return v;
    await delay(1000);
  }
  return null;
}

async function login(page: Page, options: ScraperOptions, debugLog: string[]): Promise<void> {
  const username = await page.waitForSelector("#username", { visible: true, timeout: 20_000 }).catch(() => null);
  if (!username) {
    debugLog.push("   No reconocí el formulario de ingreso: espero que entres en la ventana");
    return;
  }
  debugLog.push("2. Escribiendo RUT y contraseña...");
  await username.click({ clickCount: 3 });
  // Solo números y dígito verificador: la página pone el guion.
  await username.type(options.rut.replace(/[^0-9kK]/g, "").toUpperCase(), { delay: 50 });
  const password = await page.$("#password");
  if (!password) return;
  await password.type(options.password, { delay: 50 });
  const submit = await page.$('button[type="submit"][data-action-button-primary="true"]');
  if (submit) await submit.click().catch(() => {});
  else await password.press("Enter");
}

async function scrapeBiceHipotecaria(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { page, debugLog, screenshot } = session;
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "bicehipotecaria", accounts: [], error, debug: debugLog.join("\n") });

  progress("Abriendo BICE Hipotecaria…");
  debugLog.push("1. Abriendo Antecedentes Crédito...");
  await page.goto(CREDIT_URL, { waitUntil: "networkidle2", timeout: LOAD_TIMEOUT }).catch(() => {});
  // Sin sesión, el portal lleva al ingreso de Auth0.
  await waitFor(async () => page.url(), (u) => u.includes(LOGIN_HOST) || u.includes("/portal/"), 20_000);
  await screenshot(page, "01-inicio");

  if (page.url().includes(LOGIN_HOST)) {
    progress("Entrando a BICE Hipotecaria…");
    await login(page, options, debugLog);
    progress("Si BICE Hipotecaria muestra un desafío de seguridad, resuélvelo en la ventana de Chrome.");
    debugLog.push("3. Esperando el portal (desafío de seguridad, si lo pide)...");
    if (!(await waitFor(async () => page.url(), (u) => !u.includes(LOGIN_HOST) && u.includes("portal.bicehipotecaria.cl"), LOGIN_TIMEOUT))) {
      await screenshot(page, "02-sin-ingreso");
      const message = await page
        .evaluate(() => Array.from(document.querySelectorAll('[id^="error-element"], .ulp-input-error-message')).map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(" "))
        .catch(() => "");
      return fail(message ? `BICE Hipotecaria: ${message.slice(0, 160)}` : "No pude entrar a BICE Hipotecaria. Revisa el RUT y la contraseña.");
    }
    if (!page.url().includes("/antecedentes-credito")) {
      await page.goto(CREDIT_URL, { waitUntil: "networkidle2", timeout: LOAD_TIMEOUT }).catch(() => {});
    }
  }

  progress("Leyendo tus créditos…");
  if (!(await waitFor(() => panelHeaders(page), (h) => h.length > 0, LOAD_TIMEOUT))) {
    await screenshot(page, "03-sin-creditos");
    return fail(/Antecedentes del Cr[eé]dito/i.test(await bodyText(page)) ? "BICE Hipotecaria no mostró créditos." : "No pude abrir Antecedentes Crédito en BICE Hipotecaria.");
  }

  const ops = await operationOptions(page);
  debugLog.push(`4. Operaciones: ${ops.length || 1}`);
  const loans: LoanBalance[] = [];
  let expected = 0;
  for (let k = 0; k < Math.max(ops.length, 1); k++) {
    const op = ops[k] ? operationNumber(ops[k]) : null;
    if (ops.length > 1) {
      await selectOperation(page, k);
      // El primer panel de cada operación lleva su número.
      if (!(await waitFor(() => panelHeaders(page), (h) => h.length > 0 && (!op || operationNumber(h[0]) === op), LOAD_TIMEOUT))) {
        debugLog.push(`   No cargó la operación ${k + 1}`);
        expected++;
        continue;
      }
    }
    const headers = await panelHeaders(page);
    expected += headers.length;
    for (let j = 0; j < headers.length; j++) {
      const text = await waitFor(() => openPanel(page, j), (t) => biceLoan(t) !== null, 20_000);
      const loan = text ? biceLoan(text) : null;
      if (loan && !loans.some((l) => l.label === loan.label)) loans.push(loan);
      debugLog.push(`   Operación ${k + 1}, crédito ${j + 1}: ${loan ? "saldo leído" : "sin saldo insoluto"}`);
    }
    await screenshot(page, `04-operacion-${k + 1}`);
  }

  // Sin "Cerrar sesión" al terminar: la sesión guardada en el perfil evita el desafío de seguridad.
  await page.goto("about:blank").catch(() => {});
  if (loans.length === 0) return fail("No encontré el saldo de tus créditos en BICE Hipotecaria.");
  // Una lectura a medias borraría en la app el crédito que faltó: mejor fallar y conservar lo anterior.
  if (loans.length < expected) return fail(`Leí ${loans.length} de ${expected} créditos de BICE Hipotecaria. Intenta de nuevo.`);
  progress("Listo");
  return { success: true, bank: "bicehipotecaria", accounts: [], loans, debug: debugLog.join("\n") };
}

const bicehipotecaria: BankScraper = {
  id: "bicehipotecaria",
  name: "BICE Hipotecaria",
  url: "https://portal.bicehipotecaria.cl/",
  // Siempre visible: el ingreso tiene un desafío de seguridad (hCaptcha) que resuelve el usuario.
  scrape: (options) => runScraper("bicehipotecaria", options, { forceHeadful: true }, scrapeBiceHipotecaria),
};

export default bicehipotecaria;
