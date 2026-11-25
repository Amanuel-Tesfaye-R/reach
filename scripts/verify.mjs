import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function checkBin(cmd, args = ["--version"]) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: out.trim().split("\n")[0] };
  } catch (err) {
    return { ok: false, output: err.message };
  }
}

console.log("=== Reach System Verification ===");

const nodeMajor = Number(process.versions.node.split(".")[0]);
console.log(`Node.js: ${process.version} ${nodeMajor >= 18 ? "[OK]" : "[FAIL: >= 18 required]"}`);

const py = checkBin("python", ["--version"]);
console.log(`Python:  ${py.ok ? `${py.output} [OK]` : "not found (optional unless voice I/O is enabled)"}`);

const ff = checkBin("ffmpeg", ["-version"]);
console.log(`FFmpeg:  ${ff.ok ? `${ff.output} [OK]` : "not found (optional for Opus voice notes)"}`);

const cfgPath = path.join(ROOT, "config.json");
const envPath = path.join(ROOT, ".env");
const hasConfig = fs.existsSync(cfgPath) || fs.existsSync(envPath) || Boolean(process.env.TELEGRAM_BOT_TOKEN);
console.log(`Config:  ${hasConfig ? "found [OK]" : "missing (run 'npm run setup')"}`);

const coreFiles = ["src/bridge.mjs", "src/supervisor.mjs", "src/notify.mjs", "src/sentinel.mjs"];
for (const file of coreFiles) {
  execFileSync(process.execPath, ["--check", path.join(ROOT, file)]);
}
console.log(`Syntax:  all ${coreFiles.length} core modules valid [OK]`);
