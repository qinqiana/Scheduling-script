import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { GenerationProgress } from "../shared/types.ts";
import { getRevision } from "./db.ts";
import { diagnose, inputBlockers } from "./diagnostics.ts";
import type { GenerateInput, generateRoster } from "./engine.ts";
import { openMonthPack, persistGenerated } from "./repository/month.ts";

interface Job {
  id: string;
  year: number;
  month: number;
  status: "running" | "completed" | "failed";
  progress?: GenerationProgress;
  result?: ReturnType<typeof generateRoster> & { diagnostics: ReturnType<typeof diagnose> };
  error?: string;
}

// ponytail: 单工作线程避免多份月排班争抢 CPU；只保留最近 8 个任务供页面恢复查询。
const jobs = new Map<string, Job>();
let active: { job: Job; cancel: () => void } | undefined;
export function getJob(id: string): Job | undefined { return jobs.get(id); }
export function activeJob(): Job | undefined { return active?.job; }

export function startGeneration(input: GenerateInput): Job {
  if (active) throw Object.assign(new Error("已有排班正在生成，请等待完成"), { status: 409 });
  const pack = openMonthPack(input.year, input.month);
  const blockers = inputBlockers(pack);
  if (blockers.length) throw Object.assign(new Error(blockers.map((x) => x.message).join("；")), { status: 422 });
  const revision = getRevision();
  const job: Job = { id: randomUUID(), year: input.year, month: input.month, status: "running" };
  const worker = new Worker(new URL("./generateWorker.mjs", import.meta.url), { workerData: { input, pack } });
  jobs.set(job.id, job);
  while (jobs.size > 8) jobs.delete(jobs.keys().next().value!);
  const finish = (error?: string) => {
    clearTimeout(timeout);
    if (error) { job.status = "failed"; job.error = error; }
    if (active?.job.id === job.id) active = undefined;
    void worker.terminate();
  };
  const timeout = setTimeout(() => finish("生成超时，原班表已保留"), 5 * 60_000);
  active = { job, cancel: () => finish("已取消生成，原班表已保留") };
  worker.on("message", (message) => {
    if (job.status !== "running") return;
    if (message.type === "progress") { job.progress = message.progress; return; }
    if (message.type === "error") { finish(message.error); return; }
    if (message.type !== "result") return;
    try {
      if (revision !== getRevision()) throw new Error("生成期间人员、规则或班表已修改，本次结果未保存，请重新生成");
      const result = message.result as ReturnType<typeof generateRoster>;
      persistGenerated(input.year, input.month, result.roster);
      job.result = { ...result, diagnostics: diagnose(pack, result.conflicts) };
      job.status = "completed";
      finish();
    } catch (error) { finish(error instanceof Error ? error.message : "保存失败，原班表已保留"); }
  });
  worker.on("error", (error) => { if (job.status === "running") finish(error instanceof Error ? error.message : "生成失败"); });
  worker.on("exit", () => { if (job.status === "running") finish("生成进程意外退出，原班表已保留"); });
  return job;
}

export function cancelGeneration(id: string): boolean {
  if (active?.job.id !== id) return false;
  active.cancel();
  return true;
}
