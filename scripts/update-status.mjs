#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(process.cwd());
// Write feeds into public/ so they are served directly by Vercel at /status.json, /errors.json, /board.json
// Also mirror them at repo root for local tooling/grep convenience.
const PUBLIC_DIR = path.join(ROOT, "public");

const OUT_PATH = path.join(PUBLIC_DIR, "status.json");
const ERR_PATH = path.join(PUBLIC_DIR, "errors.json");
const BOARD_PATH = path.join(PUBLIC_DIR, "board.json");
const ACTIVITY_PATH = path.join(PUBLIC_DIR, "activity.json");

const OUT_PATH_ROOT = path.join(ROOT, "status.json");
const ERR_PATH_ROOT = path.join(ROOT, "errors.json");
const BOARD_PATH_ROOT = path.join(ROOT, "board.json");
const ACTIVITY_PATH_ROOT = path.join(ROOT, "activity.json");

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
    .some((line) =>
      /\s((public\/)?(status|errors|board|activity)\.json)$/.test(line)
    );

  if (!changed) {
    process.stdout.write("No status/errors change; skip git push.\n");
    return;
  }

  await execFileAsync(
    "git",
    [
      "add",
      "public/status.json",
      "public/errors.json",
      "public/board.json",
      "public/activity.json",
      "status.json",
      "errors.json",
      "board.json",
      "activity.json"
    ],
    { cwd: ROOT }
  );
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

function toIso(ts, fallbackIso) {
  if (!ts) return fallbackIso;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString();
  }
  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? fallbackIso : d.toISOString();
  }
  return fallbackIso;
}

