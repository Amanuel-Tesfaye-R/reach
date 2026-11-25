import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "bridge.log");
const SUP_PID_PATH = path.join(__dirname, "supervisor.pid");
const BRIDGE_SCRIPT = path.join(__dirname, "bridge.mjs");

function log(level, msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${level}] ${msg}\n`, "utf-8");
  } catch (e) {}
}

// Single-instance lock for supervisor
try {
  if (fs.existsSync(SUP_PID_PATH)) {
    const oldPid = Number(fs.readFileSync(SUP_PID_PATH, "utf-8").trim());
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        log("SUPERVISOR", `Stopping previous supervisor (PID ${oldPid})`);
        process.kill(oldPid, "SIGTERM");
      } catch (e) {}
    }
  }
  fs.writeFileSync(SUP_PID_PATH, String(process.pid), "utf-8");
} catch (e) {}

let child = null;
let shuttingDown = false;
let backoffMs = 3000;

function cleanup() {
  shuttingDown = true;
  if (child) {
    try { child.kill("SIGTERM"); } catch (e) {}
  }
  try {
    if (fs.existsSync(SUP_PID_PATH)) {
      const cur = Number(fs.readFileSync(SUP_PID_PATH, "utf-8").trim());
      if (cur === process.pid) fs.unlinkSync(SUP_PID_PATH);
    }
  } catch (e) {}
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

function startBridge() {
  if (shuttingDown) return;
  const startedAt = Date.now();
  log("SUPERVISOR", `Spawning bridge.mjs (supervisor PID ${process.pid})`);

  child = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: __dirname,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.on("close", (code, signal) => {
    child = null;
    if (shuttingDown) return;

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > 60000) backoffMs = 3000;

    if (code === 0) {
      log("SUPERVISOR", "Bridge exited cleanly (code 0). Supervisor stopping.");
      cleanup();
      process.exit(0);
    }

    log(
      "SUPERVISOR",
      `Bridge crashed (code=${code}, signal=${signal}, uptime=${Math.round(uptimeMs / 1000)}s). Restarting in ${backoffMs / 1000}s...`
    );
    setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, 30000);
      startBridge();
    }, backoffMs);
  });

  child.on("error", (err) => {
    log("SUPERVISOR_ERR", err.message);
  });
}

startBridge();
