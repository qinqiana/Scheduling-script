import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function copyTree(from: string, to: string): void {
  if (process.platform === "win32") {
    const r = spawnSync("robocopy", [from, to, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"], {
      stdio: "inherit",
    });
    if ((r.status ?? 1) >= 8) throw new Error(`复制失败：${from}`);
    return;
  }
  cpSync(from, to, { recursive: true });
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release", "入网审核排班");
const app = join(out, "app");
const zip = join(root, "release", "入网审核排班.zip");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");

if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("缺少 dist，请先执行 npx vite build");
  process.exit(1);
}
if (!existsSync(tsxCli)) {
  console.error("缺少 node_modules，请先在能联网的电脑执行 npm install");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(app, "runtime"), { recursive: true });

for (const name of ["server", "shared", "dist", "node_modules"]) {
  console.log("复制", name);
  copyTree(join(root, name), join(app, name));
}
copyFileSync(join(root, "package.json"), join(app, "package.json"));
copyFileSync(process.execPath, join(app, "runtime", "node.exe"));

writeFileSync(
  join(out, "打开排班.bat"),
  `\uFEFF@echo off
setlocal
chcp 65001 >nul
title 入网审核排班
set "APP=%~dp0app"
if not exist "%APP%\\runtime\\node.exe" (
  echo 请先解压整个文件夹，再双击「打开排班」。
  pause
  exit /b 1
)
cd /d "%APP%"
set "ROSTER_ROOT=%APP%\\"

curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:8787/api/health | findstr /c:"200" >nul
if %errorlevel%==0 (
  start "" "http://127.0.0.1:8787/"
  exit /b 0
)

echo 正在打开排班，请稍候...
echo 用完后关闭本窗口即可。
start "roster-browser" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8787/"
"%APP%\\runtime\\node.exe" "%APP%\\node_modules\\tsx\\dist\\cli.mjs" "%APP%\\server\\index.ts"
echo.
echo 程序已结束。
pause
`,
  "utf8",
);

writeFileSync(
  join(out, "使用说明.txt"),
  `解压后，只双击「打开排班」。
不要点 app 文件夹里的任何文件。
用完关掉黑色窗口即可。
`,
  "utf8",
);

if (existsSync(zip)) rmSync(zip);
console.log("正在打包压缩包…");
const zipped = spawnSync("tar", ["-a", "-c", "-f", zip, "-C", join(root, "release"), "入网审核排班"], {
  stdio: "inherit",
});
if (zipped.status !== 0) {
  console.error("压缩失败，仍可直接拷贝文件夹：", out);
  process.exit(1);
}

console.log(`发给对方这一个文件即可：${zip}`);
