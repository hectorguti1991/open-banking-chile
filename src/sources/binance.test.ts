import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { scrapeBinance, signQuery, unsafePermissions, walletsTotalBtc } from "./binance.js";

const READ_ONLY = {
  ipRestrict: false, enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false,
  enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableFixApiTrade: false,
  enableFixReadOnly: true, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false,
};

const WALLETS = [
  { activate: true, balance: "0.01", walletName: "Spot" },
  { activate: true, balance: "0.005", walletName: "Funding" },
  { activate: true, balance: "0.0025", walletName: "Earn" },
  { activate: false, balance: "9", walletName: "Options" },
];

/** Un `fetch` falso que responde según la ruta y guarda lo que se pidió. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const path = new URL(url).pathname;
    const r = routes[path];
    if (!r) throw new Error(`ruta inesperada ${path}`);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  return { fn, calls };
}

const OK_ROUTES = {
  "/api/v3/time": { body: { serverTime: 1700000000000 } },
  "/sapi/v1/account/apiRestrictions": { body: READ_ONLY },
  "/sapi/v1/asset/wallet/balance": { body: WALLETS },
  "/api/v3/ticker/price": { body: { symbol: "BTCUSDT", price: "60000.00" } },
};

describe("Binance", () => {
  it("firma la consulta con HMAC SHA256 (ejemplo de la documentación de Binance)", () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(signQuery(query, secret)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("una llave solo de lectura no tiene permisos peligrosos", () => {
    expect(unsafePermissions(READ_ONLY)).toEqual([]);
  });

  it("nombra los permisos que permiten mover plata", () => {
    expect(unsafePermissions({ ...READ_ONLY, enableWithdrawals: true, enableSpotAndMarginTrading: true })).toEqual(["retiros", "trading spot y margen"]);
    // Sin la respuesta esperada, no se confía en la llave.
    expect(unsafePermissions(null)).toEqual(["permisos desconocidos"]);
    expect(unsafePermissions({ ...READ_ONLY, enableReading: false })).toEqual(["sin permiso de lectura"]);
  });

  it("suma en BTC las billeteras activas", () => {
    expect(walletsTotalBtc(WALLETS)).toBeCloseTo(0.0175, 10);
    expect(walletsTotalBtc("no")).toBeNull();
  });

  it("entrega el total en dólares, con la llave en el encabezado y la consulta firmada", async () => {
    const { fn, calls } = fakeFetch(OK_ROUTES);
    const r = await scrapeBinance({ rut: "LLAVE", password: "SECRETO" }, fn);
    expect(r).toMatchObject({ success: true, bank: "binance", accounts: [{ label: "Binance", balance: 1050, currency: "USD", movements: [] }] });
    const signed = calls.filter((c) => c.url.includes("/sapi/"));
    expect(signed).toHaveLength(2);
    for (const c of signed) {
      expect(c.headers["X-MBX-APIKEY"]).toBe("LLAVE");
      expect(c.url).toMatch(/[?&]timestamp=1700000000000&/);
      expect(c.url).toMatch(/&signature=[0-9a-f]{64}$/);
      expect(c.url).not.toContain("SECRETO");
    }
    expect(r.debug ?? "").not.toContain("SECRETO");
    expect(r.debug ?? "").not.toContain("LLAVE");
  });

  it("rechaza una llave que permite operar o retirar, sin leer saldos", async () => {
    const { fn, calls } = fakeFetch({ ...OK_ROUTES, "/sapi/v1/account/apiRestrictions": { body: { ...READ_ONLY, enableWithdrawals: true } } });
    const r = await scrapeBinance({ rut: "LLAVE", password: "SECRETO" }, fn);
    expect(r.success).toBe(false);
    expect(r.error).toContain("retiros");
    expect(calls.some((c) => c.url.includes("/wallet/balance"))).toBe(false);
  });

  it("explica cuando Binance rechaza la llave", async () => {
    const { fn } = fakeFetch({ ...OK_ROUTES, "/sapi/v1/account/apiRestrictions": { status: 401, body: { code: -2015, msg: "Invalid API-key, IP, or permissions for action." } } });
    const r = await scrapeBinance({ rut: "LLAVE", password: "SECRETO" }, fn);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining("Binance rechazó la API key") });
  });

  it("pide la llave y el secreto", async () => {
    const { fn } = fakeFetch(OK_ROUTES);
    expect((await scrapeBinance({ rut: "", password: "x" }, fn)).success).toBe(false);
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "binance", name: "Binance", url: "https://www.binance.com/" });
  });
});
