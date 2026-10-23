import { describe, expect, it } from "vitest";
import { bchileCreditLines, parseBciHome, parseFalabellaCreditLine, scotiabankAccountsSummary } from "./credit-lines.js";

describe("scotiabankAccountsSummary", () => {
  // Lo que entregó /bff-home-main-web/v1/accounts el 23-10-2026 (números de cuenta cambiados).
  const accounts = [
    { key: "a", display_id: "0009 7613 0000", type: "CTACTE", description: "Cuenta Corriente", currency_code: "CLP", total_balance: "$1.500.000", amount_available: "$0", icon_name: "x" },
    { key: "b", display_id: "7100 8076 5018", type: "LICRED", description: "Línea de Crédito", currency_code: "CLP", total_balance: "$1.500.000", amount_available: "$1.487.912", icon_name: "x" },
    { key: "c", display_id: "0009 8210 0000", type: "CTAUSD", description: "Cuenta Corriente en Dólares", currency_code: "USD", total_balance: "USD 0", amount_available: "USD 0", icon_name: "x" },
  ];

  it("lee el saldo de la cuenta corriente y el cupo usado de la línea", () => {
    expect(scotiabankAccountsSummary(accounts)).toEqual({
      balance: 0,
      creditLines: [{ label: "Línea de crédito ****5018", used: 12088, total: 1500000, available: 1487912 }],
    });
  });

  it("sin línea entrega una lista vacía; una respuesta que no es lista no entrega nada", () => {
    expect(scotiabankAccountsSummary(accounts.slice(0, 1))).toEqual({ balance: 0, creditLines: [] });
    expect(scotiabankAccountsSummary({ error: 1 })).toBeNull();
  });
});

describe("bchileCreditLines", () => {
  it("el cupo usado es el cupo menos lo disponible", () => {
    expect(bchileCreditLines([
      { tipo: "CUENTA_CORRIENTE", moneda: "CLP", numero: "00-801-19072-10", disponible: 0, cupo: 0 },
      { tipo: "LINEA_CREDITO", moneda: "CLP", numero: "01-801-19072-00", disponible: 750000, cupo: 1000000 },
    ])).toEqual([{ label: "Línea de crédito ****7200", used: 250000, total: 1000000, available: 750000 }]);
  });

  it("sin usar queda en cero", () => {
    expect(bchileCreditLines([{ tipo: "LINEA_CREDITO", moneda: "CLP", numero: "01-801-19072-00", disponible: 1000000, cupo: 1000000 }])[0].used).toBe(0);
  });
});

describe("parseBciHome", () => {
  // Texto del recuadro "Cuenta" del inicio de BCI.
  const text = "Cuenta Corriente: 76757099\nSaldo Disponible\n$ 0\nSaldo Contable\n$ 0\nRetenciones\n$ 0\nSobregiro Disponible\n$ 167.662\nSobregiro Utilizado\n$ -32.338\nLínea de Emergencia Disponible\n$ 0\nIr a últimos Movimientos";

  it("lee el saldo disponible y el sobregiro usado", () => {
    expect(parseBciHome(text)).toEqual({ balance: 0, creditLine: { label: "Sobregiro", used: 32338, total: 200000, available: 167662 } });
  });

  it("sin el recuadro no entrega nada", () => {
    expect(parseBciHome("Mi Banco")).toEqual({});
  });
});

describe("parseFalabellaCreditLine", () => {
  // Fila de "Mis productos" del inicio de Banco Falabella.
  const row = "Línea de Crédito\n2 016 048589 4\n$500.000\nCupo autorizado\n$120.500\nSaldo utilizado\n$379.500\nSaldo disponible\nAumentar mi línea\nPagar / Configurar";

  it("lee el cupo autorizado, utilizado y disponible", () => {
    expect(parseFalabellaCreditLine(row)).toEqual({ label: "Línea de crédito ****5894", used: 120500, total: 500000, available: 379500 });
  });

  it("otra fila no es una línea", () => {
    expect(parseFalabellaCreditLine("Cuenta Corriente\n1 016 000000 0\n$149.460\nSaldo contable\n$149.460\nSaldo disponible")).toBeNull();
  });
});
