import { describe, expect, it } from "vitest";
import type { BankMovement } from "../types.js";
import { withBillingDate } from "./falabella.js";

const cuota: BankMovement = {
  date: "23-10-2026", description: "COMPRA CUOTAS SIN INTERES LEON Y CIA. SA", amount: -112167, balance: 0,
  source: "credit_card_billed", installments: "01/06", totalAmount: 673000,
};

describe("withBillingDate", () => {
  it("marca lo facturado con la fecha de facturación del estado de cuenta", () => {
    expect(withBillingDate([cuota], "20-11-2026")).toEqual([{ ...cuota, billingDate: "20-11-2026" }]);
  });

  it("sin fecha de facturación deja los movimientos igual", () => {
    expect(withBillingDate([cuota], undefined)).toEqual([cuota]);
  });
});
