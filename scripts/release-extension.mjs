#!/usr/bin/env node
/**
 * Tag the current commit as v{manifest.version} and push so
 * .github/workflows/release.yml builds zips and attaches them
 * to a GitHub Release.
 *
 * Usage: npm run release
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "extension", "manifest.json");
const version = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;

if (!/^\d+\.\d+\.\d+([.+-][\w.-]+)?$/.test(version)) {
  console.error(`Invalid extension version in manifest.json: ${version}`);
  process.exit(1);
}

const tag = `v${version}`;

function run(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

const existing = run(`git tag -l ${JSON.stringify(tag)}`);
if (existing === tag) {
  console.error(`Tag ${tag} already exists. Bump extension/manifest.json version first.`);
  process.exit(1);
}

const status = run("git status --porcelain");
if (status) {
  console.error("Working tree is dirty. Commit (or stash) changes before releasing.");
  console.error(status);
  process.exit(1);
}

run(`git tag -a ${JSON.stringify(tag)} -m ${JSON.stringify(`Personal Shield ${version}`)}`);
run(`git push origin ${JSON.stringify(tag)}`);

console.log(`Pushed ${tag}. GitHub Actions will attach chromium + firefox zips to the release.`);
console.log(`https://github.com/${run("git config --get remote.origin.url").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "")}/releases/tag/${tag}`);
