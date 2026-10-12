import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NotificationStatus = {
  enabled: boolean;
  allowed: boolean;
  initialized: boolean;
  lastAttempt: number;
  lastSuccess: number;
  error: string;
  intervalHours: number;
};
export type NotificationOpen = {
  target: "" | "mail" | "mailbox" | "settings";
  itemId: string;
};
export const MailNotifications = registerPlugin<{
  getStatus(): Promise<NotificationStatus>;
  setEnabled(options: { enabled: boolean }): Promise<NotificationStatus>;
  checkNow(): Promise<NotificationStatus>;
  testNotification(): Promise<void>;
  openSettings(): Promise<void>;
  consumeOpen(): Promise<NotificationOpen>;
  addListener(
    event: "notificationOpen",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}>("MailNotifications");
