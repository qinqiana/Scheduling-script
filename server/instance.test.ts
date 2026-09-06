import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("跨进程独占数据目录；第二实例不写库；崩溃后可再次启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-instance-"));
  const launch = (directory = dir) => fork(new URL("./testdata/instanceChild.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, ROSTER_DATA_DIR: directory }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const children: ReturnType<typeof launch>[] = [];
  try {
    const first = launch(); children.push(first);
    assert.deepEqual((await once(first, "message"))[0], { ready: true });
    const saved = readFileSync(join(dir, "data.db"));
    const second = launch(); children.push(second);
    assert.deepEqual((await once(second, "message"))[0], { blocked: true, port: 12345 });
    assert.deepEqual(readFileSync(join(dir, "data.db")), saved);
    const separate = launch(mkdtempSync(join(tmpdir(), "roster-separate-"))); children.push(separate);
    assert.deepEqual((await once(separate, "message"))[0], { ready: true });
    const exited = once(first, "exit"); first.kill(); await exited;
    const third = launch(); children.push(third);
    assert.deepEqual((await once(third, "message"))[0], { ready: true });
  } finally {
    await Promise.all(children.filter((child) => child.exitCode === null && !child.killed).map(async (child) => {
      const exited = once(child, "exit"); child.kill(); await exited;
    }));
  }
});
