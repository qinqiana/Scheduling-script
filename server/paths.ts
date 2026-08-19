import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function fallbackRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

export function projectRoot(): string {
  return process.env.ROSTER_ROOT || fallbackRoot();
}

export function dataDir(): string {
  return process.env.ROSTER_DATA_DIR || projectRoot();
}

export function dbPath(): string {
  return join(dataDir(), "data.db");
}

export function distDir(): string {
  return process.env.ROSTER_DIST || join(projectRoot(), "dist");
}

export function templatesDir(): string {
  return process.env.ROSTER_TEMPLATES || join(projectRoot(), "templates");
}

export function sqlWasmPath(): string {
  const env = process.env.SQL_WASM;
  if (env && existsSync(env)) return env;
  const candidates = [
    join(projectRoot(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "", "sql-wasm.wasm"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}
