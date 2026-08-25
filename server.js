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
  res.json({ok:true,catalogCount:catalog.length,catalogImportedAt:meta?.importedAt||null,knowledgeCount:knowledge.length,jobsCount:jobs.length,aiConfigured:Boolean(process.env.OPENAI_API_KEY),yiqiConfigured:Boolean(process.env.YIQI_USER&&process.env.YIQI_PASSWORD),yiqiCreateEnabled:String(process.env.YIQI_ENABLE_CREATE).toLowerCase()==="true"});
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
  const selected=Array.isArray(req.body.selected)?req.body.selected:jobs[i].selected||[];
  jobs[i]={...jobs[i],selected,hasSavedSelection:true,status:req.body.status||jobs[i].status,client:req.body.client??jobs[i].client,updatedAt:new Date().toISOString()}; await writeJson("jobs.json",jobs);res.json({ok:true,job:jobs[i]});
}catch(e){next(e)}});

app.post("/api/aprendizaje", async(req,res,next)=>{try{
  const {client,mappings}=req.body;if(!Array.isArray(mappings))throw new Error("mappings debe ser un array.");
  const existing=await readJson("knowledge.json",[]), now=new Date().toISOString();
  for(const m of mappings){if(!m.texto_original||!m.sku)continue;const record={cliente:client||"",texto_original:m.texto_original,texto_normalizado:normalizeText(m.texto_original),sku:String(m.sku),descripcion:m.descripcion||"",tipo_relacion:m.tipo_relacion||"validada",prioridad:m.prioridad||100,createdAt:now};const duplicate=existing.some(x=>normalizeText(x.cliente)===normalizeText(record.cliente)&&x.texto_normalizado===record.texto_normalizado&&String(x.sku)===record.sku);if(!duplicate)existing.push(record)}
  await writeJson("knowledge.json",existing);res.json({ok:true,knowledgeCount:existing.length});
}catch(e){next(e)}});

app.post("/api/export/xlsx", (req,res,next)=>{try{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw new Error("No hay SKU seleccionados para exportar.");
  const data=rows.map(r=>({Renglon:r.renglon??"",Solicitado:r.solicitado??"",SKU:r.sku??"",Descripcion:r.descripcion??"",Cantidad:r.cantidad??""}));
  const ws=XLSX.utils.json_to_sheet(data), wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Pedido");ws["!cols"]=[{wch:10},{wch:65},{wch:18},{wch:65},{wch:12}];
  const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename=pedido_sku_${new Date().toISOString().slice(0,10)}.xlsx`);res.send(buf);
}catch(e){next(e)}});

app.get("/api/yiqi/status", async(_req,res,next)=>{try{const info=await getLoginInfo();res.json({ok:true,schemaId:info.schemaId||info.SchemaId||info.schemas?.[0]?.id||null});}catch(e){next(e)}});
app.get("/api/yiqi/pedido/:id", async(req,res,next)=>{try{res.json(await inspectPedido(req.params.id));}catch(e){next(e)}});
app.post("/api/yiqi/pedido", async(req,res,next)=>{try{res.json(await createPedido(req.body));}catch(e){next(e)}});

app.get("/healthz", (_req,res)=>res.json({ok:true}));
app.use(express.static(path.join(__dirname,"public")));
app.get("/*splat", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.use((err,_req,res,_next)=>{console.error(err);res.status(400).json({ok:false,error:err.message||String(err)})});

const port=Number(process.env.PORT||8788);app.listen(port,()=>console.log(`Dentalab Licitaciones Web listo en puerto ${port}`));
