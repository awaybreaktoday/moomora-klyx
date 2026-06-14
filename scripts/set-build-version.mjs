#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.argv[2] ?? "";
const version = raw.replace(/^v/, "");
const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);

if (!match) {
  console.error("usage: node scripts/set-build-version.mjs <version>");
  console.error("version must be stable SemVer, for example 0.2.0 or v0.2.0");
  process.exit(2);
}

const [, major, minor, patch] = match;
const windowsVersion = `${major}.${minor}.${patch}.0`;

function repoPath(file) {
  return path.join(root, file);
}

function read(file) {
  return fs.readFileSync(repoPath(file), "utf8");
}

function write(file, content) {
  fs.writeFileSync(repoPath(file), content);
  console.log(`versioned ${file}`);
}

function replaceChecked(file, pattern, replacement) {
  const before = read(file);
  if (!pattern.test(before)) {
    throw new Error(`no version replacement matched in ${file}`);
  }
  const after = before.replace(pattern, replacement);
  write(file, after);
}

function setJSON(file, update) {
  const data = JSON.parse(read(file));
  update(data);
  write(file, `${JSON.stringify(data, null, "\t")}\n`);
}

function setPlistVersion(file) {
  let content = read(file);
  const shortPattern = /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/;
  const buildPattern = /(<key>CFBundleVersion<\/key>\s*<string>)([^<]+)(<\/string>)/;
  if (!shortPattern.test(content) || !buildPattern.test(content)) {
    throw new Error(`no bundle version keys found in ${file}`);
  }
  content = content
    .replace(shortPattern, `$1${version}$3`)
    .replace(buildPattern, `$1${version}$3`);
  write(file, content);
}

replaceChecked(
  "cmd/klyx/build/config.yml",
  /^(\s*version:\s*")[^"]+(".*# The application version.*)$/m,
  `$1${version}$2`,
);
replaceChecked("cmd/klyx/build/linux/nfpm/nfpm.yaml", /^version: "[^"]+"/m, `version: "${version}"`);

setPlistVersion("cmd/klyx/build/darwin/Info.plist");
setPlistVersion("cmd/klyx/build/darwin/Info.dev.plist");
setPlistVersion("cmd/klyx/build/ios/Info.plist");

setJSON("cmd/klyx/build/windows/info.json", (data) => {
  data.fixed.file_version = version;
  data.info["0000"].ProductVersion = version;
});

replaceChecked(
  "cmd/klyx/build/windows/wails.exe.manifest",
  /(<assemblyIdentity[^>]*\bname="io\.moomora\.klyx"[^>]*\bversion=")[^"]+("[^>]*\/>)/,
  `$1${windowsVersion}$2`,
);
replaceChecked("cmd/klyx/build/windows/msix/app_manifest.xml", /Version="[^"]+"/, `Version="${windowsVersion}"`);
replaceChecked("cmd/klyx/build/windows/msix/template.xml", /Version="[^"]+"/, `Version="${windowsVersion}"`);
replaceChecked("cmd/klyx/build/windows/nsis/wails_tools.nsh", /!define INFO_PRODUCTVERSION "[^"]+"/, `!define INFO_PRODUCTVERSION "${version}"`);

console.log(`Klyx build metadata set to ${version}`);
