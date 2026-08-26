import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import XLSX from "xlsx";
import { importCatalog, getCatalog, getCatalogMeta, normalizeText } from "./src/catalog.js";
import { extractRequest, matchItems } from "./src/ai.js";
import { readJson, writeJson } from "./src/storage.js";
import { getLoginInfo, inspectPedido, createPedido } from "./src/yiqi.js";

const app = express();
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:30*1024*1024, files:10 } });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { "script-src": ["'self'"], "style-src": ["'self'"], "img-src": ["'self'","data:"], "connect-src": ["'self'"] } } }));
app.use(express.json({ limit:"12mb" }));
app.use(rateLimit({ windowMs:60_000, limit:90, standardHeaders:"draft-8", legacyHeaders:false }));

const accessRequired = () => Boolean(process.env.APP_ACCESS_KEY);
function auth(req,res,next){
  if(!accessRequired()) return next();
  const provided=String(req.headers["x-app-key"] || "");
  const expected=String(process.env.APP_ACCESS_KEY || "");
  const a=Buffer.from(provided), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({ok:false,error:"Clave de acceso incorrecta."});
  next();
}

app.get("/api/auth/status", (_req,res)=>res.json({required:accessRequired()}));
app.post("/api/auth/check", auth, (_req,res)=>res.json({ok:true}));
app.use("/api", auth);

app.get("/api/status", async (_req,res)=>{
  const catalog=await getCatalog(), meta=await getCatalogMeta(), knowledge=await readJson("knowledge.json",[]), jobs=await readJson("jobs.json",[]);
  res.json({ok:true,catalogCount:catalog.length,catalogImportedAt:meta?.importedAt||null,knowledgeCount:knowledge.length,jobsCount:jobs.length,aiConfigured:Boolean(process.env.GEMINI_API_KEY),yiqiConfigured:Boolean(process.env.YIQI_USER&&process.env.YIQI_PASSWORD),yiqiCreateEnabled:String(process.env.YIQI_ENABLE_CREATE).toLowerCase()==="true"});
});

app.post("/api/catalog", upload.single("file"), async(req,res,next)=>{try{if(!req.file)throw new Error("Falta el archivo de catálogo.");res.json({ok:true,...await importCatalog(req.file.buffer,req.file.originalname)});}catch(e){next(e)}});
app.get("/api/catalog/search", async(req,res)=>{
  const q=normalizeText(req.query.q||""), catalog=await getCatalog();
  if(!q) return res.json(catalog.slice(0,40));
  const terms=q.split(" ").filter(Boolean);
  res.json(catalog.filter(x=>{const hay=normalizeText(`${x.sku} ${x.descripcion} ${x.marca}`);return terms.every(t=>hay.includes(t));}).slice(0,60));
});

app.post("/api/solicitudes/analizar", upload.array("files",10), async(req,res,next)=>{try{
  const files=req.files||[], text=String(req.body.text||"").trim(), client=String(req.body.client||"").trim();
  if(!files.length&&!text) throw new Error("Subí al menos un archivo o pegá el texto de la solicitud.");
  const catalog=await getCatalog(); if(!catalog.length) throw new Error("Primero cargá el catálogo de artículos (SKU + descripción).");
  const knowledge=await readJson("knowledge.json",[]);
  const extracted=await extractRequest({files,pastedText:text,clientName:client});
  const detectedClient=client||extracted.cliente_detectado||"";
  const matched=await matchItems({extractedItems:extracted.items,catalog,knowledge,clientName:detectedClient});
  const byIndex=new Map(matched.map(x=>[x.itemIndex,x]));
  const items=extracted.items.map((item,itemIndex)=>({...item,itemIndex,opciones:byIndex.get(itemIndex)?.opciones||[],observacion_matching:byIndex.get(itemIndex)?.observacion||null}));
  const job={id:crypto.randomUUID(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:"en_revision",client:detectedClient,titulo:extracted.titulo||"Solicitud",referencia:extracted.referencia||"",sourceFiles:files.map(f=>f.originalname),items,selected:[],hasSavedSelection:false};
  const jobs=await readJson("jobs.json",[]); jobs.unshift(job); await writeJson("jobs.json",jobs.slice(0,500));
  res.json(job);
}catch(e){next(e)}});

app.get("/api/jobs", async(_req,res)=>{const jobs=await readJson("jobs.json",[]);res.json(jobs.map(j=>({id:j.id,createdAt:j.createdAt,updatedAt:j.updatedAt,status:j.status,client:j.client,titulo:j.titulo,referencia:j.referencia,sourceFiles:j.sourceFiles,itemCount:j.items?.length||0,selectedCount:j.selected?.length||0})));});
app.get("/api/jobs/:id", async(req,res,next)=>{try{const jobs=await readJson("jobs.json",[]),j=jobs.find(x=>x.id===req.params.id);if(!j)return res.status(404).json({ok:false,error:"Trabajo no encontrado."});res.json(j)}catch(e){next(e)}});
app.put("/api/jobs/:id", async(req,res,next)=>{try{
  const jobs=await readJson("jobs.json",[]), i=jobs.findIndex(x=>x.id===req.params.id); if(i<0)return res.status(404).json({ok:false,error:"Trabajo no encontrado."});
  const selected=Array.isArray(req.body.selected)?req.body.selected:jobs[i
