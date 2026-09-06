import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { goldenPack } from "./testdata/goldenPack.ts";
import { diagnose, inputBlockers } from "./diagnostics.ts";
import type { Conflict } from "../shared/types.ts";

test("逐条归类四个月份的全部 49 条硬冲突，不把未知可行性称为无解", () => {
  let total = 0;
  for (const month of [2, 5, 8, 10]) {
    const snapshot = JSON.parse(readFileSync(new URL(`./testdata/golden/2026-${String(month).padStart(2, "0")}.json`, import.meta.url), "utf8")) as { conflicts: Conflict[] };
    const report = diagnose(goldenPack(2026, month), snapshot.conflicts);
    assert.equal(report.blockers.length, 0);
    assert.ok(report.items.every((item) => item.category !== "其他"));
    total += report.items.length;
  }
  assert.equal(total, 49);
});

test("识别锁定超过出勤目标，以及想休与加班矛盾", () => {
  const pack = goldenPack(2026, 5);
  pack.people[1].targetDays = 0;
  pack.assignments.push({ id: 99, personId: 2, date: "2026-05-02", shift: "早", locked: true });
  pack.wishes.push({ personId: 2, date: "2026-05-01" });
  const issues = inputBlockers(pack);
  assert.ok(issues.some((x) => x.message.includes("目标")));
  assert.ok(issues.some((x) => x.message.includes("矛盾")));
});
