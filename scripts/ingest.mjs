import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sharp from "sharp";
import { importSchema, START_DATE } from "../server/store.mjs";
import { readConfig } from "../server/config.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const data = resolve(process.env.SNAIL_DATA_DIR || join(root, "data"));
export function parseSource(s, options = {}) {
  const headers = Object.fromEntries(
    s.headers.map((h) => [h.name.toLowerCase(), h.value]),
  );
  if (
    !/^USPSInformeddelivery@email\.informeddelivery\.usps\.com$/i.test(
      (headers.from.match(/<([^>]+)>/)?.[1] || headers.from).trim(),
    )
  )
    throw new Error("Unexpected sender");
  const auth = headers["authentication-results"] || "";
  if (
    !/dmarc=pass[^;]*header\.from=(?:email\.informeddelivery\.)?usps\.com(?:\s|;|$)/i.test(
      auth,
    ) ||
    !/dkim=pass[^;]*header\.i=@email\.informeddelivery\.usps\.com/i.test(auth)
  )
    throw new Error("Sender authentication not verified");
  const date = s.text?.match(/Today's Deliveries:\s*(\d{2})\/(\d{2})\/(\d{4})/);
  if (!date) throw new Error("Digest date missing; review new template");
  const dateISO = `${date[3]}-${date[1]}-${date[2]}`;
  if (dateISO < (options.startDate || START_DATE))
    throw new Error("Before tracking start");
  const $ = cheerio.load(s.html);
  const countText = $('[id="total-mailpieces"]').first().text().trim();
  if (!/^\d+$/.test(countText)) throw new Error("Mail count missing");
  const count = Number(countText);
  const seen = new Set();
  const pieces = [];
  $(
    'img[id="mailpiece-image-src-id"], img[id="campaign-representative-image-src-id"]',
  ).each((i, e) => {
    const src = $(e).attr("src") || "";
    if (!src.startsWith("cid:"))
      throw new Error("Non-inline mail image requires manual review");
    const filename = src.slice(4);
    if (seen.has(filename)) return;
    seen.add(filename);
    const part = s.attachments.find(
      (a) =>
        a.filename === filename || a.cid?.replace(/[<>]/g, "") === filename,
    );
    if (!part) throw new Error("Inline image missing MIME attachment");
    const representative =
      !/^\d+-\d+\.(?:jpg|png)$/i.test(part.filename) &&
      $(e).attr("id").startsWith("campaign");
    const saturation = $(e).closest('[id="sat-campaign"]').length > 0;
    const campaignId = saturation
      ? part.filename.match(/^mailer-(\d{1,30})\.(?:jpg|png)$/i)?.[1]
      : null;
    if (saturation && (!representative || !campaignId))
      throw new Error(
        "Unrecognized saturation campaign; review source identity",
      );
    let supplemental = [];
    for (const parent of $(e).parents().toArray()) {
      if (
        $(parent).find(
          'img[id="mailpiece-image-src-id"], img[id="campaign-representative-image-src-id"]',
        ).length > 1
      )
        break;
      const related = $(parent)
        .find('img[id="campaign-ridealong-image-src-id"]')
        .map((i, img) => ($(img).attr("src") || "").replace(/^cid:/, ""))
        .get();
      if (related.length) {
        supplemental = [...new Set(related)]
          .map(
            (cid) =>
              s.attachments.find(
                (a) =>
                  a.filename === cid || a.cid?.replace(/[<>]/g, "") === cid,
              )?.filename,
          )
          .filter((f) => f && f !== part.filename);
        break;
      }
    }
    pieces.push({
      key: String(pieces.length + 1),
      filename: part.filename,
      supplemental,
      imageKind: representative ? "representative" : "scan",
      campaignId,
    });
  });
  if (pieces.length > count)
    throw new Error("More primary images than advertised pieces; do not guess");
  // USPS may explicitly count pieces for which no image is supplied.
  while (pieces.length < count)
    pieces.push({
      key: String(pieces.length + 1),
      filename: null,
      supplemental: [],
      imageKind: "unavailable",
    });
  const packageMap = new Map();
  $('[id="pra-tracking-number-id"]').each((i, e) => {
    const tracking = $(e).text().trim().replace(/\s/g, "");
    if (!/^[A-Z0-9]{10,40}$/.test(tracking))
      throw new Error("Unexpected package tracking number");
    const area =
      $(e)
        .parents(
          '[id="awaiting-sender-package-div"], [id="soon-package-div"], [id="today-package-div"]',
        )
        .first()
        .attr("id") || "";
    packageMap.set(tracking, {
      tracking,
      sender: "USPS package",
      status: "expected",
      expectedDate: null,
      deliveredDate: null,
      details: area.includes("awaiting")
        ? "USPS is awaiting the item"
        : area.includes("today")
          ? "Listed in today’s digest; delivery is not confirmed"
          : "An inbound package is listed in the digest",
    });
  });
  return {
    sourceId: s.id,
    date: dateISO,
    advertisedCount: count,
    subject: headers.subject || "USPS Informed Delivery",
    pieces,
    packages: [...packageMap.values()],
  };
}

export async function download(dir, localOnly = false) {
  const source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8"));
  const parsed = parseSource(source, readConfig(data));
  const filenames = new Set(
    parsed.pieces
      .flatMap((p) => [p.filename, ...p.supplemental])
      .filter(Boolean),
  );
  const downloads = localOnly
    ? [...filenames].map((filename) => ({ filename }))
    : JSON.parse(readFileSync(join(dir, "downloads.json"), "utf8"));
  const assets = {};
  mkdirSync(join(dir, "originals"), { recursive: true });
  mkdirSync(join(data, "images"), { recursive: true });
  mkdirSync(join(data, "thumbs"), { recursive: true });
  for (const d of downloads) {
    if (
      !source.attachments.some((a) => a.filename === d.filename) ||
      basename(d.filename) !== d.filename
    )
      throw new Error("Unlisted attachment filename");
    if (!filenames.has(d.filename)) continue; // Ignore logos outside mail previews.
    const target = join(dir, "originals", d.filename);
    let buffer;
    if (existsSync(target)) {
      if (statSync(target).size > 15 * 1024 * 1024)
        throw new Error("Image exceeds size limit");
      buffer = readFileSync(target);
    } else {
      if (localOnly)
        throw new Error(`Original attachment missing: ${d.filename}`);
      const url = new URL(d.url);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".oaiusercontent.com")
      )
        throw new Error(
          "Expected Gmail connector download URL; use assets for locally saved attachments",
        );
      const r = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error(`Attachment download failed: ${r.status}`);
      const length = Number(r.headers.get("content-length"));
      if (length > 15 * 1024 * 1024)
        throw new Error("Image exceeds size limit");
      buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length > 15 * 1024 * 1024)
        throw new Error("Image exceeds size limit");
      writeFileSync(target, buffer);
    }
    const meta = await sharp(buffer, { limitInputPixels: 30000000 }).metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format))
      throw new Error("Unsupported image");
    const hash = createHash("sha256").update(buffer).digest("hex") + ".jpg";
    if (!existsSync(join(data, "images", hash)))
      await sharp(buffer, { limitInputPixels: 30000000 })
        .rotate()
        .jpeg({ quality: 95 })
        .toFile(join(data, "images", hash));
    if (!existsSync(join(data, "thumbs", hash)))
      await sharp(buffer, { limitInputPixels: 30000000 })
        .rotate()
        .resize({
          width: 600,
          height: 300,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toFile(join(data, "thumbs", hash));
    assets[d.filename] = hash;
  }
  writeFileSync(join(dir, "assets.json"), JSON.stringify(assets, null, 2));
  console.log(`Validated ${Object.keys(assets).length} image assets`);
}
export function prepare(parsed, assets, classifications) {
  return importSchema.parse({
    sourceId: parsed.sourceId,
    date: parsed.date,
    advertisedCount: parsed.advertisedCount,
    subject: parsed.subject,
    packages: parsed.packages,
    items: parsed.pieces.map((p) => {
      const c = classifications[p.key];
      if (!c) throw new Error(`Classification missing for piece ${p.key}`);
      if (p.filename && !assets[p.filename])
        throw new Error("Image not downloaded");
      return {
        ...c,
        evidence: p.campaignId
          ? c.evidence.replace(
              " Repeated images on different digest dates are counted separately.",
              "",
            )
          : c.evidence,
        key: p.key,
        image: p.filename ? assets[p.filename] : null,
        supplemental: p.supplemental.map((f) => {
          if (!assets[f]) throw new Error("Supplemental image missing");
          return assets[f];
        }),
        imageKind: p.imageKind,
        campaignId: p.campaignId || null,
      };
    }),
  });
}
async function call(path, body) {
  const config = existsSync(join(data, "config.json"))
    ? JSON.parse(readFileSync(join(data, "config.json"), "utf8"))
    : {};
  const r = await fetch(
    `http://127.0.0.1:${config.port || 4318}/api/ingest/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readFileSync(join(data, "ingestion.key"), "utf8").trim()}`,
      },
      body: JSON.stringify(body),
    },
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
async function main() {
  const [command, input, ...args] = process.argv.slice(2);
  if (command === "run") {
    console.log(
      await call("run", { ok: input === "ok", detail: args.join(" ") }),
    );
    return;
  }
  const dir = resolve(input || "");
  if (
    !dir.startsWith(join(data, "staging") + "\\") &&
    !dir.startsWith(join(data, "staging") + "/")
  )
    throw new Error("Use a digest directory inside data/staging");
  if (command === "parse") {
    const parsed = parseSource(
      JSON.parse(readFileSync(join(dir, "source.json"), "utf8")),
      readConfig(data),
    );
    writeFileSync(join(dir, "parsed.json"), JSON.stringify(parsed, null, 2));
    console.log(JSON.stringify(parsed, null, 2));
  } else if (command === "download" || command === "assets")
    await download(dir, command === "assets");
  else if (command === "commit") {
    const get = (n) => JSON.parse(readFileSync(join(dir, n + ".json"), "utf8"));
    const parsed = parseSource(get("source"), readConfig(data));
    const manifest = prepare(
      parsed,
      existsSync(join(dir, "assets.json")) ? get("assets") : {},
      get("classifications"),
    );
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    const result = await call("import", manifest);
    const config = existsSync(join(data, "config.json"))
      ? JSON.parse(readFileSync(join(data, "config.json"), "utf8"))
      : {};
    const state = await (
      await fetch(`http://127.0.0.1:${config.port || 4318}/api/state`)
    ).json();
    if (
      !state.digests.some((d) => d.id === manifest.sourceId) ||
      state.items.filter((i) => i.sourceId === manifest.sourceId).length !==
        manifest.advertisedCount
    )
      throw new Error("Import readback did not reconcile");
    for (const item of manifest.items) {
      const saved = state.items.find(
        (i) => i.id === `${manifest.sourceId}:${item.key}`,
      );
      if (
        !saved ||
        saved.image !== item.image ||
        (saved.campaignId || null) !== item.campaignId
      )
        throw new Error("Import readback source identity did not reconcile");
    }
    console.log({ ...result, verified: true });
  } else
    throw new Error(
      "Usage: node scripts/ingest.mjs parse|download|assets|commit data/staging/MESSAGE_ID, or run ok|failed DETAIL",
    );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
