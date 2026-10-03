#!/usr/bin/env node
/**
 * Rejects commit subjects that Release Please can't classify.
 * Usage: node scripts/check-commit-message.mjs --message "<subject>"
 */
const i = process.argv.indexOf("--message");
const subject = (i >= 0 ? process.argv[i + 1] : "")?.trim() ?? "";
const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"];
const pattern = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: \\S`);

if (subject.startsWith("Merge ") || pattern.test(subject)) process.exit(0);
console.error(`Not a Conventional Commit subject: "${subject}"`);
console.error(`Use <type>[(scope)][!]: <summary>, with type one of: ${TYPES.join(", ")}`);
process.exit(1);
