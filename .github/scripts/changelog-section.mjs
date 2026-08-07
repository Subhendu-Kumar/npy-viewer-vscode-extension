#!/usr/bin/env node
/**
 * Prints one version's section of the changelog, for use as GitHub release notes.
 *
 *   node .github/scripts/changelog-section.mjs 1.2.3 [CHANGELOG.md]
 *
 * Exits non-zero when the version has no section, so a release cannot be cut
 * with empty or stale notes.
 */

import { readFileSync } from "node:fs";

const version = process.argv[2];
const changelogPath = process.argv[3] ?? "CHANGELOG.md";

if (!version) {
  console.error("usage: changelog-section.mjs <version> [changelog]");
  process.exit(2);
}

let source;
try {
  source = readFileSync(changelogPath, "utf8");
} catch (error) {
  console.error(`Cannot read ${changelogPath}: ${error.message}`);
  process.exit(2);
}

const lines = source.split(/\r?\n/);

// Matches "## [1.2.3] - date", "## 1.2.3", "## v1.2.3" and similar. The version
// is escaped because it contains dots, which are regex wildcards.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`, "i");
const anyHeading = /^##\s/;

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  console.error(
    `No section for version ${version} in ${changelogPath}.\n` +
      `Add a "## [${version}]" heading describing the release before tagging.`,
  );
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (anyHeading.test(lines[i])) {
    end = i;
    break;
  }
}

// Drop the heading itself — the release already carries the version as a title —
// then trim the blank lines that surround the body.
const body = lines.slice(start + 1, end);
while (body.length && body[0].trim() === "") {
  body.shift();
}
while (body.length && body[body.length - 1].trim() === "") {
  body.pop();
}

if (body.length === 0) {
  console.error(`The section for version ${version} is empty.`);
  process.exit(1);
}

process.stdout.write(`${body.join("\n")}\n`);
