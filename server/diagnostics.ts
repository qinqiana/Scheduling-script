import type { Conflict } from "../shared/types.ts";
import type { MonthPack } from "./repository/month.ts";

/** 只报告可直接证明的必要条件冲突；没有命中不代表已证明有解。 */
export function inputBlockers(pack: MonthPack): Conflict[] {
  const issues: Conflict[] = [];
  const key = (id: number, date: string) => `${id}|${date}`;
  const leaves = new Set(pack.leaves.map((x) => key(x.personId, x.date)));
  const wishes = new Set(pack.wishes.map((x) => key(x.personId, x.date)));
  const flags = new Map(pack.flags.map((x) => [key(x.personId, x.date), x.kind]));
  const locks = new Map(pack.assignments.filter((x) => x.locked).map((x) => [key(x.personId, x.date), x.shift]));
  for (const p of pack.people) {
    let minimum = 0;
    let maximum = 0;
    let adjustment = 0;
    let legalLeave = 0;
    for (const c of pack.cells) {
      const k = key(p.id, c.date);
      const flag = flags.get(k);
      const lock = locks.get(k);
      const leave = leaves.has(k);
      if (leave && (c.kind === "workday" || c.kind === "makeup")) legalLeave++;
      if (!leave) adjustment += flag === "overtime" ? 1 : flag === "comp_rest" ? -1 : 0;
      if ((leave && (flag || wishes.has(k) || lock)) ||
          (wishes.has(k) && (flag === "overtime" || lock === "早" || lock === "晚")) ||
          (flag === "comp_rest" && (lock === "早" || lock === "晚"))) {
        issues.push({ severity: "hard", personId: p.id, date: c.date, message: `${p.name} ${c.day} 日存在互相矛盾的请假、想休、锁定或加班补休标记` });
      }
      const fixedWork = !leave && (flag === "overtime" || lock === "早" || lock === "晚");
      if (fixedWork) minimum++;
      if (fixedWork || (!leave && !wishes.has(k) && flag !== "comp_rest" && lock !== "休" && c.kind !== "holiday")) maximum++;
    }
    const legal = pack.cells.filter((c) => c.kind === "workday" || c.kind === "makeup").length;
    const target = Math.max(0, (p.targetDays ?? legal - legalLeave) + adjustment);
    if (target < minimum || target > maximum) issues.push({ severity: "hard", personId: p.id,
      message: `${p.name} 目标 ${target} 天，但现有锁定和请假只允许 ${minimum}～${maximum} 天出勤` });
  }
  return issues;
}

export function conflictCategory(message: string): string {
  if (/夹心休/.test(message)) return "夹心休";
  if (/出勤.*天/.test(message)) return "出勤天数";
  if (/极差/.test(message)) return "晚班公平";
  if (/穿插/.test(message)) return "班次切换";
  if (/早班接在晚班/.test(message)) return "晚接早";
  if (/连续|上班间隔|该周/.test(message)) return "连班与休息";
  if (/需要 ≥|无人值班/.test(message)) return "覆盖";
  return "其他";
}

export function diagnose(pack: MonthPack, conflicts: Conflict[]) {
  const blockers = inputBlockers(pack);
  return {
    blockers,
    conclusion: blockers.length ? "已发现输入矛盾；其余冲突仍需逐项处理" : "未发现直接输入矛盾；剩余冲突属于求解未满足，不能据此认定无解",
    items: conflicts.filter((c) => c.severity === "hard").map((c) => ({ ...c, category: conflictCategory(c.message) })),
  };
}
