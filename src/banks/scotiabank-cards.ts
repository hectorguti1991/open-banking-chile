import type { BankMovement, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";

// Scotiabank's card statement page (an iframe inside the private shell) loads its data from
// /cgi-bin/transac/dotrxajax as column-oriented JSON: one array per field, one index per row.
// Amounts are zero-padded digit strings and their sign lives in a separate "+"/"-" field, where
// "+" is a charge to the card. Library convention: charges negative, payments positive.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The inner list object (e.g. `lstUltimosMovVisaEnc`) that holds the given column. */
function columns(json: unknown, column: string): Obj | null {
  if (!isObj(json)) return null;
  for (const v of Object.values(json)) if (isObj(v) && Array.isArray(v[column])) return v;
  return null;
}

const cell = (cols: Obj, key: string, i: number): string => {
  const col = cols[key];
  return Array.isArray(col) ? String(col[i] ?? "") : "";
};

/** "20260814" → "14-08-2026"; null for blanks and "00000000". */
function toDate(yyyymmdd: string): string | null {
  const m = yyyymmdd.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m || m[1] === "0000") return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const digits = (s: string) => parseInt(s.trim() || "0", 10) || 0;
/** "-" is a payment or credit to the card (positive); anything else is a charge (negative). */
const signed = (value: number, sign: string) => (sign.trim() === "-" ? value : -value);

function movement(date: string, description: string, amount: number, source: MovementSource, card: string): BankMovement {
  return { date, description, amount, balance: 0, source, card };
}

/** Unbilled movements (`vt_UltimosMovVisaEnc`). Values carry two decimals. */
export function parseUnbilledCardJson(json: unknown, card: string): BankMovement[] {
  const cols = columns(json, "ftrs");
  if (!cols) return [];
  const out: BankMovement[] = [];
  for (let i = 0; i < (cols.ftrs as unknown[]).length; i++) {
    const date = toDate(cell(cols, "ftrs", i));
    if (!date) continue;
    const amount = Math.round(digits(cell(cols, "vtrs", i)) / 100);
    if (!amount) continue;
    // The merchant name is split across gtipo (first 17 characters) and gdesc (the rest).
    const description = (cell(cols, "gtipo", i) + cell(cols, "gdesc", i)).replace(/\s+/g, " ").trim();
    out.push(movement(date, description, signed(amount, cell(cols, "svtrs", i)), MOVEMENT_SOURCE.credit_card_unbilled, card));
  }
  return out;
}

/**
 * Last billed statement, national section (`vt_EstadoVisaNacEnc`). Rows with tdet "T" are section
 * titles. vmtotran is the purchase total with two decimals; vmtocuo is this statement's installment
 * in whole pesos.
 */
export function parseBilledCardJson(json: unknown, card: string): BankMovement[] {
  const cols = columns(json, "fectran");
  if (!cols) return [];
  const out: BankMovement[] = [];
  for (let i = 0; i < (cols.fectran as unknown[]).length; i++) {
    if (cell(cols, "tdet", i).trim() !== "D") continue;
    const date = toDate(cell(cols, "fectran", i));
    if (!date) continue;
    const description = `${cell(cols, "gmovuno", i)} ${cell(cols, "gmovdos", i)}`.replace(/\s+/g, " ").trim();
    const total = Math.round(digits(cell(cols, "vmtotran", i)) / 100);
    const n = digits(cell(cols, "tcdnumcuot", i));
    const of = digits(cell(cols, "tcdtotcuo", i));
    if (of > 1) {
      const installment = digits(cell(cols, "vmtocuo", i));
      if (!installment) continue;
      out.push({
        ...movement(date, description, signed(installment, cell(cols, "svmtocuo", i)), MOVEMENT_SOURCE.credit_card_billed, card),
        installments: `${String(n).padStart(2, "0")}/${String(of).padStart(2, "0")}`,
        totalAmount: total,
      });
    } else {
      if (!total) continue;
      out.push(movement(date, description, signed(total, cell(cols, "svmtotran", i)), MOVEMENT_SOURCE.credit_card_billed, card));
    }
  }
  return out;
}

/** "Mastercard Black ****5075" → "5075". */
export function cardLast4(label: string): string | null {
  const m = label.match(/\*{2,}\s*(\d{4})\b/);
  return m ? m[1] : null;
}
