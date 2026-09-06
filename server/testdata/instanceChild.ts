import { getDb } from "../db.ts";
import { InstanceInUse, setInstancePort } from "../instance.ts";
process.on("message", () => {});
try {
  await Promise.all([getDb(), getDb()]);
  setInstancePort(12345);
  process.send?.({ ready: true });
} catch (error) {
  process.send?.({ blocked: error instanceof InstanceInUse, port: error instanceof InstanceInUse ? error.existingPort : undefined });
  process.exitCode = 1;
  process.disconnect?.();
}
