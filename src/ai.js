import OpenAI from "openai";
import XLSX from "xlsx";
import mammoth from "mammoth";
import { topCandidates, normalizeText } from "./catalog.js";

function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("La IA todavía no está configurada en el servidor (falta OPENAI_API_KEY).");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
  if (["txt","md"].includes(ext)) return `ARCHIVO: ${file.originalname}\n${file.buffer.toString("utf8")}`;
  return null;
}

function directFileContent(file) {
  const base64 = file.buffer.toString("base64");
  if (file.mimetype?.startsWith("image/")) {
    return { type: "input_image", image_url: `data:${file.mimetype};base64,${base64}`, detail: "high" };
  }
  return { type: "input_file", filename: file.originalname, file_data: base64, detail: "auto" };
}

export async function extractRequest({ files = [], pastedText = "", clientName = "" }) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const textChunks = [], direct = [];
  for (const file of files) {
    const text = await fileToText(file);
    if (text) textChunks.push(text.slice(0, 220000)); else direct.push(directFileContent(file));
  }

  const instructions = `Extraé TODOS los renglones de esta solicitud de cotización o licitación odontológica.\n\nREGLAS CRÍTICAS:\n- La solicitud puede estar repartida entre varios archivos; tratarlos como un único expediente.\n- No omitas renglones aunque se repitan.\n- Cantidad = cantidad solicitada, no contenido/presentación del envase.\n- Conservá calibres, medidas, colores, números, marcas, compatibilidades, presentaciones y exigencias técnicas.\n- No inventes SKU. En esta etapa sólo extraés lo pedido.\n- Encabezados, subtotales, firmas y condiciones comerciales no son artículos.\n- Si un dato no existe, devolver null.\n- En fuente indicar el nombre del archivo o \"texto pegado\" cuando sea posible.\nCliente informado por el operador: ${clientName || "(sin informar)"}.`;

  const content = [{ type: "input_text", text: `${instructions}${pastedText ? `\n\nTEXTO PEGADO:\n${pastedText}` : ""}${textChunks.length ? `\n\nCONTENIDO EXTRAÍDO DE ARCHIVOS:\n${textChunks.join("\n\n---\n\n")}` : ""}` }, ...direct];
  const response = await client.responses.create({
    model,
    input: [{ role: "user", content }],
    reasoning: { effort: "low" },
    text: { format: { type: "json_schema", name: "solicitud_cotizacion", strict: true, schema: extractionSchema } }
  });
  return JSON.parse(response.output_text);
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
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const payload = extractedItems.map((item, itemIndex) => ({
    itemIndex,
    solicitado: item,
    candidatos_catalogo: topCandidates(`${item.descripcion} ${item.marca_requerida || ""} ${item.presentacion || ""} ${(item.restricciones || []).join(" ")}`, catalog, 24)
      .map(c => ({ sku:c.sku, descripcion:c.descripcion, marca:c.marca, stock:c.stock, precio:c.precio, score_lexico:Number(c.lexicalScore.toFixed(2)) })),
    relaciones_confirmadas_previas: memoryForItem(item, knowledge, clientName)
  }));

  const response = await client.responses.create({
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: `Actuás como especialista en insumos odontológicos y armado de licitaciones. Elegí del catálogo únicamente opciones plausibles para cada renglón.\n\nREGLAS:\n1. Un renglón puede tener 0, 1 o VARIAS opciones válidas; conservar alternativas reales.\n2. Nunca inventar SKU: sólo devolver SKU de candidatos_catalogo o relaciones_confirmadas_previas.\n3. Validar tipo de producto, medida/calibre/número, presentación, marca obligatoria y compatibilidad.\n4. Si una diferencia impide cumplir técnicamente, no sugerir.\n5. confianza = 0 a 100. Menos de 70 requiere revisión.\n6. cantidad_a_cargar normalmente coincide con la cantidad solicitada. Si hay conversión de presentación dudosa, mantener cantidad solicitada y requiere_revision_cantidad=true.\n7. No forzar coincidencias: cero opciones es válido.\n8. Las relaciones confirmadas previamente tienen prioridad, pero sólo si siguen siendo compatibles con la solicitud actual.\n\nCliente: ${clientName || "sin especificar"}\n\nDATOS:\n${JSON.stringify(payload)}` }] }],
    reasoning: { effort: "medium" },
    text: { format: { type: "json_schema", name: "matching_catalogo", strict: true, schema: matchSchema } }
  });
  const result = JSON.parse(response.output_text);
  const catalogBySku = new Map(catalog.map(c => [String(c.sku), c]));
  return result.resultados.map(r => ({ ...r, opciones: r.opciones.map(o => ({ ...o, ...(catalogBySku.get(String(o.sku)) || {}) })) }));
}
