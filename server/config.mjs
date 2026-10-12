import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const configSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(4318),
    publicOrigin: z
      .string()
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.hostname.endsWith(".ts.net") &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        } catch {
          return false;
        }
      }, "Use your private Tailscale HTTPS origin, without a path"),
    allowedLogin: z.string().default(""),
    startDate: z
      .string()
      .default("1970-01-01")
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          !Number.isNaN(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value,
        "Use a valid YYYY-MM-DD start date",
      ),
    timezone: z
      .string()
      .default("UTC")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use an IANA timezone such as America/New_York"),
  })
  .strict()
  .refine(
    (value) => !value.publicOrigin || !!value.allowedLogin.trim(),
    "Remote access requires your Tailscale login identity",
  );

export function readConfig(dir) {
  const path = join(dir, "config.json");
  return configSchema.parse(
    existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
      : {},
  );
}
