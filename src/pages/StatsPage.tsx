import { useEffect, useState } from "react";
import { api } from "../api";
import type { RosterPayload } from "../types";

export function StatsPage({
  year,
  month,
  setYear,
  setMonth,
  tick,
}: {
  year: number;
  month: number;
  setYear: (n: number) => void;
  setMonth: (n: number) => void;
  tick: number;
}) {
  const [data, setData] = useState<RosterPayload | null>(null);

  useEffect(() => {
    void api.roster(year, month).then(setData);
  }, [year, month, tick]);

  const nights = data?.stats.people.map((p) => p.night) ?? [];
  const nightDiff = nights.length ? Math.max(...nights) - Math.min(...nights) : 0;
  const gaps = data?.stats.days.filter((d) => d.gap) ?? [];

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>统计</h1>
          <p className="hint">看出勤、早/晚、周末次数、连班和缺口。改格子后这里会重算冲突。</p>
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
        </div>
      </div>

      <div className="legend">
        <span>晚班极差 {nightDiff} 天</span>
        <span>缺口天数 {gaps.length}</span>
        <span>硬冲突 {data?.conflicts.filter((c) => c.severity === "hard").length ?? 0}</span>
      </div>

      <div className="card">
        <table className="list">
          <thead>
            <tr>
              <th>姓名</th>
              <th>组别</th>
              <th>出勤</th>
              <th>目标</th>
              <th>早班</th>
              <th>晚班</th>
              <th>周末</th>
              <th>节假日</th>
              <th>休息</th>
              <th>请假</th>
              <th>最长连班</th>
              <th>单周最多</th>
            </tr>
          </thead>
          <tbody>
            {data?.stats.people.map((p) => (
              <tr key={p.personId}>
                <td>{p.name}</td>
                <td>{p.groupName}</td>
                <td>{p.workDays}</td>
                <td>{p.targetDays}</td>
                <td>{p.morning}</td>
                <td>{p.night}</td>
                <td>{p.weekendWork}</td>
                <td>{p.holidayWork}</td>
                <td>{p.restDays}</td>
                <td>{p.leaveDays}</td>
                <td style={{ color: p.maxConsecutive > (data.settings.maxConsecutiveWork) ? "#b42318" : undefined }}>
                  {p.maxConsecutive}
                </td>
                <td style={{ color: p.maxWeekWork > data.settings.maxWorkPerWeek ? "#b42318" : undefined }}>
                  {p.maxWeekWork}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <strong>每日覆盖</strong>
          <table className="list">
            <thead>
              <tr>
                <th>日期</th>
                <th>出勤</th>
                <th>早</th>
                <th>晚</th>
                <th>缺口</th>
              </tr>
            </thead>
            <tbody>
              {data?.stats.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date.slice(8)}</td>
                  <td>{d.totalWork}</td>
                  <td>{d.totalMorning}</td>
                  <td>{d.totalNight}</td>
                  <td>{d.gap ? "是" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <strong>冲突清单</strong>
          <ul className="conflict-list">
            {(data?.conflicts.length ?? 0) === 0 && <li>当前没有冲突</li>}
            {data?.conflicts.map((c) => (
              <li key={c.message} className={c.severity}>
                {c.severity === "hard" ? "硬 · " : "软 · "}
                {c.message}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
