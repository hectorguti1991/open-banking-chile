import type { CreditLineBalance } from "../types.js";
import { parseChileanAmount } from "../utils.js";

// ─── Líneas de crédito y sobregiros ──────────────────────────────
// Cada banco muestra la línea de la cuenta corriente a su manera; estas funciones leen lo que entrega
// cada uno (JSON o texto de la página) y devuelven el cupo usado.

const last4 = (s: string) => s.replace(/\D/g, "").slice(-4);

function line(label: string, total: number, available: number): CreditLineBalance {
  return { label, used: Math.max(total - available, 0), total, available };
}

/**
 * Scotiabank, `/bff-home-main-web/v1/accounts`: el saldo de la cuenta corriente (`amount_available` de
 * CTACTE) y las líneas (LICRED: `total_balance` es el cupo y `amount_available` lo disponible).
 * `null` si la respuesta no es una lista.
 */
export function scotiabankAccountsSummary(json: unknown): { balance?: number; creditLines: CreditLineBalance[] } | null {
  if (!Array.isArray(json)) return null;
  const rows = json as Array<{ type?: unknown; display_id?: unknown; currency_code?: unknown; total_balance?: unknown; amount_available?: unknown }>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const checking = rows.find(r => r.type === "CTACTE" && r.currency_code === "CLP" && str(r.amount_available));
  const creditLines = rows
    .filter(r => r.type === "LICRED" && str(r.total_balance))
    .map(r => line(`Línea de crédito ****${last4(str(r.display_id))}`, parseChileanAmount(str(r.total_balance)), parseChileanAmount(str(r.amount_available))));
  return checking ? { balance: parseChileanAmount(str(checking.amount_available)), creditLines } : { creditLines };
}

/** Banco de Chile, `bff-pp-prod-ctas-saldos/productos/cuentas/saldos`: las filas LINEA_CREDITO. */
export function bchileCreditLines(saldos: Array<{ tipo: string; moneda: string; numero?: string; disponible: number; cupo?: number }>): CreditLineBalance[] {
  return saldos
    .filter(s => s.tipo === "LINEA_CREDITO" && s.moneda === "CLP" && typeof s.cupo === "number")
    .map(s => line(`Línea de crédito ****${last4(s.numero ?? "")}`, s.cupo!, s.disponible));
}

/** BCI, recuadro "Cuenta" del inicio: "Saldo Disponible", "Sobregiro Disponible" y "Sobregiro Utilizado" (negativo). */
export function parseBciHome(text: string): { balance?: number; creditLine?: CreditLineBalance } {
  const amount = (label: string) => {
    const m = text.match(new RegExp(`${label}\\s*\\$\\s*(-?\\s*[\\d.]+)`));
    return m ? parseChileanAmount(m[1].replace(/\s/g, "")) : undefined;
  };
  const out: { balance?: number; creditLine?: CreditLineBalance } = {};
  const balance = amount("Saldo Disponible");
  if (balance !== undefined) out.balance = balance;
  const used = amount("Sobregiro Utilizado");
  const available = amount("Sobregiro Disponible");
  if (used !== undefined && available !== undefined) {
    out.creditLine = { label: "Sobregiro", used: Math.abs(used), total: Math.abs(used) + available, available };
  }
  return out;
}

/** Banco Falabella, fila "Línea de Crédito" de "Mis productos": cada monto va antes de su nombre. */
export function parseFalabellaCreditLine(text: string): CreditLineBalance | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!/^L[ií]nea de Cr[eé]dito\b/i.test(flat)) return null;
  const amount = (label: string) => {
    const m = flat.match(new RegExp(`\\$\\s*([\\d.]+)\\s*${label}`, "i"));
    return m ? parseChileanAmount(m[1]) : undefined;
  };
  const total = amount("Cupo autorizado");
  const used = amount("Saldo utilizado");
  const available = amount("Saldo disponible");
  if (used === undefined) return null;
  const number = flat.match(/^L[ií]nea de Cr[eé]dito\s+([\d ]+?)\s*\$/i)?.[1] ?? "";
  return { label: `Línea de crédito ****${last4(number)}`, used, total, available };
}
