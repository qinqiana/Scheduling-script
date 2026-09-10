import { useEffect, useMemo, useRef, useState } from "react";
import { api, exportUrl } from "../api";
import type { GenerationJob, ImportResult, Person, RosterCell, RosterPayload, ShiftMark } from "../types";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

function cellClass(kind: string, gap: boolean): string {
  return ["day", kind === "weekend" || kind === "bridge" ? "weekend" : "", kind === "holiday" ? "holiday" : "", gap ? "gap" : ""]
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
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importTargetY, setImportTargetY] = useState(year);
  const [importTargetM, setImportTargetM] = useState(month);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const loadSequence = useRef(0);
  const writeSeq = useRef(0);
  const [job, setJob] = useState<GenerationJob | null>(null);

  useEffect(() => {
    let active = true;
    void api.activeGeneration().then((next) => { if (active && next) setJob(next); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.generationJob(job.id);
        if (!active) return;
        setJob(next);
        if (next.status === "completed" && next.result) {
          if (next.year === year && next.month === month) setData(next.result);
          setBusy("");
        } else if (next.status === "failed") {
          setError(next.error ?? "生成失败"); setBusy("");
        } else timer = setTimeout(poll, 500);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : "查询生成进度失败");
        timer = setTimeout(poll, 1500);
      }
    };
    setBusy("正在后台生成，现有班表仍可查看…");
    timer = setTimeout(poll, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.id, job?.status, year, month]);

  const load = async () => {
    const sequence = ++loadSequence.current;
    setError("");
    try {
      const next = await api.roster(year, month);
      if (sequence === loadSequence.current) setData(next);
    } catch (e) {
      if (sequence === loadSequence.current) setError(e instanceof Error ? e.message : "加载失败");
    }
  };

  useEffect(() => {
    setData(null);
    setEdit(null);
    void load();
    return () => { loadSequence.current += 1; };
  }, [year, month, tick]);

  useEffect(() => setPersonId(0), [year, month]);

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

  const showConflict = (conflict: (typeof hard)[number]) => {
    if (conflict.personId) {
      setPersonId(conflict.personId);
      const person = people.find((p) => p.id === conflict.personId);
      const cell = conflict.date && map.get(`${conflict.personId}|${conflict.date}`);
      if (person && conflict.date && cell) setEdit({ person, date: conflict.date, cell });
    }
  };

  const clearMonthRoster = async (all: boolean) => {
    const ok = all
      ? confirm(
          `确定全部清空 ${year} 年 ${month} 月？将清除排班、想休、加班、补休和请假。人员和规则会保留。`,
        )
      : confirm(`确定清空 ${year} 年 ${month} 月的未锁定排班？已锁定格子和想休会保留。请假、加班、补休、人员和规则会保留。`);
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

  const run = async () => {
    setBusy(`正在生成 ${year} 年 ${month} 月…`);
    setError("");
    try {
      setJob(await api.generate(year, month));
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
      setBusy("");
    }
  };

  const runEdit = async (
    label: string,
    action: () => Promise<RosterPayload | void>,
    keepOpen = false,
  ) => {
    const seq = ++writeSeq.current;
    setBusy(label);
    setError("");
    try {
      const next = (await action()) ?? (await api.roster(year, month));
      if (seq !== writeSeq.current) return;
      setData(next);
      if (keepOpen && edit) {
        const cell = next.roster.find((c) => c.personId === edit.person.id && c.date === edit.date);
        if (cell) setEdit({ ...edit, cell });
        else setEdit(null);
      } else {
        setEdit(null);
      }
    } catch (e) {
      if (seq !== writeSeq.current) return;
      setError(e instanceof Error ? e.message : label);
    } finally {
      if (seq === writeSeq.current) setBusy("");
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
            点「生成 {month} 月」只排当前月份。{year} 年 {month} 月法定工作日 {data ? `${legalDays} 天` : "自动识别"}；请假和想休会保留，手工加班或补休会调整当月目标出勤。
          </p>
          <details className="rule-details">
            <summary>查看排班规则</summary>
            <p>法定节假日全员休息，通告连休日按周末值班，调休上班日按工作日排班。满周默认 5 上 2 休；连续工作至少 3 天才休息，最多连续 6 天。除月末三天外早晚尽量按 2:1；每人早晚最多切一次，夹心休最多一天。硬约束不满足时会换种子重排。</p>
          </details>
        </div>
        <div className="actions">
          <label className="field">
            年
            <input type="number" disabled={!!busy} min={1000} max={9999} value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </label>
          <label className="field">
            月
            <select disabled={!!busy} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
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
          <button className="btn primary" disabled={!!busy} onClick={() => void run()}>
            生成 {month} 月
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
          <button className="btn" disabled={!!busy} onClick={() => setImportOpen(true)}>
            导入 Excel
          </button>
          <a className="btn ghost" href="/api/backup">
            备份 data.db
          </a>
        </div>
      </div>

      {busy && <div className="toast ok">{busy}</div>}
      {job?.status === "running" && <div className="card generation-status" role="status" aria-live="polite">
        {job.progress ? `已尝试 ${job.progress.attempt}/${job.progress.maxAttempts} 次，当前最少 ${job.progress.bestHard} 条硬冲突，用时 ${Math.round(job.progress.elapsedMs / 1000)} 秒` : "正在准备排班…"}
        <progress max={job.progress?.maxAttempts ?? 24} value={job.progress?.attempt ?? 0} aria-label="排班尝试进度" />
        <button className="btn" onClick={() => void api.cancelGeneration(job.id).catch((e) => setError(e instanceof Error ? e.message : "取消失败"))}>取消生成</button>
      </div>}
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
                    {c.kind === "bridge" ? <div className="day-tag">连休</div> : null}
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
          {hard.length} 条硬约束未满足。{data?.diagnostics?.conclusion ?? "可逐条查看并修改相关格子。"}
          <ul className="conflict-list">
            {hard.slice(0, 8).map((c) => (
              <li key={c.message} className="hard">
                <span>{data?.diagnostics?.items.find((item) => item.message === c.message)?.category ? `［${data.diagnostics.items.find((item) => item.message === c.message)?.category}］ ` : ""}{c.message}</span>
                {c.personId && <button className="btn ghost mini" onClick={() => showConflict(c)}>查看</button>}
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
                  disabled={!!busy}
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
                    <button key={s} className="btn" disabled={!!busy} onClick={() => void saveCell(s, edit.cell.locked)}>
                      {s}
                    </button>
                  ))}
                </div>
                <div className="shift-picks">
                  <button
                    className="btn"
                    disabled={!!busy}
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
              <button className="btn" disabled={!!busy} onClick={() => void addLeave()}>
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

      {importOpen && (
        <div className="drawer-back" onClick={() => setImportOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <h2>导入 Excel 排班</h2>
            <div className="shift-picks" style={{ marginBottom: 8 }}>
              <a className="btn" href="/api/roster/import-template">
                下载考勤表模板
              </a>
            </div>
            <p className="hint">
              选择一份「系统同款考勤表模板」导出的 xlsx（第 2 行是日期 1~31，第 3 行起每行一个人），
              导入时会用表里的格子覆盖 {importTargetY} 年 {importTargetM} 月对应排班。
              识别：早 / 晚 / 休 / 8（按早班）、早加 / 晚加 / 加班 / 节加（加班按早班，早加/晚加保留原班次）、补休、假 / 病假 / 事假 / 年休 / 出差 / 婚假 / 陪产假 / 护理假（记为请假）。
            </p>
            <div className="form" style={{ marginTop: 12 }}>
              <label>
                年份
                <input
                  type="number"
                  value={importTargetY}
                  onChange={(e) => setImportTargetY(Number(e.target.value))}
                />
              </label>
              <label>
                月份
                <select value={importTargetM} onChange={(e) => setImportTargetM(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1} 月
                    </option>
                  ))}
                </select>
              </label>
              <label>
                考勤表文件
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => {
                    setImportFile(e.target.files?.[0] ?? null);
                    setImportResult(null);
                  }}
                />
              </label>
            </div>

            {importResult && (
              <div className="card" style={{ marginTop: 12 }}>
                <p>
                  已导入 {importResult.imported} 格：班次 {importResult.shifts}、请假{" "}
                  {importResult.leaves}、加班 {importResult.overtimes}、补休 {importResult.compRests}。
                </p>
                {importResult.skippedUnknown.length > 0 && (
                  <p className="hint">未能识别（已跳过）：{importResult.skippedUnknown.join("、")}</p>
                )}
                {importResult.unmatchedNames.length > 0 && (
                  <p className="hint">
                    表里有人名不在当前人员名单（已跳过）：{importResult.unmatchedNames.join("、")}
                  </p>
                )}
              </div>
            )}

            <div className="shift-picks" style={{ marginTop: 16 }}>
              <button
                className="btn primary"
                disabled={!importFile || !!busy}
                onClick={async () => {
                  if (!importFile) return;
                  setBusy(`正在导入 ${importTargetY} 年 ${importTargetM} 月…`);
                  setError("");
                  setImportResult(null);
                  try {
                    const res = await api.importExcel(importFile, importTargetY, importTargetM);
                    setImportResult(res);
                    if (importTargetY === year && importTargetM === month) setData(res.rosterCells);
                    onChange();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "导入失败");
                  } finally {
                    setBusy("");
                  }
                }}
              >
                确认导入
              </button>
              <button className="btn" disabled={!!busy} onClick={() => setImportOpen(false)}>
                关闭
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
