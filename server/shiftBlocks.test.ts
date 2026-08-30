import assert from "node:assert/strict";
import { test } from "node:test";
import { bestBlockPlan, blockPlans, isAvoidableInterleave, shiftSwitches } from "./shiftBlocks.ts";

test("早晚只切一次不算穿插", () => {
  assert.equal(isAvoidableInterleave(["早", "晚"], [false, false]), false);
});

test("未锁格就能压到一次以内的来回切要罚", () => {
  assert.equal(isAvoidableInterleave(["早", "晚", "早"], [false, false, false]), true);
  assert.equal(isAvoidableInterleave(["早", "晚", "早"], [false, true, false]), true);
  assert.equal(isAvoidableInterleave(["早", "晚", "早"], [true, false, true]), true);
});

test("锁定造成的切不罚", () => {
  assert.equal(isAvoidableInterleave(["早", "晚", "早"], [true, true, true]), false);
  assert.equal(isAvoidableInterleave(["早", "晚", "早", "晚"], [true, true, true, false]), false);
});

test("未锁格可涂成最多切一次", () => {
  const plan = bestBlockPlan(["早", "晚", "早"], [false, false, false], true);
  assert.ok(plan);
  assert.ok(shiftSwitches(plan) <= 1);
});

test("全锁的来回切没有可改方案", () => {
  assert.equal(bestBlockPlan(["早", "晚", "早"], [true, true, true], true), null);
});

test("forbidMorningAt 排除指定格涂早", () => {
  const plans = blockPlans(["早", "晚"], [false, false], true, new Set([0]));
  assert.equal(plans.some((p) => p[0] === "早"), false);
});
