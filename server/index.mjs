import express from "express";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, importSchema } from "./store.mjs";
import { notificationFeed } from "./notifications.mjs";
import { createInterface } from "node:readline";
import { readConfig } from "./config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const data = resolve(process.env.SNAIL_DATA_DIR || join(root, "data"));
mkdirSync(data, { recursive: true });
const config = readConfig(data);
const port = Number(process.env.PORT || config.port || 4318);
const keyPath = join(data, "ingestion.key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
const secret = readFileSync(keyPath, "utf8").trim();
const store = createStore(data);
const app = express();
app.disable("x-powered-by");
const publicOrigin = config.publicOrigin || "";
const origins = new Set(
  [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://localhost",
    publicOrigin,
  ].filter(Boolean),
);
const hosts = new Set(
  [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    publicOrigin ? new URL(publicOrigin).host : "",
  ].filter(Boolean),
);
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (!hosts.has(req.headers.host))
    return res.status(403).json({ error: "Unknown host" });
  const remote =
    req.headers.host === (publicOrigin ? new URL(publicOrigin).host : "") ||
    !!req.get("X-Forwarded-For") ||
    !!req.get("Tailscale-User-Login");
  if (
    remote &&
    (!config.allowedLogin ||
      req.get("Tailscale-User-Login") !== config.allowedLogin)
  )
    return res
      .status(403)
      .json({ error: "This mailbox is private to its Tailscale owner" });
  const origin = req.get("Origin");
  if (origin && !origins.has(origin))
    return res.status(403).json({ error: "Origin is not allowed" });
  if (origin) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (
    ["POST", "PATCH", "DELETE"].includes(req.method) &&
    !req.is("application/json")
  )
    return res.status(415).json({ error: "JSON required" });
  next();
});
app.use(express.json({ limit: "3mb" }));
app.get("/api/health", (_, res) => res.json({ ok: true, version: "1.0.0" }));
app.get("/api/state", (_, res) => res.json(store.state()));
app.get("/api/notifications", (_, res) =>
  res.json(notificationFeed(store.state())),
);
app.post("/api/pickup", (req, res) =>
  res.json(store.pickup(req.body.id, req.body.revision)),
);
app.post("/api/pickup/:id/undo", (req, res) =>
  res.json(store.undo(req.params.id)),
);
app.patch("/api/items/:id", (req, res) =>
  res.json(store.correct(req.params.id, req.body)),
);
app.patch("/api/settings", (req, res) => res.json(store.configure(req.body)));
app.use("/api/ingest", (req, res, next) => {
  const received = Buffer.from(
    req.get("Authorization")?.replace(/^Bearer /, "") || "",
  );
  const expected = Buffer.from(secret);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    return res.status(401).json({ error: "Ingestion credential required" });
  next();
});
app.post("/api/ingest/import", (req, res) => {
  const m = importSchema.parse(req.body);
  for (const item of m.items)
    for (const name of [item.image, ...item.supplemental].filter(Boolean)) {
      if (
        !existsSync(join(data, "images", name)) ||
        !existsSync(join(data, "thumbs", name))
      )
        throw new Error("Missing validated image asset");
    }
  res.json(store.importDigest(m));
});
app.post("/api/ingest/run", (req, res) => {
  if (typeof req.body.ok !== "boolean") throw new Error("ok must be a boolean");
  res.json(store.recordRun(req.body.ok, req.body.detail));
});
app.get("/media/:kind/:name", (req, res) => {
  if (
    !["images", "thumbs"].includes(req.params.kind) ||
    !/^[a-f0-9]{64}\.jpg$/.test(req.params.name)
  )
    return res.sendStatus(404);
  res.sendFile(join(data, req.params.kind, req.params.name));
});
app.get("/downloads/snail-mail.apk", (_, res) => {
  const p = join(root, "releases", "snail-mail.apk");
  if (!existsSync(p)) return res.sendStatus(404);
  res.download(p);
});
app.use(
  express.static(join(root, "dist"), { etag: false, lastModified: false }),
);
app.get("/{*path}", (req, res) => {
  if (req.path.startsWith("/api/"))
    return res.status(404).json({ error: "Not found" });
  res.sendFile(join(root, "dist", "index.html"));
});
app.use((err, req, res, next) => {
  console.error(
    `${new Date().toISOString()} ${req.method} ${req.path}: ${err.message}`,
  );
  res.status(err.status || 400).json({
    error:
      err.name === "ZodError"
        ? "Invalid request data; check the import schema."
        : err.message || "Request failed",
  });
});
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`Snail Mail listening at http://127.0.0.1:${port}`),
);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Bound shutdown if a client keeps a connection open.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 3000).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
if (process.env.SNAIL_TRAY_MANAGED === "1") {
  // Private parent/child pipe, never an HTTP endpoint. Closing the tray process
  // also closes stdin, so its server cannot remain orphaned after a crash.
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    if (line === "snail-mail:shutdown") shutdown();
  });
  input.on("close", shutdown);
}
