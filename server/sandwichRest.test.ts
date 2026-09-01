import assert from "node:assert/strict";
import { test } from "node:test";
import { HARD_SANDWICH_LIMIT, isSandwichAt, MAX_COUNTED_SANDWICH, sandwichCount } from "./sandwichRest.ts";

test("上班中间单独一天休是夹心休", () => {
  assert.equal(isSandwichAt("WRW", 1), true);
});

test("贴着休或法定假的休不是夹心休", () => {
  assert.equal(isSandwichAt("RRW", 0, "W"), false);
  assert.equal(isSandwichAt("WRH", 1), false);
  assert.equal(isSandwichAt("HRW", 1), false);
});

test("月初月末单挂一天休算夹心休", () => {
  assert.equal(isSandwichAt("RW", 0, "W"), true);
  assert.equal(isSandwichAt("RW", 0, "R"), false);
  assert.equal(isSandwichAt("WR", 1), true);
});

test("夹心休按天计数，可跳过指定日", () => {
  assert.equal(isSandwichAt("WRWWR", 1) && isSandwichAt("WRWWR", 4), true);
  assert.equal(sandwichCount("WRWWR"), 2);
  assert.equal(sandwichCount("WRWWR", undefined, (i) => i === 4), 1);
});

test("生成尽量 1 个，覆盖不够时硬约束最多 2 个", () => {
  assert.equal(MAX_COUNTED_SANDWICH, 1);
  assert.equal(HARD_SANDWICH_LIMIT, 2);
});
