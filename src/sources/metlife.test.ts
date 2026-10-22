import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { metlifeLoan, parseUf } from "./metlife.js";

describe("MetLife", () => {
  it("lee montos en UF con formato chileno", () => {
    expect(parseUf("UF 2.107,41")).toBe(2107.41);
    expect(parseUf(" UF 950 ")).toBe(950);
    expect(parseUf("$553.282")).toBeNull();
    expect(parseUf("")).toBeNull();
  });

  it("arma el crédito con la deuda pendiente, el dividendo y la cuota", () => {
    expect(metlifeLoan({ credit: "2017060831A025", debt: "UF 2.107,41", installment: "112 / 248" })).toEqual({
      label: "Mutuo Hipotecario ****A025", currency: "UF", balance: 2107.41, installments: "112/248",
    });
    expect(metlifeLoan({ credit: "2017060831A025", debt: "cargando", installment: null })).toBeNull();
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "metlife", name: "MetLife (hipotecario)", url: "https://portaldeclientes.metlife.cl/PIP/login" });
  });
});
