import assert from "node:assert/strict";
import { test } from "node:test";
import { isShortClosedWork } from "./workStreak.ts";

test("休息夹住的 1 天或 2 天连班算短班", () => {
  assert.equal(isShortClosedWork("RWR", 1), true);
  assert.equal(isShortClosedWork("RWWR", 1), true);
  assert.equal(isShortClosedWork("RWWR", 2), true);
});

test("连续上班满 3 天再休不算短班", () => {
  assert.equal(isShortClosedWork("RWWWR", 1), false);
});

test("跨月初用 prev 接上左右休息", () => {
  assert.equal(isShortClosedWork("WWR", 0, "R"), true);
  assert.equal(isShortClosedWork("WWWR", 0, "R"), false);
});

test("法定假夹在中间不打断连班，请假不能当闭合", () => {
  assert.equal(isShortClosedWork("RWHWR", 1), true);
  assert.equal(isShortClosedWork("RWHWWR", 1), false);
  assert.equal(isShortClosedWork("RWLW", 1), false);
});

test("月边界未闭合不算短班", () => {
  assert.equal(isShortClosedWork("WW", 0, "R"), false);
  assert.equal(isShortClosedWork("WR", 0, "W"), false);
});
