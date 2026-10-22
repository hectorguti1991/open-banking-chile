import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { parseAfcAmount } from "./afc.js";

describe("AFC", () => {
  it("lee el saldo total en pesos", () => {
    expect(parseAfcAmount("12.345.678")).toBe(12345678);
    expect(parseAfcAmount(" 0 ")).toBe(0);
  });

  it("no inventa un saldo cuando está oculto o vacío", () => {
    expect(parseAfcAmount("****")).toBeNull();
    expect(parseAfcAmount("")).toBeNull();
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "afc", name: "AFC (seguro de cesantía)", url: "https://personas.afc.cl/" });
  });
});
