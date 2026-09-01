/** 黄金快照。改引擎后若结果应变，设 UPDATE_GOLDEN=1 重写 testdata/golden。 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateRoster } from "./engine.ts";
import type { Conflict, RosterCell } from "../shared/types.ts";
import { GOLDEN_SEED, goldenPack } from "./testdata/goldenPack.ts";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "testdata", "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface Golden {
  seed: number;
  year: number;
  month: number;
  roster: Pick<
    RosterCell,
    "personId" | "date" | "mark" | "locked" | "wantRest" | "overtime" | "manualOvertime" | "compRest" | "leaveReason"
  >[];
  conflicts: Conflict[];
}

const MONTHS = [
  { year: 2026, month: 2, label: "春节月（法定假 + 连休 + 调休 + canNight=false）" },
  { year: 2026, month: 5, label: "劳动节月（假日加班 + 请假）" },
  { year: 2026, month: 8, label: "普通月（想休 + 请假）" },
  { year: 2026, month: 10, label: "国庆月（假日 + 请假 + 想休 + 加班）" },
] as const;

function capture(year: number, month: number): Golden {
  const result = generateRoster({ year, month, seed: GOLDEN_SEED }, goldenPack(year, month));
  return JSON.parse(
    JSON.stringify({
      seed: GOLDEN_SEED,
      year,
      month,
      roster: result.roster.map((c) => ({
        personId: c.personId,
        date: c.date,
        mark: c.mark,
        locked: c.locked,
        wantRest: c.wantRest,
        overtime: c.overtime,
        manualOvertime: c.manualOvertime,
        compRest: c.compRest,
        leaveReason: c.leaveReason,
      })),
      conflicts: result.conflicts,
    }),
  ) as Golden;
}

function snapshotPath(year: number, month: number): string {
  return join(GOLDEN_DIR, `${year}-${String(month).padStart(2, "0")}.json`);
}

for (const { year, month, label } of MONTHS) {
  test(`黄金快照 ${year}-${String(month).padStart(2, "0")} ${label}`, () => {
    const got = capture(year, month);
    const path = snapshotPath(year, month);
    if (UPDATE || !existsSync(path)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(path, `${JSON.stringify(got, null, 2)}\n`);
      if (!UPDATE) {
        throw new Error(`已写入黄金快照 ${path}。请提交该文件后重跑测试。`);
      }
      return;
    }
    const want = JSON.parse(readFileSync(path, "utf8")) as Golden;
    assert.deepEqual(got, want);
  });
}

test("同一 seed 两次生成结果一致", () => {
  const a = capture(2026, 2);
  const b = capture(2026, 2);
  assert.deepEqual(a, b);
});

test("黄金生成不打开数据库", () => {
  const pack = goldenPack(2026, 2);
  const result = generateRoster({ year: 2026, month: 2, seed: GOLDEN_SEED }, pack);
  assert.equal(result.people.length, 14);
  assert.equal(result.roster.length, pack.cells.length * 14);
});
