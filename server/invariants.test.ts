import assert from "node:assert/strict";
import { test } from "node:test";
import { generateRoster } from "./engine.ts";
import { checkInvariants } from "./invariants.ts";
import { feasiblePack } from "./testdata/feasiblePack.ts";

test("已知可行输入多种子生成：零硬冲突且通过独立规则检查", () => {
  for (const seed of [1, 17, 20260831]) {
    const pack = feasiblePack();
    pack.assignments.push({ id: 1, personId: 1, date: "2026-02-26", shift: "早", locked: true });
    const result = generateRoster({ year: 2026, month: 2, seed }, pack);
    assert.deepEqual(result.conflicts.filter((c) => c.severity === "hard"), []);
    assert.deepEqual(checkInvariants(pack, result.roster), []);
    const corrupt = structuredClone(result.roster);
    corrupt.find((c) => c.personId === 1 && c.date === "2026-02-03")!.mark = "晚";
    corrupt.find((c) => c.personId === 1 && c.date === "2026-02-26")!.mark = "休";
    const failures = checkInvariants(pack, corrupt);
    for (const rule of ["请假被覆盖", "锁定被覆盖", "不能晚班", "覆盖不足"]) assert.ok(failures.some((x) => x.includes(rule)), rule);
  }
});
