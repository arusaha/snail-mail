import { readFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { trackingUpdateSchema } from "../server/store.mjs";
import { readConfig } from "../server/config.mjs";
import { call } from "./ingest.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const data = resolve(process.env.SNAIL_DATA_DIR || join(root, "data"));
async function main() {
  if (!process.argv[2])
    throw new Error(
      "Usage: node scripts/update-tracking.mjs data/tracking/CHECK.json",
    );
  const input = resolve(process.argv[2]);
  const within = relative(join(data, "tracking"), input);
  if (!within || within.startsWith("..") || isAbsolute(within))
    throw new Error("Save tracking evidence inside data/tracking");
  const updates = trackingUpdateSchema
    .array()
    .min(1)
    .max(100)
    .parse(JSON.parse(readFileSync(input, "utf8")));
  const { port } = readConfig(data);
  for (const update of updates) {
    await call("tracking", update);
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    if (!response.ok) throw new Error("Tracking readback failed");
    const state = await response.json();
    const saved = state.packages.find(
      (p) => p.tracking === update.tracking,
    )?.trackingUpdate;
    if (JSON.stringify(saved) !== JSON.stringify(update))
      throw new Error("Persisted tracking evidence did not reconcile");
    console.log({
      ending: update.tracking.slice(-4),
      status: saved.status,
      verified: true,
    });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
