import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const REMINDERS_PATH = path.join(__dirname, "reminders.json");
const PRODUCTS_PATH = path.join(__dirname, "products.json");

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch (e) {}
  }
  cfg.botToken = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  cfg.allowedChatId = cfg.allowedChatId || (process.env.ALLOWED_CHAT_ID ? Number(process.env.ALLOWED_CHAT_ID) : null);
  return cfg;
}

export function parseNaturalTime(str) {
  if (!str) return null;
  const now = new Date();
  const lower = str.toLowerCase().trim();

  // "in Xm" / "in Xh" / "in Xd"
  const inMatch = lower.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (inMatch) {
    const val = parseInt(inMatch[1], 10);
    const unit = inMatch[2][0];
    const ms = unit === "m" ? val * 60000 : unit === "h" ? val * 3600000 : val * 86400000;
    return new Date(now.getTime() + ms);
  }

  // "at HH:MM" (am/pm optional)
  const atMatch = lower.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atMatch) {
    let hours = parseInt(atMatch[1], 10);
    const mins = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const meridiem = atMatch[3];
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  // "tomorrow at HH:MM"
  const tmrwMatch = lower.match(/^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tmrwMatch) {
    let hours = parseInt(tmrwMatch[1], 10);
    const mins = tmrwMatch[2] ? parseInt(tmrwMatch[2], 10) : 0;
    const meridiem = tmrwMatch[3];
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(hours, mins, 0, 0);
    return target;
  }

  // Fallback: standard date string
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

export async function sendTelegramNotification(text, options = {}) {
  const cfg = loadConfig();
  if (!cfg.allowedChatId) throw new Error("No authorized chat ID configured yet.");
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const body = {
    chat_id: cfg.allowedChatId,
    text,
    parse_mode: options.parseMode || "HTML",
    disable_web_page_preview: true,
  };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

export function scheduleReminder(title, timeStr, category = "task") {
  const due = parseNaturalTime(timeStr);
  if (!due) throw new Error(`Could not parse time expression: "${timeStr}"`);

  let reminders = [];
  try {
    reminders = JSON.parse(fs.readFileSync(REMINDERS_PATH, "utf-8"));
  } catch (e) {}

  const rem = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    dueAt: due.toISOString(),
    category,
    created: new Date().toISOString(),
    completed: false,
    notified: false,
  };
  reminders.push(rem);
  fs.writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2), "utf-8");
  return rem;
}

export function addProductItem(name, notes = "", project = "general") {
  let products = [];
  try {
    products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf-8"));
  } catch (e) {}

  const prod = {
    id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    notes,
    project,
    status: "active",
    created: new Date().toISOString(),
  };
  products.push(prod);
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(products, null, 2), "utf-8");
  return prod;
}

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.length === 0) {
      console.log("Usage:");
      console.log('  node notify.mjs "Message to Boss"');
      console.log('  node notify.mjs --remind "Review Bakery deploy" --in "2h"');
      console.log('  node notify.mjs --product "Vanilla Beans" --notes "Bulk 5kg"');
      process.exit(0);
    }

    if (args[0] === "--remind" && args[1]) {
      const title = args[1];
      const inIdx = args.indexOf("--in");
      const timeStr = inIdx !== -1 && args[inIdx + 1] ? args[inIdx + 1] : "in 1h";
      const rem = scheduleReminder(title, timeStr);
      console.log(`Reminder scheduled: "${rem.title}" due at ${rem.dueAt}`);
      await sendTelegramNotification(
        `⏰ <b>Reminder Scheduled</b>\n• <b>Task:</b> ${title}\n• <b>Due:</b> ${new Date(rem.dueAt).toLocaleTimeString()}`
      );
      process.exit(0);
    }

    if (args[0] === "--product" && args[1]) {
      const name = args[1];
      const notesIdx = args.indexOf("--notes");
      const notes = notesIdx !== -1 && args[notesIdx + 1] ? args[notesIdx + 1] : "";
      const prod = addProductItem(name, notes);
      console.log(`Product tracked: "${prod.name}"`);
      await sendTelegramNotification(
        `📦 <b>Product Logged</b>\n• <b>Item:</b> ${name}\n• <b>Notes:</b> ${notes || "(none)"}`
      );
      process.exit(0);
    }

    const message = args.join(" ");
    const res = await sendTelegramNotification(message);
    console.log("Delivered notification to Boss:", res.ok);
  })().catch((err) => {
    console.error("Notify failed:", err.message);
    process.exit(1);
  });
}
