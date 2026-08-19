import { useEffect, useMemo, useState } from "react";
import { api, exportUrl } from "../api";
import type { Person, RosterCell, RosterPayload, ShiftMark } from "../types";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function cellClass(kind: string, gap: boolean): string {
  return ["day", kind === "weekend" ? "weekend" : "", kind === "holiday" ? "holiday" : "", gap ? "gap" : ""]
    .filter(Boolean)
    .join(" ");
}

function markChip(mark: ShiftMark): string {
  if (mark === "早") return "chip morning";
  if (mark === "晚") return "chip night";
  if (mark === "假") return "chip leave";
  return "chip rest";
}

export function CalendarPage({
  year,
  month,
  setYear,
  setMonth,
  tick,
  onChange,
}: {
  year: number;
  month: number;
  setYear: (n: number) => void;
  setMonth: (n: number) => void;
  tick: number;
  onChange: () => void;
}) {
  const [data, setData] = useState<RosterPayload | null>(null);
  const [personId, setPersonId] = useState<number | 0>(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<{ person: Person; date: string; cell: RosterCell } | null>(null);
  const [leaveReason, setLeaveReason] = useState("");

  const load = async () => {
    setError("");
    try {
      setData(await api.roster(year, month));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  };

  useEffect(() => {
    void load();
  }, [year, month, tick]);

  const map = useMemo(() => {
    const m = new Map<string, RosterCell>();
    for (const c of data?.roster ?? []) m.set(`${c.personId}|${c.date}`, c);
    return m;
  }, [data]);

  const people = data?.people ?? [];
  const visible = personId ? people.filter((p) => p.id === personId) : people;
  const hard = data?.conflicts.filter((c) => c.severity === "hard") ?? [];
  const soft = data?.conflicts.filter((c) => c.severity === "soft") ?? [];
  const gapDates = new Set((data?.stats.days ?? []).filter((d) => d.gap).map((d) => d.date));

  const clearMonthRoster = async () => {
    if (!confirm(`确定清空 ${year} 年 ${month} 月的全部排班和想休？请假、人员和规则会保留。`)) return;
    setBusy("正在清空本月…");
    setError("");
    try {
      setData(await api.clear(year, month));
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "清空失败");
    } finally {
      setBusy("");
    }
  };

  const run = async (keepLocked: boolean) => {
    setBusy(keepLocked ? "正在重排未锁定格子…" : "正在生成本月…");
    setError("");
    try {
      setData(await api.generate(year, month, keepLocked));
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy("");
    }
  };

  const saveCell = async (shift: "早" | "晚" | "休", locked: boolean) => {
    if (!edit) return;
    setBusy("保存中…");
    try {
      setData(await api.setCell({ personId: edit.person.id, date: edit.date, shift, locked }));
      setEdit(null);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy("");
    }
  };

  const addLeave = async () => {
    if (!edit) return;
    setBusy("登记请假…");
    try {
      await api.addLeave({ personId: edit.person.id, date: edit.date, reason: leaveReason });
      await load();
      setEdit(null);
      setLeaveReason("");
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请假失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>月历班表</h1>
          <p className="hint">点格子改早/晚/休，可锁定后再重排其余。请假是硬约束，「想休」生成时优先排休。</p>
        </div>
        <div className="actions">
          <label className="field">
            年
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <label className="field">
            月
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} 月
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            我的班表
            <select value={personId} onChange={(e) => setPersonId(Number(e.target.value))}>
              <option value={0}>全员</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" disabled={!!busy} onClick={() => void run(false)}>
            生成本月
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void run(true)}>
            重排未锁定
          </button>
          <button className="btn danger" disabled={!!busy} onClick={() => void clearMonthRoster()}>
            清空本月
          </button>
          <a className="btn" href={exportUrl(year, month)}>
            导出 Excel
          </a>
          <a className="btn ghost" href="/api/backup">
            备份 data.db
          </a>
        </div>
      </div>

      {busy && <div className="banner ok">{busy}</div>}
      {error && <div className="banner">{error}</div>}
      {hard.length > 0 && (
        <div className="banner">
          {hard.length} 条硬约束未满足
          <ul className="conflict-list">
            {hard.slice(0, 8).map((c) => (
              <li key={c.message} className="hard">
                {c.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="legend">
          <span className="chip morning">早</span>
          <span className="chip night">晚</span>
          <span className="chip rest">休</span>
          <span>未生成时留空</span>
          <span className="chip leave">假</span>
          <span className="wish-mark">想休</span>
          <span className="chip gap">缺口</span>
          {soft.length > 0 && <span>软约束 {soft.length} 条，见统计页</span>}
        </div>
        <div className="table-wrap">
          <table className="roster">
            <thead>
              <tr>
                <th className="sticky">姓名</th>
                <th className="sticky" style={{ left: 72 }}>
                  组别
                </th>
                {data?.cells.map((c) => (
                  <th key={c.date} title={c.holidayName}>
                    {c.day}
                    <div>{WEEK[c.weekday]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id}>
                  <td className="sticky">{p.name}</td>
                  <td className="sticky" style={{ left: 72 }}>
                    {p.groupName}
                  </td>
                  {data?.cells.map((c) => {
                    const cell = map.get(`${p.id}|${c.date}`);
                    const mark = cell?.mark ?? "";
                    return (
                      <td
                        key={c.date}
                        className={cellClass(c.kind, gapDates.has(c.date))}
                        onClick={() => cell && setEdit({ person: p, date: c.date, cell })}
                      >
                        {mark ? <span className={markChip(mark)}>{mark}</span> : null}
                        {cell?.wantRest && <div className="wish-mark">想</div>}
                        {cell?.locked && <div className="lock">锁</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {edit && (
        <div className="drawer-back" onClick={() => setEdit(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <h2>
              {edit.person.name} · {edit.date}
            </h2>
            <p className="hint">
              {edit.person.groupName}
              {edit.cell.leaveReason ? ` · 请假：${edit.cell.leaveReason}` : ""}
              {edit.cell.wantRest ? " · 已标想休" : ""}
            </p>
            {edit.cell.mark === "假" ? (
              <>
                <p>该日已请假，生成时不会排班。</p>
                <button
                  className="btn"
                  onClick={async () => {
                    setBusy("撤销请假…");
                    try {
                      await api.deleteLeaveCell(edit.person.id, edit.date);
                      await load();
                      setEdit(null);
                      onChange();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "撤销失败");
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  撤销请假
                </button>
              </>
            ) : (
              <>
                <div className="shift-picks">
                  {(["早", "晚", "休"] as const).map((s) => (
                    <button key={s} className="btn" onClick={() => void saveCell(s, edit.cell.locked)}>
                      {s}
                    </button>
                  ))}
                </div>
                <button
                  className="btn"
                  onClick={() =>
                    void saveCell(
                      edit.cell.mark === "早" || edit.cell.mark === "晚" || edit.cell.mark === "休"
                        ? edit.cell.mark
                        : "休",
                      !edit.cell.locked,
                    )
                  }
                >
                  {edit.cell.locked ? "解锁此格" : "锁定此格"}
                </button>
              </>
            )}
            <div className="form" style={{ marginTop: 16 }}>
              <label>
                请假原因
                <input value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="调休 / 年假 / 病假" />
              </label>
              <button className="btn" onClick={() => void addLeave()}>
                登记请假
              </button>
              <button
                className={edit.cell.wantRest ? "btn primary" : "btn"}
                disabled={!!busy}
                onClick={async () => {
                  setBusy(edit.cell.wantRest ? "取消想休…" : "标记想休…");
                  try {
                    setData(
                      await api.setWish({
                        personId: edit.person.id,
                        date: edit.date,
                        want: !edit.cell.wantRest,
                      }),
                    );
                    setEdit(null);
                    onChange();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "想休失败");
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {edit.cell.wantRest ? "取消想休" : "想休"}
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
