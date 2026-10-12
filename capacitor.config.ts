import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "app.snailmail.local",
  appName: "Snail Mail",
  webDir: "dist",
  android: { backgroundColor: "#f5f4f0" },
  server: { androidScheme: "https" },
};
export default config;
