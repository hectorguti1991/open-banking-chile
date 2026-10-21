import type { BankMovement } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, parseChileanAmount } from "../utils.js";

const DATE_KEY = /fecha|date/i;
const AMOUNT_KEY = /monto|amount|importe|valor/i;
const DESCRIPTION_KEY = /glosa|descrip|detalle|concept|narrative/i;
const TYPE_KEY = /tipo|type|indicator|naturaleza|signo|cargoabono/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function looksLikeDate(v: unknown): boolean {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(v.trim());
}

function pickKey(o: Obj, pattern: RegExp, ok: (v: unknown) => boolean): string | undefined {
  return Object.keys(o).find((k) => pattern.test(k) && ok(o[k]));
}

/** Finds the arrays of objects anywhere in the JSON. */
function arraysOfObjects(json: unknown, out: Obj[][] = []): Obj[][] {
  if (Array.isArray(json)) {
    if (json.length && json.every(isObj)) out.push(json as Obj[]);
    for (const v of json) arraysOfObjects(v, out);
  } else if (isObj(json)) {
    for (const v of Object.values(json)) arraysOfObjects(v, out);
  }
  return out;
}

function toAmount(v: unknown): number {
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string") return parseChileanAmount(v);
  return 0;
}

function isDebit(v: unknown): boolean | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toUpperCase();
  if (/^(D|DEBIT|DEBITO|DÉBITO|CARGO|C(?!R))/.test(s) && !/^CR|^CREDIT|^ABONO/.test(s)) return true;
  if (/^(CR|CREDIT|CREDITO|CRÉDITO|ABONO|A)/.test(s)) return false;
  return undefined;
}

/**
 * Reads movements from the JSON of Scotiabank's `.../accounts/<type>/<id>/transactions` endpoint without
 * relying on exact field names: the largest list of objects that has a date and an amount wins.
 * Unsigned amounts take their sign from a cargo/abono-style field.
 */
export function parseTransactionsJson(json: unknown): BankMovement[] {
  const candidates = arraysOfObjects(json)
    .filter((list) => {
      const first = list[0];
      return pickKey(first, DATE_KEY, looksLikeDate) && pickKey(first, AMOUNT_KEY, (v) => typeof v === "number" || typeof v === "string");
    })
    .sort((a, b) => b.length - a.length);
  const list = candidates[0];
  if (!list) return [];

  const movements: BankMovement[] = [];
  for (const item of list) {
    const dateKey = pickKey(item, DATE_KEY, looksLikeDate);
    const amountKey = pickKey(item, AMOUNT_KEY, (v) => typeof v === "number" || typeof v === "string");
    if (!dateKey || !amountKey) continue;
    let amount = toAmount(item[amountKey]);
    if (!amount) continue;
    const typeKey = pickKey(item, TYPE_KEY, (v) => typeof v === "string");
    const debit = typeKey ? isDebit(item[typeKey]) : undefined;
    if (debit === true) amount = -Math.abs(amount);
    if (debit === false) amount = Math.abs(amount);
    const descriptionKey = pickKey(item, DESCRIPTION_KEY, (v) => typeof v === "string");
    movements.push({
      date: normalizeDate(String(item[dateKey]).slice(0, 10)),
      description: descriptionKey ? String(item[descriptionKey]).trim() : "",
      amount,
      balance: 0,
      source: MOVEMENT_SOURCE.account,
    });
  }
  return movements;
}

const TEXT_KEY = /label|name|title|text|nombre|descrip/i;
const LINK_KEY = /url|href|link|path|route/i;
const maskDigits = (s: string) => s.replace(/\d{4,}/g, "<n>");

/**
 * "text -> link" for every object in the JSON (a menu, say) whose text matches, with long digit runs
 * masked so card numbers never reach the diagnostics.
 */
export function findLinkedEntries(json: unknown, pattern: RegExp, out: string[] = []): string[] {
  if (Array.isArray(json)) {
    for (const v of json) findLinkedEntries(v, pattern, out);
  } else if (isObj(json)) {
    const textKey = pickKey(json, TEXT_KEY, (v) => typeof v === "string" && pattern.test(v));
    const linkKey = pickKey(json, LINK_KEY, (v) => typeof v === "string" && v.length > 0);
    if (textKey && linkKey) out.push(maskDigits(`${String(json[textKey]).trim()} -> ${json[linkKey]}`));
    for (const v of Object.values(json)) findLinkedEntries(v, pattern, out);
  }
  return out;
}

/** Keys and value types of a JSON value, never the values themselves (for diagnostics). */
export function describeJsonShape(json: unknown, depth = 0): string {
  if (depth > 6) return "…";
  if (Array.isArray(json)) return json.length ? `[${json.length}×${describeJsonShape(json[0], depth + 1)}]` : "[]";
  if (isObj(json)) return `{${Object.entries(json).map(([k, v]) => `${k}:${describeJsonShape(v, depth + 1)}`).join(",")}}`;
  return json === null ? "null" : typeof json;
}
