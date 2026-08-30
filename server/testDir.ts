import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `roster-test-${process.pid}`);
mkdirSync(dir, { recursive: true });
process.env.ROSTER_DATA_DIR = dir;
