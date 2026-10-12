import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "../server/store.mjs";
import { parseSource, prepare } from "../scripts/ingest.mjs";
import { groupMail } from "../src/mail-groups.ts";
import { notificationFeed } from "../server/notifications.mjs";

const artwork = "a".repeat(64) + ".jpg";
const campaign = (patch = {}) => ({
  key: "1",
  sender: "Weekly coupons",
  category: "spam",
  priority: "normal",
  summary: "Coupons",
  evidence: "Promotional artwork",
  confidence: "high",
  image: artwork,
  imageKind: "representative",
  units: 2,
  campaignId: "1000000001",
  ...patch,
});
const digest = (sourceId, date, items = [campaign()]) => ({
  sourceId,
  date,
  advertisedCount: items.length,
  subject: "Daily Digest",
  items,
  packages: [],
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "snail-campaign-"));
  let now = new Date("2026-10-11T23:00:00Z");
  let store = createStore(dir, () => now);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get s() {
      return store;
    },
    time: (v) => (now = new Date(v)),
    reopen: () => {
      store.close();
      store = createStore(dir, () => now);
    },
  };
}
const source = (saturation = true, filename = "mailer-1000000001.jpg") => ({
  id: "aaaaaaaaaaaa",
  headers: [
    {
      name: "From",
      value: "USPSInformeddelivery@email.informeddelivery.usps.com",
    },
    {
      name: "Authentication-Results",
      value:
        "dkim=pass header.i=@email.informeddelivery.usps.com; dmarc=pass header.from=usps.com",
    },
  ],
  text: "Today's Deliveries: 10/09/2026",
  html: `<span id="total-mailpieces">1</span><div id="${saturation ? "sat-campaign" : "other-campaign"}"><img id="campaign-representative-image-src-id" src="cid:${filename}"></div>`,
  attachments: [{ filename, cid: `<${filename}>` }],
});

test("only a recognized saturation section supplies campaign identity; model cannot invent it", () => {
  const parsed = parseSource(source());
  assert.equal(parsed.pieces[0].campaignId, "1000000001");
  assert.equal(parseSource(source(false)).pieces[0].campaignId, null);
  assert.throws(
    () => parseSource(source(true, "mailer-unknown.jpg")),
    /Unrecognized saturation/,
  );
  const classification = campaign({ campaignId: "999" });
  const assets = { "mailer-1000000001.jpg": artwork };
  assert.equal(
    prepare(parsed, assets, { 1: classification }).items[0].campaignId,
    "1000000001",
  );
  assert.equal(
    prepare(parseSource(source(false)), assets, { 1: classification }).items[0]
      .campaignId,
    null,
  );
});

test("four saturation previews count once with full source history; matching non-saturation art stays separate", (t) => {
  const { s } = fixture(t);
  for (const [i, id] of [
    "aaaaaaaaaaaa",
    "bbbbbbbbbbbb",
    "cccccccccccc",
    "dddddddddddd",
  ].entries())
    s.importDigest(digest(id, `2026-10-0${i + 5}`));
  let state = s.state();
  assert.equal(state.items.length, 4);
  assert.equal(state.mailings.length, 1);
  assert.equal(state.counts.spam, 1);
  assert.equal(state.capacity.units, 2);
  assert.equal(state.capacity.expectedCampaigns, 1);
  assert.equal(state.capacity.ageDays, 7);
  assert.equal(groupMail(state.items)[0].occurrences.length, 4);
  assert.ok(
    state.digests.every(
      (d) => state.items.filter((i) => i.sourceId === d.id).length === d.count,
    ),
  );
  s.importDigest(
    digest("eeeeeeeeeeee", "2026-10-09", [campaign({ campaignId: null })]),
  );
  s.importDigest(
    digest("ffffffffffff", "2026-10-10", [campaign({ campaignId: null })]),
  );
  state = s.state();
  assert.equal(state.counts.spam, 3);
  assert.equal(state.capacity.units, 6);
  assert.equal(groupMail(state.items).length, 2); // Nonsaturation art still groups visually only.
});

test("pickup and Undo use first campaign appearance; later repeats stay archived and new IDs accumulate", (t) => {
  const { s, time } = fixture(t);
  s.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  const first = s.pickup(randomUUID(), s.state().revision);
  time("2026-10-12T20:00:00Z");
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-12"));
  s.importDigest(digest("cccccccccccc", "2026-10-06")); // Late source.
  assert.deepEqual(s.state().counts, { inbox: 0, spam: 0, archive: 1 });
  assert.equal(s.state().capacity.units, 0);
  s.importDigest(
    digest("dddddddddddd", "2026-10-12", [
      campaign({ campaignId: "1202159999" }),
    ]),
  );
  assert.deepEqual(s.state().counts, { inbox: 0, spam: 1, archive: 1 });
  assert.equal(groupMail(s.state().items).length, 2); // Same art, different campaigns.
  const second = s.pickup(randomUUID(), s.state().revision);
  s.undo(second.id);
  assert.deepEqual(s.state().counts, { inbox: 0, spam: 1, archive: 1 });
  s.undo(first.id);
  assert.deepEqual(s.state().counts, { inbox: 0, spam: 2, archive: 0 });
  assert.equal(s.state().capacity.units, 4);
});

