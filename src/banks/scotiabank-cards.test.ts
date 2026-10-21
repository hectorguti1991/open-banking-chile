import { describe, it, expect } from "vitest";
import type { BankMovement } from "../types.js";
import { cardBillingDates, cardLast4, linkUnbilledInstallments, parseBilledCardJson, parseUnbilledCardJson, unbilledCardLast4 } from "./scotiabank-cards.js";

// Shapes captured from the site's /cgi-bin/transac/dotrxajax responses (values invented).
const unbilled = { lstUltimosMovVisaEnc: {
  gtipo: ["TARJETA :      00", "VIDRIERIA LAS CON", "PAGO             ", "LIDER EXPRESS    "],
  gdesc: ["05587271100545075", "DES                    ", "                       ", "                       "],
  ftrs: ["        ", "20260814", "20261006", "20261012"],
  vtrs: ["           ", "00059749900", "00184944400", "00001599000"],
  svtrs: [" ", "+", "-", "+"],
  gciu: ["              ", "SANTIAGO      ", "              ", "SANTIAGO      "],
  haymas: "N", nreg: "004", fant: "20260923", fsig: "20261023",
} };

const billed = { llamada: "", lstEstadoNacVisaEnc: {
  tdet: ["T", "D", "T", "D", "D", "D"],
  fectran: ["00000000", "20260909", "00000000", "20260910", "20260801", "20260924"],
  gmovuno: ["1.TOTAL OPERACIONES", "PAGO EN EFECTIVO", "PAGOS A LA CUENTA", "SCOTIABANK", "FALABELLA", "SERVICIO DE ACTIVIDAD MENSUAL"],
  gmovdos: ["", "", "", "", "", ""],
  tcdnumcuot: ["00", "01", "00", "01", "02", "01"],
  tcdtotcuo: ["00", "01", "00", "01", "06", "01"],
  vmtocuo: ["00000000000", "00001744927", "00000000000", "00001839192", "00000015990", "00000010252"],
  svmtocuo: ["+", "-", "+", "+", "+", "+"],
  vmtotran: ["00000000000", "00174492700", "00000000000", "00183919200", "00009594000", "00001025200"],
  svmtotran: ["+", "-", "+", "+", "+", "+"],
} };

describe("parseUnbilledCardJson", () => {
  it("reads dated rows, joins the split description and signs charges negative", () => {
    expect(parseUnbilledCardJson(unbilled, "****5075")).toEqual([
      { date: "14-08-2026", description: "VIDRIERIA LAS CONDES", amount: -597499, balance: 0, source: "credit_card_unbilled", card: "****5075", billingDate: "23-10-2026" },
      { date: "06-10-2026", description: "PAGO", amount: 1849444, balance: 0, source: "credit_card_unbilled", card: "****5075", billingDate: "23-10-2026" },
      { date: "12-10-2026", description: "LIDER EXPRESS", amount: -15990, balance: 0, source: "credit_card_unbilled", card: "****5075", billingDate: "23-10-2026" },
    ]);
  });

  it("returns [] for an unexpected shape", () => {
    expect(parseUnbilledCardJson({ error: "x" }, "****1")).toEqual([]);
    expect(parseUnbilledCardJson(null, "****1")).toEqual([]);
  });
});

describe("parseBilledCardJson", () => {
  it("reads detail rows, skips section titles and keeps payments positive", () => {
    const ms = parseBilledCardJson(billed, "****6357");
    expect(ms.map((m) => [m.date, m.description, m.amount])).toEqual([
      ["09-09-2026", "PAGO EN EFECTIVO", 1744927],
      ["10-09-2026", "SCOTIABANK", -1839192],
      ["01-08-2026", "FALABELLA", -15990],
      ["24-09-2026", "SERVICIO DE ACTIVIDAD MENSUAL", -10252],
    ]);
    expect(ms.every((m) => m.source === "credit_card_billed" && m.card === "****6357")).toBe(true);
  });

  it("bills the monthly installment and keeps the purchase total", () => {
    const installment = parseBilledCardJson(billed, "****6357")[2];
    expect(installment).toMatchObject({ amount: -15990, installments: "02/06", totalAmount: 95940 });
    expect(parseBilledCardJson(billed, "****6357")[1].installments).toBeUndefined();
  });
});

describe("cardLast4", () => {
  it("takes the last four digits of a masked card label", () => {
    expect(cardLast4("Mastercard Black ****5075")).toBe("5075");
    expect(cardLast4("Cuenta Corriente")).toBeNull();
  });
});

describe("unbilledCardLast4", () => {
  it("reads the card from the TARJETA header row", () => {
    expect(unbilledCardLast4(unbilled)).toBe("5075");
    expect(unbilledCardLast4({ x: 1 })).toBeNull();
  });
});

describe("cardBillingDates", () => {
  it("reads the last and next billing dates of the unbilled data", () => {
    expect(cardBillingDates(unbilled)).toEqual({ last: "23-09-2026", next: "23-10-2026" });
    expect(cardBillingDates(null)).toEqual({ last: null, next: null });
  });
});

describe("parseBilledCardJson billing date", () => {
  it("stamps each row with the statement's billing date when given", () => {
    expect(parseBilledCardJson(billed, "****6357", "23-09-2026").every((m) => m.billingDate === "23-09-2026")).toBe(true);
  });
});

describe("linkUnbilledInstallments", () => {
  const cuota = (over: Partial<BankMovement>): BankMovement => ({
    date: "13-08-2026", description: "VIDRIERIA LAS CONDES", amount: -99583, balance: 0,
    source: "credit_card_unbilled", card: "****5075", ...over,
  });
  const billedCuota = cuota({ description: "VIDRIERIA LAS CONDES TASA INT. 0%", source: "credit_card_billed", installments: "02/06", totalAmount: 597499 });

  it("marks the unbilled row of a billed installment purchase as the next installment, with the billed description", () => {
    const [next] = linkUnbilledInstallments([cuota({})], [billedCuota]);
    expect(next).toMatchObject({ description: "VIDRIERIA LAS CONDES TASA INT. 0%", installments: "03/06", totalAmount: 597499, amount: -99583 });
  });

  it("marks the purchase total as installment 01 so it is not counted as a spend", () => {
    const [total] = linkUnbilledInstallments([cuota({ date: "14-08-2026", amount: -597499 })], [billedCuota]);
    expect(total).toMatchObject({ installments: "01/06", totalAmount: 597499, amount: -597499 });
  });

  it("leaves other movements alone", () => {
    const other = cuota({ description: "METLIFE CHILE SEGUROS", amount: -873799, date: "10-10-2026" });
    expect(linkUnbilledInstallments([other], [billedCuota])).toEqual([other]);
  });
});
