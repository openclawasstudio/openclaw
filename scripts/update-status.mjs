#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(process.cwd());
// Write feeds into public/ so they are served directly by Vercel at /status.json, /errors.json, /board.json
const PUBLIC_DIR = path.join(ROOT, "public");
const OUT_PATH = path.join(PUBLIC_DIR, "status.json");
const ERR_PATH = path.join(PUBLIC_DIR, "errors.json");
const BOARD_PATH = path.join(PUBLIC_DIR, "board.json");

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
    .some((line) => /\s(public\/(status|errors|board)\.json)$/.test(line));

  if (!changed) {
    process.stdout.write("No status/errors change; skip git push.\n");
    return;
  }

  await execFileAsync("git", ["add", "public/status.json", "public/errors.json", "public/board.json"], { cwd: ROOT });
  await execFileAsync(
    "git",
    ["commit", "-m", `chore: update mission control (${nowIso})`],
    { cwd: ROOT }
  );
  await execFileAsync("git", ["push"], { cwd: ROOT });
  process.stdout.write("Committed + pushed feeds\n");
}

async function safeJson(cmd, args) {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function cronCardStatus(job, lastRun) {
  if (job?.enabled === false) return "disabled";
  const st = lastRun?.status;
  if (st === "error" || st === "failed") return "error";
  if (st === "ok") return "ok";
  return "unknown";
}

function cronColumn(job, lastRun) {
  if (job?.enabled === false) return "done";
  const st = lastRun?.status;
  if (st === "error" || st === "failed") return "blocked";
  return "doing";
}

async function main() {
  const nowIso = new Date().toISOString();
  const shouldPush = process.argv.includes("--push");

  const status = await safeJson("openclaw", ["status", "--json"]);

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

  // Pull last ~250 log lines and keep error/warn lines.
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

  // Build Kanban from cron jobs + last run status.
  let board = {
    note: "Auto-generated from OpenClaw cron jobs. Edit manually only if you disable auto-board.",
    updatedAt: nowIso,
    columns: [
      { id: "backlog", title: "Backlog" },
      { id: "doing", title: "Doing" },
      { id: "blocked", title: "Blocked" },
      { id: "done", title: "Done" }
    ],
    cards: []
  };

  try {
    const cronList = await safeJson("openclaw", ["cron", "list", "--all", "--json"]);
    const jobs = Array.isArray(cronList?.jobs) ? cronList.jobs : Array.isArray(cronList) ? cronList : [];

    for (const j of jobs) {
      const jobId = j.id || j.jobId;
      let lastRun = null;
      try {
        const runs = await safeJson("openclaw", ["cron", "runs", "--id", String(jobId), "--limit", "1", "--json"]);
        lastRun = runs?.entries?.[0] || null;
      } catch {
        // ignore
      }

      const card = {
        id: `cron-${jobId}`,
        title: j.name || `cron ${jobId}`,
        columnId: cronColumn(j, lastRun),
        status: cronCardStatus(j, lastRun),
        updatedAt: nowIso,
        meta: {
          jobId,
          enabled: j.enabled !== false,
          schedule: j.schedule,
          nextRunAtMs: j.state?.nextRunAtMs ?? lastRun?.nextRunAtMs,
          lastRun: lastRun
            ? {
                status: lastRun.status,
                ts: lastRun.ts,
                durationMs: lastRun.durationMs
              }
            : null
        }
      };

      board.cards.push(card);
    }

    // Add a synthetic card that summarizes current warnings.
    const warnCount = errors.lines.filter((l) => /\bwarn\b/i.test(l)).length;
    const errCount = errors.lines.filter((l) => /\berror\b/i.test(l)).length;
    board.cards.push({
      id: "system-errors",
      title: `Errors feed: ${errCount} error / ${warnCount} warn (last 250 lines)`,
      columnId: errCount > 0 ? "blocked" : warnCount > 0 ? "doing" : "done",
      status: errCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok",
      updatedAt: nowIso
    });
  } catch (e) {
    board.cards.push({
      id: "cron-load-failed",
      title: `Failed to load cron jobs: ${String(e)}`,
      columnId: "blocked",
      status: "error",
      updatedAt: nowIso
    });
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fs.writeFile(ERR_PATH, JSON.stringify(errors, null, 2) + "\n", "utf8");
  await fs.writeFile(BOARD_PATH, JSON.stringify(board, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${OUT_PATH} + ${ERR_PATH} + ${BOARD_PATH} @ ${nowIso}\n`);

  if (shouldPush) {
    await gitCommitPushIfChanged(nowIso);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
