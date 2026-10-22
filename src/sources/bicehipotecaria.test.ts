import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { biceLoan, operationNumber, parseBiceUf } from "./bicehipotecaria.js";

const MAIN = `32688 MH FULL ELECCION HIPOTECARIO
Monto

1.266,330000 UF

Tasa

4,940

Dividendos Total

360

Años Plazo

30

Dividendos Generados

105

Saldo Insoluto

1.055,617756

Dividendos Pagados

105

Tabla desarrollo`;

const COMPLEMENTARY = `32689 MH CLASICO COMPLEMENTARIO
Monto

158,370000

Dividendos Total

360

Saldo Insoluto

132,775982

Dividendos Cancelados

105`;

describe("BICE Hipotecaria", () => {
  it("lee montos en UF con formato chileno", () => {
    expect(parseBiceUf("1.055,617756")).toBe(1055.617756);
    expect(parseBiceUf("132,775982 UF")).toBe(132.775982);
    expect(parseBiceUf("950")).toBe(950);
    expect(parseBiceUf("")).toBeNull();
    expect(parseBiceUf("cargando")).toBeNull();
  });

  it("saca el número de operación del texto del selector o del panel", () => {
    expect(operationNumber("1213538 MH FULL ELECCION HIPOTECARIO - BARCELONA 161 DEPTO. 1305")).toBe("1213538");
    expect(operationNumber("32689 MH CLASICO COMPLEMENTARIO")).toBe("32689");
    expect(operationNumber("MH FULL")).toBeNull();
  });

  it("arma el crédito con el saldo insoluto y los dividendos pagados", () => {
    expect(biceLoan(MAIN)).toEqual({ label: "Hipotecario BICE 32688", currency: "UF", balance: 1055.617756, installments: "105/360" });
  });

  it("marca el crédito complementario y acepta 'Dividendos Cancelados'", () => {
    expect(biceLoan(COMPLEMENTARY)).toEqual({ label: "Complementario BICE 32689", currency: "UF", balance: 132.775982, installments: "105/360" });
  });

  it("no arma crédito si el panel todavía no muestra el saldo", () => {
    expect(biceLoan("32688 MH FULL ELECCION HIPOTECARIO")).toBeNull();
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "bicehipotecaria", name: "BICE Hipotecaria", url: "https://portal.bicehipotecaria.cl/" });
  });
});
