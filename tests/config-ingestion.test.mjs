import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { configSchema, readConfig } from "../server/config.mjs";
import { createStore } from "../server/store.mjs";

test("setup preserves existing configuration; calendar and start date belong to the installation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "snail-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const setup = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/setup.mjs",
        "--start-date",
        "2026-01-01",
        "--timezone",
        "Asia/Tokyo",
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, SNAIL_DATA_DIR: dir },
        encoding: "utf8",
        windowsHide: true,
      },
    );
  assert.equal(setup().status, 0);
  const original = readFileSync(join(dir, "config.json"), "utf8");
  assert.notEqual(setup().status, 0);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), original);
  assert.equal(readConfig(dir).timezone, "Asia/Tokyo");
  assert.throws(() =>
    configSchema.parse({ publicOrigin: "https://example.ts.net" }),
  );
  assert.throws(() => configSchema.parse({ startDate: "2026-02-30" }));
  assert.throws(() => configSchema.parse({ timezone: "not-a-timezone" }));
  const store = createStore(dir, () => new Date("2026-01-02T16:00:00Z"));
  try {
    const digest = {
      sourceId: "aaaaaaaaaaaa",
      date: "2026-01-03",
      advertisedCount: 1,
      subject: "Synthetic digest",
      items: [
        {
          key: "1",
          sender: "Unknown",
          category: "inbox",
          priority: "review",
          summary: "No preview",
          evidence: "No preview supplied",
          confidence: "low",
          image: null,
          imageKind: "unavailable",
        },
      ],
      packages: [],
    };
    assert.throws(() => store.importDigest({ ...digest, date: "2025-12-31" }));
    store.importDigest(digest);
    assert.equal(store.state().today, "2026-01-03");
    store.pickup(randomUUID(), store.state().revision);
    assert.equal(store.state().pickup.cutoff, "2026-01-03");
    assert.equal(store.state().counts.inbox, 0);
  } finally {
    store.close();
  }
});

test(
  "provider-neutral original attachments import through CLI with persisted images, safe replay and sync status",
  { timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "snail-assets-"));
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ port, startDate: "2020-01-01", timezone: "UTC" }),
    );
    const staging = join(dir, "staging", "abcdef123456");
    mkdirSync(join(staging, "originals"), { recursive: true });
    writeFileSync(
      join(staging, "source.json"),
      JSON.stringify({
        id: "abcdef123456",
        headers: [
          {
            name: "From",
            value: "USPSInformeddelivery@email.informeddelivery.usps.com",
          },
          // Synthetic authenticated fixture; production preserves actual Gmail headers.
          {
            name: "Authentication-Results",
            value:
              "dkim=pass header.i=@email.informeddelivery.usps.com; dmarc=pass header.from=usps.com",
          },
        ],
        text: "Today's Deliveries: 01/02/2020",
        html: '<span id="total-mailpieces">1</span><img id="mailpiece-image-src-id" src="cid:1-1.png">',
        attachments: [
          { filename: "1-1.png", mime: "image/png", cid: "<1-1.png>" },
        ],
      }),
    );
    const original = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    writeFileSync(join(staging, "originals", "1-1.png"), original);
    writeFileSync(
      join(staging, "classifications.json"),
      JSON.stringify({
        1: {
          sender: "Synthetic example",
          category: "inbox",
          priority: "review",
          summary: "Synthetic test image",
          evidence: "Blank image",
          confidence: "low",
          units: 1,
        },
      }),
    );
    const env = {
      ...process.env,
      SNAIL_DATA_DIR: dir,
      PORT: String(port),
      SNAIL_TRAY_MANAGED: "1",
    };
    const child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: resolve("."),
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const stopped = once(child, "exit");
        child.stdin.end();
        await stopped;
      }
      rmSync(dir, { recursive: true, force: true });
    });
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("Test server exited before ready");
      }),
    ]);
    const cli = (...args) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/ingest.mjs", ...args],
        { cwd: resolve("."), env, encoding: "utf8", windowsHide: true },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    cli("parse", staging);
    cli("assets", staging);
    assert.match(cli("commit", staging), /verified: true/);
    const base = `http://127.0.0.1:${port}`;
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.items.length, 1);
    const image = state.items[0].image;
  for (const kind of ["images", "thumbs"]) {
    const response = await fetch(base + "/media/" + kind + "/" + image);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/jpeg/);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(metadata.width, 40);
    assert.equal(metadata.height, 20);
  }
    await fetch(base + "/api/items/abcdef123456%3A1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "Manual correction" }),
    });
    assert.match(cli("commit", staging), /duplicate: true/);
    assert.equal(
      (await (await fetch(base + "/api/state")).json()).items[0].sender,
      "Manual correction",
    );
    cli("run", "ok", "Synthetic import verified");
  const savedSync = (await (await fetch(base + "/api/state")).json()).sync;
  assert.equal(savedSync.ok, 1);
  assert.equal(savedSync.detail, "Synthetic import verified");
  assert.equal(Number.isNaN(Date.parse(savedSync.checked)), false);
  },
);
