import { execSql, queryOne, runMany } from "./db.ts";

export interface CellState {
  shift?: "早" | "晚" | "休";
  locked: boolean;
  wish: boolean;
  flag?: "overtime" | "comp_rest";
  leave?: string;
}
export type CellAction =
  | { type: "shift"; shift: "早" | "晚" | "休"; locked: boolean }
  | { type: "wish"; want: boolean }
  | { type: "flag"; kind: "overtime" | "comp_rest" | null }
  | { type: "leave"; reason: string }
  | { type: "clear" };

export function transitionCell(current: CellState, action: CellAction): CellState {
  if (action.type === "leave") return { locked: true, wish: false, leave: action.reason };
  if (current.leave !== undefined) throw Object.assign(new Error("该日已请假，先撤销请假再改班"), { status: 400 });
  const next = { ...current };
  if (action.type === "clear") return { locked: false, wish: false };
  if (action.type === "wish") {
    if (action.want) return { shift: "休", locked: true, wish: true };
    if (next.wish) { next.wish = false; next.locked = !!next.flag; }
  } else if (action.type === "flag") {
    if (action.kind === "overtime") return { shift: next.shift === "晚" ? "晚" : "早", locked: true, wish: false, flag: "overtime" };
    if (action.kind === "comp_rest") return { shift: "休", locked: true, wish: false, flag: "comp_rest" };
    if (next.flag) { delete next.flag; next.locked = next.wish; }
  } else {
    next.shift = action.shift;
    next.locked = action.locked;
    if (action.shift !== "休" || !action.locked) next.wish = false;
    if ((action.shift === "休" && next.flag === "overtime") || (action.shift !== "休" && next.flag === "comp_rest")) delete next.flag;
    if (next.flag) {
      if (!action.locked) throw Object.assign(new Error("请先取消加班或补休标记，再解锁此格"), { status: 400 });
      next.locked = true;
    }
  }
  return next;
}

export function readCellState(personId: number, date: string): CellState {
  const params = [personId, date];
  const assignment = queryOne<{ shift: CellState["shift"]; locked: number }>("SELECT shift, locked FROM assignments WHERE person_id=? AND date=?", params);
  return {
    shift: assignment?.shift, locked: assignment?.locked === 1,
    wish: !!queryOne("SELECT 1 FROM rest_wishes WHERE person_id=? AND date=?", params),
    flag: queryOne<{ kind: CellState["flag"] }>("SELECT kind FROM attendance_flags WHERE person_id=? AND date=?", params)?.kind,
    leave: queryOne<{ reason: string }>("SELECT reason FROM leaves WHERE person_id=? AND date=?", params)?.reason,
  };
}

/** 调用者负责事务，供界面单格修改和 Excel 批量导入共用。 */
export function writeCellState(personId: number, date: string, state: CellState): void {
  const params = [personId, date];
  for (const table of ["assignments", "rest_wishes", "attendance_flags", "leaves"]) execSql(`DELETE FROM ${table} WHERE person_id=? AND date=?`, params);
  if (state.leave !== undefined) {
    execSql("INSERT INTO leaves(person_id,date,reason) VALUES (?,?,?)", [...params, state.leave]);
    return;
  }
  if (state.shift) execSql("INSERT INTO assignments(person_id,date,shift,locked) VALUES (?,?,?,?)", [...params, state.shift, state.locked ? 1 : 0]);
  if (state.wish) execSql("INSERT INTO rest_wishes(person_id,date) VALUES (?,?)", params);
  if (state.flag) execSql("INSERT INTO attendance_flags(person_id,date,kind) VALUES (?,?,?)", [...params, state.flag]);
}

export function editCell(personId: number, date: string, action: CellAction): void {
  runMany(() => writeCellState(personId, date, transitionCell(readCellState(personId, date), action)));
}
