/** 连续上班少于此天数就休息，算硬约束。节假日夹在中间不计入也不打断。 */
export const MIN_WORK_BEFORE_REST = 3;

/** seq：W 上班 / R 休 / H 法定假 / L 请假。prev 是月初前一天。 */
export function closedWorkRun(
  seq: string,
  idx: number,
  prev?: string,
): { length: number; closed: boolean } {
  if (idx < 0 || idx >= seq.length || seq[idx] !== "W") return { length: 0, closed: false };

  let length = 1;
  let j = idx - 1;
  while (j >= 0 && seq[j] === "H") j -= 1;
  while (j >= 0 && seq[j] === "W") {
    length += 1;
    j -= 1;
    while (j >= 0 && seq[j] === "H") j -= 1;
  }
  let leftRest = false;
  if (j >= 0) leftRest = seq[j] === "R";
  else if (prev === "W") length += 1;
  else leftRest = prev === "R";

  let k = idx + 1;
  while (k < seq.length && seq[k] === "H") k += 1;
  while (k < seq.length && seq[k] === "W") {
    length += 1;
    k += 1;
    while (k < seq.length && seq[k] === "H") k += 1;
  }
  const rightRest = k < seq.length && seq[k] === "R";
  return { length, closed: leftRest && rightRest };
}

export function isShortClosedWork(seq: string, idx: number, prev?: string): boolean {
  const run = closedWorkRun(seq, idx, prev);
  return run.length > 0 && run.length < MIN_WORK_BEFORE_REST && run.closed;
}
