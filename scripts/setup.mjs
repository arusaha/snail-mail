import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema } from "../server/config.mjs";

const options = {};
const names = {
  "--start-date": "startDate",
  "--timezone": "timezone",
  "--public-origin": "publicOrigin",
  "--allowed-login": "allowedLogin",
  "--port": "port",
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const field = names[args[i]];
  if (!field || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(
      "Usage: npm run setup -- [--start-date YYYY-MM-DD] [--timezone IANA_ZONE] [--public-origin https://device.tailnet.ts.net --allowed-login you@example.com] [--port 4318]",
    );
  options[field] = field === "port" ? Number(args[++i]) : args[++i];
}
const timezone =
  options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const config = configSchema.parse({ startDate: today, timezone, ...options });
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = resolve(process.env.SNAIL_DATA_DIR || resolve(root, "data"));
mkdirSync(dir, { recursive: true });
const target = resolve(dir, "config.json");
if (existsSync(target))
  throw new Error(
    "Configuration already exists. Edit data/config.json intentionally; setup never overwrites it.",
  );
writeFileSync(target, JSON.stringify(config, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  `Created ${target}. Tracking from ${config.startDate} in ${config.timezone}.`,
);
