import { describe, expect, it } from "vitest";
import { listSources } from "../index.js";
import { parseUsd, racionalTotal } from "./racional.js";

describe("Racional", () => {
  it("lee montos en dólares con formato chileno", () => {
    expect(parseUsd("US$277,59")).toBe(277.59);
    expect(parseUsd(" US$ 1.234,5 ")).toBe(1234.5);
    expect(parseUsd("US$0,00")).toBe(0);
    expect(parseUsd("$50.000")).toBeNull();
    expect(parseUsd("")).toBeNull();
  });

  it("el total es lo invertido más la billetera", () => {
    expect(racionalTotal({ invested: "US$277,59", wallet: "US$12,41" })).toBe(290);
    expect(racionalTotal({ invested: "US$277,59", wallet: null })).toBe(277.59);
    expect(racionalTotal({ invested: null, wallet: "US$12,41" })).toBeNull();
  });

  it("es una fuente de patrimonio", () => {
    expect(listSources()).toContainEqual({ id: "racional", name: "Racional", url: "https://racional.cl/" });
  });
});
