import { describe, expect, it } from "vitest";
import { listBanks, listSources, getSource } from "../index.js";
import { cleanRut, parseTotalAhorrado } from "./afpuno.js";

describe("AFP UNO", () => {
  it("lee el total ahorrado con formato chileno", () => {
    expect(parseTotalAhorrado("$56.702.988")).toBe(56702988);
    expect(parseTotalAhorrado(" $ 1.234 ")).toBe(1234);
  });

  it("no inventa un monto cuando está oculto o vacío", () => {
    expect(parseTotalAhorrado("$ ••••••")).toBeNull();
    expect(parseTotalAhorrado("")).toBeNull();
  });

  it("escribe el RUN sin puntos ni guion, con K mayúscula", () => {
    expect(cleanRut("17.768.776-k")).toBe("17768776K");
  });

  it("es una fuente de patrimonio, no un banco", () => {
    expect(listSources()).toContainEqual({ id: "afpuno", name: "AFP UNO", url: "https://www.uno.cl/" });
    expect(getSource("afpuno")?.id).toBe("afpuno");
    expect(listBanks().map((b) => b.id)).not.toContain("afpuno");
  });
});
