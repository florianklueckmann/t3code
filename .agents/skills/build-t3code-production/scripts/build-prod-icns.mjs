#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const source = valueFor("--source");
const output = valueFor("--output");

if (!source || !output) {
  console.error("Usage: build-prod-icns.mjs --source <png> --output <icns>");
  process.exit(2);
}

const sourcePath = resolve(source);
const outputPath = resolve(output);
const temporaryRoot = mkdtempSync(join(tmpdir(), "t3code-prod-icon-"));
const iconsetPath = join(temporaryRoot, "icon.iconset");

const sizes = [16, 32, 128, 256, 512];
const runSips = (size, target) => {
  const result = spawnSync(
    "sips",
    ["-z", String(size), String(size), sourcePath, "--out", target],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `sips failed for ${target}\n`);
    process.exit(result.status ?? 1);
  }
};

import { mkdirSync } from "node:fs";
mkdirSync(iconsetPath, { recursive: true });

for (const size of sizes) {
  runSips(size, join(iconsetPath, `icon_${size}x${size}.png`));
  runSips(size * 2, join(iconsetPath, `icon_${size}x${size}@2x.png`));
}

const entries = [
  ["icp4", "icon_16x16.png"],
  ["icp5", "icon_32x32.png"],
  ["ic07", "icon_128x128.png"],
  ["ic08", "icon_256x256.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
  ["ic11", "icon_16x16@2x.png"],
  ["ic12", "icon_32x32@2x.png"],
  ["ic13", "icon_128x128@2x.png"],
  ["ic14", "icon_256x256@2x.png"],
];

const chunks = entries.map(([type, filename]) => {
  const data = readFileSync(join(iconsetPath, filename));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length + 8);
  return Buffer.concat([Buffer.from(type), length, data]);
});

const totalLength = Buffer.alloc(4);
totalLength.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0));
writeFileSync(outputPath, Buffer.concat([Buffer.from("icns"), totalLength, ...chunks]));
rmSync(temporaryRoot, { recursive: true, force: true });

console.log(outputPath);
