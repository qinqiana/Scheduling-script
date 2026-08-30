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
