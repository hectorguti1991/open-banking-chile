import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { isHomeUrl, parseAmount, racionalBalances } from "./racional.js";

describe("Racional", () => {
  it("lee montos en dólares y pesos con formato chileno, de Racional 1.0 y 2.0", () => {
    expect(parseAmount("US$277,59")).toEqual({ currency: "USD", value: 277.59 });
    expect(parseAmount(" US$ 1.234,5 ")).toEqual({ currency: "USD", value: 1234.5 });
    expect(parseAmount("USD 276,17")).toEqual({ currency: "USD", value: 276.17 });
    expect(parseAmount("USD 0,00")).toEqual({ currency: "USD", value: 0 });
    expect(parseAmount("CLP 250.000")).toEqual({ currency: "CLP", value: 250000 });
    expect(parseAmount("$50.000")).toEqual({ currency: "CLP", value: 50000 });
    expect(parseAmount("+USD 110,89")).toBeNull();
    expect(parseAmount("— CLP 0")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("Racional 2.0: suma lo del resumen (menos la ganancia) y la billetera", () => {
    expect(
      racionalBalances({
        summary: [
          { label: "Stocks", amount: "USD 276,17" },
          { label: "Ganancia total", amount: "+USD 110,89" },
        ],
        wallet: "USD 12,41",
        invested: null,
      }),
    ).toEqual([{ currency: "USD", balance: 288.58 }]);
  });

  it("Racional 2.0: lo que está en pesos va aparte, y una línea en cero no suma nada", () => {
    expect(
      racionalBalances({
        summary: [
          { label: "Stocks", amount: "USD 276,17" },
          { label: "Portafolios", amount: "CLP 150.000" },
          { label: "Depósito a plazo", amount: "CLP 0" },
          { label: "Ganancia total", amount: "+USD 110,89" },
        ],
        wallet: "USD 0,00",
        invested: null,
      }),
    ).toEqual([
      { currency: "USD", balance: 276.17 },
      { currency: "CLP", balance: 150000 },
    ]);
  });

  it("Racional 1.0: el total es lo invertido más la billetera", () => {
    expect(racionalBalances({ summary: [], invested: "US$277,59", wallet: "US$12,41" })).toEqual([{ currency: "USD", balance: 290 }]);
    expect(racionalBalances({ summary: [], invested: "US$277,59", wallet: null })).toEqual([{ currency: "USD", balance: 277.59 }]);
  });

  it("sin lo invertido no hay total", () => {
    expect(racionalBalances({ summary: [], invested: null, wallet: "US$12,41" })).toBeNull();
    expect(racionalBalances({ summary: [{ label: "Ganancia total", amount: "+USD 1,00" }], invested: null, wallet: "USD 1,00" })).toBeNull();
  });

  it("reconoce el inicio de Racional 1.0 y 2.0, pero no el ingreso", () => {
    expect(isHomeUrl("https://app.racional.cl/tabs/home")).toBe(true);
    expect(isHomeUrl("https://app.racional.cl/home")).toBe(true);
    expect(isHomeUrl("https://app.racional.cl/login?redirect=%2Fhome")).toBe(false);
    expect(isHomeUrl("https://app.racional.cl/start")).toBe(false);
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "racional", name: "Racional", url: "https://racional.cl/" });
  });
});
