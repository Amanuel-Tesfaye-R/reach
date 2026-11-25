import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegramNotification } from "./notify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "sentinel-state.json");
const TARGETS_CONFIG = path.join(__dirname, "..", "sentinel-targets.json");

const DEFAULT_TARGETS = [
  {
    id: "sample-repo",
    name: "Sample Project",
    type: "pr",
    repo: "owner/repo",
    number: 1,
    issueRef: "#1",
    url: "https://github.com/owner/repo/pull/1",
  },
];

function getTargets() {
  if (fs.existsSync(TARGETS_CONFIG)) {
    try {
      return JSON.parse(fs.readFileSync(TARGETS_CONFIG, "utf-8"));
    } catch (e) {}
  }
  return DEFAULT_TARGETS;
}

const TARGETS = getTargets();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[Sentinel] Error loading state:", e.message);
  }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.error("[Sentinel] Error saving state:", e.message);
  }
}

function fetchTargetData(target) {
  try {
    const cmd =
      target.type === "pr"
        ? `gh pr view ${target.number} --repo ${target.repo} --json state,labels,comments,reviews,statusCheckRollup,mergedAt`
        : `gh issue view ${target.number} --repo ${target.repo} --json state,comments,assignees`;

    const raw = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[Sentinel] Fetch error for ${target.name}:`, e.message);
    return null;
  }
}

export async function checkTargets(silentInitial = false) {
  const state = loadState();
  const alerts = [];
  const isFirstRun = Object.keys(state).length === 0;

  for (const target of TARGETS) {
    const data = fetchTargetData(target);
    if (!data) continue;

    const prev = state[target.id] || null;
    const currentLabels = (data.labels || []).map((l) => l.name);
    const comments = data.comments || [];
    const stateStr = data.state;
    const isMerged = Boolean(data.mergedAt);

    if (prev) {
      // 1. State change (Merged / Closed)
      if (isMerged && !prev.isMerged) {
        alerts.push(
          `🎉 <b>${target.name} PR MERGED!</b>\n` +
            `• <b>PR:</b> <a href="${target.url}">#${target.number}</a>\n` +
            `• <b>Target:</b> ${target.issueRef || ""}\n` +
            `Your contribution is officially merged into upstream main!`
        );
      } else if (stateStr !== prev.state) {
        alerts.push(
          `📌 <b>${target.name} Status Update</b>\n` +
            `• <b>Item:</b> <a href="${target.url}">${target.type.toUpperCase()} #${target.number}</a>\n` +
            `• <b>New State:</b> <code>${stateStr}</code>`
        );
      }

      // 2. Cal.com 'run-ci' label detection
      if (target.id === "calcom") {
        const hadRunCi = (prev.labels || []).includes("run-ci");
        const hasRunCi = currentLabels.includes("run-ci");
        if (hasRunCi && !hadRunCi) {
          alerts.push(
            `🟢 <b>Cal.com: Maintainer Approved 'run-ci'</b>\n` +
              `• <b>PR:</b> <a href="${target.url}">#${target.number}</a>\n` +
              `A maintainer attached the <code>run-ci</code> label. Full test suite has been unlocked!`
          );
        }
      }

      // 3. New Comments
      if (comments.length > (prev.commentsCount || 0)) {
        const newComments = comments.slice(prev.commentsCount || 0);
        for (const c of newComments) {
          const author = c.author?.login || "unknown";
          if (author === "Amanuel-Tesfaye-R") continue; // Skip own comments

          const bodySnippet = (c.body || "")
            .replace(/<[^>]*>/g, "")
            .slice(0, 200)
            .trim();

          alerts.push(
            `💬 <b>New Comment on ${target.name}</b>\n` +
              `• <b>From:</b> @${author}\n` +
              `• <b>Link:</b> <a href="${c.url || target.url}">View Comment</a>\n` +
              `• <b>Message:</b> <i>"${bodySnippet}${c.body?.length > 200 ? "..." : ""}"</i>`
          );
        }
      }
    }

    // Save updated state for target
    state[target.id] = {
      state: stateStr,
      isMerged,
      labels: currentLabels,
      commentsCount: comments.length,
      lastChecked: new Date().toISOString(),
    };
  }

  saveState(state);

  // Dispatch alerts to Telegram
  for (const alert of alerts) {
    console.log("[Sentinel Alert]", alert.replace(/<[^>]*>/g, ""));
    try {
      await sendTelegramNotification(alert);
    } catch (err) {
      console.error("[Sentinel] Notification delivery failed:", err.message);
    }
  }

  return { checked: TARGETS.length, alertsCount: alerts.length, isFirstRun };
}

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith("sentinel.mjs")) {
  const args = process.argv.slice(2);

  (async () => {
    if (args.includes("--daemon")) {
      const intervalSec = 300; // 5 minutes
      console.log(`[Sentinel] Daemon started. Polling every ${intervalSec}s...`);

      // Initial check
      await checkTargets(false);

      setInterval(async () => {
        try {
          console.log(`[Sentinel] Running cycle at ${new Date().toLocaleTimeString()}...`);
          await checkTargets(false);
        } catch (e) {
          console.error("[Sentinel] Cycle error:", e.message);
        }
      }, intervalSec * 1000);
    } else {
      console.log("[Sentinel] Running single scan...");
      const res = await checkTargets(false);
      console.log(`[Sentinel] Complete. Checked ${res.checked} targets. Dispatched ${res.alertsCount} alerts.`);
      process.exit(0);
    }
  })().catch((err) => {
    console.error("[Sentinel] Fatal:", err);
    process.exit(1);
  });
}
