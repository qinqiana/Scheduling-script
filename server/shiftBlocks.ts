/** 早↔晚切换次数。休/假不在序列里。 */
export function shiftSwitches(marks: readonly string[]): number {
  let n = 0;
  let prev: string | undefined;
  for (const m of marks) {
    if (prev && prev !== m) n += 1;
    prev = m;
  }
  return n;
}

/** 不改锁定格也能压到最多一次切换 → 当前多切算生成穿插，要罚。 */
export function isAvoidableInterleave(marks: readonly string[], locked: readonly boolean[]): boolean {
  if (shiftSwitches(marks) <= 1) return false;
  return shiftSwitches(marks.filter((_, i) => locked[i])) <= 1;
}

/** 未锁格可改成一段早+一段晚的方案，翻转少的在前。 */
export function blockPlans(
  marks: readonly string[],
  locked: readonly boolean[],
  canNight: boolean,
  forbidMorningAt = new Set<number>(),
): string[][] {
  const found: { plan: string[]; flips: number }[] = [];
  for (const first of ["早", "晚"] as const) {
    const second = first === "早" ? "晚" : "早";
    for (let cut = 0; cut <= marks.length; cut += 1) {
      const plan = marks.map((_, i) => (i < cut ? first : second));
      let flips = 0;
      let ok = true;
      for (let i = 0; i < marks.length; i += 1) {
        if (plan[i] === "早" && forbidMorningAt.has(i)) {
          ok = false;
          break;
        }
        if (plan[i] === marks[i]) continue;
        if (locked[i] || (plan[i] === "晚" && !canNight)) {
          ok = false;
          break;
        }
        flips += 1;
      }
      if (!ok) continue;
      found.push({ plan, flips });
    }
  }
  const nightsNow = marks.filter((m) => m === "晚").length;
  return found
    .sort((a, b) => {
      const an = a.plan.filter((m) => m === "晚").length;
      const bn = b.plan.filter((m) => m === "晚").length;
      const ad = Math.abs(an - nightsNow);
      const bd = Math.abs(bn - nightsNow);
      if (ad !== bd) return ad - bd;
      return a.flips - b.flips;
    })
    .map((x) => x.plan);
}

export function bestBlockPlan(
  marks: readonly string[],
  locked: readonly boolean[],
  canNight: boolean,
): string[] | null {
  return blockPlans(marks, locked, canNight)[0] ?? null;
}