function sevFromCronStatus(st, enabled = true) {
  if (enabled === false) return "info";
  if (st === "error" || st === "failed") return "error";
  if (st === "ok") return "ok";
  if (st === "warn") return "warn";
  return "info";
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round((ms / 1000) * 10) / 10;
  return `${s}s`;
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

  // Activity feed (cron + git + sessions). Public. Keep it lightweight.
  const activity = {
    updatedAt: nowIso,
    events: []
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
    // Prefer the CLI (it may query the gateway), but fall back to local cron state files
    // so Mission Control still updates when the gateway is unreachable from this process.
    let jobs = [];
    try {
      const cronList = await safeJson("openclaw", ["cron", "list", "--all", "--json"]);
      jobs = Array.isArray(cronList?.jobs) ? cronList.jobs : Array.isArray(cronList) ? cronList : [];
    } catch (e) {
      const jobsPath = path.join(process.env.HOME || "", ".openclaw", "cron", "jobs.json");
      try {
        const raw = JSON.parse(await fs.readFile(jobsPath, "utf8"));
        jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
        activity.events.push({
          ts: nowIso,
          type: "cron",
          title: "Cron feed fallback",
          summary: `openclaw cron list failed; using ${jobsPath}`,
          severity: "warn",
          meta: { error: String(e) }
        });
      } catch (e2) {
        throw new Error(`openclaw cron list failed (${String(e)}), and local fallback failed (${String(e2)})`);
      }
    }

    for (const j of jobs) {
      const jobId = j.id || j.jobId;
      let lastRun = null;
      try {
        const runs = await safeJson("openclaw", ["cron", "runs", "--id", String(jobId), "--limit", "1", "--json"]);
        lastRun = runs?.entries?.[0] || null;
      } catch {
        // Fallback: read local runs file (JSONL) and parse the last entry.
        try {
          const p = path.join(
            process.env.HOME || "",
            ".openclaw",
            "cron",
            "runs",
            `${String(jobId)}.jsonl`
          );
          const txt = await fs.readFile(p, "utf8");
          const lines = txt.split("\n").filter(Boolean);
          const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
          // Normalize to the shape used below.
          lastRun = last?.entry || last?.run || last;
        } catch {
          // ignore
        }
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

      // Activity event for this job (last run summary). If error, also fetch last 3 runs.
      const last = card.meta?.lastRun;
      const enabled = card.meta?.enabled !== false;
      const lastSt = last?.status;
      const lastTsIso = toIso(last?.ts, nowIso);
      activity.events.push({
        ts: lastTsIso,
        type: "cron",
        title: `Cron: ${card.title}`,
        summary: last
          ? `${lastSt || "unknown"} · duration ${fmtDur(last.durationMs)}`
          : enabled
            ? "No runs yet"
            : "Disabled",
        severity: sevFromCronStatus(lastSt, enabled),
        meta: {
          jobId: card.meta?.jobId,
          enabled,
          schedule: card.meta?.schedule,
          lastRun: last || null
        }
      });

      if (enabled && (lastSt === "error" || lastSt === "failed")) {
        try {
          const runs = await safeJson("openclaw", [
            "cron",
            "runs",
            "--id",
            String(jobId),
            "--limit",
            "3",
            "--json"
          ]);
          const entries = Array.isArray(runs?.entries) ? runs.entries : [];
          for (const r of entries) {
            activity.events.push({
              ts: toIso(r?.ts, nowIso),
              type: "cron",
              title: `Cron failed: ${card.title}`,
              summary: `${r?.status || "error"} · duration ${fmtDur(r?.durationMs)}`,
              severity: "error",
              meta: {
                jobId: card.meta?.jobId,
                status: r?.status,
                ts: r?.ts,
                durationMs: r?.durationMs
              }
            });
          }
        } catch {
          // ignore
        }
      }
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

  // Git activity (last 20 commits)
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-n", "20", "--pretty=format:%H|%an|%ad|%s", "--date=iso"],
      { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }
    );

    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const [hash, author, ad, subject] = line.split("|");
      const tsIso = toIso(ad, nowIso);
      const short = (hash || "").slice(0, 7);
      activity.events.push({
        ts: tsIso,
        type: "git",
        title: `Git: ${subject || short || "commit"}`,
        summary: `${author || "unknown"} · ${short}`,
        severity: "info",
        meta: { hash, author, subject, date: ad }
      });
    }
  } catch {
    // ignore
  }

  // Session/subagent activity (from openclaw status --json)
  try {
    const recent = Array.isArray(status?.sessions?.recent) ? status.sessions.recent : [];
    for (const s of recent) {
      const tsIso = toIso(s?.updatedAt, nowIso);
      const key = s?.key || s?.id || "session";
      const model = s?.model ? normalizeModel(s.model) : undefined;
      activity.events.push({
        ts: tsIso,
        type: "session",
        title: `Session: ${key}`,
        summary: `${model || "—"}${s?.age ? ` · age ${s.age}` : ""}`,
        severity: "info",
        meta: {
          key: s?.key,
          updatedAt: s?.updatedAt,
          age: s?.age,
          model: s?.model
        }
      });
    }
  } catch {
    // ignore
  }

  // Newest-first
  activity.events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const payloadText = JSON.stringify(payload, null, 2) + "\n";
  const errorsText = JSON.stringify(errors, null, 2) + "\n";
  const boardText = JSON.stringify(board, null, 2) + "\n";
  const activityText = JSON.stringify(activity, null, 2) + "\n";

  // public/ (served)
  await fs.writeFile(OUT_PATH, payloadText, "utf8");
  await fs.writeFile(ERR_PATH, errorsText, "utf8");
  await fs.writeFile(BOARD_PATH, boardText, "utf8");
  await fs.writeFile(ACTIVITY_PATH, activityText, "utf8");

  // repo root (mirrors)
  await fs.writeFile(OUT_PATH_ROOT, payloadText, "utf8");
  await fs.writeFile(ERR_PATH_ROOT, errorsText, "utf8");
  await fs.writeFile(BOARD_PATH_ROOT, boardText, "utf8");
  await fs.writeFile(ACTIVITY_PATH_ROOT, activityText, "utf8");

  process.stdout.write(
    `Wrote ${OUT_PATH} + ${ERR_PATH} + ${BOARD_PATH} + ${ACTIVITY_PATH} (and root mirrors) @ ${nowIso}\n`
  );

  if (shouldPush) {
    await gitCommitPushIfChanged(nowIso);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
