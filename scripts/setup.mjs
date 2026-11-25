import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function copyIfMissing(srcName, destName) {
  const src = path.join(ROOT, srcName);
  const dest = path.join(ROOT, destName);
  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`[setup] Created ${destName} from ${srcName}`);
  } else if (fs.existsSync(dest)) {
    console.log(`[setup] ${destName} already exists (preserved)`);
  }
}

console.log("=== Reach Environment Setup ===");
copyIfMissing(".env.example", ".env");
copyIfMissing("config.example.json", "config.json");

console.log("\nNext steps:");
console.log("  1. Add your TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID in config.json or .env");
console.log("  2. Optional voice I/O: python -m venv .venv && pip install -r requirements.txt");
console.log("  3. Run diagnostics: npm run verify");
console.log("  4. Start daemon:    npm start");
