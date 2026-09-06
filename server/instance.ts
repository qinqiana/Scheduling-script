import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths.ts";

let lease: Server | undefined;
let port: number | undefined;
export class InstanceInUse extends Error {
  constructor(public readonly existingPort?: number) {
    super(existingPort ? `该数据目录已由另一实例打开：http://127.0.0.1:${existingPort}/` : "该数据目录已被另一实例占用或正在启动，请稍后重试");
  }
}
export function setInstancePort(value: number): void { port = value; }
export function releaseInstance(): void { lease?.close(); lease = undefined; port = undefined; }

export async function claimInstance(): Promise<void> {
  if (lease) return;
  mkdirSync(dataDir(), { recursive: true });
  const path = realpathSync(dataDir());
  const id = createHash("sha256").update(process.platform === "win32" ? path.toLowerCase() : path).digest("hex").slice(0, 32);
  // Windows 命名管道由操作系统持有，进程崩溃也会自动释放，无需删除锁文件。
  const address = process.platform === "win32" ? `\\\\.\\pipe\\roster-${id}` : join(tmpdir(), `roster-${id}.sock`);
  const server = createServer((socket) => socket.end(JSON.stringify({ port })));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => { server.removeListener("error", reject); resolve(); });
    });
    lease = server;
    server.unref();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const existing = await new Promise<number | undefined>((resolve) => {
      const socket = createConnection(address);
      let body = "";
      socket.setTimeout(2000, () => { socket.destroy(); resolve(undefined); });
      socket.on("data", (data) => { body += data; });
      socket.on("error", () => resolve(undefined));
      socket.on("end", () => {
        try { resolve((JSON.parse(body) as { port?: number }).port); } catch { resolve(undefined); }
      });
    });
    throw new InstanceInUse(existing);
  }
}
