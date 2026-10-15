import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "../server/store.mjs";
import { notificationFeed } from "../server/notifications.mjs";
import { mailboxPackageUnits } from "../server/package-capacity.mjs";

const tracking = "0000000000000000000001";
const pack = {
  tracking,
  sender: "Test package",
  status: "expected",
  expectedDate: null,
  deliveredDate: null,
  details: "USPS is awaiting the item",
};
const delivery = {
  tracking,
  status: "delivered",
  checkedAt: "2026-10-11T23:00:00.000Z",
  sourceUrl: `https://tools.usps.com/tracking/${tracking}`,
  expectedDate: null,
  deliveredDate: "2026-10-11",
  details: "Delivered, In/At Mailbox",
  evidence:
    "Your item was delivered in or at the mailbox at 1:54 pm on October 11, 2026.",
};
const digest = (id, date, items = []) => ({
  sourceId: id,
  date,
  subject: "Test",
  advertisedCount: items.length,
  items,
  packages: [pack],
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "snail-capacity-"));
  let now = new Date("2026-10-11T23:00:00Z");
  const store = createStore(dir, () => now, {
    startDate: "2026-10-05",
    timezone: "America/Los_Angeles",
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, time: (value) => (now = new Date(value)) };
}

test("mailbox packages alone contribute space and age, notify, and clear with pickup and Undo", (t) => {
  const { store, time } = fixture(t);
  store.importDigest(digest("aaaaaaaaaaaa", "2026-10-05"));
  store.updateTracking(delivery);
  let state = store.state();
  assert.equal(state.capacity.units, 5);
  assert.equal(state.capacity.packageUnits, 5);
  assert.equal(state.capacity.mailboxPackages, 1);
  assert.equal(
    state.capacity.ageDays,
    1,
    "age starts on delivery, not the first preview",
  );
  assert.equal(state.packages[0].mailboxUnits, 5);
  time("2026-10-18T20:00:00Z");
  state = store.state();
  assert.equal(state.capacity.level, "medium");
  assert.equal(state.counts.inbox + state.counts.spam, 0);
  assert.equal(
    notificationFeed(state).alerts.some((a) => a.slot === "capacity"),
    true,
  );
  const id = randomUUID();
  store.pickup(id, state.revision);
  assert.equal(store.state().capacity.units, 0);
  assert.equal(store.state().capacity.ageDays, 0);
  assert.equal(store.state().packages[0].mailboxUnits, 0);
  assert.equal(
    notificationFeed(store.state()).alerts.some((a) => a.slot === "capacity"),
    false,
  );
  store.undo(id);
  assert.equal(store.state().capacity.units, 5);
});

test("mailbox package fullness combines with mail once and survives later digest previews", (t) => {
  const { store, time } = fixture(t);
  const items = [5, 5, 5, 1].map((units, i) => ({
    key: String(i),
    sender: "Test",
    category: "spam",
    priority: "normal",
    summary: "Promotional mail",
    evidence: "Visible advertising",
    confidence: "high",
    units,
    image: null,
    imageKind: "unavailable",
  }));
  store.importDigest(digest("aaaaaaaaaaaa", "2026-10-11", items));
  store.updateTracking(delivery);
  assert.equal(store.state().capacity.mailUnits, 16);
  assert.equal(store.state().capacity.units, 21);
  assert.equal(store.state().capacity.level, "high");
  time("2026-10-12T20:00:00Z");
  store.importDigest(digest("bbbbbbbbbbbb", "2026-10-12"));
  assert.equal(store.state().capacity.units, 21);
  assert.equal(store.state().capacity.mailboxPackages, 1);
});

test("late tracking confirmation for a collected date stays outside fullness", (t) => {
  const { store } = fixture(t);
  store.importDigest(
    digest("aaaaaaaaaaaa", "2026-10-11", [
      {
        key: "1",
        sender: "Test",
        category: "inbox",
        priority: "review",
        summary: "Letter",
        evidence: "Unknown contents",
        confidence: "low",
        image: null,
        imageKind: "unavailable",
      },
    ]),
  );
  store.pickup(randomUUID(), store.state().revision);
  store.updateTracking(delivery);
  assert.equal(store.state().packages[0].archived, true);
  assert.equal(store.state().capacity.units, 0);
});

test("only explicit completed mailbox delivery evidence contributes occupancy", () => {
  const item = {
    status: "delivered",
    deliveredDate: "2026-10-11",
    archived: false,
    trackingUpdate: delivery,
  };
  assert.equal(mailboxPackageUnits(item), 5);
  assert.equal(
    mailboxPackageUnits({
      ...item,
      trackingUpdate: {
        ...delivery,
        evidence: "Delivered, In/At Mailbox\nOctober 11, 2026",
      },
    }),
    5,
  );
  for (const evidence of [
    "Delivered, Front Door/Porch",
    "Delivered, Parcel Locker",
    "Delivered to Agent for Final Delivery",
    "Delivered on October 11, 2026.",
    "Your item was not delivered in or at the mailbox.",
  ])
    assert.equal(
      mailboxPackageUnits({
        ...item,
        trackingUpdate: { ...delivery, evidence },
      }),
      0,
      evidence,
    );
  assert.equal(mailboxPackageUnits({ ...item, status: "expected" }), 0);
  assert.equal(mailboxPackageUnits({ ...item, archived: true }), 0);
  assert.equal(mailboxPackageUnits({ ...item, deliveredDate: null }), 0);
  assert.equal(mailboxPackageUnits({ ...item, trackingUpdate: undefined }), 0);
  assert.equal(
    mailboxPackageUnits({
      ...item,
      trackingUpdate: { ...delivery, status: "out_for_delivery" },
    }),
    0,
  );
});
