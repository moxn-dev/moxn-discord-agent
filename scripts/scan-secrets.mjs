import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  {
    name: "private key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: "Moxn API key",
    expression: /\bmoxn__[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    name: "OpenAI API key",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "Discord bot token",
    expression:
      /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    name: "populated secret environment assignment",
    expression:
      /^(?:DISCORD_BOT_TOKEN|TEMPORAL_API_KEY|MOXN_API_KEY|MOXN_MCP_TOKEN)[ \t]*=[ \t]*[^ \t\r\n#][^\r\n]*$/gim,
  },
];

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function inspect(label, content, findings) {
  for (const { name, expression } of patterns) {
    expression.lastIndex = 0;
    if (expression.test(content)) findings.push(`${label}: ${name}`);
  }
}

const findings = [];
const files = trackedFiles();
for (const file of files) {
  if (/(^|\/)(?:\.env|auth\.json|credentials-[^/]+\.json)$/.test(file)) {
    findings.push(`${file}: sensitive filename is tracked`);
    continue;
  }
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  inspect(file, bytes.toString("utf8"), findings);
}

if (process.argv.includes("--history")) {
  const history = execFileSync(
    "git",
    ["log", "--all", "--full-history", "--no-color", "-p"],
    { encoding: "utf8", maxBuffer: 50_000_000 },
  );
  inspect("git history", history, findings);
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.info(
  `Secret scan passed for ${files.length} tracked file(s)${process.argv.includes("--history") ? " and Git history" : ""}.`,
);
