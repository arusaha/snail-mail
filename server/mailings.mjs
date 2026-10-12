const rank = { urgent: 0, important: 1, review: 2, normal: 3 };
const fields = ["sender", "category", "priority"];
export const campaignCorrectionKey = (id) => `campaign-correction:${id}`;

// Keep source occurrences for reconciliation/history. Only positively identified
// USPS saturation campaigns share one expected mailing, independent of artwork.
export function resolveMailings(rows, cutoff, correctionFor) {
  const groups = new Map();
  for (const row of rows) {
    const base = JSON.parse(row.data);
    const overrides = JSON.parse(row.overrides);
    const item = {
      ...base,
      ...overrides,
      id: row.id,
      sourceId: row.source_id,
      date: row.date,
      campaignId: base.campaignId || null,
    };
    const key = item.campaignId ? `campaign:${item.campaignId}` : item.id;
    const members = groups.get(key) || [];
    members.push({ item, overrides });
    groups.set(key, members);
  }
  const items = [],
    mailings = [];
  for (const [mailingId, members] of groups) {
    members.sort(
      (a, b) =>
        a.item.date.localeCompare(b.item.date) ||
        a.item.id.localeCompare(b.item.id),
    );
    const lead = [...members].sort(
      (a, b) =>
        rank[a.item.priority] - rank[b.item.priority] ||
        a.item.category.localeCompare(b.item.category) ||
        b.item.date.localeCompare(a.item.date),
    )[0].item;
    const mailingDate = members[0].item.date;
    const archived = !!cutoff && mailingDate <= cutoff;
    const shared = {};
    if (lead.campaignId) {
      for (const key of fields) shared[key] = lead[key];
      // Retain pre-migration corrections; newer digest corrections win conflicts.
      // Subsequent edits are stored once for the campaign, including future repeats.
      for (const { overrides } of members)
        for (const key of fields)
          if (Object.hasOwn(overrides, key)) shared[key] = overrides[key];
      Object.assign(shared, correctionFor(lead.campaignId) || {});
      if (["important", "urgent"].includes(shared.priority))
        shared.category = "inbox";
    }
    const resolved = members.map(({ item }) => ({
      ...item,
      ...shared,
      mailingId,
      mailingDate,
      archived,
    }));
    items.push(...resolved);
    const deadlineItem = resolved
      .filter((i) => i.deadline && i.deadlineEvidence)
      .sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
    mailings.push({
      ...resolved.find((i) => i.id === lead.id),
      ...(deadlineItem
        ? {
            deadline: deadlineItem.deadline,
            deadlineEvidence: deadlineItem.deadlineEvidence,
          }
        : {}),
      units: Math.max(...resolved.map((i) => i.units)),
      occurrenceIds: resolved.map((i) => i.id),
    });
  }
  items.sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
  return { items, mailings };
}
