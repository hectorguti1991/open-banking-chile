import { describe, it, expect } from "vitest";
import { cardLast4, parseBilledCardJson, parseUnbilledCardJson } from "./scotiabank-cards.js";

// Shapes captured from the site's /cgi-bin/transac/dotrxajax responses (values invented).
const unbilled = { lstUltimosMovVisaEnc: {
  gtipo: ["TARJETA :      00", "VIDRIERIA LAS CON", "PAGO             ", "LIDER EXPRESS    "],
  gdesc: ["05587271100545075", "DES                    ", "                       ", "                       "],
  ftrs: ["        ", "20260814", "20261006", "20261012"],
  vtrs: ["           ", "00059749900", "00184944400", "00001599000"],
  svtrs: [" ", "+", "-", "+"],
  gciu: ["              ", "SANTIAGO      ", "              ", "SANTIAGO      "],
  haymas: "N", nreg: "004",
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
      { date: "14-08-2026", description: "VIDRIERIA LAS CONDES", amount: -597499, balance: 0, source: "credit_card_unbilled", card: "****5075" },
      { date: "06-10-2026", description: "PAGO", amount: 1849444, balance: 0, source: "credit_card_unbilled", card: "****5075" },
      { date: "12-10-2026", description: "LIDER EXPRESS", amount: -15990, balance: 0, source: "credit_card_unbilled", card: "****5075" },
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
