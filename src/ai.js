import OpenAI from "openai";
import XLSX from "xlsx";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { topCandidates, normalizeText } from "./catalog.js";

function getClient() {
  if (!process.env.GEMINI_API_KEY) throw new Error("La IA todavía no está configurada en el servidor (falta GEMINI_API_KEY).");
  return new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
  });
}

const extractionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    titulo: { type: ["string","null"] }, cliente_detectado: { type: ["string","null"] }, referencia: { type: ["string","null"] },
    items: { type: "array", items: { type: "object", additionalProperties: false,
      properties: {
        renglon: { type: ["integer","null"] }, descripcion: { type: "string" }, cantidad: { type: ["number","null"] }, unidad: { type: ["string","null"] },
        marca_requerida: { type: ["string","null"] }, presentacion: { type: ["string","null"] }, restricciones: { type: "array", items: { type: "string" } },
        fuente: { type: ["string","null"] }, pagina: { type: ["integer","null"] }
      },
      required: ["renglon","descripcion","cantidad","unidad","marca_requerida","presentacion","restricciones","fuente","pagina"]
    }}
  }, required: ["titulo","cliente_detectado","referencia","items"]
};

const matchSchema = {
  type: "object", additionalProperties: false,
  properties: { resultados: { type: "array", items: { type: "object", additionalProperties: false,
    properties: {
      itemIndex: { type: "integer" },
      opciones: { type: "array", items: { type: "object", additionalProperties: false,
        properties: {
          sku: { type: "string" }, confianza: { type: "number" }, tipo: { type: "string", enum: ["exacta","equivalente","alternativa","dudosa"] },
          motivo: { type: "string" }, cantidad_a_cargar: { type: ["number","null"] }, requiere_revision_cantidad: { type: "boolean" }
        }, required: ["sku","confianza","tipo","motivo","cantidad_a_cargar","requiere_revision_cantidad"]
      }}, observacion: { type: ["string","null"] }
    }, required: ["itemIndex","opciones","observacion"]
  }}}
  , required: ["resultados"]
};

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfToText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function fileToText(file) {
  const ext = file.originalname.toLowerCase().split(".").pop();
  if (["xlsx","xls","xlsm","csv"].includes(ext)) {
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    const chunks = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: "\t", RS: "\n" });
      chunks.push(`ARCHIVO: ${file.originalname}\nHOJA: ${name}\n${csv}`);
    }
    return chunks.join("\n\n");
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return `ARCHIVO: ${file.originalname}\n${result.value}`;
  }
  if (ext === "pdf") {
    const text = await pdfToText(file.buffer);
    return `ARCHIVO: ${file.originalname}\n${text}`;
  }
  if (["txt","md"].includes(ext)) return `ARCHIVO: ${file.originalname}\n${file.buffer.toString("utf8")}`;
  if (["html","htm"].includes(ext)) return `ARCHIVO: ${file.originalname}\n${htmlToText(file.buffer.toString("utf8"))}`;
  return null;
}

function directFileContent(file) {
  if (file.mimetype?.startsWith("image/")) {
    const base64 = file.buffer.toString("base64");
    return { type: "image_url", image_url: { url: `data:${file.mimetype};base64,${base64}` } };
  }
  return null;
}

