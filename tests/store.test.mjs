import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore, localDate } from "../server/store.mjs";
import { parseSource } from "../scripts/ingest.mjs";
const item = (key = "1", extra = {}) => ({
  key,
  sender: "Example",
  category: "inbox",
  priority: "review",
  summary: "Unknown contents",
  evidence: "Only the address side is visible",
  confidence: "low",
  image: null,
  imageKind: "unavailable",
  ...extra,
});
const digest = (sourceId, date, items = [item()], packages = []) => ({
  sourceId,
  date,
  advertisedCount: items.length,
  subject: "Daily Digest",
  items,
  packages,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "snail-test-"));
  let now = new Date("2026-10-11T23:00:00Z");
  const s = createStore(dir, () => now, {
    startDate: "2026-10-05",
    timezone: "America/Los_Angeles",
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { s, time: (v) => (now = new Date(v)) };
}
test("repeated imports are idempotent, corrections persist, shared artwork remains separate physical occurrences", (t) => {
  const { s } = fixture(t);
  const d = digest("aaaaaaaaaaaa", "2026-10-05");
  s.importDigest(d);
  s.correct("aaaaaaaaaaaa:1", { sender: "Corrected", priority: "important" });
  assert.equal(s.importDigest(d).duplicate, true);
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-06"));
  assert.equal(s.state().items.length, 2);
  assert.equal(
    s.state().items.find((i) => i.sourceId === d.sourceId).sender,
    "Corrected",
  );
});
test("pickup clears both tabs; late imports stay archived; next day resumes; undo restores late mail too", (t) => {
  const { s, time } = fixture(t);
  s.importDigest(
    digest("aaaaaaaaaaaa", "2026-10-05", [
      item(),
      item("2", { category: "spam", priority: "normal", confidence: "high" }),
    ]),
  );
  const id = randomUUID();
  s.pickup(id, s.state().revision);
  assert.equal(s.state().counts.inbox, 0);
  assert.equal(s.state().counts.spam, 0);
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-10"));
  assert.equal(s.state().counts.archive, 3);
  time("2026-10-12T16:00:00Z");
  s.importDigest(digest("cccccccccccc", "2026-10-12"));
  assert.equal(s.state().counts.inbox, 1);
  s.undo(id);
  assert.equal(s.state().counts.archive, 0);
  assert.equal(s.state().counts.inbox, 3);
  assert.equal(s.state().counts.spam, 1);
});
test("stale pickup fails instead of archiving unseen incoming mail; retry of same request is idempotent", (t) => {
  const { s } = fixture(t);
  s.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  const old = s.state().revision;
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-06"));
  assert.throws(() => s.pickup(randomUUID(), old), /Mail changed/);
  const id = randomUUID();
  s.pickup(id, s.state().revision);
  s.pickup(id, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM pickups").get().n, 1);
  s.undo(id);
  s.undo(id);
  assert.equal(s.state().counts.inbox, 2);
});
test("undo uses the previous cutoff and cannot undo an older pickup out of order", (t) => {
  const { s, time } = fixture(t);
  s.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  const first = randomUUID();
  s.pickup(first, s.state().revision);
  time("2026-10-12T18:00:00Z");
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-12"));
  const second = randomUUID();
  s.pickup(second, s.state().revision);
  assert.throws(() => s.undo(first), /latest pickup/);
  s.undo(second);
  assert.equal(s.state().counts.archive, 1);
  assert.equal(s.state().counts.inbox, 1);
});
test("bad count, pre-start date, unsupported confidence and duplicate occurrences leave no partial digest", (t) => {
  const { s } = fixture(t);
  for (const d of [
    { ...digest("aaaaaaaaaaaa", "2026-10-05"), advertisedCount: 3 },
    digest("bbbbbbbbbbbb", "2026-10-04"),
    digest("cccccccccccc", "2026-10-05", [item("1", { category: "spam" })]),
    digest("dddddddddddd", "2026-10-05", [item(), item()]),
  ])
    assert.throws(() => s.importDigest(d));
  assert.equal(s.state().digests.length, 0);
});
test("fullness includes bulky spam; package repeats deduplicate and do not occupy the mailbox", (t) => {
  const { s } = fixture(t);
  const p = {
    tracking: "0000000000000000000001",
    sender: "USPS",
    status: "expected",
    expectedDate: null,
    deliveredDate: null,
    details: "Awaiting item",
  };
  s.importDigest(
    digest(
      "aaaaaaaaaaaa",
      "2026-10-11",
      [
        item("1", {
          units: 5,
          category: "spam",
          priority: "normal",
          confidence: "high",
        }),
      ],
      [p],
    ),
  );
  s.importDigest(digest("bbbbbbbbbbbb", "2026-10-11", [], [p]));
  assert.equal(s.state().capacity.units, 5);
  assert.equal(s.state().packages.length, 1);
  s.pickup(randomUUID(), s.state().revision);
  assert.equal(s.state().packages[0].archived, false);
  assert.equal(s.state().capacity.units, 0);
});
test("calendar cutoff follows Pacific time across midnight and DST", () => {
  assert.equal(
    localDate(new Date("2026-10-12T06:59:59Z"), "America/Los_Angeles"),
    "2026-10-11",
  );
  assert.equal(
    localDate(new Date("2026-10-12T07:00:00Z"), "America/Los_Angeles"),
    "2026-10-12",
  );
  assert.equal(
    localDate(new Date("2026-11-02T07:59:59Z"), "America/Los_Angeles"),
    "2026-11-01",
  );
});
const source = (html, count = 1) => ({
  id: "aaaaaaaaaaaa",
  headers: [
    {
      name: "From",
      value: "USPSInformeddelivery@email.informeddelivery.usps.com",
    },
    {
      name: "Authentication-Results",
      value:
        "mx.google.com; dkim=pass header.i=@email.informeddelivery.usps.com; dmarc=pass header.from=usps.com",
    },
  ],
  text: "Today's Deliveries: 10/09/2026",
  html: `<span id="total-mailpieces">${count}</span>${html}`,
  attachments: [
    { filename: "mailer-example.jpg", cid: "<mailer-example.jpg>" },
    { filename: "content-example.jpg", cid: "<content-example.jpg>" },
  ],
});
test("MIME parser excludes desktop/mobile ridealong duplicates and retains unavailable pieces", () => {
  const parsed = parseSource(
    source(
      '<table><tr><td><img id="campaign-representative-image-src-id" src="cid:mailer-example.jpg"><img id="campaign-ridealong-image-src-id" src="cid:content-example.jpg"><img id="campaign-ridealong-image-src-id-secondary" src="cid:content-example.jpg"></td></tr></table>',
      2,
    ),
  );
  assert.equal(parsed.pieces.length, 2);
  assert.deepEqual(parsed.pieces[0].supplemental, ["content-example.jpg"]);
  assert.equal(parsed.pieces[1].filename, null);
});
test("unverified sender and unsupported template fail closed", () => {
  const s = source("");
  s.headers[1].value = "dmarc=fail";
  assert.throws(() => parseSource(s), /authentication/);
  const good = source("");
  good.html = "changed template";
  assert.throws(() => parseSource(good), /count missing/);
});
