/** 生成自己排出的夹心休上限（锁定/月末/贴假的不计）。 */
export const MAX_COUNTED_SANDWICH = 1;

/** seq：W 上班 / R 休 / H 法定假 / L 请假。prev 是月初前一天。 */
export function isSandwichAt(seq: string, idx: number, prev?: string): boolean {
  if (idx < 0 || idx >= seq.length || seq[idx] !== "R") return false;
  const left = idx > 0 ? seq[idx - 1] : (prev ?? "E");
  const right = idx < seq.length - 1 ? seq[idx + 1] : "E";
  const pair = (s: string) => s === "R" || s === "H";
  if (pair(left) || pair(right)) return false;
  const workOrEdge = (s: string) => s === "W" || s === "E";
  return workOrEdge(left) && workOrEdge(right);
}

export function sandwichCount(seq: string, prev?: string, skip?: (i: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < seq.length; i += 1) {
    if (skip?.(i)) continue;
    if (isSandwichAt(seq, i, prev)) n += 1;
  }
  return n;
}

function check(got: boolean, want: boolean, msg: string) {
  if (got !== want) throw new Error(`${msg}: got ${got}`);
}

check(isSandwichAt("WRW", 1), true, "WRW");
check(isSandwichAt("RRW", 0, "W"), false, "pair right");
check(isSandwichAt("WRH", 1), false, "holiday right");
check(isSandwichAt("HRW", 1), false, "holiday left");
check(isSandwichAt("RW", 0, "W"), true, "start after work");
check(isSandwichAt("RW", 0, "R"), false, "start after rest");
check(isSandwichAt("WR", 1), true, "end after work");
check(isSandwichAt("WRWWR", 1) && isSandwichAt("WRWWR", 4), true, "two sandwiches");
if (sandwichCount("WRWWR") !== 2) throw new Error("count 2");
if (sandwichCount("WRWWR", undefined, (i) => i === 4) !== 1) throw new Error("skip");
