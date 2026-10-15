import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import {
  Mails,
  Mail,
  Mailbox,
  CheckCheck,
  ArrowLeft,
  RefreshCw,
  Settings,
  X,
  ArrowUpRight,
  AlertCircle,
  Undo2,
  Package,
  ImageOff,
  Search,
  ChevronLeft,
  ChevronRight,
  Download,
  ZoomIn,
} from "lucide-react";
import "./style.css";
import { groupMail } from "./mail-groups";
import { MailNotifications, type NotificationOpen } from "./notifications";
import { NotificationSettings } from "./NotificationSettings";
import { PackageCard, type PackageUpdate } from "./PackageCard";

type MailItem = {
  id: string;
  sourceId: string;
  date: string;
  sender: string;
  category: "inbox" | "spam";
  priority: "normal" | "review" | "important" | "urgent";
  summary: string;
  evidence: string;
  confidence: string;
  deadline: string | null;
  deadlineEvidence: string;
  image: string | null;
  supplemental: string[];
  imageKind: string;
  campaignId: string | null;
  archived: boolean;
  notes?: string;
  units: number;
};
type Config = {
  warningUnits: number;
  fullUnits: number;
  warningDays: number;
  fullDays: number;
};
type State = {
  items: MailItem[];
  mailings: MailItem[];
  packages: PackageUpdate[];
  counts: Record<string, number>;
  capacity: {
    units: number;
    mailUnits: number;
    packageUnits: number;
    mailboxPackages: number;
    ageDays: number;
    level: string;
    expectedCampaigns: number;
  };
  settings: Config;
  pickup: { id: string; cutoff: string } | null;
  revision: number;
  today: string;
  startDate: string;
  timezone: string;
  digests: { id: string; date: string; count: number }[];
  sync: { checked: string; ok: number; detail: string } | null;
};
type View = "inbox" | "spam" | "archive";
type SortOrder = "recency" | "importance";
const sortPreferenceKey = "snail-mail.sort-order";
const native = Capacitor.isNativePlatform();
const apiOrigin = native ? import.meta.env.VITE_API_ORIGIN || "" : "";
const asset = (name: string, thumb = false) =>
  `${apiOrigin}/media/${thumb ? "thumbs" : "images"}/${name}`;
