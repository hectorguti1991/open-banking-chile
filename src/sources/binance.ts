import { createHmac } from "node:crypto";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";

// ─── Binance ─────────────────────────────────────────────────────
// Sin navegador: la API oficial con una API key solo de lectura. En las credenciales, `rut` es la API key y
// `password` el secreto (tipo HMAC). Antes de leer saldos se revisan los permisos de la llave y se rechaza
// si permite operar, transferir o retirar. El saldo es la suma de todas las billeteras (Spot, Funding, Earn…),
// que Binance entrega en BTC, pasada a dólares con el precio BTC/USDT.

const API = "https://api.binance.com";
const RECV_WINDOW = 10_000;

/** Lo mínimo de `fetch` que se usa (para poder probar sin red). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Firma de Binance: HMAC SHA256 de la consulta con el secreto, en hexadecimal. */
export function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

const DANGEROUS: Array<[string, string]> = [
  ["enableWithdrawals", "retiros"],
  ["enableInternalTransfer", "transferencias internas"],
  ["permitsUniversalTransfer", "transferencias universales"],
  ["enableSpotAndMarginTrading", "trading spot y margen"],
  ["enableMargin", "margen"],
  ["enableFutures", "futuros"],
  ["enableVanillaOptions", "opciones"],
  ["enablePortfolioMarginTrading", "portfolio margin"],
  ["enableFixApiTrade", "trading por FIX"],
];

/** Los permisos de la llave que permiten mover plata (vacío si es solo de lectura). */
export function unsafePermissions(restrictions: unknown): string[] {
  if (!restrictions || typeof restrictions !== "object") return ["permisos desconocidos"];
  const r = restrictions as Record<string, unknown>;
  if (r.enableReading !== true) return ["sin permiso de lectura"];
  return DANGEROUS.filter(([field]) => r[field] === true).map(([, name]) => name);
}

/** Suma en BTC de las billeteras activas; `null` si la respuesta no es una lista de billeteras. */
export function walletsTotalBtc(wallets: unknown): number | null {
  if (!Array.isArray(wallets)) return null;
  let total = 0;
  for (const w of wallets) {
    const { activate, balance } = (w ?? {}) as { activate?: unknown; balance?: unknown };
    const n = typeof balance === "string" ? Number(balance) : Number.NaN;
    if (activate === true && Number.isFinite(n)) total += n;
  }
  return total;
}

class BinanceError extends Error {}

function errorMessage(status: number, body: unknown): string {
  const code = (body as { code?: unknown } | null)?.code;
  if (code === -2015 || code === -2014 || status === 401) {
    return "Binance rechazó la API key. Revisa la llave y el secreto, y que la llave tenga permiso de lectura (y tu IP, si la restringiste).";
  }
  if (code === -1022) return "Binance no aceptó la firma. Usa una API key de tipo HMAC (generada por el sistema) y revisa el secreto.";
  if (code === -1021) return "La hora de este computador no coincide con la de Binance. Ajusta la hora y vuelve a intentar.";
  return `Binance respondió con un error (${typeof code === "number" ? code : status}).`;
}

export async function scrapeBinance(options: Pick<ScraperOptions, "rut" | "password" | "onProgress">, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ScrapeResult> {
  const debugLog: string[] = [];
  const progress = options.onProgress ?? (() => {});
  const fail = (error: string): ScrapeResult => ({ success: false, bank: "binance", accounts: [], error, debug: debugLog.join("\n") });
  const apiKey = options.rut.trim();
  const secret = options.password.trim();
  if (!apiKey || !secret) return fail("Ingresa la API key y el secreto de Binance.");

  const get = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
    const r = await fetchImpl(`${API}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`);
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new BinanceError(errorMessage(r.status, body));
    return body;
  };

  try {
    progress("Conectando con Binance…");
    // Con la hora de Binance, un reloj local desfasado no hace fallar la firma.
    debugLog.push("1. Hora de Binance...");
    const serverTime = (await get("/api/v3/time") as { serverTime?: unknown } | null)?.serverTime;
    const timestamp = typeof serverTime === "number" ? serverTime : Date.now();

    const signed = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
      const query = new URLSearchParams({ ...params, timestamp: String(timestamp), recvWindow: String(RECV_WINDOW) }).toString();
      const r = await fetchImpl(`${API}${path}?${query}&signature=${signQuery(query, secret)}`, { headers: { "X-MBX-APIKEY": apiKey } });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new BinanceError(errorMessage(r.status, body));
      return body;
    };

    debugLog.push("2. Revisando los permisos de la llave...");
    const unsafe = unsafePermissions(await signed("/sapi/v1/account/apiRestrictions"));
    if (unsafe.length > 0) {
      debugLog.push(`   Llave rechazada: ${unsafe.join(", ")}`);
      return fail(`La API key de Binance no es solo de lectura (${unsafe.join(", ")}). Crea una con solo "Enable Reading" y vuelve a ingresarla.`);
    }

    progress("Leyendo tus billeteras…");
    debugLog.push("3. Saldo de las billeteras...");
    const wallets = await signed("/sapi/v1/asset/wallet/balance", { quoteAsset: "BTC" });
    const btc = walletsTotalBtc(wallets);
    if (btc === null) return fail("Binance no entregó el saldo de tus billeteras.");
    debugLog.push(`   Billeteras activas: ${(wallets as unknown[]).filter((w) => (w as { activate?: unknown }).activate === true).length}`);

    debugLog.push("4. Precio BTC/USDT...");
    const price = Number((await get("/api/v3/ticker/price", { symbol: "BTCUSDT" }) as { price?: unknown } | null)?.price);
    if (!Number.isFinite(price) || price <= 0) return fail("No pude leer el precio del BTC en Binance.");

    progress("Listo");
    const usd = Math.round(btc * price * 100) / 100;
    return { success: true, bank: "binance", accounts: [{ label: "Binance", balance: usd, currency: "USD", movements: [] }], debug: debugLog.join("\n") };
  } catch (err) {
    if (err instanceof BinanceError) return fail(err.message);
    debugLog.push(`   Error de conexión: ${err instanceof Error ? err.name : "desconocido"}`);
    return fail("No pude conectarme con Binance. Revisa tu conexión a internet.");
  }
}

const binance: BankScraper = {
  id: "binance",
  name: "Binance",
  url: "https://www.binance.com/",
  scrape: (options) => scrapeBinance(options),
};

export default binance;
