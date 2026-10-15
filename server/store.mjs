import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveMailings, campaignCorrectionKey } from "./mailings.mjs";
import { readConfig, configSchema } from "./config.mjs";
import { mailboxPackageUnits } from "./package-capacity.mjs";

export const START_DATE = "1970-01-01";
export const TIMEZONE = "UTC";
export const localDate = (now = new Date(), timezone = TIMEZONE) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
  );
const imageName = z.string().regex(/^[a-f0-9]{64}\.jpg$/);
export const trackingUpdateSchema = z
  .object({
    tracking: z.string().regex(/^[A-Z0-9]{10,40}$/),
    status: z.enum([
      "awaiting_usps",
      "in_transit",
      "out_for_delivery",
      "available_for_pickup",
      "delivered",
      "exception",
      "unknown",
    ]),
    checkedAt: z.string().datetime(),
    sourceUrl: z.string().url(),
    expectedDate: day.nullable(),
    deliveredDate: day.nullable(),
    details: z.string().min(1).max(600),
    evidence: z.string().min(1).max(1500),
  })
  .strict()
  .superRefine((update, ctx) => {
    if (
      update.sourceUrl !== `https://tools.usps.com/tracking/${update.tracking}`
    )
      ctx.addIssue({
        code: "custom",
        message: "Tracking evidence must identify the same package on USPS",
      });
    if ((update.status === "delivered") !== !!update.deliveredDate)
      ctx.addIssue({
        code: "custom",
        message: "Only confirmed delivery requires a delivery date",
      });
  });
export const itemSchema = z
  .object({
    key: z.string().min(1).max(180),
    sender: z.string().min(1).max(200),
    category: z.enum(["inbox", "spam"]),
    priority: z.enum(["normal", "review", "important", "urgent"]),
    summary: z.string().max(1500),
    evidence: z.string().max(1500),
    confidence: z.enum(["low", "medium", "high"]),
    deadline: day.nullable().default(null),
    deadlineEvidence: z.string().max(400).default(""),
    image: imageName.nullable(),
    supplemental: z.array(imageName).max(5).default([]),
    imageKind: z.enum(["scan", "representative", "unavailable"]),
    campaignId: z
      .string()
      .regex(/^\d{1,30}$/)
      .nullable()
      .default(null),
    units: z.number().min(1).max(5).default(1),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.campaignId && (item.imageKind !== "representative" || !item.image))
      ctx.addIssue({
        code: "custom",
        message: "Saturation campaigns require a representative image",
      });
    if (item.deadline && !item.deadlineEvidence)
      ctx.addIssue({
        code: "custom",
        message: "Deadlines require visible evidence",
      });
    if (
      item.category === "spam" &&
      (item.confidence !== "high" ||
        ["important", "urgent"].includes(item.priority))
    )
      ctx.addIssue({
        code: "custom",
        message: "Uncertain or important mail belongs in Inbox",
      });
  });
