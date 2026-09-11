#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const [, , categoryTitle, outputDirArg = "./raw-photos", limitArg = "10"] = process.argv;

if (!categoryTitle) {
  console.error(
    "Usage: node fetchFromCommons.mjs \"Category Name\" [outputDir] [limit]\nExample: node fetchFromCommons.mjs \"Stubble burning\" ./raw-photos/crop_residue_burning 10"
  );
  process.exit(1);
}

const limit = Number.parseInt(limitArg, 10);
const maxFiles = Number.isFinite(limit) && limit > 0 ? limit : 10;
const outputDir = path.resolve(process.cwd(), outputDirArg);
const category = categoryTitle.trim();

await fs.mkdir(outputDir, { recursive: true });
const seen = new Set();
const collected = [];

const api = "https://commons.wikimedia.org/w/api.php";
const query = new URLSearchParams({
  origin: "*",
  action: "query",
  generator: "categorymembers",
  gcmtitle: `Category:${category}`,
  gcmtype: "file",
  prop: "imageinfo",
  iiprop: "url|extmetadata",
  iiurlwidth: "2000",
  format: "json",
  formatversion: "2",
  gcmlimit: String(Math.min(maxFiles, 50)),
});

let continueToken = "";
let pageCount = 0;

while (true) {
  if (continueToken) {
    query.set("gcmcontinue", continueToken);
  }

  const res = await fetch(`${api}?${query.toString()}`);
  if (!res.ok) {
    throw new Error(`Commons API request failed (${res.status} ${res.statusText})`);
  }

  const data = await res.json();
  const pages = data?.query?.pages ?? [];

  for (const page of pages) {
    if (pageCount >= maxFiles) break;
    if (page.ns !== 6) continue;
    const fileName = page.title.replace(/^File:/, "");
    if (seen.has(fileName)) continue;
    seen.add(fileName);

    const info = page.imageinfo?.[0];
    const downloadUrl =
      info?.url || `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}`;

    const extMetadata = info?.extmetadata ?? {};
    const licenseName = extMetadata.LicenseShortName?.value || "Unknown";
    const attribution = extMetadata.Credit?.value || extMetadata.Artist?.value || "Unknown";

    if (!downloadUrl) continue;

    try {
      const imageRes = await fetch(downloadUrl);
      if (!imageRes.ok) {
        console.warn(`Skipping ${fileName}: download failed (${imageRes.status})`);
        continue;
      }

      const bytes = Buffer.from(await imageRes.arrayBuffer());
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const targetPath = path.join(outputDir, safeName);
      await fs.writeFile(targetPath, bytes);

      collected.push({
        fileName,
        downloadUrl,
        localPath: path.relative(process.cwd(), targetPath),
        license: licenseName,
        attribution,
        sourcePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName).replace(/%20/g, "_")}`,
      });
      pageCount += 1;
    } catch (error) {
      console.warn(`Unable to fetch ${fileName}:`, error instanceof Error ? error.message : String(error));
    }

    if (pageCount >= maxFiles) break;
  }

  continueToken = data?.continue?.gcmcontinue ?? "";
  if (!continueToken || pageCount >= maxFiles) break;
}

const manifestPath = path.join(outputDir, "sources.json");
await fs.writeFile(
  manifestPath,
  JSON.stringify(
    {
      categoryTitle: category,
      generatedAt: new Date().toISOString(),
      files: collected,
    },
    null,
    2
  )
);

console.log(`Saved ${collected.length} files to ${outputDir}`);
console.log(`Manifest: ${manifestPath}`);
