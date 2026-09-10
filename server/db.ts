import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import initSqlJs, { type Database } from "sql.js";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.ts";
import { OFFICIAL_HOLIDAYS } from "./holidays.ts";
import { dataDir, dbPath, sqlWasmPath } from "./paths.ts";
import { SEED_PEOPLE } from "./seedPeople.ts";
import { claimInstance, releaseInstance } from "./instance.ts";

export function getDbPath(): string {
  return dbPath();
}

let db: Database | null = null;
let revision = 0;
export function getRevision(): number { return revision; }

let opening: Promise<Database> | undefined;
export async function getDb(): Promise<Database> {
  if (db) return db;
  if (!opening) opening = openDb().catch((error) => {
    db?.close(); db = null; opening = undefined; releaseInstance(); throw error;
  });
  return opening;
}

async function openDb(): Promise<Database> {
  await claimInstance();
  const wasm = sqlWasmPath();
  const SQL = await initSqlJs({
    locateFile: (file) => (file.endsWith(".wasm") ? wasm : file),
  });
  const path = dbPath();
  const load = (p: string): Database | null => {
    if (!existsSync(p)) return null;
    let candidate: Database;
    try { candidate = new SQL.Database(readFileSync(p)); } catch { return null; }
    try {
      const check = candidate.exec("PRAGMA integrity_check");
      if (check[0]?.values[0]?.[0] !== "ok") { candidate.close(); return null; }
      return candidate;
    } catch { candidate.close(); return null; }
  };
  db = load(path) ?? load(`${path}.bak`);
  if (db) {
    migrate(db);
    persist(); // 从 .bak 恢复后写回主库
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
  const temporary = `${dbPath()}.tmp`;
  writeFileSync(temporary, Buffer.from(db.export()));
  renameSync(temporary, dbPath());
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

/** 首次写入国务院办公厅放假调休日历（法定假日 + 连休 + 调休上班日）；已有行（含用户手工改动）保留不覆盖 */
function ensureOfficialHolidays(database: Database): void {
  const upsert = database.prepare(
    "INSERT INTO holidays (date, name, kind) VALUES (?, ?, ?) ON CONFLICT(date) DO NOTHING",
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
  try {
    stmt.bind(params as never[]);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(sql, params)[0];
}

export function execSql(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error("db not ready");
  const stmt = db.prepare(sql);
  try {
    stmt.run(params as never[]);
  } finally {
    stmt.free();
  }
}

export function run(sql: string, params: unknown[] = []): void {
  runMany(() => execSql(sql, params));
}

export function runMany(actions: () => void): void {
  if (!db) throw new Error("db not ready");
  db.exec("BEGIN TRANSACTION");
  try {
    actions();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    persist();
    revision++;
  } catch (error) {
    // 落盘失败时回到磁盘上的最后成功版本，避免失败操作被下次保存带入。
    const previous = readFileSync(dbPath());
    const DatabaseClass = db.constructor as new (data: Uint8Array) => Database;
    db.close();
    db = new DatabaseClass(previous);
    throw error;
  }
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
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    // 这三项是业务硬约束：不再向界面暴露开关，旧数据库中的值也不能关闭它们。
    weekendNeedWork: true,
    noMorningAfterNight: true,
    nightRestRequired: false,
  };
}

export function saveSettings(next: Settings): Settings {
  const fixed = {
    ...next,
    weekendNeedWork: true,
    noMorningAfterNight: true,
    nightRestRequired: false,
  };
  run(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(fixed)],
  );
  return getSettings();
}

export function backupTo(target: string): void {
  persist();
  copyFileSync(dbPath(), target);
}

export function restoreFrom(source: Buffer): void {
  if (!db) throw new Error("db not ready");
  const DatabaseClass = db.constructor as new (data: Uint8Array) => Database;
  const candidate = new DatabaseClass(source);
  const previous = db;
  try {
    const integrity = candidate.exec("PRAGMA integrity_check");
    if (integrity[0]?.values[0]?.[0] !== "ok") throw new Error("备份数据库已损坏");
    candidate.exec("SELECT id, name, group_name, active, target_days, can_night, sort_order FROM people LIMIT 0");
    candidate.exec("SELECT key, value FROM settings LIMIT 0");
    migrate(candidate);
    // 旧备份允许缺少新增表，但已有表的列必须与当前读取路径兼容。
    candidate.exec("SELECT person_id, date, shift, locked FROM assignments LIMIT 0");
    candidate.exec("SELECT id, person_id, date, reason FROM leaves LIMIT 0");
    candidate.exec("SELECT person_id, date FROM rest_wishes LIMIT 0");
    candidate.exec("SELECT person_id, date, kind FROM attendance_flags LIMIT 0");
    candidate.exec("SELECT year, month FROM generated_months LIMIT 0");
    backupTo(`${dbPath()}.bak`);
    db = candidate;
    persist();
  } catch (error) {
    db = previous;
    candidate.close();
    throw error;
  }
  previous.close();
  revision++;
}
