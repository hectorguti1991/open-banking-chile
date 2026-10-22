import { describe, expect, it } from "vitest";
import { listBanks, listSources, getSource } from "../index.js";
import { cleanRut, parseTotalAhorrado, waitForTotal } from "./afpuno.js";

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

describe("esperar el Total ahorrado", () => {
  const reader = (texts: Array<string | null>) => {
    let i = 0;
    return async () => texts[Math.min(i++, texts.length - 1)];
  };
  const sleep = async () => {};

  it("no se queda con el $0 que muestra la página mientras carga", async () => {
    expect(await waitForTotal(reader([null, "$0", "$0", "$56.702.988"]), { attempts: 10, sleep })).toEqual({ text: "$56.702.988", amount: 56702988 });
  });

  it("si nunca pasa de $0, no entrega un saldo", async () => {
    expect(await waitForTotal(reader(["$0"]), { attempts: 5, sleep })).toEqual({ text: "$0", amount: null });
  });

  it("con el monto oculto deja de esperar", async () => {
    let calls = 0;
    const read = async () => { calls++; return "$ ••••••"; };
    expect(await waitForTotal(read, { attempts: 10, sleep })).toEqual({ text: "$ ••••••", amount: null });
    expect(calls).toBe(1);
  });
});
