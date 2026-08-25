import { readJson } from "./storage.js";

let tokenCache = null, refreshToken = null, expiresAt = 0, schemaCache = null;
const authBase = () => process.env.YIQI_AUTH_BASE || "https://api.yiqi.com.ar";
const apiBase = () => process.env.YIQI_API_BASE || "https://api.yiqi.com.ar/api/public";

async function login() {
  if (!process.env.YIQI_USER || !process.env.YIQI_PASSWORD) throw new Error("YiQi no está configurado: faltan YIQI_USER/YIQI_PASSWORD.");
  if (tokenCache && Date.now() < expiresAt - 60000) return tokenCache;
  const body = new URLSearchParams();
  if (refreshToken) { body.set("grant_type","refresh_token"); body.set("refresh_token", refreshToken); }
  else { body.set("grant_type","password"); body.set("username",process.env.YIQI_USER); body.set("password",process.env.YIQI_PASSWORD); }
  let res = await fetch(`${authBase()}/token`, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
  if (!res.ok && refreshToken) { refreshToken = null; return login(); }
  if (!res.ok) throw new Error(`YiQi login falló (${res.status}): ${await res.text()}`);
  const data = await res.json();
  tokenCache = data.access_token; refreshToken = data.refresh_token || refreshToken; expiresAt = Date.now() + Number(data.expires_in || 900) * 1000;
  return tokenCache;
}

async function yiqiFetch(path, options={}) {
  const token = await login();
  const res = await fetch(`${apiBase()}${path}`, { ...options, headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...(options.headers||{})} });
  if (!res.ok) throw new Error(`YiQi ${path} falló (${res.status}): ${await res.text()}`);
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.text();
}

export async function getLoginInfo() {
  const token = await login();
  const res = await fetch(`${authBase()}/api/accountapi/GetLoginInformation`, { headers:{Authorization:`Bearer ${token}`} });
  if (!res.ok) throw new Error(`GetLoginInformation falló (${res.status}): ${await res.text()}`);
  const info = await res.json();
  schemaCache = info.schemaId || info.SchemaId || info.schemas?.[0]?.id || schemaCache;
  return info;
}
export async function getSchemaId() { if(schemaCache) return schemaCache; await getLoginInfo(); if(!schemaCache) throw new Error("No pude obtener schemaId desde YiQi."); return schemaCache; }
export async function inspectPedido(id) { const schemaId=await getSchemaId(); return yiqiFetch(`/PEDIDO/${encodeURIComponent(id)}?${new URLSearchParams({schemaId:String(schemaId)})}`); }

export async function createPedido({ client, observations, items }) {
  if (String(process.env.YIQI_ENABLE_CREATE).toLowerCase() !== "true") throw new Error("Creación directa deshabilitada hasta validar el mapeo de Pedido de Dentalab.");
  const mapping = await readJson("yiqi-mapping.json", {});
  if (!mapping.enabled) throw new Error("El mapeo YiQi todavía no está habilitado.");
  const required=[mapping.header?.clientField,mapping.items?.relationField,mapping.items?.skuField,mapping.items?.quantityField];
  if(required.some(v=>!v)) throw new Error("El mapeo YiQi está incompleto.");
  const schemaId=await getSchemaId();
  const data={...(mapping.defaults||{})};
  data[mapping.header.clientField]=client;
  if(mapping.header.observationsField) data[mapping.header.observationsField]=observations||"";
  if(mapping.header.dateField) data[mapping.header.dateField]=new Date().toISOString();
  data[mapping.items.relationField]=items.map(i=>{
    const line={}; line[mapping.items.skuField]=i.sku; line[mapping.items.quantityField]=i.cantidad;
    if(mapping.items.descriptionField) line[mapping.items.descriptionField]=i.descripcion||"";
    return line;
  });
  return yiqiFetch("/PEDIDO", { method:"POST", body:JSON.stringify({schemaId,data}) });
}
