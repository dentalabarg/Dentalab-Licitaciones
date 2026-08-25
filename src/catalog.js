import XLSX from "xlsx";
import { readJson, writeJson } from "./storage.js";

const SKU_ALIASES = ["sku","codigo","código","cod","articulo","artículo","codigo articulo","código artículo","codigo material","material"];
const DESC_ALIASES = ["descripcion","descripción","nombre","articulo descripcion","detalle","producto","nombre articulo","nombre artículo"];
const BRAND_ALIASES = ["marca","brand","fabricante"];
const STOCK_ALIASES = ["stock","existencia","disponible","stock total"];
const PRICE_ALIASES = ["precio","precio venta","lista","lista 1","lista1","precio final"];

function normalizeHeader(v) {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function findKey(row, aliases) {
  const keys = Object.keys(row);
  const normalized = new Map(keys.map(k => [normalizeHeader(k), k]));
  for (const alias of aliases) {
    const found = normalized.get(normalizeHeader(alias));
    if (found) return found;
  }
  return null;
}

function parseRows(rows) {
  if (!rows.length) throw new Error("El archivo de catálogo no tiene filas.");
  const sample = rows.find(r => Object.keys(r).length) || rows[0];
  const skuKey = findKey(sample, SKU_ALIASES);
  const descKey = findKey(sample, DESC_ALIASES);
  if (!skuKey || !descKey) throw new Error("No pude identificar las columnas SKU/Código y Descripción/Nombre del catálogo.");
  const brandKey = findKey(sample, BRAND_ALIASES);
  const stockKey = findKey(sample, STOCK_ALIASES);
  const priceKey = findKey(sample, PRICE_ALIASES);

  const seen = new Set();
  const items = [];
  rows.forEach((r, index) => {
    const item = {
      sku: String(r[skuKey] ?? "").trim(),
      descripcion: String(r[descKey] ?? "").trim(),
      marca: brandKey ? String(r[brandKey] ?? "").trim() : "",
      stock: stockKey ? r[stockKey] ?? null : null,
      precio: priceKey ? r[priceKey] ?? null : null,
      sourceRow: index + 2
    };
    if (!item.sku || !item.descripcion || seen.has(item.sku)) return;
    seen.add(item.sku);
    items.push(item);
  });

  if (!items.length) throw new Error("No encontré artículos válidos con SKU y descripción.");
  return { items, detected: { skuKey, descKey, brandKey, stockKey, priceKey } };
}

export async function importCatalog(buffer, originalName) {
  const ext = originalName.toLowerCase().split(".").pop();
  let rows;
  if (["xlsx","xls","xlsm"].includes(ext)) {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  } else if (ext === "csv") {
    const wb = XLSX.read(buffer.toString("utf8"), { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  } else {
    throw new Error("Catálogo: usá XLSX, XLS o CSV.");
  }
  const parsed = parseRows(rows);
  await writeJson("catalog.json", parsed.items);
  await writeJson("catalog-meta.json", { importedAt: new Date().toISOString(), originalName, count: parsed.items.length, detected: parsed.detected });
  return { count: parsed.items.length, detected: parsed.detected };
}

export async function getCatalog() { return readJson("catalog.json", []); }
export async function getCatalogMeta() { return readJson("catalog-meta.json", null); }

export function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9#.+/-]+/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(["de","del","la","el","los","las","un","una","por","para","con","sin","y","o","x","und","unidad","unidades","envase","caja","pack"]);
function tokens(text) { return normalizeText(text).split(" ").filter(t => t.length > 1 && !STOP.has(t)); }

function scoreCandidate(query, item) {
  const q = tokens(query), d = tokens(`${item.descripcion} ${item.marca} ${item.sku}`);
  if (!q.length || !d.length) return 0;
  const ds = new Set(d);
  let shared = 0, weighted = 0;
  for (const t of q) {
    if (ds.has(t)) { shared++; weighted += /\d/.test(t) ? 2.6 : (t.length >= 7 ? 1.6 : 1); }
  }
  const coverage = shared / q.length;
  const precision = shared / Math.max(d.length, 1);
  const exactSkuBoost = normalizeText(item.sku) === normalizeText(query) ? 20 : 0;
  const phraseBoost = normalizeText(item.descripcion).includes(normalizeText(query)) ? 5 : 0;
  return weighted * 5 + coverage * 22 + precision * 5 + phraseBoost + exactSkuBoost;
}

export function topCandidates(query, catalog, limit = 24) {
  return catalog.map(item => ({ ...item, lexicalScore: scoreCandidate(query, item) }))
    .sort((a,b) => b.lexicalScore - a.lexicalScore).slice(0, limit);
}
