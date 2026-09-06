import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

try {
  const { generateRoster } = await tsImport("./engine.ts", import.meta.url);
  const result = generateRoster(workerData.input, workerData.pack, (progress) => {
    parentPort.postMessage({ type: "progress", progress });
  });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : "生成失败" });
}
