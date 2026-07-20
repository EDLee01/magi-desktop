#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const packagingRoot = path.join(desktopRoot, ".packaging");
const runtimeRoot = path.join(packagingRoot, "windows-runtime");
const magiRuntime = path.join(runtimeRoot, "magi");
const nodeRuntime = path.join(runtimeRoot, "node");
const cacheRoot = path.join(packagingRoot, "cache");

await access(path.join(repositoryRoot, "dist", "cli.js"));
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(magiRuntime, { recursive: true });
await mkdir(nodeRuntime, { recursive: true });
await mkdir(cacheRoot, { recursive: true });

for (const entry of [
  "dist",
  "package.json",
  "package-lock.json",
  "capability-manifest.json",
  "LICENSE"
]) {
  await cp(path.join(repositoryRoot, entry), path.join(magiRuntime, entry), {
    recursive: true
  });
}

const nodeRelease = await resolveNodeRelease();
await installProductionDependencies(nodeRelease.version);
await stageNodeRuntime(nodeRelease);
await verifyWindowsNativeModule();

console.log(`Prepared Magi Windows runtime with Node ${nodeRelease.version}.`);

async function resolveNodeRelease() {
  const checksumsUrl = "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt";
  const response = await fetch(checksumsUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${checksumsUrl}: HTTP ${response.status}`);
  }
  const checksums = await response.text();
  const match = /^([a-f0-9]{64})\s+(node-v([^\s]+)-win-x64\.zip)$/m.exec(checksums);
  if (!match) throw new Error("Could not locate the latest Node 24 Windows x64 archive.");
  return {
    checksum: match[1],
    filename: match[2],
    version: match[3],
    url: `https://nodejs.org/dist/latest-v24.x/${match[2]}`
  };
}

async function installProductionDependencies(nodeVersion) {
  await run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "ci",
    "--omit=dev",
    "--platform=win32",
    "--arch=x64",
    "--no-audit",
    "--no-fund"
  ], {
    cwd: magiRuntime,
    env: {
      ...process.env,
      npm_config_platform: "win32",
      npm_config_arch: "x64",
      npm_config_target: nodeVersion
    }
  });
}

async function stageNodeRuntime(release) {
  const archivePath = path.join(cacheRoot, release.filename);
  let archive;
  try {
    archive = await readFile(archivePath);
  } catch {
    const response = await fetch(release.url);
    if (!response.ok) {
      throw new Error(`Could not download ${release.url}: HTTP ${response.status}`);
    }
    archive = Buffer.from(await response.arrayBuffer());
    await writeFile(archivePath, archive);
  }
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== release.checksum) {
    throw new Error(`Checksum mismatch for ${release.filename}.`);
  }

  const extractRoot = path.join(packagingRoot, "node-extract");
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      archivePath,
      extractRoot
    ]);
  } else {
    await run("unzip", ["-q", archivePath, "-d", extractRoot]);
  }

  const extracted = path.join(extractRoot, release.filename.replace(/\.zip$/, ""));
  await cp(path.join(extracted, "node.exe"), path.join(nodeRuntime, "node.exe"));
  await cp(path.join(extracted, "LICENSE"), path.join(nodeRuntime, "LICENSE.node.txt"));
  await rm(extractRoot, { recursive: true, force: true });
}

async function verifyWindowsNativeModule() {
  const addonPath = path.join(
    magiRuntime,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  const addon = await readFile(addonPath);
  if (addon[0] !== 0x4d || addon[1] !== 0x5a) {
    throw new Error("better-sqlite3 is not a Windows PE binary.");
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}
