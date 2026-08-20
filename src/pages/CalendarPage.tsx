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
  const generated = data?.generated === true;
  const hard = generated ? (data?.conflicts.filter((c) => c.severity === "hard") ?? []) : [];
  const soft = generated ? (data?.conflicts.filter((c) => c.severity === "soft") ?? []) : [];
  const gapDates = new Set(
    generated ? (data?.stats.days ?? []).filter((d) => d.gap).map((d) => d.date) : [],
  );
  const legalDays = (data?.cells ?? []).filter((c) => c.kind === "workday" || c.kind === "makeup").length;

  const clearMonthRoster = async (all: boolean) => {
    const ok = all
      ? confirm(
          `确定全部清空 ${year} 年 ${month} 月？将清除排班、想休、加班、补休和请假。人员和规则会保留。`,
        )
      : confirm(`确定清空 ${year} 年 ${month} 月的全部排班和想休？请假、加班、补休、人员和规则会保留。`);
    if (!ok) return;
    setBusy(all ? `正在全部清空 ${month} 月…` : `正在清空 ${month} 月…`);
    setError("");
    try {
      setData(await api.clear(year, month, all));
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "清空失败");
    } finally {
      setBusy("");
    }
  };

  const run = async (keepLocked: boolean) => {
    setBusy(keepLocked ? `正在重排 ${month} 月未锁定格子…` : `正在生成 ${year} 年 ${month} 月…`);
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

  const runEdit = async (
    label: string,
    action: () => Promise<RosterPayload | void>,
    keepOpen = false,
  ) => {
    setBusy(label);
    setError("");
    try {
      const next = (await action()) ?? (await api.roster(year, month));
      setData(next);
      if (keepOpen && edit) {
        const cell = next.roster.find((c) => c.personId === edit.person.id && c.date === edit.date);
        if (cell) setEdit({ ...edit, cell });
        else setEdit(null);
      } else {
        setEdit(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : label);
    } finally {
      setBusy("");
    }
  };

  const saveCell = async (shift: "早" | "晚" | "休", locked: boolean) => {
    if (!edit) return;
    await runEdit("保存中…", () =>
      api.setCell({ personId: edit.person.id, date: edit.date, shift, locked }),
    );
  };

  const addLeave = async () => {
    if (!edit) return;
    await runEdit("登记请假…", async () => {
      await api.addLeave({ personId: edit.person.id, date: edit.date, reason: leaveReason });
      setLeaveReason("");
    });
  };

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>月历班表</h1>
          <p className="hint">
            点「生成 {month} 月」只排顶部所选月份。{year} 年 {month} 月法定工作日{" "}
            {data ? `${legalDays} 天` : "按该自然月自动识别"}
            （普通工作日，不含周末和全年 13 天法定节假日）。这 13 天不用上班，其余周末按周末正常排班。满周默认 5 上 2 休，和其他硬约束冲突时可以多排并标「加」。请假是硬约束，「想休」生成时优先排休。「加班」把当月应出勤 +1，「补休」把当月应出勤 −1，其它规则不变。
          </p>
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
            生成 {month} 月
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void run(true)}>
            重排未锁定
          </button>
          <button className="btn danger" disabled={!!busy} onClick={() => void clearMonthRoster(false)}>
            清空 {month} 月
          </button>
          <button className="btn danger" disabled={!!busy} onClick={() => void clearMonthRoster(true)}>
            全部清空
          </button>
          <a className="btn" href={exportUrl(year, month)}>
            导出 Excel
          </a>
          <a className="btn ghost" href="/api/backup">
            备份 data.db
          </a>
        </div>
      </div>

      {busy && <div className="toast ok">{busy}</div>}
      {error && <div className="toast err">{error}</div>}

      <div className="card">
        <div className="legend">
          <span className="chip morning">早</span>
          <span className="chip night">晚</span>
          <span className="chip rest">休</span>
          <span>未生成时留空</span>
          <span className="chip leave">假</span>
          <span className="wish-mark">想休</span>
          <span className="ot-mark">加班</span>
          <span className="comp-mark">补休</span>
          <span className="chip gap">缺口</span>
          <span>软约束 {soft.length} 条，见统计页</span>
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
                  <th
                    key={c.date}
                    className={c.kind === "workday" ? "" : c.kind}
                    title={c.holidayName ?? (c.kind === "makeup" ? "调休上班" : "")}
                  >
                    {c.day}
                    <div>{WEEK[c.weekday]}</div>
                    {c.kind === "makeup" ? <div className="day-tag">班</div> : null}
                    {c.kind === "holiday" ? <div className="day-tag">假</div> : null}
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
                        className={`${cellClass(c.kind, gapDates.has(c.date))}${c.kind === "makeup" ? " makeup" : ""}`}
                        onClick={() => cell && setEdit({ person: p, date: c.date, cell })}
                      >
                        {mark ? (
                          <span className={cell?.compRest ? "chip rest" : markChip(mark)}>
                            {cell?.compRest ? "补" : mark}
                          </span>
                        ) : null}
                        {(cell?.overtime || cell?.wantRest || cell?.locked) && (
                          <div className="cell-meta">
                            {cell?.overtime && <span className="ot-mark">加</span>}
                            {cell?.wantRest && <span className="wish-mark">想</span>}
                            {cell?.locked && <span className="lock">锁</span>}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {hard.length > 0 && (
        <div className="banner after-table">
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
              {edit.cell.manualOvertime ? " · 加班（应出勤+1）" : ""}
              {edit.cell.compRest ? " · 补休（应出勤−1）" : ""}
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
                <div className="shift-picks">
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
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() =>
                      void runEdit("清空此格…", () =>
                        api.clearCell({ personId: edit.person.id, date: edit.date }),
                      )
                    }
                  >
                    清空此格
                  </button>
                </div>
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
              <div className="shift-picks">
                {(
                  [
                    {
                      on: !!edit.cell.wantRest,
                      label: "想休",
                      run: () =>
                        api.setWish({
                          personId: edit.person.id,
                          date: edit.date,
                          want: !edit.cell.wantRest,
                        }),
                    },
                    {
                      on: !!edit.cell.manualOvertime,
                      label: "加班",
                      run: () =>
                        api.setFlag({
                          personId: edit.person.id,
                          date: edit.date,
                          kind: edit.cell.manualOvertime ? null : "overtime",
                        }),
                    },
                    {
                      on: !!edit.cell.compRest,
                      label: "补休",
                      run: () =>
                        api.setFlag({
                          personId: edit.person.id,
                          date: edit.date,
                          kind: edit.cell.compRest ? null : "comp_rest",
                        }),
                    },
                  ] as const
                ).map((btn) => (
                  <button
                    key={btn.label}
                    className={btn.on ? "btn primary" : "btn"}
                    disabled={!!busy}
                    onClick={() =>
                      void runEdit(btn.on ? `取消${btn.label}…` : `标记${btn.label}…`, btn.run, true)
                    }
                  >
                    {btn.on ? `取消${btn.label}` : btn.label}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
