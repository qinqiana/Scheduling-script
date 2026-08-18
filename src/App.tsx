import { useEffect, useState } from "react";
import { CalendarPage } from "./pages/CalendarPage";
import { PeoplePage } from "./pages/PeoplePage";
import { RulesPage } from "./pages/RulesPage";
import { StatsPage } from "./pages/StatsPage";
import type { PageId } from "./types";

const now = new Date();

export function App() {
  const [page, setPage] = useState<PageId>("calendar");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    document.title = "入网审核排班";
  }, []);

  const refresh = () => setTick((n) => n + 1);

  return (
    <div className="app">
      <aside className="side">
        <p className="brand">入网审核排班</p>
        <p className="brand-sub">早 / 晚 · 按组覆盖</p>
        <nav className="nav">
          {(
            [
              ["calendar", "月历班表"],
              ["people", "人员"],
              ["rules", "规则与节假日"],
              ["stats", "统计"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>
              {label}
            </button>
          ))}
        </nav>
        <p className="side-note">
          格子写「早」「晚」「休」；请假写「假」。导出对齐现有考勤表。数据在本地 <code>data.db</code>。
        </p>
      </aside>
      <main className="main">
        {page === "calendar" && (
          <CalendarPage year={year} month={month} setYear={setYear} setMonth={setMonth} tick={tick} onChange={refresh} />
        )}
        {page === "people" && <PeoplePage onChange={refresh} />}
        {page === "rules" && <RulesPage year={year} onChange={refresh} />}
        {page === "stats" && <StatsPage year={year} month={month} setYear={setYear} setMonth={setMonth} tick={tick} />}
      </main>
    </div>
  );
}
