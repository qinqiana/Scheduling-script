import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.ts";
import { OFFICIAL_HOLIDAYS } from "./holidays.ts";
import { dataDir, dbPath, sqlWasmPath } from "./paths.ts";
import { SEED_PEOPLE } from "./seedPeople.ts";

export function getDbPath(): string {
  return dbPath();
}

let db: Database | null = null;

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
    persist();
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
    CREATE TABLE IF NOT EXISTS attendance_flags (
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (person_id, date)
    );
    CREATE TABLE IF NOT EXISTS generated_months (
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      PRIMARY KEY (year, month)
    );
    `,
  );
  ensureOfficialHolidays(database);
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

/** 写入国务院办公厅放假调休日历（法定假日 + 连休 + 调休上班日） */
function ensureOfficialHolidays(database: Database): void {
  const upsert = database.prepare(
    "INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name, kind = excluded.kind",
  );
  for (const h of OFFICIAL_HOLIDAYS) {
    upsert.run([h.date, h.name, h.kind]);
  }
  upsert.free();
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
  const parsed = JSON.parse(row.value) as Partial<Settings> & Record<string, unknown>;
  delete parsed.lateCoverAfterDay;
  delete parsed.lateCoverRatio;
  delete parsed.lateMaxRestPerGroup;
  delete parsed.requiredWorkDays;
  delete parsed.week2Preference;
  delete parsed.lastWeekPreference;
  return { ...DEFAULT_SETTINGS, ...parsed };
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
