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

/** Last (`fant`) and next (`fsig`) billing dates in the unbilled data, as dd-mm-yyyy. */
export function cardBillingDates(unbilledJson: unknown): { last: string | null; next: string | null } {
  const cols = columns(unbilledJson, "ftrs");
  if (!cols) return { last: null, next: null };
  return { last: toDate(String(cols.fant ?? "")), next: toDate(String(cols.fsig ?? "")) };
}

/**
 * Unbilled movements (`vt_UltimosMovVisaEnc`). Values carry two decimals. Every row will be billed
 * on the next billing date.
 */
export function parseUnbilledCardJson(json: unknown, card: string): BankMovement[] {
  const cols = columns(json, "ftrs");
  if (!cols) return [];
  const billingDate = cardBillingDates(json).next;
  const out: BankMovement[] = [];
  for (let i = 0; i < (cols.ftrs as unknown[]).length; i++) {
    const date = toDate(cell(cols, "ftrs", i));
    if (!date) continue;
    const amount = Math.round(digits(cell(cols, "vtrs", i)) / 100);
    if (!amount) continue;
    // The merchant name is split across gtipo (first 17 characters) and gdesc (the rest).
    const description = (cell(cols, "gtipo", i) + cell(cols, "gdesc", i)).replace(/\s+/g, " ").trim();
    const m = movement(date, description, signed(amount, cell(cols, "svtrs", i)), MOVEMENT_SOURCE.credit_card_unbilled, card);
    out.push(billingDate ? { ...m, billingDate } : m);
  }
  return out;
}

const parseInstallments = (s?: string) => {
  const m = s?.match(/^(\d+)\/(\d+)$/);
  return m ? { n: Number(m[1]), of: Number(m[2]) } : null;
};
const DAY = 24 * 60 * 60 * 1000;
const dayNumber = (ddmmyyyy: string) => {
  const [d, m, y] = ddmmyyyy.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
};
const sameMerchant = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * The unbilled list carries no installment fields, so a pending installment looks like a plain
 * purchase and the purchase total shows up as one more row. Both are recognised from the billed
 * installments of the same card: a row with the same date, merchant and amount is the next
 * installment (it takes the billed description, so it keeps its id once billed), and a row whose
 * amount is the purchase total becomes installment 01 with that total, which is not a spend.
 */
export function linkUnbilledInstallments(unbilled: BankMovement[], billed: BankMovement[]): BankMovement[] {
  const plans = billed.flatMap((b) => {
    const inst = parseInstallments(b.installments);
    return inst && inst.of > 1 && b.totalAmount ? [{ b, ...inst }] : [];
  });
  return unbilled.map((u) => {
    if (u.installments) return u;
    for (const { b, n, of } of plans) {
      if (b.card !== u.card || !sameMerchant(b.description, u.description)) continue;
      const pad = (x: number) => String(x).padStart(2, "0");
      if (u.date === b.date && u.amount === b.amount && n < of) {
        return { ...u, description: b.description, installments: `${pad(n + 1)}/${pad(of)}`, totalAmount: b.totalAmount };
      }
      if (-u.amount === b.totalAmount && Math.abs(dayNumber(u.date) - dayNumber(b.date)) <= 7) {
        return { ...u, installments: `01/${pad(of)}`, totalAmount: b.totalAmount };
      }
    }
    return u;
  });
}

/**
 * Last billed statement, national section (`vt_EstadoVisaNacEnc`). Rows with tdet "T" are section
 * titles. vmtotran is the purchase total with two decimals; vmtocuo is this statement's installment
 * in whole pesos.
 */
export function parseBilledCardJson(json: unknown, card: string, billingDate?: string | null): BankMovement[] {
  const cols = columns(json, "fectran");
  if (!cols) return [];
  const out: BankMovement[] = [];
  const stamp = (m: BankMovement): BankMovement => (billingDate ? { ...m, billingDate } : m);
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
      out.push(stamp({
        ...movement(date, description, signed(installment, cell(cols, "svmtocuo", i)), MOVEMENT_SOURCE.credit_card_billed, card),
        installments: `${String(n).padStart(2, "0")}/${String(of).padStart(2, "0")}`,
        totalAmount: total,
      }));
    } else {
      if (!total) continue;
      out.push(stamp(movement(date, description, signed(total, cell(cols, "svmtotran", i)), MOVEMENT_SOURCE.credit_card_billed, card)));
    }
  }
  return out;
}

/** Last four digits of the card in the unbilled data's "TARJETA :" header row. */
export function unbilledCardLast4(json: unknown): string | null {
  const cols = columns(json, "gtipo");
  if (!cols) return null;
  for (let i = 0; i < (cols.gtipo as unknown[]).length; i++) {
    if (!/^TARJETA/.test(cell(cols, "gtipo", i).trim())) continue;
    const m = cell(cols, "gdesc", i).trim().match(/(\d{4})$/);
    if (m) return m[1];
  }
  return null;
}

/** "Mastercard Black ****5075" → "5075". */
export function cardLast4(label: string): string | null {
  const m = label.match(/\*{2,}\s*(\d{4})\b/);
  return m ? m[1] : null;
}
