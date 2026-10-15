import {
  ArrowUpRight,
  CalendarDays,
  Clock3,
  Package,
  PackageCheck,
  Truck,
  MapPin,
  AlertCircle,
} from "lucide-react";

export type PackageUpdate = {
  tracking: string;
  sender: string;
  status: "expected" | "delivered";
  expectedDate: string | null;
  deliveredDate: string | null;
  details: string;
  archived: boolean;
  sourceDate: string;
  mailboxUnits?: number;
  trackingUpdate?: {
    status:
      | "awaiting_usps"
      | "in_transit"
      | "out_for_delivery"
      | "available_for_pickup"
      | "delivered"
      | "exception"
      | "unknown";
    checkedAt: string;
  };
};

const todayDigestDetails =
  "Listed in today’s digest; delivery is not confirmed";
const formatDate = (date: string) =>
  new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

function appearance(item: PackageUpdate, today: string) {
  if (item.status === "delivered")
    return { tone: "delivered", label: "Delivered", Icon: PackageCheck };
  if (item.trackingUpdate) {
    switch (item.trackingUpdate.status) {
      case "awaiting_usps":
        return { tone: "awaiting", label: "Awaiting USPS", Icon: Clock3 };
      case "in_transit":
        return { tone: "expected", label: "In transit", Icon: Truck };
      case "out_for_delivery":
        return { tone: "today", label: "Out for delivery", Icon: Truck };
      case "available_for_pickup":
        return { tone: "today", label: "Ready for pickup", Icon: MapPin };
      case "exception":
        return {
          tone: "exception",
          label: "Delivery issue",
          Icon: AlertCircle,
        };
      default:
        return { tone: "awaiting", label: "Status unavailable", Icon: Package };
    }
  }
  if (item.details === "USPS is awaiting the item")
    return { tone: "awaiting", label: "Awaiting USPS", Icon: Clock3 };
  // A digest preview is an expectation, never confirmation of delivery.
  // Use the server's mailbox date so an old preview doesn't remain "today".
  if (
    item.expectedDate === today ||
    (item.sourceDate === today && item.details === todayDigestDetails)
  )
    return { tone: "today", label: "Expected today", Icon: CalendarDays };
  return { tone: "expected", label: "Expected", Icon: Package };
}

export function PackageCard({
  item,
  today,
}: {
  item: PackageUpdate;
  today: string;
}) {
  const { tone, label, Icon } = appearance(item, today);
  const details =
    item.details === todayDigestDetails
      ? `Listed in the ${formatDate(item.sourceDate)} digest; delivery is not confirmed`
      : item.details || "Awaiting a delivery update";
  return (
    <article
      className="package-card"
      aria-label={`${item.sender || "USPS package"}: ${label}`}
    >
      <div className={`package-thumbnail package-${tone}`}>
        <Icon size={36} strokeWidth={1.6} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="package-info">
        <strong>{item.sender || "USPS package"}</strong>
        <p>{details}</p>
        {!!item.mailboxUnits && (
          <p className="package-date">
            Counts toward fullness · about {item.mailboxUnits} letter
            equivalents
          </p>
        )}
        {item.status === "delivered" ? (
          item.deliveredDate && (
            <p className="package-date">
              Delivered {formatDate(item.deliveredDate)}
            </p>
          )
        ) : item.expectedDate ? (
          <p className="package-date">
            Expected {formatDate(item.expectedDate)}
          </p>
        ) : null}
        <p className="caption">
          {item.trackingUpdate
            ? `USPS checked ${new Date(item.trackingUpdate.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
            : `As of the ${formatDate(item.sourceDate)} digest`}
        </p>
        <span className="package-tracking">{item.tracking}</span>
        <a
          href={`https://tools.usps.com/go/TrackConfirmAction?tLabels=${item.tracking}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Track package ending ${item.tracking.slice(-4)} on USPS`}
        >
          Track package <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      </div>
    </article>
  );
}
