import "./testDir.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { execSql, getDb, getDbPath, queryAll, run, runMany, saveSettings } from "./db.ts";
import { cancelGeneration, getJob, startGeneration } from "./generationJobs.ts";
import { feasiblePack } from "./testdata/feasiblePack.ts";

test("后台生成成功、健康接口响应、并发拒绝、取消和旧结果不覆盖新编辑", async () => {
  await getDb();
  const pack = feasiblePack();
  runMany(() => {
    for (const table of ["people", "assignments", "leaves", "rest_wishes", "attendance_flags", "holidays"]) execSql(`DELETE FROM ${table}`);
    for (const p of pack.people) execSql("INSERT INTO people (id,name,group_name,active,can_night,target_days,sort_order) VALUES (?,?,?,1,?,?,?)", [p.id,p.name,p.groupName,p.canNight ? 1 : 0,p.targetDays,p.sortOrder]);
    for (const c of pack.cells.filter((c) => c.kind === "holiday")) execSql("INSERT INTO holidays VALUES (?, '测试', 'holiday')", [c.date]);
    // 28 日是周末，合成用例需要标为调休上班。
    execSql("INSERT INTO holidays VALUES ('2026-02-28','测试','workday_makeup')");
  });
  saveSettings(pack.settings);
  process.env.ELECTRON_RUN = "1";
  const { app } = await import("./index.ts");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const base = `http://127.0.0.1:${addr.port}`;
  const input = { year: 2026, month: 2, keepLocked: true, seed: 17 };
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = getJob(id)!;
      if (job.status !== "running") return job;
      await delay(25);
    }
    cancelGeneration(id);
    throw new Error("测试任务超时");
  };
  try {
    const response = await fetch(`${base}/api/roster/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 202);
    const started = await response.json() as { id: string };
    assert.throws(() => startGeneration(input), /已有排班/);
    const start = performance.now();
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.ok(performance.now() - start < 1000, "健康接口不能等待生成结束");
    const result = await wait(started.id);
    assert.equal(result.status, "completed", result.error ?? "生成完成");
    assert.equal(result.result?.conflicts.filter((c) => c.severity === "hard").length, 0);
    assert.ok(result.progress);
    assert.equal(queryAll("SELECT * FROM assignments").length, 84);
    const before = readFileSync(getDbPath());
    const canceled = startGeneration(input);
    assert.ok(cancelGeneration(canceled.id));
    assert.equal(getJob(canceled.id)?.status, "failed");
    assert.deepEqual(readFileSync(getDbPath()), before);
    const stale = startGeneration(input);
    run("UPDATE people SET name = '已编辑' WHERE id = 1");
    const edited = readFileSync(getDbPath());
    const rejected = await wait(stale.id);
    assert.equal(rejected.status, "failed");
    assert.match(rejected.error!, /已修改/);
    assert.deepEqual(readFileSync(getDbPath()), edited);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
