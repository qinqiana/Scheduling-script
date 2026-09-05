import "./testDir.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { DEFAULT_SETTINGS } from "../shared/types.ts";
import { execSql, getDb, getDbPath, queryOne, restoreFrom, run, runMany } from "./db.ts";
import { importRosterFromExcel } from "./importRoster.ts";
import { validDate, validMonth, validateSettings } from "./validation.ts";

test("年月、真实日期与规则边界", () => {
  assert.ok(validDate("2024-02-29"));
  for (const date of ["2026-02-29", "2026-04-31", "2026-1-01", {}, null]) assert.ok(!validDate(date));
  for (const [year, month] of [[2026, 13], [0, 1], [2026, 1.5], [Infinity, 2]]) assert.ok(!validMonth(year, month));
  validateSettings(DEFAULT_SETTINGS);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, maxNightDiff: -1 }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, maxWorkPerWeek: 8 }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, sheetName: "非法/表名" }));
});

test("失败回滚、备份恢复、导入锁定与 HTTP 边界", async () => {
  await getDb();
  const person = queryOne<{ id: number; name: string }>("SELECT id, name FROM people LIMIT 1")!;
  const saved = readFileSync(getDbPath());
  assert.throws(() => runMany(() => {
    execSql("UPDATE people SET name = '不应保存' WHERE id = ?", [person.id]);
    execSql("INSERT INTO missing_table VALUES (1)");
  }));
  assert.equal(queryOne<{ name: string }>("SELECT name FROM people WHERE id = ?", [person.id])?.name, person.name);
  assert.deepEqual(readFileSync(getDbPath()), saved);

  // 用同名目录模拟临时文件无法写入，确认磁盘和内存都保留旧值。
  mkdirSync(`${getDbPath()}.tmp`);
  try {
    assert.throws(() => run("UPDATE people SET name = '写盘失败' WHERE id = ?", [person.id]));
    assert.equal(queryOne<{ name: string }>("SELECT name FROM people WHERE id = ?", [person.id])?.name, person.name);
    assert.deepEqual(readFileSync(getDbPath()), saved);
  } finally {
    rmdirSync(`${getDbPath()}.tmp`);
  }
  assert.throws(() => restoreFrom(Buffer.from("invalid sqlite")));
  assert.deepEqual(readFileSync(getDbPath()), saved);
  run("UPDATE people SET name = '临时修改' WHERE id = ?", [person.id]);
  restoreFrom(saved);
  assert.equal(queryOne<{ name: string }>("SELECT name FROM people WHERE id = ?", [person.id])?.name, person.name);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("导入");
  sheet.getCell("C2").value = 1;
  sheet.getCell("B3").value = person.name;
  sheet.getCell("C3").value = "加班";
  await importRosterFromExcel(Buffer.from(await workbook.xlsx.writeBuffer()), 2026, 9);
  assert.deepEqual(queryOne("SELECT shift, locked FROM assignments WHERE person_id = ? AND date = '2026-09-01'", [person.id]), { shift: "早", locked: 1 });

  process.env.ELECTRON_RUN = "1";
  const { app } = await import("./index.ts");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/roster?year=2026&month=13`)).status, 400);
    assert.equal((await fetch(`${base}/api/settings`, json("PUT", { maxWorkPerWeek: "abc" }))).status, 400);
    assert.equal((await fetch(`${base}/api/leaves`, json("POST", { personId: person.id, date: "2026-02-30" }))).status, 400);
    assert.equal((await fetch(`${base}/api/holidays`, json("POST", { date: "2026-09-02", name: "错误", kind: "invalid" }))).status, 400);
    assert.equal((await fetch(`${base}/api/people`, json("POST", { name: "  ", groupName: "组" }))).status, 400);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: base } })).status, 200);
    const badJson = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(badJson.status, 400);
    assert.ok(((await badJson.json()) as { error: string }).error);
    const form = new FormData();
    form.append("file", new Blob(["bad database"]), "data.db");
    assert.equal((await fetch(`${base}/api/restore`, { method: "POST", body: form })).status, 400);
    assert.equal((await fetch(`${base}/api/people`)).status, 200);
    const exported = await fetch(`${base}/api/export?year=2026&month=9`);
    assert.equal(exported.status, 200);
    assert.ok((await exported.arrayBuffer()).byteLength > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