export const importSchema = z
  .object({
    sourceId: z.string().regex(/^[a-f0-9]{10,40}$/),
    date: day,
    advertisedCount: z.number().int().min(0).max(200),
    subject: z.string().max(500),
    items: z.array(itemSchema).max(200),
    packages: z
      .array(
        z
          .object({
            tracking: z.string().regex(/^[A-Z0-9]{10,40}$/),
            sender: z.string().max(200),
            status: z.enum(["expected", "delivered"]),
            expectedDate: day.nullable(),
            deliveredDate: day.nullable(),
            details: z.string().max(600),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.date < START_DATE)
      ctx.addIssue({
        code: "custom",
        message: "Digest predates tracking start",
      });
    if (m.items.length !== m.advertisedCount)
      ctx.addIssue({
        code: "custom",
        message: "Mail count must reconcile before import",
      });
    if (new Set(m.items.map((x) => x.key)).size !== m.items.length)
      ctx.addIssue({ code: "custom", message: "Duplicate source occurrence" });
  });

export function createStore(dir, clock = () => new Date(), overrides = {}) {
  const config = configSchema.parse({ ...readConfig(dir), ...overrides });
  const { startDate, timezone } = config;
  const todayAt = () => localDate(clock(), timezone);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "mail.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS digests (id TEXT PRIMARY KEY, date TEXT NOT NULL, count INTEGER NOT NULL, subject TEXT NOT NULL, imported TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES digests(id), date TEXT NOT NULL, data TEXT NOT NULL, overrides TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS items_date ON items(date);
    CREATE TABLE IF NOT EXISTS packages (tracking TEXT PRIMARY KEY, source_date TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pickups (id TEXT PRIMARY KEY, cutoff TEXT NOT NULL, created TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, checked TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);`);
  const meta = (key) => {
    const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? JSON.parse(r.value) : null;
  };
  const setMeta = (key, value) =>
    db
      .prepare(
        "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  const settings = () =>
    meta("settings") || {
      warningUnits: 12,
      fullUnits: 20,
      warningDays: 7,
      fullDays: 14,
    };
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const lastPickup = () =>
    db
      .prepare(
        "SELECT * FROM pickups WHERE undone=0 ORDER BY rowid DESC LIMIT 1",
      )
      .get() || null;
  const revision = () => meta("revision") || 0;
  const bump = () => setMeta("revision", revision() + 1);
  function importDigest(input) {
    const m = importSchema.parse(input);
    if (m.date < startDate) throw new Error("Digest predates tracking start");
    if (m.date > todayAt()) throw new Error("Future digest date");
    return transaction(() => {
      const existing = db
        .prepare("SELECT * FROM digests WHERE id=?")
        .get(m.sourceId);
      if (existing) {
        // A replay can annotate previously imported campaign evidence, but cannot
        // replace source identity, classifications, manual corrections or pickups.
        if (existing.date !== m.date || existing.count !== m.advertisedCount)
          throw new Error("Replay source identity mismatch");
        let annotated = 0;
        for (const item of m.items) {
          const id = `${m.sourceId}:${item.key}`;
          const row = db.prepare("SELECT data FROM items WHERE id=?").get(id);
          const old = row && JSON.parse(row.data);
          if (
            !old ||
            old.image !== item.image ||
            old.imageKind !== item.imageKind ||
            (old.campaignId &&
              item.campaignId &&
              old.campaignId !== item.campaignId)
          )
            throw new Error("Replay source identity mismatch");
          if (item.campaignId && !old.campaignId) {
            old.campaignId = item.campaignId;
            // Remove only the known, incorrect legacy counting sentence. Original
            // classification files remain in staging as part of the source audit.
            old.evidence = old.evidence.replace(
              " Repeated images on different digest dates are counted separately.",
              "",
            );
            db.prepare("UPDATE items SET data=? WHERE id=?").run(
              JSON.stringify(old),
              id,
            );
            annotated++;
          }
        }
        if (annotated) bump();
        return { duplicate: true, sourceId: m.sourceId, added: 0, annotated };
      }
      db.prepare("INSERT INTO digests VALUES (?,?,?,?,?)").run(
        m.sourceId,
        m.date,
        m.advertisedCount,
        m.subject,
        clock().toISOString(),
      );
      for (const item of m.items)
        db.prepare(
          "INSERT INTO items (id,source_id,date,data) VALUES (?,?,?,?)",
        ).run(
          `${m.sourceId}:${item.key}`,
          m.sourceId,
          m.date,
          JSON.stringify(item),
        );
      for (const p of m.packages) {
        const existing = db
          .prepare("SELECT * FROM packages WHERE tracking=?")
          .get(p.tracking);
        if (!existing || existing.source_date <= m.date) {
          const old = existing ? JSON.parse(existing.data) : null;
          // Once delivered, a stale expected card must never make a package pending again.
          const data =
            old?.status === "delivered" && p.status === "expected" ? old : p;
          db.prepare(
            "INSERT INTO packages VALUES (?,?,?) ON CONFLICT(tracking) DO UPDATE SET source_date=excluded.source_date,data=excluded.data",
          ).run(p.tracking, m.date, JSON.stringify(data));
        }
      }
      bump();
      return { duplicate: false, sourceId: m.sourceId, added: m.items.length };
    });
  }
  function state() {
    const pickup = lastPickup();
    const cutoff = pickup?.cutoff || null;
    const today = todayAt();
    const rows = db.prepare("SELECT * FROM items ORDER BY date DESC,id").all();
    const { items, mailings } = resolveMailings(rows, cutoff, (id) =>
      meta(campaignCorrectionKey(id)),
    );
    const pending = mailings.filter((x) => !x.archived);
    const mailUnits = pending.reduce((s, x) => s + x.units, 0);
    const packages = db
      .prepare("SELECT * FROM packages ORDER BY source_date DESC")
      .all()
      .map((r) => ({ ...JSON.parse(r.data), sourceDate: r.source_date }))
      .map((p) => {
        const trackingUpdate = meta(`tracking:${p.tracking}`);
        if (!trackingUpdate) return p;
        return {
          ...p,
          status:
            trackingUpdate.status === "delivered" ? "delivered" : p.status,
          expectedDate: trackingUpdate.expectedDate,
          deliveredDate: trackingUpdate.deliveredDate || p.deliveredDate,
          details: trackingUpdate.details,
          trackingUpdate,
        };
      })
      .map((p) => ({
        ...p,
        archived:
          !!cutoff &&
          p.status === "delivered" &&
          p.deliveredDate &&
          p.deliveredDate <= cutoff,
      }))
      .map((p) => ({ ...p, mailboxUnits: mailboxPackageUnits(p) }));
    const mailboxPackages = packages.filter((p) => p.mailboxUnits > 0);
    const packageUnits = mailboxPackages.reduce(
      (sum, p) => sum + p.mailboxUnits,
      0,
    );
    const units = mailUnits + packageUnits;
    const oldest = [
      ...pending.map((x) => x.mailingDate),
      ...mailboxPackages.map((p) => p.deliveredDate),
    ].sort()[0];
    const ageDays = oldest
      ? Math.floor((Date.parse(today) - Date.parse(oldest)) / 86400000) + 1
      : 0;
    const s = settings();
    const fullness =
      units >= s.fullUnits || ageDays >= s.fullDays
        ? "high"
        : units >= s.warningUnits || ageDays >= s.warningDays
          ? "medium"
          : "low";
    return {
      items,
      mailings,
      packages,
      counts: {
        inbox: pending.filter((x) => x.category === "inbox").length,
        spam: pending.filter((x) => x.category === "spam").length,
        archive: mailings.length - pending.length,
      },
      capacity: {
        units,
        mailUnits,
        packageUnits,
        mailboxPackages: mailboxPackages.length,
        ageDays,
        level: fullness,
        expectedCampaigns: pending.filter((x) => x.campaignId).length,
      },
      settings: s,
      pickup,
      revision: revision(),
      today,
      startDate,
      timezone,
      digests: db.prepare("SELECT * FROM digests ORDER BY date DESC").all(),
      sync:
        db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get() || null,
    };
  }
  function pickup(id, expectedRevision) {
    z.string().uuid().parse(id);
    return transaction(() => {
      const old = db.prepare("SELECT * FROM pickups WHERE id=?").get(id);
      if (old) return old;
      if (expectedRevision !== revision())
        throw Object.assign(
          new Error("Mail changed. Review the refreshed inbox and try again."),
          { status: 409 },
        );
      const s = state();
      if (
        !s.items.some((x) => !x.archived) &&
        !s.packages.some((p) => p.status === "delivered" && !p.archived)
      )
        throw new Error("There is no mail to pick up");
      db.prepare("INSERT INTO pickups (id,cutoff,created) VALUES (?,?,?)").run(
        id,
        todayAt(),
        clock().toISOString(),
      );
      bump();
      return lastPickup();
    });
  }
  function undo(id) {
    return transaction(() => {
      const old = db.prepare("SELECT * FROM pickups WHERE id=?").get(id);
      if (old?.undone) return { undone: true };
      if (!old || lastPickup()?.id !== id)
        throw Object.assign(new Error("Only the latest pickup can be undone"), {
          status: 409,
        });
      db.prepare("UPDATE pickups SET undone=1 WHERE id=?").run(id);
      bump();
      return { undone: true };
    });
  }
  function correct(id, changes) {
    const patch = z
      .object({
        category: z.enum(["inbox", "spam"]).optional(),
        priority: z
          .enum(["normal", "review", "important", "urgent"])
          .optional(),
        sender: z.string().min(1).max(200).optional(),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .parse(changes);
    return transaction(() => {
      const r = db
        .prepare("SELECT overrides,data FROM items WHERE id=?")
        .get(id);
      if (!r) throw Object.assign(new Error("Mail not found"), { status: 404 });
      const base = JSON.parse(r.data);
      const effective = base.campaignId
        ? state().items.find((i) => i.id === id)
        : { ...base, ...JSON.parse(r.overrides) };
      const combined = { ...effective, ...patch };
      const classificationChange = ["sender", "category", "priority"].some(
        (key) => Object.hasOwn(patch, key),
      );
      if (
        classificationChange &&
        ["important", "urgent"].includes(combined.priority)
      )
        patch.category = "inbox";
      if (base.campaignId && classificationChange) {
        const shared = { ...meta(campaignCorrectionKey(base.campaignId)) };
        for (const key of ["sender", "category", "priority"])
          if (Object.hasOwn(patch, key)) shared[key] = patch[key];
        setMeta(campaignCorrectionKey(base.campaignId), shared);
      }
      db.prepare("UPDATE items SET overrides=? WHERE id=?").run(
        JSON.stringify({ ...JSON.parse(r.overrides), ...patch }),
        id,
      );
      bump();
      return { saved: true };
    });
  }
  function configure(input) {
    const s = z
      .object({
        warningUnits: z.number().int().min(1).max(100),
        fullUnits: z.number().int().min(2).max(200),
        warningDays: z.number().int().min(1).max(60),
        fullDays: z.number().int().min(2).max(90),
      })
      .strict()
      .refine((s) => s.fullUnits > s.warningUnits && s.fullDays > s.warningDays)
      .parse(input);
    setMeta("settings", s);
    bump();
    return s;
  }
  function recordRun(ok, detail = "") {
    db.prepare("INSERT INTO runs (checked,ok,detail) VALUES (?,?,?)").run(
      clock().toISOString(),
      ok ? 1 : 0,
      String(detail).slice(0, 1000),
    );
    return { saved: true };
  }
  function updateTracking(input) {
    const update = trackingUpdateSchema.parse(input);
    if (Date.parse(update.checkedAt) > clock().getTime() + 60000)
      throw new Error("Tracking check is in the future");
    if (update.deliveredDate && update.deliveredDate > todayAt())
      throw new Error("Delivery date is in the future");
    return transaction(() => {
      const row = db
        .prepare("SELECT data FROM packages WHERE tracking=?")
        .get(update.tracking);
      if (!row) throw new Error("Tracking number is not in this mailbox");
      const previous = meta(`tracking:${update.tracking}`);
      if (
        previous &&
        Date.parse(update.checkedAt) < Date.parse(previous.checkedAt)
      )
        throw new Error("A newer tracking check is already saved");
      if (
        (previous?.status === "delivered" ||
          JSON.parse(row.data).status === "delivered") &&
        update.status !== "delivered"
      )
        throw new Error("A tracking update cannot undo confirmed delivery");
      if (JSON.stringify(previous) === JSON.stringify(update))
        return { saved: true, duplicate: true };
      setMeta(`tracking:${update.tracking}`, update);
      bump();
      return { saved: true };
    });
  }
  return {
    db,
    state,
    importDigest,
    pickup,
    undo,
    correct,
    configure,
    recordRun,
    updateTracking,
    close: () => db.close(),
  };
}
