import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.ts";
import { HOLIDAYS_2026 } from "./holidays.ts";
import { dataDir, dbPath, sqlWasmPath } from "./paths.ts";

export function getDbPath(): string {
  return dbPath();
}

let db: Database | null = null;

const SEED_PEOPLE: { name: string; groupName: string }[] = [
  { name: "冯宝儿", groupName: "广州" },
  { name: "钟梓枫", groupName: "广州" },
  { name: "钟龙", groupName: "广州" },
  { name: "姚炎兰", groupName: "广州" },
  { name: "骆成奕", groupName: "广州" },
  { name: "毛佩凤", groupName: "广州" },
  { name: "刘文达", groupName: "佛山" },
  { name: "陈彩怡", groupName: "佛山" },
  { name: "周秋艳", groupName: "佛山" },
  { name: "杨礼", groupName: "佛山" },
  { name: "俞观权", groupName: "中山清远" },
  { name: "陆威婷", groupName: "中山清远" },
  { name: "李珊珊", groupName: "中山清远" },
  { name: "江金岚", groupName: "中山清远" },
];

export async function getDb(): Promise<Database> {
  if (db) return db;
  const wasm = sqlWasmPath();
  const SQL = await initSqlJs({
    locateFile: (file) => (file.endsWith(".wasm") ? wasm : file),
  });
  const path = dbPath();
  if (existsSync(path)) {
    db = new SQL.Database(readFileSync(path));
    migrate(db);
  } else {
    db = new SQL.Database();
    migrate(db);
    seed(db);
    persist();
  }
  return db;
}

export function persist(): void {
  if (!db) return;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(dbPath(), Buffer.from(db.export()));
}

function exec(database: Database, sql: string): void {
  database.exec(sql);
}

function migrate(database: Database): void {
  exec(
    database,
    `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      target_days INTEGER,
      can_night INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS holidays (
      date TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      UNIQUE(person_id, date)
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      shift TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      UNIQUE(person_id, date)
    );
    CREATE TABLE IF NOT EXISTS rest_wishes (
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      PRIMARY KEY (person_id, date)
    );
    `,
  );
  const row = database.prepare("SELECT value FROM settings WHERE key = 'settings'");
  if (row.step()) {
    const raw = row.getAsObject() as { value?: string };
    row.free();
    if (raw.value) {
      const parsed = JSON.parse(raw.value) as Settings;
      if (parsed.maxNightDiff === 5) {
        parsed.maxNightDiff = 3;
        const upd = database.prepare(
          "UPDATE settings SET value = ? WHERE key = 'settings'",
        );
        upd.run([JSON.stringify(parsed)]);
        upd.free();
      }
    }
  } else {
    row.free();
  }
}

function seed(database: Database): void {
  const stmt = database.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?)",
  );
  stmt.run(["settings", JSON.stringify(DEFAULT_SETTINGS)]);
  stmt.free();

  const person = database.prepare(
    "INSERT INTO people (name, group_name, active, target_days, can_night, sort_order) VALUES (?, ?, 1, NULL, 1, ?)",
  );
  SEED_PEOPLE.forEach((p, i) => {
    person.run([p.name, p.groupName, i + 1]);
  });
  person.free();

  const holiday = database.prepare(
    "INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?)",
  );
  for (const h of HOLIDAYS_2026) {
    holiday.run([h.date, h.name, h.kind]);
  }
  holiday.free();
}

export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  if (!db) throw new Error("db not ready");
  const stmt = db.prepare(sql);
  stmt.bind(params as never[]);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(sql, params)[0];
}

export function execSql(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error("db not ready");
  const stmt = db.prepare(sql);
  stmt.run(params as never[]);
  stmt.free();
}

export function run(sql: string, params: unknown[] = []): void {
  execSql(sql, params);
  persist();
}

export function runMany(actions: () => void): void {
  actions();
  persist();
}

export function getSettings(): Settings {
  const row = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
}

export function saveSettings(next: Settings): Settings {
  run(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(next)],
  );
  return getSettings();
}

export function backupTo(target: string): void {
  persist();
  copyFileSync(dbPath(), target);
}

export function restoreFrom(source: Buffer): void {
  persist();
  writeFileSync(dbPath(), source);
  db?.close();
  db = null;
}
