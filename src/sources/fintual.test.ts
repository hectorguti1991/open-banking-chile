import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { goalsFromApi } from "./fintual.js";

describe("Fintual", () => {
  it("un saldo por objetivo con plata, redondeado a pesos", () => {
    const body = { data: [
      { id: "1", type: "goal", attributes: { name: "Educación Mateo", nav: 889723.4 } },
      { id: "2", type: "goal", attributes: { name: "Vacaciones", nav: 0 } },
      { id: "3", type: "goal", attributes: { name: " Jubilación anticipada ", nav: 441013 } },
      { id: "4", type: "goal", attributes: { name: "Raro", nav: "mucho" } },
    ] };
    expect(goalsFromApi(body)).toEqual([
      { label: "Educación Mateo", balance: 889723, movements: [] },
      { label: "Jubilación anticipada", balance: 441013, movements: [] },
    ]);
  });

  it("una respuesta sin datos no inventa saldos", () => {
    expect(goalsFromApi(null)).toEqual([]);
    expect(goalsFromApi({ error: "Tienes que iniciar sesión" })).toEqual([]);
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "fintual", name: "Fintual", url: "https://fintual.cl/" });
  });
});
