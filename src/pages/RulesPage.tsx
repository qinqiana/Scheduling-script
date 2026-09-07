import { useEffect, useState } from "react";
import { api } from "../api";
import type { Holiday, Leave, Person, Settings } from "../types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function legalWorkDaysOfMonth(year: number, month: number, holidays: Holiday[]): number {
  const map = new Map(holidays.map((h) => [h.date, h]));
  const n = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= n; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    const weekday = new Date(year, month - 1, day).getDay();
    const h = map.get(date);
    let kind: "workday" | "weekend" | "holiday" | "bridge" | "makeup" = weekday === 0 || weekday === 6 ? "weekend" : "workday";
    if (h?.kind === "holiday") kind = "holiday";
    if (h?.kind === "bridge") kind = "bridge";
    if (h?.kind === "workday_makeup") kind = "makeup";
    if (kind === "workday" || kind === "makeup") count += 1;
  }
  return count;
}

export function RulesPage({
  year,
  month,
  setMonth,
  onChange,
}: {
  year: number;
  month: number;
  setMonth: (n: number) => void;
  onChange: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [h, setH] = useState({ date: "", name: "", kind: "holiday" as Holiday["kind"] });
  const [leave, setLeave] = useState({ personId: 0, date: "", reason: "" });
  const [msg, setMsg] = useState("");

  const load = async () => {
    const [s, hs, ps, ls] = await Promise.all([
      api.settings(),
      api.holidays(year),
      api.people(),
      api.leaves(year, month),
    ]);
    setSettings(s);
    setHolidays(hs);
    setPeople(ps);
    setLeaves(ls);
    if (!leave.personId && ps[0]) setLeave((x) => ({ ...x, personId: ps[0].id }));
  };

  useEffect(() => {
    void load();
  }, [year, month]);

  const save = async () => {
    if (!settings) return;
    await api.saveSettings(settings);
    setMsg("规则已保存，下次生成生效");
    onChange();
  };

  if (!settings) return <p>加载规则…</p>;

  return (
    <section>
      <div className="topbar">
        <div>
          <h1>规则与节假日</h1>
          <p className="hint">班次为早 / 晚 / 休，请假写假。覆盖优先，公平用权重。</p>
        </div>
        <button className="btn primary" onClick={() => void save()}>
          保存规则
        </button>
      </div>
      {msg && <div className="banner ok">{msg}</div>}

      <div className="rule-stack">
        <div className="card form">
          <strong>约束参数</strong>
          <p className="hint">
            无请假、无手工加班/补休时，每人每月出勤必须等于所选自然月的法定工作日，休息天数也必须相同。有请假则减去请假占用的法定工作日。
            法定工作日只按中国政府网刊登的国办发明电计算：当月日历天数减去周六日，再减去通告写明的放假日，加上通告写明「上班」的调休日。不采用无出处工时表。
            {year} 年 {month} 月为 {legalWorkDaysOfMonth(year, month, holidays)} 天。
          </p>
          <label>
            每组每天最少出勤
            <input
              type="number"
              value={settings.minPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            每组每天最少早班
            <input
              type="number"
              value={settings.minMorningPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minMorningPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            每组每天最少晚班
            <input
              type="number"
              value={settings.minNightPerGroupPerDay}
              onChange={(e) => setSettings({ ...settings, minNightPerGroupPerDay: Number(e.target.value) })}
            />
          </label>
          <label>
            满周默认上班天数（软约束启用时）
            <input
              type="number"
              disabled={!settings.preferWeeklyWorkTarget}
              value={settings.maxWorkPerWeek}
              onChange={(e) => setSettings({ ...settings, maxWorkPerWeek: Number(e.target.value) })}
            />
          </label>
          <label>
            最长连续上班
            <input
              type="number"
              value={settings.maxConsecutiveWork}
              onChange={(e) => setSettings({ ...settings, maxConsecutiveWork: Number(e.target.value) })}
            />
          </label>
          <label>
            每个人每月晚班与同组相差上限（硬，天）
            <input
              type="number"
              value={settings.maxNightDiff}
              onChange={(e) => setSettings({ ...settings, maxNightDiff: Number(e.target.value) })}
            />
          </label>
          <label>
            导出表名
            <input value={settings.sheetName} onChange={(e) => setSettings({ ...settings, sheetName: e.target.value })} />
          </label>
        </div>

        <div>
          <div className="card">
            <strong>已对齐的业务规则</strong>
            <p className="hint">硬约束固定执行；软约束可为所有月份统一启用或停用。保存不会自动重新排班。</p>
            <h2 className="rule-heading">硬约束 <span className="chip rest">固定</span></h2>
            <ul className="conflict-list rule-list">
              <li>班次写「早」「晚」「休」，请假写「假」。</li>
              <li>每组每天至少 {settings.minMorningPerGroupPerDay} 个早班、{settings.minNightPerGroupPerDay} 个晚班、{settings.minPerGroupPerDay} 人出勤。</li>
              <li>月末最后三天（法定假日除外，本月不满一周也算）每组最多休 1 人，且至少 2 个晚班在岗。</li>
              <li>法定节假日全员休息、不排班。通告里为连休多放的日子按周末值班，不算法定工作日。周末调来上班的日子算法定工作日，要正常排班。</li>
              <li>无请假、无手工加班/补休时，每人出勤必须等于当月法定工作日，休息天数也必须相同。月初月末不够一周的周末仍要有人值班，但值班计入出勤，不能因此每人多排一天。有请假则减去请假占用的法定工作日；格子上标了加班或补休的人按调整后的目标算出勤和休息。</li>
              <li>满自然周不能少于 4 天；节假日、连休或请假把应出勤压得更低时跟日期走。</li>
              <li>晚班后不接早班，可休或再排晚班。法定假上的加班早班不查这条。</li>
              <li>连续工作 3 天才可以休息；连上 1 天或 2 天就休不算。法定节假日夹在中间的不算。</li>
              <li>连续上班含加班不能超过 {settings.maxConsecutiveWork} 天；连满后至少再连休 2 天。</li>
              <li>夹心休（上班–休–上班）最多 2 天。想休锁死、月末覆盖逼出来、贴着法定假的不计。</li>
              <li>除月末三天外，同一个人的早班和晚班最多切一次（一段早 + 一段晚，顺序不限）。法定假加班不计入切换。并夹心休可以拆段；不改锁定格就压不下去的穿插不罚。2:1 让给这条。</li>
              <li>同组可排晚班人员每月晚班数量相差不能超过 {settings.maxNightDiff} 天。</li>
              <li>格子上手工标「加班」当月应出勤 +1，标「补休」当月应出勤 −1，其它硬约束不变。请假和锁定格子生成时不改。</li>
            </ul>
            <h2 className="rule-heading">软约束 <span className="hint">可选</span></h2>
            <div className="rule-options">
              <label className="rule-choice">
                <input type="checkbox" checked={settings.preferPairedRest} onChange={(e) => setSettings({ ...settings, preferPairedRest: e.target.checked })} />
                <span><strong>两天休息尽量相连</strong><small>跨周也算，例如周日接周一。</small></span>
              </label>
              <label className="rule-choice">
                <input type="checkbox" checked={settings.preferBalancedShifts} onChange={(e) => setSettings({ ...settings, preferBalancedShifts: e.target.checked })} />
                <span><strong>每日早晚班尽量接近 2:1</strong><small>月末三天仍按硬约束多排晚班。</small></span>
              </label>
              <label className="rule-choice">
                <input type="checkbox" checked={settings.preferWeeklyWorkTarget} onChange={(e) => setSettings({ ...settings, preferWeeklyWorkTarget: e.target.checked })} />
                <span><strong>满自然周默认上班 {settings.maxWorkPerWeek} 天</strong><small>与硬约束冲突时可为 4 上或 6 上。</small></span>
              </label>
              <label className="rule-choice">
                <input type="checkbox" checked={settings.preferSingleSandwichRest} onChange={(e) => setSettings({ ...settings, preferSingleSandwichRest: e.target.checked })} />
                <span><strong>夹心休尽量不超过 1 天</strong><small>硬上限仍为 2 天。</small></span>
              </label>
            </div>
          </div>
          <div className="card form" style={{ marginTop: 12 }}>
            <strong>{year} 年国务院放假调休日历</strong>
            <p className="hint">
              出处仅中国政府网：
              <a href="https://www.gov.cn/zhengce/content/202310/content_6911527.htm" target="_blank" rel="noreferrer">
                2024 国办发明电〔2023〕7号
              </a>
              、
              <a href="https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm" target="_blank" rel="noreferrer">
                2025 国办发明电〔2024〕12号
              </a>
              、
              <a href="https://www.gov.cn/zhengce/content/202511/content_7047090.htm" target="_blank" rel="noreferrer">
                2026 国办发明电〔2025〕7号
              </a>
              。法定节假日记「法定假」，通告连休日记「连休」（按周末值班），通告写明上班的周日记「调休上班」。
            </p>
            <table className="roster" style={{ margin: "8px 0 12px", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>月</th>
                  {Array.from({ length: 12 }, (_, i) => (
                    <th key={i}>{i + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>法定工作日</td>
                  {Array.from({ length: 12 }, (_, i) => (
                    <td key={i}>{legalWorkDaysOfMonth(year, i + 1, holidays)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
            <div className="actions">
              <input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} />
              <input placeholder="名称" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
              <select value={h.kind} onChange={(e) => setH({ ...h, kind: e.target.value as Holiday["kind"] })}>
                <option value="holiday">法定假</option>
                <option value="bridge">连休</option>
                <option value="workday_makeup">调休上班</option>
              </select>
              <button
                className="btn"
                onClick={async () => {
                  await api.addHoliday(h);
                  await load();
                  onChange();
                }}
              >
                添加
              </button>
            </div>
            <table className="list">
              <tbody>
                {holidays.map((item) => (
                  <tr key={item.date}>
                    <td>{item.date}</td>
                    <td>{item.name}</td>
                    <td>{item.kind === "holiday" ? "法定假" : item.kind === "bridge" ? "连休" : "上班"}</td>
                    <td>
                      <button
                        className="btn danger"
                        onClick={async () => {
                          await api.deleteHoliday(item.date);
                          await load();
                          onChange();
                        }}
                      >
                        删
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="topbar">
          <strong>请假 / 调休</strong>
          <label className="field">
            月
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="actions" style={{ marginBottom: 10 }}>
          <select value={leave.personId} onChange={(e) => setLeave({ ...leave, personId: Number(e.target.value) })}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input type="date" value={leave.date} onChange={(e) => setLeave({ ...leave, date: e.target.value })} />
          <input placeholder="原因" value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} />
          <button
            className="btn"
            onClick={async () => {
              await api.addLeave(leave);
              await load();
              onChange();
            }}
          >
            登记
          </button>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>日期</th>
              <th>姓名</th>
              <th>原因</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leaves.map((item) => (
              <tr key={item.id}>
                <td>{item.date}</td>
                <td>{people.find((p) => p.id === item.personId)?.name ?? item.personId}</td>
                <td>{item.reason}</td>
                <td>
                  <button
                    className="btn danger"
                    onClick={async () => {
                      await api.deleteLeave(item.id);
                      await load();
                      onChange();
                    }}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
