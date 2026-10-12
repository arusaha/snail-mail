import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { groupMail } from "../src/mail-groups.ts";
import { createStore } from "../server/store.mjs";

const artwork = "a".repeat(64) + ".jpg";
const entry = (id, date, patch = {}) => ({
  id,
  date,
  image: artwork,
  imageKind: "representative",
  category: "spam",
  priority: "normal",
  archived: false,
  sender: "Weekly offers",
  notes: "",
  ...patch,
});

test("identical promotional artwork has one thumbnail and preserves each dated entry", () => {
  const items = [
    entry("a", "2026-10-05", { notes: "Keep this coupon" }),
    entry("b", "2026-10-06"),
    entry("c", "2026-10-07"),
    entry("d", "2026-10-08"),
  ];
  const original = structuredClone(items);
  const cards = groupMail(items);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "d");
  assert.deepEqual(
    cards[0].occurrences.map((x) => x.id),
    ["d", "c", "b", "a"],
  );
  assert.equal(cards[0].occurrences.at(-1).notes, "Keep this coupon");
  assert.deepEqual(items, original);
  assert.equal(groupMail(items.slice(0, 2))[0].groupId, cards[0].groupId);
});

test("scans, missing images, different artwork and differently corrected tabs stay separate", () => {
  const cards = groupMail([
    entry("a", "2026-10-05"),
    entry("b", "2026-10-06", { image: "b".repeat(64) + ".jpg" }),
    entry("c", "2026-10-06", { imageKind: "scan" }),
    entry("d", "2026-10-07", { imageKind: "scan" }),
    entry("e", "2026-10-07", { image: null }),
    entry("f", "2026-10-08", { image: null }),
    entry("g", "2026-10-08", { category: "inbox", priority: "important" }),
    entry("h", "2026-10-05", { archived: true }),
  ]);
  assert.equal(cards.length, 8);
});

test("a newer ordinary promotion cannot hide an earlier important entry", () => {
  const cards = groupMail([
    entry("new", "2026-10-08", { category: "inbox" }),
    entry("old", "2026-10-05", { category: "inbox", priority: "urgent" }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "old");
  assert.equal(cards[0].priority, "urgent");
  assert.equal(cards[0].occurrences[0].id, "new");
});

test("grouping preserves occupancy, source reconciliation, pickup cutoffs, Undo and corrections", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "snail-groups-"));
  let now = new Date("2026-10-11T20:00:00Z");
  const store = createStore(dir, () => now);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ingest = (sourceId, date) =>
    store.importDigest({
      sourceId,
      date,
      advertisedCount: 1,
      subject: "USPS daily digest",
      packages: [],
      items: [
        {
          key: "1",
          sender: "Weekly offers",
          category: "spam",
          priority: "normal",
          summary: "Coupons",
          evidence: "Advertising artwork",
          confidence: "high",
          image: artwork,
          imageKind: "representative",
          units: 2,
        },
      ],
    });
  ingest("aaaaaaaaaaaa", "2026-10-05");
  ingest("bbbbbbbbbbbb", "2026-10-06");
  let state = store.state();
  assert.equal(groupMail(state.items).length, 1);
  assert.equal(state.counts.spam, 2);
  assert.equal(state.capacity.units, 4);
  assert.ok(
    state.digests.every(
      (d) => state.items.filter((i) => i.sourceId === d.id).length === d.count,
    ),
  );
  const pickup = store.pickup(randomUUID(), state.revision);
  assert.equal(store.state().counts.spam, 0);
  now = new Date("2026-10-12T20:00:00Z");
  ingest("cccccccccccc", "2026-10-12");
  ingest("dddddddddddd", "2026-10-07"); // Late digest stays in Archive.
  state = store.state();
  let cards = groupMail(state.items);
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.archived).occurrences.length, 3);
  assert.equal(cards.find((c) => !c.archived).occurrences.length, 1);
  assert.equal(state.capacity.units, 2);
  store.undo(pickup.id);
  assert.equal(groupMail(store.state().items).length, 1);
  store.correct("aaaaaaaaaaaa:1", { notes: "Keep coupon" });
  assert.equal(
    groupMail(store.state().items)[0].occurrences.find(
      (i) => i.id === "aaaaaaaaaaaa:1",
    ).notes,
    "Keep coupon",
  );
  store.correct("aaaaaaaaaaaa:1", { priority: "important" });
  state = store.state();
  cards = groupMail(state.items);
  assert.equal(cards.length, 2);
  assert.equal(cards.find((c) => c.category === "inbox").id, "aaaaaaaaaaaa:1");
  assert.equal(cards.find((c) => c.category === "spam").occurrences.length, 3);
  assert.equal(state.capacity.units, 8);
});
