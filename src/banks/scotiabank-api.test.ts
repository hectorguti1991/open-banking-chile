import { describe, it, expect } from "vitest";
import { describeJsonShape, findLinkedEntries, parseTransactionsJson } from "./scotiabank-api.js";

describe("parseTransactionsJson", () => {
  it("reads a list of transactions with date, description and signed amount", () => {
    const json = { data: { transactions: [
      { transactionDate: "2026-10-01T00:00:00", description: "COMPRA LIDER", amount: -15990 },
      { transactionDate: "2026-09-28", description: "SUELDO", amount: 2700000 },
    ] } };
    expect(parseTransactionsJson(json)).toEqual([
      { date: "01-10-2026", description: "COMPRA LIDER", amount: -15990, balance: 0, source: "account" },
      { date: "28-09-2026", description: "SUELDO", amount: 2700000, balance: 0, source: "account" },
    ]);
  });

  it("uses a debit/credit indicator when amounts are unsigned", () => {
    const json = [
      { fecha: "01/10/2026", glosa: "PAGO SERVICIO", monto: "15.990", tipo: "CARGO" },
      { fecha: "02/10/2026", glosa: "TRANSFERENCIA RECIBIDA", monto: "50.000", tipo: "ABONO" },
      { fecha: "03/10/2026", glosa: "GIRO", monto: 20000, debitCreditIndicator: "D" },
    ];
    expect(parseTransactionsJson(json).map((m) => m.amount)).toEqual([-15990, 50000, -20000]);
  });

  it("returns [] when there is no list of transactions", () => {
    expect(parseTransactionsJson({ status: "ok", accounts: [] })).toEqual([]);
    expect(parseTransactionsJson(null)).toEqual([]);
  });
});

describe("describeJsonShape", () => {
  it("lists keys and types without values", () => {
    const shape = describeJsonShape({ data: { transactions: [{ date: "2026-10-01", amount: -15990, description: "COMPRA LIDER" }] }, total: 1 });
    expect(shape).toBe("{data:{transactions:[1×{date:string,amount:number,description:string}]},total:number}");
    expect(shape).not.toContain("LIDER");
    expect(shape).not.toContain("15990");
  });
});

describe("findLinkedEntries", () => {
  it("lists the text and link of menu entries whose text matches, masking long digit runs", () => {
    const menu = { items: [
      { label: "Cuentas", url: "/cuentas", children: [] },
      { label: "Tarjetas", children: [
        { label: "Movimientos tarjeta de crédito", url: "/mfe/tarjetas/movimientos" },
        { name: "Visa 4567123412341234", link: "/tarjetas/4567123412341234" },
      ] },
    ] };
    expect(findLinkedEntries(menu, /tarjeta|visa/i)).toEqual([
      "Movimientos tarjeta de crédito -> /mfe/tarjetas/movimientos",
      "Visa <n> -> /tarjetas/<n>",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(findLinkedEntries({ items: [{ label: "Cuentas", url: "/c" }] }, /tarjeta/i)).toEqual([]);
  });
});
