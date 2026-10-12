type GroupableMail = {
  id: string;
  date: string;
  image: string | null;
  imageKind: string;
  campaignId?: string | null;
  category: string;
  archived: boolean;
  priority: "normal" | "review" | "important" | "urgent";
};

const rank = { urgent: 0, important: 1, review: 2, normal: 3 };

// The server resolves saturation campaigns into one expected mailing. Other
// identical promotional artwork is grouped only for presentation.
export function groupMail<T extends GroupableMail>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.campaignId
      ? `campaign:${item.campaignId}`
      : item.imageKind === "representative" && item.image
        ? `promo:${item.image}:${item.category}:${item.archived}`
        : `entry:${item.id}`;
    const members = groups.get(key) || [];
    members.push(item);
    groups.set(key, members);
  }
  return [...groups].map(([groupId, members]) => {
    const occurrences = [...members].sort(
      (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
    );
    // A newer routine repeat must not hide an earlier important entry.
    const lead = [...occurrences].sort(
      (a, b) => rank[a.priority] - rank[b.priority],
    )[0];
    return { ...lead, groupId, occurrences };
  });
}
