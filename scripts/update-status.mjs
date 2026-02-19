#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(process.cwd());
const OUT_PATH = path.join(ROOT, "status.json");
const ERR_PATH = path.join(ROOT, "errors.json");

function guessDiscordOk(channelSummary) {
  if (!Array.isArray(channelSummary)) return undefined;
  // Examples: "Discord: configured", "Discord: ON", etc.
  return channelSummary.some((s) => typeof s === "string" && s.toLowerCase().includes("discord:"));
}

function normalizeModel(m) {
  if (!m) return undefined;
  // status --json returns e.g. "gpt-5.2"; we store the provider-qualified model for clarity.
  if (m.includes("/")) return m;
  return `openai-codex/${m}`;
}

async function gitCommitPushIfChanged(nowIso) {
  // If status.json or errors.json changed, commit + push.
  const { stdout: por } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: ROOT
  });

  const changed = por
    .split("\n")
    .filter(Boolean)
    .some((line) => /\s(status\.json|errors\.json)$/.test(line));

  if (!changed) {
    process.stdout.write("No status/errors change; skip git push.\n");
    return;
  }

  await execFileAsync("git", ["add", "status.json", "errors.json"], { cwd: ROOT });
  await execFileAsync(
    "git",
    ["commit", "-m", `chore: update feeds (${nowIso})`],
    { cwd: ROOT }
  );
  await execFileAsync("git", ["push"], { cwd: ROOT });
  process.stdout.write("Committed + pushed feeds\n");
}

async function main() {
  const nowIso = new Date().toISOString();
  const shouldPush = process.argv.includes("--push");

  const { stdout } = await execFileAsync("openclaw", ["status", "--json"], {
    maxBuffer: 10 * 1024 * 1024
  });

  const status = JSON.parse(stdout);

  const payload = {
    note: "Auto-generated. Public. Do not put secrets here.",
    updatedAt: nowIso,
    gateway: {
      ok: true,
      dashboard: status?.dashboardUrl || status?.dashboard || "http://127.0.0.1:18789/"
    },
    discord: {
      ok: guessDiscordOk(status?.channelSummary),
      summary: status?.channelSummary
    },
    model: normalizeModel(status?.sessions?.defaults?.model),
    sessions: status?.sessions?.count,
    raw: {
      heartbeat: status?.heartbeat,
      queuedSystemEvents: status?.queuedSystemEvents?.length ?? 0
    }
  };

  // Pull last ~200 log lines and keep error/warn lines.
  let errorLines = [];
  try {
    const { stdout: logs } = await execFileAsync(
      "openclaw",
      ["logs", "--limit", "250", "--plain"],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    errorLines = logs
      .split("\n")
      .filter((l) => /\b(error|warn)\b/i.test(l))
      .slice(-40);
  } catch (e) {
    errorLines = [`Failed to fetch logs: ${String(e)}`];
  }

  const errors = {
    note: "Auto-generated from gateway logs (filtered warn/error). Public.",
    updatedAt: nowIso,
    lines: errorLines
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fs.writeFile(ERR_PATH, JSON.stringify(errors, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${OUT_PATH} + ${ERR_PATH} @ ${nowIso}\n`);

  if (shouldPush) {
    await gitCommitPushIfChanged(nowIso);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
