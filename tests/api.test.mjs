import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
test("HTTP integration: access boundaries, validated imports, pickup, undo and restart persistence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "snail-api-"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      port,
      publicOrigin: "https://example.tailtest.ts.net",
      allowedLogin: "owner@example.com",
    }),
  );
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: resolve("."),
      env: {
        ...process.env,
        SNAIL_DATA_DIR: dir,
        PORT: String(port),
        SNAIL_TRAY_MANAGED: "1",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`Server exited ${code}`);
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server startup timed out")),
          10000,
        );
        timer.unref();
      }),
    ]);
  };
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const hostStatus = (headers, path = "/api/state") =>
    new Promise((resolve, reject) => {
      const req = request(base + path, { headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
  assert.equal(await hostStatus({ Host: "evil.example" }), 403);
  assert.equal(
    await hostStatus({ Host: "example.tailtest.ts.net" }, "/api/notifications"),
    403,
  );
  assert.equal(
    await hostStatus(
      {
        Host: "example.tailtest.ts.net",
        "Tailscale-User-Login": "owner@example.com",
      },
      "/api/notifications",
    ),
    200,
  );
  assert.equal(await hostStatus({ Host: "example.tailtest.ts.net" }), 403);
  assert.equal(
    await hostStatus({
      Host: "example.tailtest.ts.net",
      "Tailscale-User-Login": "stranger@example.com",
    }),
    403,
  );
  assert.equal(
    await hostStatus({
      Host: "example.tailtest.ts.net",
      "Tailscale-User-Login": "owner@example.com",
    }),
    200,
  );
  assert.equal(
    await hostStatus({
      Host: `127.0.0.1:${port}`,
      "X-Forwarded-For": "100.1.2.3",
    }),
    403,
  );
  assert.equal(
    (await post("/api/pickup", {}, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await post("/api/ingest/import", {})).status, 401);
  assert.equal((await post("/api/ingest/tracking", {})).status, 401);
  const auth = {
    Authorization: `Bearer ${readFileSync(join(dir, "ingestion.key"), "utf8").trim()}`,
  };
  const m = {
    sourceId: "aaaaaaaaaaaa",
    date: "2026-10-05",
    advertisedCount: 1,
    subject: "Test",
    items: [
      {
        key: "1",
        sender: "Test sender",
        category: "inbox",
        priority: "review",
        summary: "Unknown contents",
        evidence: "Image unavailable",
        confidence: "low",
        image: null,
        imageKind: "unavailable",
      },
    ],
    packages: [
      {
        tracking: "0000000000000000000001",
        sender: "Test package",
        status: "expected",
        expectedDate: null,
        deliveredDate: null,
        details: "USPS is awaiting the item",
      },
    ],
  };
  assert.equal(
    (await post("/api/ingest/import", { ...m, advertisedCount: 2 }, auth))
      .status,
    400,
  );
  assert.equal((await post("/api/ingest/import", m, auth)).status, 200);
  assert.equal(
    (await (await post("/api/ingest/import", m, auth)).json()).duplicate,
    true,
  );
  const state = await (await fetch(base + "/api/state")).json();
  assert.equal(state.items.length, 1);
  const tracking = {
    tracking: "0000000000000000000001",
    status: "in_transit",
    sourceUrl: "https://tools.usps.com/tracking/0000000000000000000001",
    checkedAt: new Date().toISOString(),
    expectedDate: null,
    deliveredDate: null,
    details: "Arrived at USPS Facility",
    evidence: "The item is in transit.",
  };
  assert.equal(
    (await post("/api/ingest/tracking", tracking, auth)).status,
    200,
  );
  assert.deepEqual(
    (await (await fetch(base + "/api/state")).json()).packages[0]
      .trackingUpdate,
    tracking,
  );
  await fetch(base + "/api/items/aaaaaaaaaaaa%3A1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority: "important" }),
  });
  const notificationState = await (
    await fetch(base + "/api/notifications")
  ).json();
  assert.equal(notificationState.version, 1);
  assert.equal(
    notificationState.alerts.filter((x) => x.target === "mail").length,
    1,
  );
  const updatedState = await (await fetch(base + "/api/state")).json();
  const id = randomUUID();
  assert.equal(
    (
      await post(
        "/api/pickup",
        { id, revision: updatedState.revision },
        { Origin: "https://localhost" },
      )
    ).status,
    200,
  );
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).counts.inbox,
    0,
  );
  assert.equal(
    (await (await fetch(base + "/api/notifications")).json()).alerts.some(
      (x) => x.target === "mail",
    ),
    false,
  );
  assert.equal((await post(`/api/pickup/${id}/undo`, {})).status, 200);
  const stopped = once(child, "exit");
  child.stdin.write("snail-mail:shutdown\n");
  assert.equal((await stopped)[0], 0);
  await start();
  assert.deepEqual(
    (await (await fetch(base + "/api/state")).json()).packages[0]
      .trackingUpdate,
    tracking,
  );
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).counts.inbox,
    1,
  );
  const parentGone = once(child, "exit");
  child.stdin.end();
  assert.equal((await parentGone)[0], 0);
});