const fmt = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
const label = {
  normal: "Mail",
  review: "Take a look",
  important: "Important",
  urgent: "Time-sensitive",
};
async function api(path: string, body?: unknown, method = "POST") {
  const r = await fetch(apiOrigin + "/api" + path, {
    method: body === undefined ? "GET" : method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Could not reach your mailbox");
  return data;
}
function App() {
  const [data, setData] = useState<State | null>(null),
    [view, setView] = useState<View>("inbox"),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [settings, setSettings] = useState(false),
    [zoom, setZoom] = useState<string | null>(null),
    [toast, setToast] = useState("");
  const [form, setForm] = useState<Config | null>(null),
    [notes, setNotes] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => {
    try {
      return localStorage.getItem(sortPreferenceKey) === "recency"
        ? "recency"
        : "importance";
    } catch {
      return "importance";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(sortPreferenceKey, sortOrder);
    } catch {
      // Sorting still works when browser storage is unavailable.
    }
  }, [sortOrder]);
  const notificationOpen = useRef<NotificationOpen | null>(null);
  const appActive = useRef(true);
  const scroll = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const returnFocus = useRef<string | null>(null);
  const overlayRef = useRef({ zoom, settings });
  overlayRef.current = { zoom, settings };
  const load = async () => {
    const destination = notificationOpen.current;
    if (destination?.target === "settings") {
      // Connection-failure alerts must open local controls even with the server offline.
      notificationOpen.current = null;
      setZoom(null);
      setSettings(true);
    }
    try {
      const d = await api("/state");
      setData(d);
      setError("");
      if (destination?.target === "settings") setForm(d.settings);
      if (destination && notificationOpen.current === destination) {
        notificationOpen.current = null;
        setZoom(null);
        setQuery("");
        if (destination.target === "settings") {
          setForm(d.settings);
          setSettings(true);
        } else {
          setSettings(false);
          const item: MailItem | undefined = d.items.find(
            (x: MailItem) => x.id === destination.itemId,
          );
          if (destination.target === "mail" && item) {
            setView(item.archived ? "archive" : item.category);
            const group = groupMail(d.items as MailItem[]).find((g) =>
              g.occurrences.some((x) => x.id === item.id),
            )!;
            if (!selectedRef.current) {
              scroll.current = 0;
              history.pushState({ reader: true }, "");
            }
            returnFocus.current = `mail-${group.groupId}`;
            setSelected(item.id);
          } else {
            if (selectedRef.current) history.back();
            setSelected(null);
            setView("inbox");
            if (destination.target === "mail")
              setToast(
                "This item is no longer available. Your current mailbox is shown.",
              );
          }
          window.scrollTo(0, 0);
        }
      }
    } catch (e) {
      setError(
        (e as Error).message === "Failed to fetch"
          ? "Cannot reach your home server. Check that this computer is awake and Tailscale is connected."
          : (e as Error).message,
      );
    }
  };
  useEffect(() => {
    if (!native) return;
    let active = true;
    const receive = async () => {
      if (!active) return;
      try {
        const destination = await MailNotifications.consumeOpen();
        if (!active || !destination.target) return;
        notificationOpen.current = destination;
        await load();
      } catch {
        if (active)
          setError(
            "Could not open the notification. Refresh your mailbox to try again.",
          );
      }
    };
    const handle = MailNotifications.addListener(
      "notificationOpen",
      () => void receive(),
    );
    // Listener first, then consume cold-start intent; warm taps use the same path.
    void handle.then(() => {
      if (active) void receive();
    });
    return () => {
      active = false;
      void handle.then((h) => h.remove());
    };
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (appActive.current && document.visibilityState === "visible")
        void load();
    }, 60000);
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    const appStateHandle = native
      ? NativeApp.addListener("appStateChange", ({ isActive }) => {
          appActive.current = isActive;
          if (isActive) void load();
        })
      : null;
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      void appStateHandle?.then((h) => h.remove());
    };
  }, []);
  useEffect(() => {
    const onPop = () => {
      setSelected(null);
      setZoom(null);
      requestAnimationFrame(() => {
        window.scrollTo(0, scroll.current);
        if (returnFocus.current)
          document
            .getElementById(returnFocus.current)
            ?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("popstate", onPop);
    const backHandle = native
      ? NativeApp.addListener("backButton", () => {
          if (overlayRef.current.zoom) setZoom(null);
          else if (overlayRef.current.settings) setSettings(false);
          else if (selectedRef.current) history.back();
          else NativeApp.minimizeApp();
        })
      : null;
    return () => {
      window.removeEventListener("popstate", onPop);
      void backHandle?.then((h) => h.remove());
    };
  }, []);
  useEffect(() => {
    if (!zoom && !settings) return;
    const previous = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>(
      zoom ? ".image-overlay" : ".modal",
    );
    const elements = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),a[href],input,textarea",
        ) || [],
      ).filter((x) => x.offsetParent !== null);
    elements()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const nodes = elements(),
        first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", trap);
      previous?.focus({ preventScroll: true });
    };
  }, [zoom, settings]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoom) setZoom(null);
        else if (settings) setSettings(false);
        else if (selected) history.back();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected, zoom, settings]);
  const open = (id: string, groupId: string) => {
    if (!selected) {
      scroll.current = window.scrollY;
      history.pushState({ reader: true }, "");
      returnFocus.current = `mail-${groupId}`;
    }
    setSelected(id);
    if (native || window.innerWidth < 720) window.scrollTo(0, 0);
  };
  const changeView = (v: View) => {
    if (selected) {
      history.back();
      setSelected(null);
    }
    setView(v);
    setQuery("");
  };
  const action = async (fn: () => Promise<unknown>, message = "") => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await load();
      if (message) setToast(message);
    } catch (e) {
      setError((e as Error).message);
      await load();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = data?.items.find((x) => x.id === selected);
  const groups = groupMail(data?.items || []);
  const currentGroup = groups.find((g) =>
    g.occurrences.some((x) => x.id === selected),
  );
  useEffect(
    () => setNotes(current?.notes || ""),
    [current?.id, current?.notes],
  );
  useEffect(() => {
    // Follow a corrected item into its new tab without losing the detail view.
    if (
      current &&
      !current.archived &&
      view !== "archive" &&
      view !== current.category
    ) {
      setView(current.category);
      setQuery("");
    }
  }, [current?.id, current?.category]);
  const filtered = groups
    .filter(
      (x) =>
        (view === "archive"
          ? x.archived
          : !x.archived && x.category === view) &&
        x.occurrences.some((entry) =>
          `${entry.sender} ${entry.summary} ${entry.date}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    )
    .sort((a, b) => {
      const rank = { urgent: 0, important: 1, review: 2, normal: 3 };
      const recent = b.occurrences[0].date.localeCompare(a.occurrences[0].date);
      const important = rank[a.priority] - rank[b.priority];
      return (
        (sortOrder === "recency" ? recent || important : important || recent) ||
        a.groupId.localeCompare(b.groupId)
      );
    });
  const focusIndex = filtered.findIndex(
    (x) => x.groupId === currentGroup?.groupId,
  );
  const shownEntries = filtered.reduce((n, x) => n + x.occurrences.length, 0);
  const total =
    (data?.counts.inbox || 0) +
    (data?.counts.spam || 0) +
    (data?.capacity.mailboxPackages || 0);
  const attention =
    data?.mailings.filter(
      (x) => !x.archived && ["important", "urgent"].includes(x.priority),
    ).length || 0;
  const stale =
    !data?.sync ||
    !data.sync.ok ||
    Date.now() - Date.parse(data.sync.checked) > 30 * 3600000;
  const correct = (patch: Partial<MailItem>) =>
    current &&
    action(
      () => api(`/items/${encodeURIComponent(current.id)}`, patch, "PATCH"),
      "Saved. Your correction will stay in place.",
    );
  return (
    <div
      className={`${native ? "native " : ""}${selected ? "reading " : ""}app`}
    >
      <header className="top">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (selected) history.back();
          }}
        >
          <span className="logo">
            <Mails size={21} />
          </span>
          snail mail
        </a>
        <div className="top-actions">
          <span className="private">
            <span className="dot" />
            Your physical mailbox
          </span>
          <button
            className="icon-button"
            aria-label="Refresh mailbox"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Mailbox settings"
            onClick={() => {
              setForm(data?.settings || null);
              setSettings(true);
            }}
          >
            <Settings size={19} />
          </button>
        </div>
      </header>
      <main>
        <section className="overview">
          <div className="heading">
            <div>
              <div className="eyebrow">A little less mailbox mystery</div>
              <h1>Worth the walk?</h1>
              <p className="muted">
                {data
                  ? `${total} unfetched item${total === 1 ? "" : "s"} · ${attention ? `${attention} need${attention === 1 ? "s" : ""} your attention` : "All caught up on urgent mail"}`
                  : "Checking your mailbox…"}
              </p>
            </div>
            <button
              className="primary pickup"
              disabled={
                busy ||
                !data ||
                (total === 0 &&
                  !data.packages.some(
                    (p) => p.status === "delivered" && !p.archived,
                  )) ||
                !!error
              }
              onClick={() => {
                const id = crypto.randomUUID();
                void action(async () => {
                  await api("/pickup", { id, revision: data!.revision });
                  if (selected) history.back();
                }, "Mailbox cleared. New mail starts with tomorrow’s digest.");
              }}
            >
              <CheckCheck size={19} />I picked up the mail
            </button>
          </div>
          {data && (
            <div className={`capacity ${data.capacity.level}`}>
              <Mailbox size={24} />
              <div>
                <strong>
                  {data.capacity.units === 0
                    ? "A fresh start"
                    : data.capacity.level === "high"
                      ? "Your mailbox may be getting full"
                      : data.capacity.level === "medium"
                        ? "Worth a pickup soon"
                        : "Room for a little more"}
                </strong>
                <span>
                  {data.capacity.units === 0
                    ? "New digests will collect here."
                    : `${data.capacity.ageDays} days accumulating · about ${data.capacity.units} letter equivalents · small mailbox`}
                </span>
                {!!data.capacity.expectedCampaigns && (
                  <span>
                    Includes {data.capacity.expectedCampaigns} expected campaign
                    mailing{data.capacity.expectedCampaigns === 1 ? "" : "s"} ·
                    delivery unconfirmed
                  </span>
                )}
                {!!data.capacity.mailboxPackages && (
                  <span>
                    Includes {data.capacity.mailboxPackages} package
                    {data.capacity.mailboxPackages === 1 ? "" : "s"} delivered
                    in/at the mailbox · {data.capacity.packageUnits} estimated
                    letter equivalents
                  </span>
                )}
              </div>
              <button
                className="text-button"
                onClick={() => {
                  setForm(data.settings);
                  setSettings(true);
                }}
              >
                Estimate <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          <nav className="tabs" aria-label="Mail views">
            {(["inbox", "spam", "archive"] as View[]).map((v) => (
              <button
                key={v}
                aria-pressed={view === v}
                onClick={() => changeView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
                <span>{data?.counts[v] || 0}</span>
              </button>
            ))}
          </nav>
        </section>
        {error && (
          <div className="error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <CheckCheck size={19} />
            <span>{toast}</span>
            {data?.pickup && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(
                    () => api(`/pickup/${data.pickup!.id}/undo`, {}),
                    "Pickup undone. Your mail is back.",
                  )
                }
              >
                <Undo2 size={15} />
                Undo pickup
              </button>
            )}
            <button aria-label="Dismiss notice" onClick={() => setToast("")}>
              <X size={17} />
            </button>
          </div>
        )}
        <div className="listbar">
          <span>
            {shownEntries > filtered.length
              ? `${filtered.length} thumbnails · ${shownEntries} entries · repeated promotions grouped`
              : view === "spam"
                ? "Likely advertising · you can correct any item"
                : view === "archive"
                  ? "Collected mail, kept for reference"
                  : sortOrder === "recency"
                    ? "Newest digests first"
                    : "Needs attention first"}
          </span>
          <div className="list-controls">
            <label className="sort-control">
              <span>Sort</span>
              <select
                aria-label="Sort mail"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              >
                <option value="recency">Most recent</option>
                <option value="importance">Most important</option>
              </select>
            </label>
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search mail"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a sender"
              />
            </label>
          </div>
        </div>
        <div className={`workspace ${current ? "has-detail" : ""}`}>
          <div className="gallery" aria-label="Mail thumbnails">
            {filtered.map((item) => (
              <button
                key={item.groupId}
                id={`mail-${item.groupId}`}
                className="card"
                aria-label={`${item.sender}, ${fmt(item.date)}, ${label[item.priority]}${item.occurrences.length > 1 ? `, ${item.occurrences.length} digest entries grouped` : ""}`}
                aria-current={currentGroup?.groupId === item.groupId}
                onClick={() => open(item.id, item.groupId)}
              >
                <div className="thumbnail">
                  {item.image ? (
                    <img
                      src={asset(item.image, true)}
                      alt={`Mail from ${item.sender}`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="missing">
                      <ImageOff size={25} />
                      <span>No image available</span>
                    </div>
                  )}
                  {item.priority === "urgent" && (
                    <span className="urgent-dot" />
                  )}
                  {item.occurrences.length > 1 && (
                    <span className="repeat-badge">
                      {item.campaignId
                        ? `${item.occurrences.length} previews`
                        : `Seen ${item.occurrences.length}×`}
                    </span>
                  )}
                </div>
                <div className="card-info">
                  <strong>{item.sender}</strong>
                  <span className="card-date">
                    {item.occurrences.length > 1
                      ? `${fmt(item.occurrences.at(-1)!.date)} – ${fmt(item.occurrences[0].date)}`
                      : `${fmt(item.date)} digest`}
                    {item.campaignId
                      ? " · expected mailing"
                      : item.imageKind === "representative"
                        ? " · representative image"
                        : ""}
                  </span>
                  <span className={`chip ${item.priority}`}>
                    {item.deadline
                      ? `Due ${fmt(item.deadline)}`
                      : item.category === "spam"
                        ? "Likely advertising"
                        : label[item.priority]}
                  </span>
                </div>
              </button>
            ))}
            {!filtered.length && (
              <div className="empty">
                <span className="empty-icon">
                  {view === "archive" ? (
                    <CheckCheck size={30} />
                  ) : (
                    <Mail size={30} />
                  )}
                </span>
                <h2>
                  {!data
                    ? "Opening your mailbox…"
                    : query
                      ? "No matching mail"
                      : view === "inbox"
                        ? "Nothing waiting here"
                        : view === "spam"
                          ? "No suspected spam"
                          : "No pickups yet"}
                </h2>
                <p>
                  {query
                    ? "Try a different sender or date."
                    : view === "archive"
                      ? "Collected mail will stay here when you mark a pickup."
                      : `Mail from ${data ? fmt(data.startDate) : "your tracking start date"} onward appears here as digests are checked.`}
                </p>
              </div>
            )}
          </div>
          {current && (
            <article className="detail" aria-label="Mail details">
              <div className="detail-nav">
                <button className="back" onClick={() => history.back()}>
                  <ArrowLeft size={17} />
                  <span className="desktop-back">All thumbnails</span>
                  <span className="mobile-back">Back to {view}</span>
                </button>
                <div className="next-prev">
                  <button
                    aria-label="Previous mail"
                    disabled={focusIndex <= 0}
                    onClick={() =>
                      open(
                        filtered[focusIndex - 1].id,
                        filtered[focusIndex - 1].groupId,
                      )
                    }
                  >
                    <ChevronLeft size={19} />
                  </button>
                  <span>
                    {focusIndex + 1} / {filtered.length}
                  </span>
                  <button
                    aria-label="Next mail"
                    disabled={
                      focusIndex < 0 || focusIndex >= filtered.length - 1
                    }
                    onClick={() =>
                      open(
                        filtered[focusIndex + 1].id,
                        filtered[focusIndex + 1].groupId,
                      )
                    }
                  >
                    <ChevronRight size={19} />
                  </button>
                </div>
              </div>
              <div className="eyebrow">
                {current.campaignId
                  ? current.archived
                    ? "Archived campaign"
                    : "Expected mailing · delivery unconfirmed"
                  : current.archived
                    ? "Collected"
                    : "Unfetched"}{" "}
                · {fmt(current.date)} digest
              </div>
              <h2>{current.sender}</h2>
              <span className={`chip ${current.priority}`}>
                {current.category === "spam"
                  ? "Likely advertising"
                  : label[current.priority]}
              </span>
              <div className="full-image">
                {current.image ? (
                  <button
                    aria-label="Expand full mail image"
                    onClick={() => setZoom(current.image)}
                  >
                    <img
                      src={asset(current.image)}
                      alt={`Full mail image from ${current.sender}`}
                    />
                    <span>
                      <ZoomIn size={16} />
                      Expand image
                    </span>
                  </button>
                ) : (
                  <div className="missing">
                    <ImageOff size={36} />
                    <p>USPS did not include a preview for this piece.</p>
                  </div>
                )}
              </div>
              <p className="caption">
                {current.campaignId
                  ? "Campaign preview · not a scan of an individually delivered piece"
                  : current.imageKind === "representative"
                    ? "Mailer-provided representative image · may differ from your physical piece"
                    : current.image
                      ? "Full USPS preview · address side only"
                      : "No USPS image included"}
              </p>
              {currentGroup &&
                (current.campaignId || currentGroup.occurrences.length > 1) && (
                  <section
                    className="repeat-history"
                    aria-label="Promotional image history"
                  >
                    <h3>
                      {current.campaignId
                        ? `One expected mailing · ${currentGroup.occurrences.length} digest appearance${currentGroup.occurrences.length === 1 ? "" : "s"}`
                        : `Same image in ${currentGroup.occurrences.length} digest entries`}
                    </h3>
                    <p className="caption">
                      {current.campaignId
                        ? "USPS repeats this saturation campaign preview. It counts once toward fullness until pickup; delivery is unconfirmed. Select a date for its source and notes."
                        : "Select a date for its details and notes. Each entry still counts toward mailbox fullness."}
                    </p>
                    <div className="repeat-dates">
                      {currentGroup.occurrences.map((entry) => (
                        <button
                          key={entry.id}
                          aria-pressed={entry.id === current.id}
                          onClick={() => setSelected(entry.id)}
                        >
                          {fmt(entry.date)} digest
                          {["important", "urgent"].includes(entry.priority) &&
                            ` · ${label[entry.priority]}`}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              {current.deadline && (
                <div className="deadline">
                  <AlertCircle size={19} />
                  <div>
                    <strong>Visible deadline: {fmt(current.deadline)}</strong>
                    <p>{current.deadlineEvidence}</p>
                  </div>
                </div>
              )}
              <h3>What it looks like</h3>
              <p className="summary">{current.summary}</p>
              <h3>Why it’s here</h3>
              <p className="reason">{current.evidence}</p>
              <p className="caption">
                Classification confidence: {current.confidence}. The contents
                inside are unknown.
              </p>
              {!!current.supplemental.length && (
                <details>
                  <summary>Related image from the digest</summary>
                  {current.supplemental.map((s) => (
                    <button
                      className="supplemental"
                      key={s}
                      onClick={() => setZoom(s)}
                    >
                      <img src={asset(s)} alt="Related mailer image" />
                    </button>
                  ))}
                </details>
              )}
              <div className="corrections">
                <h3>Your call</h3>
                {currentGroup &&
                  (current.campaignId ||
                    currentGroup.occurrences.length > 1) && (
                    <p className="caption correction-scope">
                      {current.campaignId
                        ? "Moving or flagging applies to this mailing and its future previews. Notes belong to the selected digest."
                        : `Changes apply to the selected ${fmt(current.date)} digest entry.`}
                    </p>
                  )}
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void correct({
                        category:
                          current.category === "spam" ? "inbox" : "spam",
                        priority: "normal",
                      })
                    }
                  >
                    {current.category === "spam"
                      ? "Move to Inbox"
                      : "Move to Spam"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void correct({
                        priority: ["important", "urgent"].includes(
                          current.priority,
                        )
                          ? "normal"
                          : "important",
                      })
                    }
                  >
                    {["important", "urgent"].includes(current.priority)
                      ? "Remove flag"
                      : "Flag as important"}
                  </button>
                </div>
                <label className="notes">
                  A note for later
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional note…"
                    maxLength={2000}
                  />
                </label>
                <button
                  disabled={busy || notes === (current.notes || "")}
                  onClick={() => void correct({ notes })}
                >
                  Save note
                </button>
              </div>
              <a
                className="source-link"
                href={`https://mail.google.com/mail/u/0/#all/${current.sourceId}`}
                target="_blank"
                rel="noreferrer"
              >
                View original digest <ArrowUpRight size={15} />
              </a>
            </article>
          )}
        </div>
        <section className="bottom-content">
          {!!data?.packages.filter((p) =>
            view === "archive" ? p.archived : !p.archived,
          ).length && (
            <section className="packages">
              <div className="packages-heading">
                <Package size={20} />
                <h3>Package updates</h3>
              </div>
              <div className="package-grid">
                {data.packages
                  .filter((p) =>
                    view === "archive" ? p.archived : !p.archived,
                  )
                  .map((p) => (
                    <PackageCard key={p.tracking} item={p} today={data.today} />
                  ))}
              </div>
              <p className="caption">
                Each package confirmed delivered in/at the mailbox adds 5 letter
                equivalents until pickup. Package dimensions are unknown.
              </p>
            </section>
          )}
          <footer>
            <div className={stale ? "sync stale" : "sync"}>
              <span className="dot" />
              {data?.sync
                ? `${data.sync.ok ? "Checked" : "Check failed"} ${new Date(data.sync.checked).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                : "First ingestion check pending"}
              {stale && " · attention needed"}
              <span>·</span>
              {data?.digests.length || 0} digests stored
            </div>
            <p>
              USPS previews can arrive before the physical mail and may omit
              some pieces. Fullness is an estimate.
            </p>
            {data?.pickup && (
              <div className="pickup-history">
                Last pickup: {fmt(data.pickup.cutoff)} · resumes with the next
                day’s digest{" "}
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () => api(`/pickup/${data.pickup!.id}/undo`, {}),
                      "Pickup undone. Your mail is back.",
                    )
                  }
                >
                  <Undo2 size={14} />
                  Undo pickup
                </button>
              </div>
            )}
          </footer>
        </section>
      </main>
      {settings && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Close settings"
              onClick={() => setSettings(false)}
            >
              <X />
            </button>
            <div className="eyebrow">Make it yours</div>
            <h2 id="settings-title">Your mailbox</h2>
            <p>
              Small apartment or cluster mailbox. Fullness includes Inbox and
              Spam. Bulky pieces count as more than one letter. Repeated USPS
              saturation campaign previews count as one expected mailing, with
              delivery unconfirmed.
            </p>
            <p>
              Packages confirmed delivered in/at the mailbox add 5 letter
              equivalents each until pickup. This is a conservative allowance;
              USPS tracking does not provide dimensions.
            </p>
            {form && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(
                    () => api("/settings", form, "PATCH"),
                    "Mailbox estimates updated.",
                  );
                }}
              >
                <div className="settings-grid">
                  {(
                    [
                      "warningUnits",
                      "fullUnits",
                      "warningDays",
                      "fullDays",
                    ] as const
                  ).map((key, i) => (
                    <label key={key}>
                      {
                        [
                          "Pickup soon: letter equivalents",
                          "May be full: letter equivalents",
                          "Pickup soon: days",
                          "May be full: days",
                        ][i]
                      }
                      <input
                        type="number"
                        min={1}
                        max={key.includes("Units") ? 200 : 90}
                        required
                        value={form[key]}
                        onChange={(e) =>
                          setForm({ ...form, [key]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                </div>
                <button className="primary" disabled={busy}>
                  Save settings
                </button>
              </form>
            )}
            <hr />
            {native && (
              <>
                <NotificationSettings />
                <hr />
              </>
            )}
            <p>
              Tracking since {data?.startDate || "your configured start date"} ·{" "}
              {data?.timezone || "your configured timezone"}
            </p>
            <p>
              Pickup archives both Inbox and Spam through today. Undo restores
              the previous cutoff, including any late-arriving digests.
            </p>
            {!native && (
              <a className="download" href="/downloads/snail-mail.apk">
                <Download size={17} />
                Download Android app
              </a>
            )}
            <p className="caption">
              Connect Tailscale on your phone and keep the home computer awake.
              Your images stay on the home server.
            </p>
            {data?.sync && !data.sync.ok && (
              <p className="error">{data.sync.detail}</p>
            )}
          </section>
        </div>
      )}
      {zoom && (
        <div
          className="image-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Full mail image"
        >
          <button className="zoom-close" onClick={() => setZoom(null)}>
            <X size={21} />
            Close image
          </button>
          <div>
            <img src={asset(zoom)} alt="Expanded full mail image" />
          </div>
          <p>Pinch to zoom on your phone. The complete image is shown.</p>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
