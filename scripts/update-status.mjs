#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(process.cwd());
const OUT_PATH = path.join(ROOT, "status.json");

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
  // If status.json changed, commit + push.
  const { stdout: por } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: ROOT
  });
  const changed = por
    .split("\n")
    .filter(Boolean)
    .some((line) => line.endsWith(" status.json") || line.endsWith("status.json"));

  if (!changed) {
    process.stdout.write("No status.json change; skip git push.\n");
    return;
  }

  await execFileAsync("git", ["add", "status.json"], { cwd: ROOT });
  await execFileAsync(
    "git",
    ["commit", "-m", `chore: update status.json (${nowIso})`],
    { cwd: ROOT }
  );
  await execFileAsync("git", ["push"], { cwd: ROOT });
  process.stdout.write("Committed + pushed status.json\n");
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

  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${OUT_PATH} @ ${nowIso}\n`);

  if (shouldPush) {
    await gitCommitPushIfChanged(nowIso);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
