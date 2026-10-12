import { createHash } from "node:crypto";

// A complete, private snapshot. Phones own delivery receipts; polling never
// changes mail, pickup cutoffs, Gmail state or the Codex monitor checkpoint.
export function notificationFeed(state, now = new Date()) {
  const alerts = [];
  for (const item of state.mailings || state.items) {
    if (item.archived || item.category !== "inbox") continue;
    const prefix = `mail:${item.mailingId || item.id}`;
    const days =
      item.deadline && item.deadlineEvidence
        ? (Date.parse(item.deadline) - Date.parse(state.today)) / 86400000
        : null;
    const due = days !== null && days >= 0 && days <= 3;
    if (!due && !["important", "urgent"].includes(item.priority)) continue;
    const level = due ? `due:${item.deadline}` : item.priority;
    alerts.push({
      key: `${prefix}:${level}`,
      slot: prefix,
      persistent: true,
      covers:
        due || item.priority === "urgent"
          ? [`${prefix}:important`, `${prefix}:urgent`]
          : [`${prefix}:important`],
      title: due
        ? "A mail deadline is approaching"
        : item.priority === "urgent"
          ? "Time-sensitive mail is waiting"
          : "Important mail is waiting",
      body: item.campaignId
        ? "Review this expected mailing in Snail Mail. Delivery is unconfirmed."
        : "Open Snail Mail to review this unfetched item.",
      target: "mail",
      itemId: item.id,
    });
  }
  const { level } = state.capacity;
  if (
    state.counts.inbox + state.counts.spam > 0 &&
    ["medium", "high"].includes(level)
  ) {
    const prefix = `capacity:${state.pickup?.id || state.startDate}`;
    alerts.push({
      key: `${prefix}:${level}`,
      slot: "capacity",
      persistent: true,
      covers: level === "high" ? [`${prefix}:medium`] : [],
      title:
        level === "high"
          ? "Your mailbox may be getting full"
          : "Worth a mailbox pickup soon",
      body: "Open Snail Mail to see the current fullness estimate.",
      target: "mailbox",
    });
  }
  if (state.sync && !state.sync.ok) {
    const reason = createHash("sha256")
      .update(state.sync.detail || "")
      .digest("hex")
      .slice(0, 24);
    alerts.push({
      key: `sync-failed:${reason}`,
      slot: "sync",
      persistent: false,
      covers: [],
      title: "Mail ingestion needs attention",
      body: "The latest digest check failed. Open Snail Mail for details.",
      target: "settings",
    });
  } else if (
    !state.sync ||
    now.getTime() - Date.parse(state.sync.checked) > 30 * 3600000
  ) {
    alerts.push({
      key: "sync-stale",
      slot: "sync",
      persistent: false,
      covers: [],
      title: "Mail checks are overdue",
      body: "Open Snail Mail to check the server and ingestion schedule.",
      target: "settings",
    });
  }
  return { version: 1, generatedAt: now.toISOString(), alerts };
}
