import { generateRoster } from "../server/engine.ts";
import { GOLDEN_SEED, goldenPack } from "../server/testdata/goldenPack.ts";
const month = Number(process.argv[2] ?? 8);
const started = performance.now();
const result = generateRoster({ year: 2026, month, keepLocked: true, seed: GOLDEN_SEED }, goldenPack(2026, month));
console.log(JSON.stringify({ month, elapsedMs: Math.round(performance.now() - started), hard: result.conflicts.filter((c) => c.severity === "hard").length }));
