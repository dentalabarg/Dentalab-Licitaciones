import fs from "node:fs/promises";
import path from "node:path";

const dataDir = () => path.resolve(process.env.DATA_DIR || "./data");

async function ensureDir() {
  await fs.mkdir(dataDir(), { recursive: true });
}

export async function readJson(name, fallback) {
  await ensureDir();
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir(), name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function writeJson(name, value) {
  await ensureDir();
  const target = path.join(dataDir(), name);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export async function mutateJson(name, fallback, mutator) {
  const current = await readJson(name, fallback);
  const next = await mutator(current) ?? current;
  await writeJson(name, next);
  return next;
}