test("campaign corrections and notification identity survive future repeats and restart; notes remain dated", (t) => {
  const f = fixture(t);
  f.s.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  f.s.correct("aaaaaaaaaaaa:1", {
    sender: "Keep coupons",
    priority: "important",
    notes: "First source note",
  });
  const before = notificationFeed(f.s.state()).alerts.filter(
    (a) => a.target === "mail",
  );
  assert.equal(before.length, 1);
  assert.equal(before[0].key, "mail:campaign:1000000001:important");
  f.s.importDigest(
    digest("bbbbbbbbbbbb", "2026-10-08", [
      campaign({ image: "b".repeat(64) + ".jpg" }),
    ]),
  );
  f.reopen();
  const state = f.s.state();
  assert.equal(state.counts.inbox, 1);
  assert.equal(state.counts.spam, 0);
  assert.ok(
    state.items.every(
      (i) => i.sender === "Keep coupons" && i.priority === "important",
    ),
  );
  assert.equal(
    state.items.find((i) => i.sourceId === "aaaaaaaaaaaa").notes,
    "First source note",
  );
  assert.equal(
    state.items.find((i) => i.sourceId === "bbbbbbbbbbbb").notes,
    undefined,
  );
  assert.equal(groupMail(state.items).length, 1); // Same campaign even if artwork changes.
  const after = notificationFeed(state).alerts.filter(
    (a) => a.target === "mail",
  );
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before[0].key);
  assert.ok(state.items.some((i) => i.id === after[0].itemId));
  f.s.correct("bbbbbbbbbbbb:1", { priority: "normal", category: "spam" });
  assert.equal(f.s.state().counts.spam, 1);
  assert.equal(
    notificationFeed(f.s.state()).alerts.filter((a) => a.target === "mail")
      .length,
    0,
  );
});

test("a dated note does not suppress stronger evidence in a future campaign preview", (t) => {
  const { s } = fixture(t);
  s.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  s.correct("aaaaaaaaaaaa:1", { notes: "Only a note" });
  s.importDigest(
    digest("bbbbbbbbbbbb", "2026-10-06", [
      campaign({ priority: "important", category: "inbox" }),
    ]),
  );
  assert.equal(s.state().mailings[0].priority, "important");
});

test("campaign annotation replays are atomic and idempotent, preserving manual data, classifications and pickups", (t) => {
  const f = fixture(t),
    s = f.s;
  const raw = digest("aaaaaaaaaaaa", "2026-10-05", [
    campaign({ campaignId: null }),
    campaign({ key: "2", campaignId: null }),
  ]);
  s.importDigest(raw);
  s.correct("aaaaaaaaaaaa:1", {
    sender: "My correction",
    priority: "important",
    notes: "Keep this",
  });
  s.pickup(randomUUID(), s.state().revision);
  const before = s.state();
  const originals = s.db
    .prepare("SELECT id,overrides,data FROM items ORDER BY id")
    .all();
  const annotated = structuredClone(raw);
  annotated.items[0].campaignId = "1000000001";
  annotated.items[0].summary = "Replay must not replace this";
  annotated.items[1].key = "wrong";
  assert.throws(() => s.importDigest(annotated), /identity mismatch/);
  assert.equal(s.state().revision, before.revision);
  assert.equal(
    s.state().items.find((i) => i.id === "aaaaaaaaaaaa:1").campaignId,
    null,
  );
  annotated.items[1].key = "2";
  annotated.items[1].campaignId = "1000000001";
  assert.equal(s.importDigest(annotated).annotated, 2);
  const revision = s.state().revision;
  assert.equal(s.importDigest(annotated).annotated, 0);
  assert.equal(s.state().revision, revision);
  assert.deepEqual(s.state().pickup, before.pickup);
  assert.equal(s.state().counts.archive, 1);
  assert.equal(s.state().mailings[0].sender, "My correction");
  for (const old of originals) {
    const saved = s.db
      .prepare("SELECT overrides,data FROM items WHERE id=?")
      .get(old.id);
    assert.equal(saved.overrides, old.overrides);
    assert.equal(JSON.parse(saved.data).summary, JSON.parse(old.data).summary);
  }
  annotated.items[0].campaignId = "999";
  assert.throws(() => s.importDigest(annotated), /identity mismatch/);
  f.reopen();
  assert.equal(f.s.state().counts.archive, 1);
  assert.equal(f.s.state().items.length, 2);
});
