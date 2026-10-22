import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { cardCredit, metlifeLoan, nextProduct, parseUf } from "./metlife.js";

describe("MetLife", () => {
  it("lee montos en UF con formato chileno", () => {
    expect(parseUf("UF 2.107,41")).toBe(2107.41);
    expect(parseUf(" UF 950 ")).toBe(950);
    expect(parseUf("$553.282")).toBeNull();
    expect(parseUf("")).toBeNull();
  });

  it("arma el crédito con la deuda pendiente, el dividendo y la cuota", () => {
    expect(metlifeLoan({ credit: "2017060831A025", debt: "UF 2.107,41", installment: "112 / 248" })).toEqual({
      label: "Mutuo Hipotecario 2017060831A025", currency: "UF", balance: 2107.41, installments: "112/248",
    });
    expect(metlifeLoan({ credit: "2017060831A025", debt: "cargando", installment: null })).toBeNull();
  });

  it("distingue créditos que terminan igual", () => {
    const a = metlifeLoan({ credit: "2017060831A025", debt: "UF 2.107,41", installment: null });
    const b = metlifeLoan({ credit: "2021070617A025", debt: "UF 3.000", installment: null });
    expect(a!.label).not.toBe(b!.label);
  });

  it("lee el número de crédito de cada tarjeta de la lista", () => {
    expect(cardCredit("MUTUO HIPOTECARIO FLEXIBLE\nGrandes Proyectos\nCrédito 2021070617A025\nVer mi producto")).toBe("2021070617A025");
    expect(cardCredit("Crédito N°: 2017060831A025")).toBe("2017060831A025");
    expect(cardCredit("Ver mi producto")).toBeNull();
  });

  it("abre el primer producto que falta leer, aunque cambie el orden", () => {
    expect(nextProduct(["2017060831A025", "2021070617A025"], new Set(["2017060831A025"]), 1)).toBe(1);
    expect(nextProduct(["2021070617A025", "2017060831A025"], new Set(["2017060831A025"]), 1)).toBe(0);
    expect(nextProduct(["2017060831A025", "2021070617A025"], new Set(["2017060831A025", "2021070617A025"]), 1)).toBe(-1);
    // Sin número en la tarjeta: se sigue por orden.
    expect(nextProduct([null, null], new Set(["x"]), 1)).toBe(1);
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "metlife", name: "MetLife (hipotecario)", url: "https://portaldeclientes.metlife.cl/PIP/login" });
  });
});
