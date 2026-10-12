import test from "node:test";
import assert from "node:assert/strict";
import { notificationFeed } from "../server/notifications.mjs";

const now = new Date("2026-10-12T01:00:00Z");
const state = (patch = {}) => ({
  items: [],
  today: "2026-10-11",
  startDate: "2026-10-05",
  pickup: null,
  counts: { inbox: 0, spam: 0 },
  capacity: { level: "low" },
  sync: { ok: 1, checked: now.toISOString(), detail: "ok" },
  ...patch,
});
const item = (patch = {}) => ({
  id: "aaaaaaaaaaaa:1",
  archived: false,
  category: "inbox",
  priority: "important",
  sender: "Private sender",
  summary: "Private correspondence",
  image: "private.jpg",
  deadline: null,
  deadlineEvidence: "",
  ...patch,
});

test("only actionable unfetched mail appears in the minimal notification feed", () => {
  const feed = notificationFeed(
    state({
      items: [
        item(),
        item({ id: "b", priority: "review" }),
        item({ id: "c", priority: "normal" }),
        item({ id: "d", archived: true }),
        item({ id: "e", category: "spam" }),
      ],
    }),
    now,
  );
  assert.equal(feed.version, 1);
  assert.equal(feed.alerts.length, 1);
  assert.equal(feed.alerts[0].itemId, "aaaaaaaaaaaa:1");
  assert.equal(feed.alerts[0].target, "mail");
  assert.equal(feed.alerts[0].key, "mail:aaaaaaaaaaaa:1:important");
  assert.equal(JSON.stringify(feed).includes("Private"), false);
  assert.equal(JSON.stringify(feed).includes("private.jpg"), false);
});

test("priority and evidence-backed deadline escalation replace the same mail notification", () => {
  const important = notificationFeed(state({ items: [item()] }), now).alerts[0];
  const urgent = notificationFeed(
    state({ items: [item({ priority: "urgent" })] }),
    now,
  ).alerts[0];
  assert.equal(important.slot, urgent.slot);
  assert.ok(urgent.covers.includes(important.key));
  const due = notificationFeed(
    state({
      items: [
        item({
          deadline: "2026-10-14",
          deadlineEvidence: "Respond by October 14",
        }),
      ],
    }),
    now,
  ).alerts[0];
  assert.match(due.key, /due:2026-10-14$/);
  assert.ok(due.covers.includes(urgent.key));
  for (const deadline of ["2026-10-10", "2026-10-15"]) {
    assert.equal(
      notificationFeed(
        state({
          items: [
            item({
              priority: "normal",
              deadline,
              deadlineEvidence: "Visible date",
            }),
          ],
        }),
        now,
      ).alerts.length,
      0,
    );
  }
  assert.equal(
    notificationFeed(
      state({ items: [item({ priority: "normal", deadline: "2026-10-11" })] }),
      now,
    ).alerts.length,
    0,
  );
});

test("fullness escalates once per pickup cycle and cleared mail has no fullness alert", () => {
  const base = state({
    counts: { inbox: 1, spam: 9 },
    capacity: { level: "medium" },
  });
  const medium = notificationFeed(base, now).alerts[0];
  const high = notificationFeed({ ...base, capacity: { level: "high" } }, now)
    .alerts[0];
  assert.ok(high.covers.includes(medium.key));
  assert.notEqual(
    notificationFeed({ ...base, pickup: { id: "new-pickup" } }, now).alerts[0]
      .key,
    medium.key,
  );
  assert.equal(
    notificationFeed({ ...base, counts: { inbox: 0, spam: 0 } }, now).alerts
      .length,
    0,
  );
});

test("sync failures are stable across retries, expose no raw error and recover cleanly", () => {
  const sync = {
    ok: 0,
    checked: now.toISOString(),
    detail: "Sensitive raw email error",
  };
  const a = notificationFeed(state({ sync }), now).alerts[0];
  const b = notificationFeed(
    state({ sync: { ...sync, checked: "2026-10-12T02:00:00Z" } }),
    now,
  ).alerts[0];
  assert.equal(a.key, b.key);
  assert.equal(a.persistent, false);
  assert.equal(a.target, "settings");
  assert.equal(JSON.stringify(a).includes("Sensitive"), false);
  assert.equal(notificationFeed(state(), now).alerts.length, 0);
  const stale = notificationFeed(
    state({ sync: { ok: 1, checked: "2026-10-10T18:00:00Z" } }),
    now,
  ).alerts[0];
  assert.equal(stale.key, "sync-stale");
});
