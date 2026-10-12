import React, { useEffect, useState } from "react";
import { App as NativeApp } from "@capacitor/app";
import { Bell } from "lucide-react";
import { MailNotifications, type NotificationStatus } from "./notifications";

export function NotificationSettings() {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      MailNotifications.getStatus()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active)
            setError(
              "Could not read notification settings. Reopen the app and try again.",
            );
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const handle = NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void refresh();
    });
    return () => {
      active = false;
      clearInterval(timer);
      void handle.then((h) => h.remove());
    };
  }, []);
  const run = async (fn: () => Promise<unknown>, notice = "") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setStatus(await MailNotifications.getStatus());
      setMessage(notice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="notification-settings"
      aria-label="Android notifications"
    >
      <h3>
        <Bell size={17} /> Android notifications
      </h3>
      <p>
        Two background checks per day over Tailscale, about 12 hours apart.
        Android may delay checks to save battery.
      </p>
      <p>
        Alerts for important mail, approaching deadlines, stronger fullness
        warnings and check failures. Routine spam stays quiet; notification text
        contains no sender names or images.
      </p>
      {status && (
        <>
          <strong className="notification-state">
            {!status.enabled
              ? "Off"
              : !status.allowed
                ? "Blocked by Android"
                : status.initialized
                  ? "On · twice daily"
                  : "On · waiting for the first check"}
          </strong>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  MailNotifications.setEnabled({ enabled: !status.enabled }),
                )
              }
            >
              {status.enabled
                ? "Turn off notifications"
                : "Enable notifications"}
            </button>
            {status.enabled && (
              <button
                disabled={busy || !status.allowed}
                onClick={() =>
                  void run(
                    () => MailNotifications.checkNow(),
                    "Check queued. Android will run it when a network is available.",
                  )
                }
              >
                Check now
              </button>
            )}
            {status.enabled && (
              <button
                disabled={busy || !status.allowed}
                onClick={() =>
                  void run(
                    () => MailNotifications.testNotification(),
                    "Test notification sent. Tap it to return here.",
                  )
                }
              >
                Send test notification
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => void run(() => MailNotifications.openSettings())}
            >
              Android notification settings
            </button>
          </div>
          {!status.allowed && (
            <p>
              Android notification permission is required. Enable notifications,
              then allow the prompt. If previously denied or muted, use Android
              notification settings.
            </p>
          )}
          <p className="caption">
            The first successful check after enabling sets a quiet baseline.
            Existing mail will not trigger a backlog of alerts.
          </p>
          {status.lastSuccess > 0 && (
            <p className="caption">
              Phone last checked:{" "}
              {new Date(status.lastSuccess).toLocaleString()}
            </p>
          )}
          {status.error && (
            <p className="error" role="alert">
              {status.error}
            </p>
          )}
        </>
      )}
      {!status && !error && <p>Loading notification settings…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="caption">
        Keep Tailscale connected and the home computer awake. Background checks
        resume after a reboot; after force-stopping the app, open it again.
      </p>
    </section>
  );
}
