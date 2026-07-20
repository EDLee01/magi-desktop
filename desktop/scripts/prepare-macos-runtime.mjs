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
const runtimeRoot = path.join(packagingRoot, "macos-runtime");
const magiRuntime = path.join(runtimeRoot, "magi");
const nodeRuntime = path.join(runtimeRoot, "node");
const cacheRoot = path.join(packagingRoot, "cache");
const targetArch = process.argv[2] ?? process.arch;

if (process.platform !== "darwin") {
  throw new Error("The macOS runtime must be prepared on a macOS runner.");
}
if (!new Set(["arm64", "x64"]).has(targetArch)) {
  throw new Error(`Unsupported macOS architecture: ${targetArch}`);
}
if (process.arch !== targetArch) {
  throw new Error(
    `Native packaging is required: runner is ${process.arch}, requested ${targetArch}.`
  );
}

await access(path.join(repositoryRoot, "dist", "cli.js"));
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(magiRuntime, { recursive: true });
await mkdir(path.join(nodeRuntime, "bin"), { recursive: true });
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
await verifyNativeBinaries();

console.log(
  `Prepared Magi macOS ${targetArch} runtime with Node ${nodeRelease.version}.`
);

async function resolveNodeRelease() {
  const checksumsUrl = "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt";
  const response = await fetch(checksumsUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${checksumsUrl}: HTTP ${response.status}`);
  }
  const checksums = await response.text();
  const filenamePattern = `node-v([^\\s]+)-darwin-${targetArch}\\.tar\\.gz`;
  const match = new RegExp(`^([a-f0-9]{64})\\s+(${filenamePattern})$`, "m").exec(
    checksums
  );
  if (!match) {
    throw new Error(`Could not locate the latest Node 24 macOS ${targetArch} archive.`);
  }
  return {
    checksum: match[1],
    filename: match[2],
    version: match[3],
    url: `https://nodejs.org/dist/latest-v24.x/${match[2]}`
  };
}

async function installProductionDependencies(nodeVersion) {
  await run("npm", [
    "ci",
    "--omit=dev",
    "--platform=darwin",
    `--arch=${targetArch}`,
    "--no-audit",
    "--no-fund"
  ], {
    cwd: magiRuntime,
    env: {
      ...process.env,
      npm_config_platform: "darwin",
      npm_config_arch: targetArch,
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
  await run("tar", ["-xzf", archivePath, "-C", extractRoot]);

  const extracted = path.join(extractRoot, release.filename.replace(/\.tar\.gz$/, ""));
  await cp(path.join(extracted, "bin", "node"), path.join(nodeRuntime, "bin", "node"));
  await cp(path.join(extracted, "LICENSE"), path.join(nodeRuntime, "LICENSE.node.txt"));
  await rm(extractRoot, { recursive: true, force: true });
}

async function verifyNativeBinaries() {
  const expectedArch = targetArch === "x64" ? "x86_64" : "arm64";
  const addonPath = path.join(
    magiRuntime,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  await access(addonPath);
  await run("lipo", ["-verify_arch", expectedArch, path.join(nodeRuntime, "bin", "node")]);
  await run("lipo", ["-verify_arch", expectedArch, addonPath]);
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