export async function extractRequest({ files = [], pastedText = "", clientName = "" }) {
  const client = getClient();
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const textChunks = [], direct = [];
  for (const file of files) {
    const text = await fileToText(file);
    if (text) { textChunks.push(text.slice(0, 220000)); continue; }
    const asImage = directFileContent(file);
    if (asImage) direct.push(asImage);
    else textChunks.push(`ARCHIVO: ${file.originalname}\n(formato no soportado, no se pudo leer)`);
  }

  const instructions = `Extraé TODOS los renglones de esta solicitud de cotización o licitación odontológica.\n\nREGLAS CRÍTICAS:\n- La solicitud puede estar repartida entre varios archivos; tratarlos como un único expediente.\n- No omitas renglones aunque se repitan.\n- Cantidad = cantidad solicitada, no contenido/presentación del envase.\n- Conservá calibres, medidas, colores, números, marcas, compatibilidades, presentaciones y exigencias técnicas.\n- No inventes SKU. En esta etapa sólo extraés lo pedido.\n- Encabezados, subtotales, firmas y condiciones comerciales no son artículos.\n- Si un dato no existe, devolver null.\n- En fuente indicar el nombre del archivo o \"texto pegado\" cuando sea posible.\nCliente informado por el operador: ${clientName || "(sin informar)"}.`;

  const content = [{ type: "text", text: `${instructions}${pastedText ? `\n\nTEXTO PEGADO:\n${pastedText}` : ""}${textChunks.length ? `\n\nCONTENIDO EXTRAÍDO DE ARCHIVOS:\n${textChunks.join("\n\n---\n\n")}` : ""}` }, ...direct];
  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "low",
    messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "solicitud_cotizacion", strict: true, schema: extractionSchema } }
  });
  return JSON.parse(response.choices[0].message.content);
}

function memoryForItem(item, knowledge, clientName) {
  const q = normalizeText(item.descripcion);
  return knowledge.filter(k => {
    const clientOk = !clientName || !k.cliente || normalizeText(k.cliente) === normalizeText(clientName);
    const mem = normalizeText(k.texto_original || k.texto_normalizado || "");
    if (!clientOk || !mem) return false;
    return q.includes(mem.slice(0, Math.min(mem.length, 36))) || mem.includes(q.slice(0, Math.min(q.length, 36)));
  }).sort((a,b) => Number(b.prioridad || 0) - Number(a.prioridad || 0)).slice(0, 10);
}

export async function matchItems({ extractedItems, catalog, knowledge, clientName }) {
  const client = getClient();
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const payload = extractedItems.map((item, itemIndex) => ({
    itemIndex,
    solicitado: item,
    candidatos_catalogo: topCandidates(`${item.descripcion} ${item.marca_requerida || ""} ${item.presentacion || ""} ${(item.restricciones || []).join(" ")}`, catalog, 24)
      .map(c => ({ sku:c.sku, descripcion:c.descripcion, marca:c.marca, stock:c.stock, precio:c.precio, score_lexico:Number(c.lexicalScore.toFixed(2)) })),
    relaciones_confirmadas_previas: memoryForItem(item, knowledge, clientName)
  }));

  const response = await client.chat.completions.create({
    model,
    reasoning_effort: "medium",
    messages: [{ role: "user", content: [{ type: "text", text: `Actuás como especialista en insumos odontológicos y armado de licitaciones. Elegí del catálogo únicamente opciones plausibles para cada renglón.\n\nREGLAS:\n1. Un renglón puede tener 0, 1 o VARIAS opciones válidas; conservar alternativas reales.\n2. Nunca inventar SKU: sólo devolver SKU de candidatos_catalogo o relaciones_confirmadas_previas.\n3. Validar tipo de producto, medida/calibre/número, presentación, marca obligatoria y compatibilidad.\n4. Si una diferencia impide cumplir técnicamente, no sugerir.\n5. confianza = 0 a 100. Menos de 70 requiere revisión.\n6. cantidad_a_cargar normalmente coincide con la cantidad solicitada. Si hay conversión de presentación dudosa, mantener cantidad solicitada y requiere_revision_cantidad=true.\n7. No forzar coincidencias: cero opciones es válido.\n8. Las relaciones confirmadas previamente tienen prioridad, pero sólo si siguen siendo compatibles con la solicitud actual.\n\nCliente: ${clientName || "sin especificar"}\n\nDATOS:\n${JSON.stringify(payload)}` }] }],
    response_format: { type: "json_schema", json_schema: { name: "matching_catalogo", strict: true, schema: matchSchema } }
  });
  const result = JSON.parse(response.choices[0].message.content);
  const catalogBySku = new Map(catalog.map(c => [String(c.sku), c]));
  return result.resultados.map(r => ({ ...r, opciones: r.opciones.map(o => ({ ...o, ...(catalogBySku.get(String(o.sku)) || {}) })) }));
}
