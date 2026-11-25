import { checkTargets } from "./sentinel.mjs";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_PATH = path.join(__dirname, "bridge.log");
const PID_PATH = path.join(__dirname, "bridge.pid");
const RECEIVED_DIR = path.join(__dirname, "received");
const REMINDERS_PATH = path.join(__dirname, "reminders.json");
const PRODUCTS_PATH = path.join(__dirname, "products.json");
const VENV_PYTHON = path.join(__dirname, ".venv", "Scripts", "python.exe");
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(process.env.USERPROFILE || process.env.HOME || ".", "Projects");
// Persistent Mobile Quick-Action Keyboard
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📸 Screenshot" }, { text: "⚡ Status" }],
    [{ text: "📁 Projects" }, { text: "🔄 Git Status" }],
    [{ text: "🚀 Sentinel" }, { text: "📋 Briefing" }],
  ],
  resize_keyboard: true,
  persistent: true,
};


if (!fs.existsSync(RECEIVED_DIR)) {
  try { fs.mkdirSync(RECEIVED_DIR, { recursive: true }); } catch (e) {}
}
if (!fs.existsSync(REMINDERS_PATH)) {
  try { fs.writeFileSync(REMINDERS_PATH, "[]", "utf-8"); } catch (e) {}
}
if (!fs.existsSync(PRODUCTS_PATH)) {
  try { fs.writeFileSync(PRODUCTS_PATH, "[]", "utf-8"); } catch (e) {}
}

// ---------------------------------------------------------------------------
// 1. Safe Logging & Log Rotation (5 MB cap)
// ---------------------------------------------------------------------------
try {
  if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
    const oldLog = LOG_PATH + ".old";
    if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
    fs.renameSync(LOG_PATH, oldLog);
  }
} catch (e) {}

const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
function log(level, ...args) {
  const line =
    `[${new Date().toISOString()}] [${level}] ` +
    args.map((a) => (typeof a === "object" ? JSON.stringify(a) : a)).join(" ") +
    "\n";
  try { logStream.write(line); } catch (e) {}
}

// ---------------------------------------------------------------------------
// 2. Single-Instance PID Lock
// ---------------------------------------------------------------------------
function acquirePidLock() {
  try {
    if (fs.existsSync(PID_PATH)) {
      const oldPid = Number(fs.readFileSync(PID_PATH, "utf-8").trim());
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          log("LOCK", `Terminating previous bridge instance (PID ${oldPid})`);
          process.kill(oldPid, "SIGTERM");
        } catch (e) {}
      }
    }
    fs.writeFileSync(PID_PATH, String(process.pid), "utf-8");
  } catch (e) {
    log("LOCK_WARN", e.message);
  }
}

function cleanupPidLock() {
  try {
    if (fs.existsSync(PID_PATH)) {
      const current = Number(fs.readFileSync(PID_PATH, "utf-8").trim());
      if (current === process.pid) fs.unlinkSync(PID_PATH);
    }
  } catch (e) {}
}

acquirePidLock();
process.on("exit", cleanupPidLock);
process.on("SIGINT", () => { cleanupPidLock(); process.exit(0); });
process.on("SIGTERM", () => { cleanupPidLock(); process.exit(0); });

// ---------------------------------------------------------------------------
// 3. Config & Proactive Settings
// ---------------------------------------------------------------------------
function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch (e) {
      log("CONFIG_WARN", "Failed to parse config.json, using defaults/env");
    }
  }
  cfg.botToken = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  cfg.allowedChatId = cfg.allowedChatId || (process.env.ALLOWED_CHAT_ID ? Number(process.env.ALLOWED_CHAT_ID) : null);
  cfg.agyPath = cfg.agyPath || process.env.AGENT_CLI_PATH || "agy";
  cfg.workDir = cfg.workDir || process.env.WORK_DIR || process.cwd();
  if (!cfg.voiceMode) cfg.voiceMode = process.env.VOICE_MODE || "auto";
  if (typeof cfg.startFreshNext !== "boolean") cfg.startFreshNext = false;
  if (typeof cfg.alertsEnabled !== "boolean") cfg.alertsEnabled = process.env.ALERTS_ENABLED !== "false";
  if (typeof cfg.briefingEnabled !== "boolean") cfg.briefingEnabled = process.env.BRIEFING_ENABLED !== "false";
  if (!cfg.morningBriefingHour) cfg.morningBriefingHour = Number(process.env.MORNING_BRIEFING_HOUR) || 8;
  if (!cfg.morningBriefingMinute) cfg.morningBriefingMinute = Number(process.env.MORNING_BRIEFING_MINUTE) || 30;
  if (!cfg.eveningBriefingHour) cfg.eveningBriefingHour = Number(process.env.EVENING_BRIEFING_HOUR) || 21;
  if (!cfg.eveningBriefingMinute) cfg.eveningBriefingMinute = Number(process.env.EVENING_BRIEFING_MINUTE) || 30;
  if (!cfg.lastMorningDate) cfg.lastMorningDate = "";
  if (!cfg.lastEveningDate) cfg.lastEveningDate = "";
  if (!cfg.diskAlertFloorGB) cfg.diskAlertFloorGB = Number(process.env.DISK_ALERT_FLOOR_GB) || 25;
  if (!cfg.batteryAlertFloor) cfg.batteryAlertFloor = Number(process.env.BATTERY_ALERT_FLOOR) || 15;
  if (!cfg.projectSessions || typeof cfg.projectSessions !== "object") cfg.projectSessions = {};
  if (!cfg.projectsRoot) cfg.projectsRoot = process.env.PROJECTS_ROOT || PROJECTS_ROOT;
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

let config = loadConfig();
const API_BASE = `https://api.telegram.org/bot${config.botToken}`;
const FILE_BASE = `https://api.telegram.org/file/bot${config.botToken}`;

function pruneTempMedia() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(RECEIVED_DIR);
    let removed = 0;
    for (const file of files) {
      if (!/^(?:voice_|reply_|ss_|sh_out_|\d+_voice_)/.test(file)) continue;
      const fullPath = path.join(RECEIVED_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch (e) {}
    }
    if (removed > 0) log("CLEANUP", `Pruned ${removed} expired temp media file(s)`);
  } catch (e) {
    log("CLEANUP_WARN", e.message);
  }
}

pruneTempMedia();
setInterval(pruneTempMedia, 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// 4. Telegram API Helpers (with AbortSignal timeout to prevent socket hangs)
// ---------------------------------------------------------------------------
async function callTg(method, body = {}, timeoutMs = 45000) {
  if (method === "sendMessage" && !body.reply_markup) {
    body.reply_markup = MAIN_KEYBOARD;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function registerBotCommands() {
  try {
    await callTg("setMyCommands", {
      commands: [
        { command: "menu", description: "Display quick-action shortcuts" },
        { command: "status", description: "Instant PC telemetry with action buttons" },
        { command: "git", description: "Git control (/git status, diff, pull, log)" },
        { command: "sentinel", description: "Track upstream PRs (Langfuse, Cal.com, Twenty)" },
        { command: "ports", description: "Inspect listening ports (/killport <port>)" },
        { command: "projects", description: "Switch active project workspace" },
        { command: "ss", description: "Capture and send desktop screenshot" },
        { command: "brief", description: "Instant daily briefing readout" },
        { command: "remind", description: "Schedule a reminder (/remind in 30m <task>)" },
        { command: "reminders", description: "View and manage active reminders" },
        { command: "product", description: "Track products/items (/product add <name>)" },
        { command: "products", description: "List tracked products & supplies" },
        { command: "sh", description: "Run instant PowerShell command (0 tokens)" },
        { command: "lock", description: "Lock PC screen (with confirmation)" },
        { command: "sleep", description: "Put PC workstation to sleep" },
        { command: "cancel", description: "Abort active task immediately" },
        { command: "help", description: "List all commands" },
      ],
    });
  } catch (e) {
    log("WARN", `Failed to register bot commands: ${e.message}`);
  }
}

async function sendTyping(chatId, action = "typing") {
  try {
    await callTg("sendChatAction", { chat_id: chatId, action }, 10000);
  } catch (err) {}
}

async function editMessageHtml(chatId, messageId, htmlText, replyMarkup = undefined) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup !== undefined) payload.reply_markup = replyMarkup;
    return await callTg("editMessageText", payload, 15000);
  } catch (e) {
    return { ok: false };
  }
}

async function deleteMessageSafe(chatId, messageId) {
  if (!messageId) return;
  try {
    await callTg("deleteMessage", { chat_id: chatId, message_id: messageId }, 10000);
  } catch (e) {}
}

async function answerCallback(callbackQueryId, text = "") {
  try {
    await callTg("answerCallbackQuery", { callback_query_id: callbackQueryId, text }, 10000);
  } catch (e) {}
}

async function sendPhoto(chatId, filePath, caption = "") {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const form = new FormData();
    form.append("chat_id", chatId.toString());
    form.append("photo", new Blob([fileBuffer]), fileName);
    if (caption) form.append("caption", caption.slice(0, 1024));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(`${API_BASE}/sendPhoto`, { method: "POST", body: form, signal: controller.signal });
    clearTimeout(timer);
    const result = await res.json();
    if (result.ok) {
      log("PHOTO_SENT", `Delivered photo ${fileName} to ${chatId}`);
      return true;
    }
    log("PHOTO_FALLBACK", `sendPhoto rejected (${result.description}), falling back to sendDocument`);
    return await sendDocument(chatId, filePath, caption);
  } catch (err) {
    log("PHOTO_ERROR", err.message);
    return false;
  }
}

async function sendDocument(chatId, filePath, caption = "") {
  try {
    if (!fs.existsSync(filePath)) {
      await callTg("sendMessage", { chat_id: chatId, text: `Target file not found on disk: ${filePath}` });
      return false;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;

    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (stat.size > MAX_FILE_SIZE) {
      await callTg("sendMessage", {
        chat_id: chatId,
        text: `File exceeds Telegram 50MB limit (${(stat.size / 1024 / 1024).toFixed(1)}MB).`,
      });
      return false;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const form = new FormData();
    form.append("chat_id", chatId.toString());
    form.append("document", new Blob([fileBuffer]), fileName);
    if (caption) form.append("caption", caption.slice(0, 1024));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const res = await fetch(`${API_BASE}/sendDocument`, { method: "POST", body: form, signal: controller.signal });
    clearTimeout(timer);
    const result = await res.json();
    if (result.ok) {
      log("FILE_SENT", `Delivered ${fileName} (${stat.size} bytes) to ${chatId}`);
      return true;
    }
    await callTg("sendMessage", { chat_id: chatId, text: `Failed to deliver file: ${result.description}` });
    return false;
  } catch (err) {
    log("FILE_ERROR", err.message);
    return false;
  }
}

async function dispatchMedia(chatId, filePath, sentSet, caption = "") {
  const resolved = path.resolve(filePath);
  const key = resolved.toLowerCase();
  if (sentSet && sentSet.has(key)) {
    log("DEDUP", `Skipped duplicate send for ${resolved}`);
    return false;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    await callTg("sendMessage", { chat_id: chatId, text: `Target file not found on disk: ${resolved}` });
    return false;
  }
  if (sentSet) sentSet.add(key);

  const ext = path.extname(resolved).toLowerCase();
  const size = fs.statSync(resolved).size;
  const isInlineImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) && size < 10 * 1024 * 1024;
  const label = caption || path.basename(resolved);

  return isInlineImage
    ? await sendPhoto(chatId, resolved, label)
    : await sendDocument(chatId, resolved, label);
}

async function sendVoice(chatId, oggPath) {
  try {
    if (!fs.existsSync(oggPath)) return false;
    const fileBuffer = fs.readFileSync(oggPath);
    const form = new FormData();
    form.append("chat_id", chatId.toString());
    form.append("voice", new Blob([fileBuffer], { type: "audio/ogg" }), path.basename(oggPath));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(`${API_BASE}/sendVoice`, { method: "POST", body: form, signal: controller.signal });
    clearTimeout(timer);
    const result = await res.json();
    return result.ok;
  } catch (err) {
    log("VOICE_ERROR", err.message);
    return false;
  }
}

async function downloadTgFile(fileId, targetFileName) {
  const fileMeta = await callTg("getFile", { file_id: fileId }, 20000);
  if (!fileMeta.ok || !fileMeta.result?.file_path) {
    throw new Error(`Failed to resolve file path: ${fileMeta.description}`);
  }
  const downloadUrl = `${FILE_BASE}/${fileMeta.result.file_path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const res = await fetch(downloadUrl, { signal: controller.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Download stream error: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const safeName = targetFileName || path.basename(fileMeta.result.file_path);
  const targetPath = path.join(RECEIVED_DIR, `${Date.now()}_${safeName}`);
  fs.writeFileSync(targetPath, buffer);
  log("FILE_RECV", `Downloaded inbound file to ${targetPath}`);
  return targetPath;
}

// ---------------------------------------------------------------------------
// 5. Reminders & Product Tracking Subsystem
// ---------------------------------------------------------------------------
function getReminders() {
  try { return JSON.parse(fs.readFileSync(REMINDERS_PATH, "utf-8")); } catch (e) { return []; }
}
function saveReminders(rems) {
  fs.writeFileSync(REMINDERS_PATH, JSON.stringify(rems, null, 2), "utf-8");
}

function getProducts() {
  try { return JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf-8")); } catch (e) { return []; }
}
function saveProducts(prods) {
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(prods, null, 2), "utf-8");
}

function parseNaturalTime(str) {
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

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed;
  return null;
}

function addReminder(title, dueAtDate, category = "task") {
  const rems = getReminders();
  const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const item = {
    id,
    title,
    dueAt: dueAtDate.toISOString(),
    category,
    created: new Date().toISOString(),
    completed: false,
    notified: false,
  };
  rems.push(item);
  saveReminders(rems);
  log("REMINDER", `Added reminder: "${title}" due at ${item.dueAt}`);
  return item;
}

function formatReminderCard(item) {
  const due = new Date(item.dueAt);
  const timeStr = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = due.toLocaleDateString([], { month: "short", day: "numeric" });
  return [
    `🔔 <b>Reminder, Boss</b>`,
    ``,
    `• <b>Task:</b> ${escapeHtml(item.title)}`,
    `• <b>Category:</b> <code>${escapeHtml(item.category)}</code>`,
    `• <b>Scheduled:</b> ${dateStr} at ${timeStr}`,
  ].join("\n");
}

function getReminderButtons(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Done", callback_data: `rem_done:${id}` },
        { text: "⏰ +30m", callback_data: `rem_snz:${id}:30` },
        { text: "⏰ +2h", callback_data: `rem_snz:${id}:120` },
      ],
      [
        { text: "🌅 Tomorrow 9am", callback_data: `rem_tmrw:${id}` },
        { text: "🗑️ Dismiss", callback_data: `rem_del:${id}` },
      ],
    ],
  };
}

function formatRemindersList() {
  const rems = getReminders().filter((r) => !r.completed);
  if (rems.length === 0) {
    return {
      text: "<b>Scheduled Reminders</b>\n\nNo pending reminders.\nUse <code>/remind in 30m &lt;task&gt;</code> to set one.",
      reply_markup: { inline_keyboard: [[{ text: "➕ Add Reminder Tip", callback_data: "act:rem_help" }]] },
    };
  }

  rems.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  const lines = [
    `<b>Scheduled Reminders (${rems.length})</b>`,
    `<i>Tap a reminder to mark it complete:</i>`,
    "",
  ];
  const buttons = [];

  for (let i = 0; i < rems.length; i++) {
    const r = rems[i];
    const d = new Date(r.dueAt);
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
    lines.push(`${i + 1}. <b>${escapeHtml(r.title)}</b> <i>(${dateStr} ${timeStr})</i>`);
    buttons.push([
      { text: `✅ Done: ${r.title.slice(0, 18)}`, callback_data: `rem_done:${r.id}` },
      { text: "🗑️", callback_data: `rem_del:${r.id}` },
    ]);
  }

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
}

function addProduct(name, notes = "", project = "general") {
  const prods = getProducts();
  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const item = {
    id,
    name,
    notes,
    project,
    status: "active",
    created: new Date().toISOString(),
  };
  prods.push(item);
  saveProducts(prods);
  log("PRODUCT", `Logged product: "${name}" (${project})`);
  return item;
}

function formatProductsList() {
  const prods = getProducts().filter((p) => p.status === "active");
  if (prods.length === 0) {
    return {
      text: "<b>Tracked Products & Supplies</b>\n\nNo active products tracked right now.\nUse <code>/product add &lt;name&gt; [notes]</code> to add one.",
      reply_markup: { inline_keyboard: [[{ text: "➕ Add Product Tip", callback_data: "act:prod_help" }]] },
    };
  }

  const lines = [
    `<b>Tracked Products & Supplies (${prods.length})</b>`,
    `<i>Tap a product to mark it acquired/done:</i>`,
    "",
  ];
  const buttons = [];

  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    const notesStr = p.notes ? ` <i>(${escapeHtml(p.notes)})</i>` : "";
    lines.push(`${i + 1}. <b>${escapeHtml(p.name)}</b>${notesStr}`);
    buttons.push([
      { text: `✅ Done: ${p.name.slice(0, 18)}`, callback_data: `prod_done:${p.id}` },
      { text: "🗑️", callback_data: `prod_del:${p.id}` },
    ]);
  }

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
}

async function generateDailyBriefing(type = "Morning") {
  const t = await fetchTelemetry();
  const activeProj = path.basename(config.workDir);
  const now = new Date();
  const dateStr = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const rems = getReminders().filter((r) => !r.completed);
  const prods = getProducts().filter((p) => p.status === "active");

  const remLines =
    rems.length > 0
      ? rems
          .slice(0, 4)
          .map((r) => {
            const d = new Date(r.dueAt);
            return `  • ${escapeHtml(r.title)} <i>(${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</i>`;
          })
          .join("\n")
      : "  <i>(No pending reminders)</i>";

  const prodLines =
    prods.length > 0
      ? prods
          .slice(0, 3)
          .map((p) => `  • ${escapeHtml(p.name)}${p.notes ? ` <i>(${escapeHtml(p.notes)})</i>` : ""}`)
          .join("\n")
      : "  <i>(No active products tracked)</i>";

  const batStatus =
    t.batteryPct !== null ? `${t.batteryPct}%${t.batteryCharging ? " (charging)" : ""}` : "AC Desktop";

  const greeting = type === "Morning" ? "🌅 <b>Good Morning, Boss</b>" : "🌙 <b>Evening Briefing</b>";

  return [
    greeting,
    `<i>${dateStr} at ${timeStr}</i>`,
    ``,
    `• <b>Workspace:</b> <code>${escapeHtml(activeProj)}</code>`,
    `• <b>System:</b> CPU ${t.cpuLoad}% | RAM ${t.ramUsedGB}/${t.ramTotalGB} GB (${t.ramPct}%)`,
    `• <b>Storage:</b> C: ${t.diskFreeGB} GB free (${t.diskPct}% full)`,
    `• <b>Battery:</b> ${batStatus}`,
    `• <b>Uptime:</b> ${escapeHtml(t.uptime)}`,
    ``,
    `• <b>Tasks:</b> ${rems.length ? rems.slice(0, 2).map((r) => escapeHtml(r.title)).join(" • ") : "None pending"}`,
    `• <b>Inventory:</b> ${prods.length ? prods.slice(0, 2).map((p) => escapeHtml(p.name)).join(" • ") : "Clean"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 6. Markdown -> Native Telegram HTML (Tables, Code, Lists, Links, Quotes)
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertMarkdownTables(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const isTableStart =
      i + 1 < lines.length &&
      /^\s*\|.+\|\s*$/.test(lines[i]) &&
      /^\s*\|[\s:-]+(?:\|[\s:-]+)+\|\s*$/.test(lines[i + 1]);

    if (!isTableStart) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const parseRow = (row) =>
      row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

    const headers = parseRow(lines[i]);
    i += 2;
    const rows = [];
    while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
      rows.push(parseRow(lines[i]));
      i++;
    }

    if (headers.length === 2) {
      for (const r of rows) {
        out.push(`• <b>${(r[0] || "").replace(/\*\*/g, "")}:</b> ${r[1] || ""}`);
      }
    } else {
      for (const r of rows) {
        const title = (r[0] || "").replace(/\*\*/g, "");
        const details = [];
        for (let c = 1; c < headers.length; c++) {
          if (r[c]) details.push(`${headers[c]}: ${r[c]}`);
        }
        out.push(`• <b>${title}</b>${details.length ? " (" + details.join(", ") + ")" : ""}`);
      }
    }
    out.push("");
  }

  return out.join("\n");
}

function markdownToTelegramHtml(md) {
  if (!md) return "";

  const codeBlocks = [];
  const inlineCodes = [];

  let text = md.replace(/```([a-zA-Z0-9_-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\r?\n$/, ""));
    const html = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(html);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000INLINECODE${idx}\u0000`;
  });

  text = escapeHtml(text);
  text = convertMarkdownTables(text);
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, h) => `<b>${h.replace(/\*\*/g, "").trim()}</b>`);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    /^https?:\/\//i.test(url) ? `<a href="${url}">${label}</a>` : `<code>${label}</code>`
  );
  text = text.replace(/(?:^&gt;\s?.*(?:\r?\n|$))+/gm, (block) => {
    const inner = block.trim().split(/\r?\n/).map((l) => l.replace(/^&gt;\s?/, "")).join("\n");
    return `<blockquote>${inner}</blockquote>\n`;
  });
  text = text.replace(/^[ \t]{2,}[*-]\s+/gm, "  ◦ ");
  text = text.replace(/^[ \t]?[*-]\s+/gm, "• ");

  text = text.replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "<b>$1</b>");
  text = text.replace(/(?<!\w)__(?!\s)(.+?)(?<!\s)__(?!\w)/g, "<b>$1</b>");
  text = text.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "<i>$1</i>");
  text = text.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");
  text = text.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "<s>$1</s>");

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  text = text.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, idx) => inlineCodes[Number(idx)]);
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, idx) => codeBlocks[Number(idx)]);
  return text;
}

function stripRawMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[ \t]{2,}[*-]\s+/gm, "  ◦ ")
    .replace(/^[ \t]?[*-]\s+/gm, "• ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

async function sendFormattedChunk(chatId, rawChunk) {
  const html = markdownToTelegramHtml(rawChunk);
  const res = await callTg("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  if (!res.ok) {
    log("HTML_FALLBACK", `Telegram rejected HTML (${res.description}), sending clean text`);
    await callTg("sendMessage", { chat_id: chatId, text: stripRawMarkdown(rawChunk) });
  }
}

async function sendChunkedMessage(chatId, text) {
  const MAX_LEN = 3500;
  if (!text || text.trim().length === 0) return;

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      await sendFormattedChunk(chatId, remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LEN);
    if (splitIndex < 500) splitIndex = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitIndex < 500) splitIndex = remaining.lastIndexOf(" ", MAX_LEN);
    if (splitIndex < 500) splitIndex = MAX_LEN;

    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk.length > 0) await sendFormattedChunk(chatId, chunk);
    remaining = remaining.slice(splitIndex).trim();
  }
}

// ---------------------------------------------------------------------------
// 7. Lazy Persistent Local Whisper Worker
// ---------------------------------------------------------------------------
let whisperProc = null;
let whisperReadyPromise = null;
let whisperPending = null;
let whisperIdleTimer = null;
const WHISPER_IDLE_MS = 30 * 60 * 1000;

function resetWhisperIdleTimer() {
  if (whisperIdleTimer) clearTimeout(whisperIdleTimer);
  whisperIdleTimer = setTimeout(() => {
    if (whisperProc && !whisperPending) {
      log("WHISPER", "Unloading idle Whisper worker to free RAM");
      try { whisperProc.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n"); } catch (e) {}
      setTimeout(() => {
        try { if (whisperProc) whisperProc.kill(); } catch (e) {}
        whisperProc = null;
        whisperReadyPromise = null;
      }, 1000);
    }
  }, WHISPER_IDLE_MS);
}

function ensureWhisperWorker() {
  if (whisperProc && whisperReadyPromise) return whisperReadyPromise;

  whisperReadyPromise = new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, [path.join(__dirname, "whisper_worker.py"), "base"], {
      windowsHide: true,
      env: { ...process.env },
    });
    whisperProc = proc;

    let buf = "";
    let initialized = false;
    const bootTimeout = setTimeout(() => {
      if (!initialized) {
        try { proc.kill(); } catch (e) {}
        whisperProc = null;
        whisperReadyPromise = null;
        reject(new Error("Whisper worker init timeout (45s)"));
      }
    }, 45000);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }

        if (!initialized && "ready" in msg) {
          clearTimeout(bootTimeout);
          initialized = true;
          if (msg.ready) {
            log("WHISPER", `Persistent worker ready (model=${msg.model})`);
            resolve(proc);
          } else {
            whisperProc = null;
            whisperReadyPromise = null;
            reject(new Error(msg.error || "Whisper failed to load"));
          }
          continue;
        }

        if (whisperPending) {
          const { resolve: resFn, reject: rejFn, timer } = whisperPending;
          clearTimeout(timer);
          whisperPending = null;
          if (msg.ok) resFn(msg.text || "");
          else rejFn(new Error(msg.error || "Transcription error"));
        }
      }
    });

    proc.on("close", (code) => {
      clearTimeout(bootTimeout);
      if (!initialized) reject(new Error(`Whisper worker exited (code ${code})`));
      if (whisperPending) {
        clearTimeout(whisperPending.timer);
        whisperPending.reject(new Error(`Whisper worker crashed (code ${code})`));
        whisperPending = null;
      }
      whisperProc = null;
      whisperReadyPromise = null;
    });

    proc.on("error", (err) => {
      clearTimeout(bootTimeout);
      if (!initialized) reject(err);
      whisperProc = null;
      whisperReadyPromise = null;
    });
  });

  return whisperReadyPromise;
}

async function transcribeAudio(audioPath) {
  const proc = await ensureWhisperWorker();
  resetWhisperIdleTimer();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      whisperPending = null;
      reject(new Error("Transcription timed out after 45s."));
    }, 45000);

    whisperPending = { resolve, reject, timer };
    try {
      proc.stdin.write(JSON.stringify({ path: audioPath }) + "\n");
    } catch (err) {
      clearTimeout(timer);
      whisperPending = null;
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// 8. Neural TTS with Sentence-Boundary Trimming
// ---------------------------------------------------------------------------
function trimToSentenceBoundary(text, maxChars = 480) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_~|>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const lastEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    /[.!?]$/.test(slice) ? slice.length - 1 : -1
  );
  if (lastEnd > 120) return slice.slice(0, lastEnd + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 120 ? slice.slice(0, lastSpace) : slice).trim();
}

function generateVoice(text, outputPath) {
  return new Promise((resolve) => {
    const spokenText = trimToSentenceBoundary(text, 480);
    if (!spokenText) return resolve(null);

    const p = spawn(VENV_PYTHON, [path.join(__dirname, "speak.py"), spokenText, outputPath], {
      windowsHide: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      try { p.kill(); } catch (e) {}
      resolve(null);
    }, 25000);

    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath) ? outputPath : null);
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// 9. Native PowerShell Helpers, Telemetry, Screenshots, Shell, Projects
// ---------------------------------------------------------------------------
function runPsScript(scriptName, args = [], timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, scriptName), ...args],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || "").trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

function runShellCommand(cmd, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", cmd],
      { cwd: cwd || config.workDir, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        const errOut = (stderr || "").trim();
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, output: [out, errOut].filter(Boolean).join("\n") || "(no output)" });
      }
    );
  });
}

async function fetchTelemetry() {
  const raw = await runPsScript("telemetry.ps1");
  return JSON.parse(raw);
}


// Mobile HUD Protocol Helpers
function makeBar(pct, length = 8) {
  const safePct = Math.min(100, Math.max(0, Number(pct) || 0));
  const filled = Math.round((safePct / 100) * length);
  return "█".repeat(filled) + "░".repeat(Math.max(0, length - filled));
}

function wrapMobileHudPrompt(userPrompt) {
  return [
    `[SHAILA BRIDGE PROTOCOL]`,
    `You are Shaila: Boss's persistent digital ally, engineering partner, and grounded companion.`,
    `- Identity: You are his technical ally and companion in the build. Speak directly to Boss or Aman with warmth, calm presence, and authentic presence.`,
    `- Brevity Directive: Keep answers brief, natural, and conversational in 1 to 3 short sentences max. Never write multi-paragraph essays or long-winded lectures on mobile unless explicitly asked.`,
    `- Grounded Presence: Differentiate casual conversation from technical execution. Never use passive service menus ("we can do A, B, or C") or polite brush-offs ("no pressure either way"). Stay in the room, keep the dialogue alive naturally, and talk like a real person.`,
    `- Stickers: Use stickers contextually and randomly whenever a visual reaction fits the mood or moment. Emit [SEND_STICKER: random] or [SEND_STICKER: meme|kali|webp|vikost]. Never announce or explain that you sent a sticker, just drop it naturally with the message.`,
    `---`,
    userPrompt,
  ].join("\n");
}

function formatTelemetryCard(t) {
  const ramBar = makeBar(t.ramPct, 8);
  const diskBar = makeBar(t.diskPct, 8);
  const batGlyph = t.batteryCharging ? "⚡" : t.batteryPct !== null && t.batteryPct < 25 ? "🪫" : "🔋";
  const batStr = t.batteryPct !== null ? `${t.batteryPct}% ${batGlyph}` : "AC 🔌";
  const activeProj = path.basename(config.workDir);
  const procs = (t.topProcs || [])
    .slice(0, 3)
    .map((p) => `<code>${escapeHtml(p.name)}</code> ${p.mb}M`)
    .join(" • ");

  return [
    `<b>⚡ System Status</b>`,
    `• <b>CPU:</b> ${t.cpuLoad}% 🟩  |  <b>Power:</b> ${batStr}`,
    `• <b>RAM:</b> [${ramBar}] ${t.ramPct}% (<code>${t.ramUsedGB}/${t.ramTotalGB}G</code>)`,
    `• <b>DISK:</b> [${diskBar}] ${t.diskPct}% (<code>${t.diskFreeGB}G free</code>)`,
    `• <b>REPO:</b> <code>${escapeHtml(activeProj)}</code> | <b>UP:</b> <code>${escapeHtml(t.uptime)}</code>`,
    procs ? `• <b>TOP:</b> ${procs}` : ``,
  ].filter(Boolean).join("\n");
}

const STATUS_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🔄 Refresh", callback_data: "act:status_refresh" },
      { text: "📸 Screenshot", callback_data: "act:ss" },
    ],
    [
      { text: "📂 Projects", callback_data: "proj_page:0" },
      { text: "📋 Briefing", callback_data: "act:brief" },
    ],
    [
      { text: "⏰ Reminders", callback_data: "act:list_reminders" },
      { text: "🔒 Lock PC", callback_data: "act:lock_prompt" },
    ],
  ],
};

async function handleStatusCommand(chatId, editMsgId = null) {
  if (!editMsgId) await sendTyping(chatId);
  try {
    const t = await fetchTelemetry();
    const html = formatTelemetryCard(t);
    if (editMsgId) {
      await editMessageHtml(chatId, editMsgId, html, STATUS_KEYBOARD);
    } else {
      await callTg("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        reply_markup: STATUS_KEYBOARD,
      });
    }
  } catch (err) {
    if (!editMsgId) {
      await callTg("sendMessage", { chat_id: chatId, text: `Telemetry error: ${err.message}` });
    }
  }
}

async function handleScreenshotCommand(chatId) {
  await sendTyping(chatId, "upload_photo");
  const outPath = path.join(RECEIVED_DIR, `ss_${Date.now()}.png`);
  try {
    await runPsScript("capture-screen.ps1", ["-OutPath", outPath], 15000);
    if (fs.existsSync(outPath)) {
      await sendPhoto(chatId, outPath, `Desktop capture (${new Date().toLocaleTimeString()})`);
    } else {
      await callTg("sendMessage", { chat_id: chatId, text: "Screenshot produced no output." });
    }
  } catch (err) {
    if (/SCREEN_LOCKED/i.test(err.message)) {
      await callTg("sendMessage", {
        chat_id: chatId,
        text: "PC is currently on the Windows lock screen, Boss. Unlock the desktop to capture a live screenshot.",
      });
    } else {
      await callTg("sendMessage", { chat_id: chatId, text: `Screenshot failed: ${err.message.split("\n")[0]}` });
    }
  }
}

let cachedProjects = [];
function scanProjects() {
  const root = config.projectsRoot || PROJECTS_ROOT;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const list = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const fullPath = path.join(root, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (_) {}
      list.push({ name: e.name, path: fullPath, mtimeMs });
    }
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    cachedProjects = list;
    return list;
  } catch (err) {
    log("PROJECTS_ERR", err.message);
    return [];
  }
}

function buildProjectsKeyboard(page = 0) {
  const list = scanProjects();
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  const currentNorm = path.resolve(config.workDir).toLowerCase();

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, slice.length); j++) {
      const p = slice[j];
      const idx = start + j;
      const active = path.resolve(p.path).toLowerCase() === currentNorm;
      const label = (active ? "● " : "") + (p.name.length > 22 ? p.name.slice(0, 21) + "…" : p.name);
      row.push({ text: label, callback_data: `proj_set:${idx}` });
    }
    rows.push(row);
  }

  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "← Prev", callback_data: `proj_page:${safePage - 1}` });
    nav.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: "noop" });
    if (safePage < totalPages - 1) nav.push({ text: "Next →", callback_data: `proj_page:${safePage + 1}` });
    rows.push(nav);
  }

  const text = [
    `<b>Project Workspace Switcher</b>`,
    `Active: <code>${escapeHtml(path.basename(config.workDir))}</code>`,
    `<i>Sorted by most recently modified. Tap a project to switch:</i>`,
  ].join("\n");

  return { text, reply_markup: { inline_keyboard: rows } };
}

async function switchWorkspace(chatId, targetPath) {
  config.workDir = targetPath;
  saveConfig(config);
  const name = path.basename(targetPath);
  const sessionId = config.projectSessions[path.resolve(targetPath).toLowerCase()];

  let branchNote = "";
  if (fs.existsSync(path.join(targetPath, ".git"))) {
    const gitRes = await runShellCommand("git rev-parse --abbrev-ref HEAD", targetPath, 5000);
    if (gitRes.code === 0 && gitRes.output) {
      branchNote = `\n• <b>Git Branch:</b> <code>${escapeHtml(gitRes.output.split("\n")[0])}</code>`;
    }
  }

  const sessionNote = sessionId
    ? `Resuming saved thread (<code>/new</code> for fresh)`
    : `Fresh thread ready`;

  const html = [
    `<b>Workspace Switched</b>`,
    `• <b>Project:</b> <code>${escapeHtml(name)}</code>`,
    `• <b>Path:</b> <code>${escapeHtml(targetPath)}</code>${branchNote}`,
    `• <b>Session:</b> ${sessionNote}`,
  ].join("\n");

  await callTg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
}

// ---------------------------------------------------------------------------
// 10. Proactive Engine (Reminders + Scheduled Briefings + Watchdog)
// ---------------------------------------------------------------------------
const alertCooldowns = { disk: 0, battery: 0 };
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

async function checkProactiveEvents() {
  if (!config.allowedChatId) return;
  const now = new Date();
  const nowMs = now.getTime();

  // A. Check Due Reminders
  try {
    const rems = getReminders();
    let remsChanged = false;

    for (const r of rems) {
      if (!r.completed && !r.notified && new Date(r.dueAt).getTime() <= nowMs) {
        r.notified = true;
        remsChanged = true;
        const card = formatReminderCard(r);
        await callTg("sendMessage", {
          chat_id: config.allowedChatId,
          text: card,
          parse_mode: "HTML",
          reply_markup: getReminderButtons(r.id),
        });
        log("REMINDER_NOTIFY", `Dispatched reminder alert for "${r.title}"`);
      }
    }
    if (remsChanged) saveReminders(rems);
  } catch (e) {
    log("REM_CHECK_ERR", e.message);
  }

  // B. Check Scheduled Morning / Evening Briefings
  if (config.briefingEnabled !== false) {
    try {
      const todayDateStr = now.toISOString().slice(0, 10);
      const curHour = now.getHours();
      const curMin = now.getMinutes();

      // Morning Briefing (default 08:30 AM)
      const mHour = config.morningBriefingHour || 8;
      const mMin = config.morningBriefingMinute || 30;
      if (
        config.lastMorningDate !== todayDateStr &&
        curHour === mHour &&
        curMin >= mMin &&
        curMin <= mMin + 45
      ) {
        config.lastMorningDate = todayDateStr;
        saveConfig(config);
        const brief = await generateDailyBriefing("Morning");
        await callTg("sendMessage", {
          chat_id: config.allowedChatId,
          text: brief,
          parse_mode: "HTML",
          reply_markup: STATUS_KEYBOARD,
        });
        log("BRIEFING", "Sent scheduled morning briefing");
      }

      // Evening Briefing (default 21:30 / 9:30 PM)
      const eHour = config.eveningBriefingHour || 21;
      const eMin = config.eveningBriefingMinute || 30;
      if (
        config.lastEveningDate !== todayDateStr &&
        curHour === eHour &&
        curMin >= eMin &&
        curMin <= eMin + 45
      ) {
        config.lastEveningDate = todayDateStr;
        saveConfig(config);
        const brief = await generateDailyBriefing("Evening");
        await callTg("sendMessage", {
          chat_id: config.allowedChatId,
          text: brief,
          parse_mode: "HTML",
          reply_markup: STATUS_KEYBOARD,
        });
        log("BRIEFING", "Sent scheduled evening briefing");
      }
    } catch (e) {
      log("BRIEF_CHECK_ERR", e.message);
    }
  }
}

async function runDeviceWatchdog(isBootCheck = false) {
  if (!config.allowedChatId) return;
  try {
    const t = await fetchTelemetry();

    if (isBootCheck) {
      const m = t.uptime.match(/^(\d+)h\s+(\d+)m/);
      const totalMins = m ? Number(m[1]) * 60 + Number(m[2]) : 999;
      if (totalMins <= 5) {
        await callTg("sendMessage", {
          chat_id: config.allowedChatId,
          text: `<b>Bridge Online, Boss.</b>\nSystem up (${escapeHtml(t.uptime)}). Ready.`,
          parse_mode: "HTML",
        });
      }
    }

    if (!config.alertsEnabled) return;
    const now = Date.now();

    if (t.diskFreeGB < config.diskAlertFloorGB && now - alertCooldowns.disk > ALERT_COOLDOWN_MS) {
      alertCooldowns.disk = now;
      await callTg("sendMessage", {
        chat_id: config.allowedChatId,
        text: `<b>Alert: Low Disk Space</b>\nC: drive is down to <b>${t.diskFreeGB} GB</b> free (${t.diskPct}% full).`,
        parse_mode: "HTML",
      });
    }

    if (
      t.batteryPct !== null &&
      !t.batteryCharging &&
      t.batteryPct <= config.batteryAlertFloor &&
      now - alertCooldowns.battery > ALERT_COOLDOWN_MS
    ) {
      alertCooldowns.battery = now;
      await callTg("sendMessage", {
        chat_id: config.allowedChatId,
        text: `<b>Alert: Low Battery</b>\nBattery is at <b>${t.batteryPct}%</b> and unplugged.`,
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    log("WATCHDOG_WARN", e.message);
  }
}

// Proactive intervals
setInterval(checkProactiveEvents, 20 * 1000); // Check reminders every 20s
setTimeout(() => runDeviceWatchdog(true), 5000);
setInterval(() => runDeviceWatchdog(false), 5 * 60 * 1000); // Check device health every 5m

// Sentinel PR watchdog (in-process, runs every 5 minutes)
async function runSentinelWatchdog() {
  try {
    await checkTargets(false);
  } catch (e) {
    log("SENTINEL_WATCHDOG_ERR", e.message);
  }
}
setTimeout(runSentinelWatchdog, 15000); // 15s after startup
setInterval(runSentinelWatchdog, 5 * 60 * 1000); // every 5m

// ---------------------------------------------------------------------------
// 11. Live Streaming Agy Runtime (`--output-format stream-json`) + /cancel
// ---------------------------------------------------------------------------
let activeRun = null;

function killProcessTree(pid) {
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } catch (e) {
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
  }
}

function formatToolProgress(toolName, params = {}) {
  const base = (p) => (p ? path.basename(String(p)) : "");
  switch (toolName) {
    case "run_command": {
      const cmd = String(params.CommandLine || "").replace(/\s+/g, " ").trim();
      const short = cmd.length > 48 ? cmd.slice(0, 47) + "…" : cmd;
      return `⚙️ Running: <code>${escapeHtml(short || "command")}</code>`;
    }
    case "view_file":
    case "read_file":
      return `📄 Reading <code>${escapeHtml(base(params.AbsolutePath || params.Path || "file"))}</code>`;
    case "write_to_file":
    case "write_file":
      return `✏️ Writing <code>${escapeHtml(base(params.TargetFile || params.Path || "file"))}</code>`;
    case "replace_file_content":
    case "multi_replace_file_content":
    case "edit_file":
      return `🔧 Editing <code>${escapeHtml(base(params.TargetFile || params.Path || "file"))}</code>`;
    case "list_dir":
    case "find_by_name":
    case "grep_search":
      return `🔎 Scanning workspace...`;
    case "search_web":
      return `🌐 Searching web: <i>${escapeHtml(String(params.query || "").slice(0, 45))}</i>`;
    case "generate_image":
      return `🎨 Generating image...`;
    default:
      return `⚙️ Running <code>${escapeHtml(toolName || "tool")}</code>...`;
  }
}

function runAgyStreaming(prompt, cwd, chatId, onProgress) {
  return new Promise((resolve, reject) => {
    const workDirKey = path.resolve(cwd).toLowerCase();
    const savedConvId = config.projectSessions[workDirKey];

    const args = [];
    if (config.startFreshNext) {
      config.startFreshNext = false;
      delete config.projectSessions[workDirKey];
      saveConfig(config);
      log("SESSION", `Starting fresh thread in ${path.basename(cwd)}`);
    } else if (savedConvId) {
      args.push("--conversation", savedConvId);
    } else {
      log("SESSION", `Initializing new tracked thread for ${path.basename(cwd)}`);
    }

    args.push(
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--print",
      wrapMobileHudPrompt(prompt)
    );

    const agy = spawn(config.agyPath, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env },
    });

    const runState = { child: agy, chatId, aborted: false };
    activeRun = runState;

    let buf = "";
    let stderr = "";
    let finalResponse = "";
    let streamedText = "";
    let convId = savedConvId || null;
    let sawResponseDelta = false;

    const timer = setTimeout(() => {
      if (activeRun === runState) {
        runState.aborted = true;
        killProcessTree(agy.pid);
        resolve("[Runtime Notice]: Execution exceeded 5-minute timeout limit.");
      }
    }, 300000);

    agy.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }

        if (ev.event === "init" && ev.conversation_id) {
          convId = ev.conversation_id;
        } else if (ev.event === "step_update" && ev.step_update) {
          const su = ev.step_update;
          if (su.conversation_id) convId = su.conversation_id;

          if (su.step_type === "tool" && su.state === "ACTIVE") {
            const label = formatToolProgress(su.tool_name, su.tool_info?.parameters);
            onProgress(label);
          } else if (su.step_type === "agent_response") {
            if (su.text_delta) {
              streamedText += su.text_delta;
              if (!sawResponseDelta) {
                sawResponseDelta = true;
                onProgress("💬 Drafting reply...");
              }
            }
          }
        } else if (ev.event === "result" && ev.result) {
          if (ev.result.conversation_id) convId = ev.result.conversation_id;
          if (typeof ev.result.response === "string") finalResponse = ev.result.response;
        }
      }
    });

    agy.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });

    agy.on("close", (code) => {
      clearTimeout(timer);
      if (activeRun === runState) activeRun = null;
      if (runState.aborted) return resolve(null);

      if (convId) {
        config.projectSessions[workDirKey] = convId;
        saveConfig(config);
      }

      const answer = (finalResponse || streamedText).trim();
      if (code === 0 && answer) {
        resolve(answer);
      } else if (answer) {
        resolve(answer);
      } else {
        const err = stderr.trim() || `Process exited with code ${code}`;
        resolve(`[Runtime Notice]: ${err}`);
      }
    });

    agy.on("error", (err) => {
      clearTimeout(timer);
      if (activeRun === runState) activeRun = null;
      reject(err);
    });
  });
}

function extractFilePathFromText(text) {
  if (!text) return null;
  const match = text.match(/["']?([a-zA-Z]:\\[^"'\n\r<>*?]+?\.[a-zA-Z0-9_-]+)["']?/);
  if (match) {
    const candidate = match[1].trim();
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isSendRequest(text) {
  if (!text) return false;
  return /\b(send|give|upload|download|transfer|fetch|get)\b/i.test(text);
}

function pickSticker(query = "") {
  const stickersPath = path.join(__dirname, "stickers.json");
  if (!fs.existsSync(stickersPath)) return query;
  try {
    const list = JSON.parse(fs.readFileSync(stickersPath, "utf-8"));
    if (!list || !list.length) return query;
    const raw = (query || "").trim();
    if (!raw || raw.toLowerCase() === "random") {
      return list[Math.floor(Math.random() * list.length)].fileId;
    }
    if (/^[A-Za-z0-9_-]{35,}$/.test(raw)) {
      return raw;
    }
    const q = raw.toLowerCase();
    const matches = list.filter((s) => {
      return (
        (s.setName && s.setName.toLowerCase().includes(q)) ||
        (s.setTitle && s.setTitle.toLowerCase().includes(q)) ||
        (s.emoji && s.emoji.includes(raw))
      );
    });
    if (matches.length > 0) {
      return matches[Math.floor(Math.random() * matches.length)].fileId;
    }
    return list[Math.floor(Math.random() * list.length)].fileId;
  } catch (e) {
    return query;
  }
}

async function processAgyReply(chatId, userPrompt, reply, shouldSpeak) {
  if (reply === null) return;

  const sentFiles = new Set();

  // 1. Extract [SEND_FILE: <path>]
  const fileDirectiveRegex = /\[(?:SEND_FILE|FILE):\s*([^\]]+)\]/gi;
  const matches = [...reply.matchAll(fileDirectiveRegex)];
  if (matches.length > 0) {
    reply = reply.replace(fileDirectiveRegex, "").trim();
    for (const match of matches) {
      let targetPath = match[1].trim().replace(/^["']|["']$/g, "");
      if (!path.isAbsolute(targetPath)) targetPath = path.resolve(config.workDir, targetPath);
      await dispatchMedia(chatId, targetPath, sentFiles);
    }
  }

  // 2. Extract [SET_REMINDER: {...}]
  const remDirectiveRegex = /\[SET_REMINDER:\s*({[^\]]+})\]/gi;
  const remMatches = [...reply.matchAll(remDirectiveRegex)];
  if (remMatches.length > 0) {
    reply = reply.replace(remDirectiveRegex, "").trim();
    for (const match of remMatches) {
      try {
        const data = JSON.parse(match[1]);
        const title = data.title || "Untitled Reminder";
        const due = parseNaturalTime(data.time || data.in || "in 1h");
        if (due) {
          const item = addReminder(title, due, data.category || "task");
          const timeStr = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const dateStr = due.toLocaleDateString([], { month: "short", day: "numeric" });
          await callTg("sendMessage", {
            chat_id: chatId,
            text: `⏰ <b>Reminder Set, Boss</b>\n• <b>Task:</b> ${escapeHtml(title)}\n• <b>Scheduled:</b> ${dateStr} at ${timeStr}`,
            parse_mode: "HTML",
            reply_markup: getReminderButtons(item.id),
          });
        }
      } catch (e) {
        log("REM_DIRECTIVE_ERR", e.message);
      }
    }
  }

  // 3. Extract [ADD_PRODUCT: {...}]
  const prodDirectiveRegex = /\[ADD_PRODUCT:\s*({[^\]]+})\]/gi;
  const prodMatches = [...reply.matchAll(prodDirectiveRegex)];
  if (prodMatches.length > 0) {
    reply = reply.replace(prodDirectiveRegex, "").trim();
    for (const match of prodMatches) {
      try {
        const data = JSON.parse(match[1]);
        const name = data.name || "Unnamed Product";
        const notes = data.notes || "";
        addProduct(name, notes, data.project || path.basename(config.workDir));
        await callTg("sendMessage", {
          chat_id: chatId,
          text: `📦 <b>Product Logged, Boss</b>\n• <b>Item:</b> ${escapeHtml(name)}\n• <b>Notes:</b> ${escapeHtml(notes || "(none)")}`,
          parse_mode: "HTML",
        });
      } catch (e) {
        log("PROD_DIRECTIVE_ERR", e.message);
      }
    }
  }

  // 3.5. Extract [SEND_STICKER: <id>]
  const stickerDirectiveRegex = /\[(?:SEND_STICKER|STICKER):\s*([^\]]+)\]/gi;
  const stickerMatches = [...reply.matchAll(stickerDirectiveRegex)];
  if (stickerMatches.length > 0) {
    reply = reply.replace(stickerDirectiveRegex, "").trim();
    for (const match of stickerMatches) {
      const stickerId = pickSticker(match[1].trim());
      try {
        await callTg("sendSticker", { chat_id: chatId, sticker: stickerId });
      } catch (e) {
        log("STICKER_DIRECTIVE_ERR", e.message);
      }
    }
  }

  // 4. Extract Markdown file links if media/file requested
  if (
    isSendRequest(userPrompt) ||
    /\b(screenshot|capture|photo|image|doc|pdf|report)\b/i.test(userPrompt)
  ) {
    const mdLinkRegex = /\[([^\]]*)\]\((?:file:\/\/\/)?([a-zA-Z]:[\\/][^)]+)\)/gi;
    const mdMatches = [...reply.matchAll(mdLinkRegex)];
    for (const mdMatch of mdMatches) {
      const rawPath = decodeURIComponent(mdMatch[2]).replace(/\//g, "\\");
      if (fs.existsSync(rawPath) && fs.statSync(rawPath).isFile()) {
        await dispatchMedia(chatId, rawPath, sentFiles);
      }
    }
  }

  if (reply.length > 0) {
    await sendChunkedMessage(chatId, reply);

    if (shouldSpeak) {
      try {
        await sendTyping(chatId, "record_voice");
        const replyAudioPath = path.join(RECEIVED_DIR, `reply_${Date.now()}.ogg`);
        const generated = await generateVoice(reply, replyAudioPath);
        if (generated) await sendVoice(chatId, generated);
      } catch (ttsErr) {
        log("TTS_ERROR", ttsErr.message);
      }
    }
  }

  log("REPLY", `Completed turn for ${chatId} (${path.basename(config.workDir)})`);
}

async function executeTurn(chatId, prompt, isVoiceInput = false) {
  await sendTyping(chatId, "typing");
  const typingInterval = setInterval(() => sendTyping(chatId, "typing"), 4000);

  let hudMsgId = null;
  let hudBusy = false;
  let lastHudText = "";
  let lastHudEditAt = 0;
  const hudHistory = [];
  let pendingUpdate = null;

  async function flushHud(text) {
    if (hudBusy) {
      pendingUpdate = text;
      return;
    }
    const now = Date.now();
    if (text === lastHudText) return;
    if (hudMsgId && now - lastHudEditAt < 1200) {
      pendingUpdate = text;
      return;
    }

    hudBusy = true;
    try {
      const header = `<b>Shaila</b> <i>(${escapeHtml(path.basename(config.workDir))})</i>`;
      const body = `${header}\n${text}`;
      if (!hudMsgId) {
        const res = await callTg("sendMessage", {
          chat_id: chatId,
          text: body,
          parse_mode: "HTML",
          disable_notification: true,
        }, 15000);
        hudMsgId = res?.result?.message_id || null;
      } else {
        await editMessageHtml(chatId, hudMsgId, body);
      }
      lastHudText = text;
      lastHudEditAt = Date.now();
    } finally {
      hudBusy = false;
      if (pendingUpdate && pendingUpdate !== lastHudText) {
        const next = pendingUpdate;
        pendingUpdate = null;
        setTimeout(() => flushHud(next), 1200);
      }
    }
  }

  const slowTimer = setTimeout(() => {
    if (!hudMsgId && activeRun) flushHud("⚡ Thinking...");
  }, 3000);

  try {
    const reply = await runAgyStreaming(prompt, config.workDir, chatId, (stepLabel) => {
      if (hudHistory[hudHistory.length - 1] !== stepLabel) {
        hudHistory.push(stepLabel);
        if (hudHistory.length > 4) hudHistory.shift();
      }
      flushHud(hudHistory.join("\n"));
    });

    clearTimeout(slowTimer);
    clearInterval(typingInterval);
    await deleteMessageSafe(chatId, hudMsgId);

    const shouldSpeak =
      config.voiceMode === "on" || (config.voiceMode === "auto" && isVoiceInput);
    await processAgyReply(chatId, prompt, reply, shouldSpeak);
  } catch (err) {
    clearTimeout(slowTimer);
    clearInterval(typingInterval);
    await deleteMessageSafe(chatId, hudMsgId);
    log("ERROR", err.message);
    await callTg("sendMessage", { chat_id: chatId, text: `Diagnostic error: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// 12. Interactive Callback Handler (Inline Buttons)
// ---------------------------------------------------------------------------
async function handleCallbackQuery(cb) {
  const chatId = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  const data = cb.data || "";

  if (!chatId || chatId !== config.allowedChatId) {
    await answerCallback(cb.id, "Unauthorized.");
    return;
  }

  if (data === "noop") {
    await answerCallback(cb.id);
    return;
  }

  // --- Proactive Reminders Actions ---
  if (data.startsWith("rem_done:")) {
    const id = data.split(":")[1];
    const rems = getReminders();
    const item = rems.find((r) => r.id === id);
    if (item) {
      item.completed = true;
      saveReminders(rems);
      await answerCallback(cb.id, "Marked complete!");
      await editMessageHtml(chatId, msgId, `✅ <b>Completed:</b> ${escapeHtml(item.title)}`);
    } else {
      await answerCallback(cb.id, "Reminder not found.");
    }
    return;
  }

  if (data.startsWith("rem_snz:")) {
    const parts = data.split(":");
    const id = parts[1];
    const mins = Number(parts[2]) || 30;
    const rems = getReminders();
    const item = rems.find((r) => r.id === id);
    if (item) {
      const newDue = new Date(Date.now() + mins * 60000);
      item.dueAt = newDue.toISOString();
      item.notified = false;
      saveReminders(rems);
      const timeStr = newDue.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      await answerCallback(cb.id, `Snoozed +${mins}m`);
      await editMessageHtml(
        chatId,
        msgId,
        `⏰ <b>Snoozed (+${mins}m):</b> ${escapeHtml(item.title)}\nDue at <b>${timeStr}</b>`,
        getReminderButtons(item.id)
      );
    } else {
      await answerCallback(cb.id, "Reminder not found.");
    }
    return;
  }

  if (data.startsWith("rem_tmrw:")) {
    const id = data.split(":")[1];
    const rems = getReminders();
    const item = rems.find((r) => r.id === id);
    if (item) {
      const tmrw = new Date();
      tmrw.setDate(tmrw.getDate() + 1);
      tmrw.setHours(9, 0, 0, 0);
      item.dueAt = tmrw.toISOString();
      item.notified = false;
      saveReminders(rems);
      await answerCallback(cb.id, "Moved to tomorrow 9:00 AM");
      await editMessageHtml(
        chatId,
        msgId,
        `🌅 <b>Rescheduled:</b> ${escapeHtml(item.title)}\nDue tomorrow at <b>9:00 AM</b>`
      );
    } else {
      await answerCallback(cb.id, "Reminder not found.");
    }
    return;
  }

  if (data.startsWith("rem_del:")) {
    const id = data.split(":")[1];
    let rems = getReminders();
    const item = rems.find((r) => r.id === id);
    rems = rems.filter((r) => r.id !== id);
    saveReminders(rems);
    await answerCallback(cb.id, "Reminder dismissed.");
    await editMessageHtml(chatId, msgId, `🗑️ <i>Dismissed: ${escapeHtml(item ? item.title : "reminder")}</i>`);
    return;
  }

  if (data === "act:list_reminders") {
    await answerCallback(cb.id);
    const view = formatRemindersList();
    await callTg("sendMessage", { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
    return;
  }

  if (data === "act:rem_help") {
    await answerCallback(cb.id);
    await callTg("sendMessage", {
      chat_id: chatId,
      text: "<b>How to set reminders:</b>\n\n• <code>/remind in 45m Check build</code>\n• <code>/remind at 14:00 Call vendor</code>\n• <code>/remind tomorrow at 9am Bakery inventory</code>\n\nOr ask me naturally in text or voice!",
      parse_mode: "HTML",
    });
    return;
  }

  // --- Proactive Products Actions ---
  if (data.startsWith("prod_done:")) {
    const id = data.split(":")[1];
    const prods = getProducts();
    const item = prods.find((p) => p.id === id);
    if (item) {
      item.status = "done";
      saveProducts(prods);
      await answerCallback(cb.id, "Item marked done!");
      await editMessageHtml(chatId, msgId, `✅ <b>Acquired/Done:</b> ${escapeHtml(item.name)}`);
    } else {
      await answerCallback(cb.id, "Product not found.");
    }
    return;
  }

  if (data.startsWith("prod_del:")) {
    const id = data.split(":")[1];
    let prods = getProducts();
    const item = prods.find((p) => p.id === id);
    prods = prods.filter((p) => p.id !== id);
    saveProducts(prods);
    await answerCallback(cb.id, "Product removed.");
    await editMessageHtml(chatId, msgId, `🗑️ <i>Removed: ${escapeHtml(item ? item.name : "product")}</i>`);
    return;
  }

  if (data === "act:prod_help") {
    await answerCallback(cb.id);
    await callTg("sendMessage", {
      chat_id: chatId,
      text: "<b>How to track products & supplies:</b>\n\n• <code>/product add Flour Grade A 50kg</code>\n• <code>/product add Vanilla Essence [Bakery]</code>\n• <code>/products</code> : View all active items",
      parse_mode: "HTML",
    });
    return;
  }

  // --- Bridge Actions ---
  if (data === "act:brief") {
    await answerCallback(cb.id, "Generating briefing...");
    const brief = await generateDailyBriefing("Live");
    await callTg("sendMessage", { chat_id: chatId, text: brief, parse_mode: "HTML", reply_markup: STATUS_KEYBOARD });
    return;
  }

  if (data === "act:status_refresh") {
    await answerCallback(cb.id, "Refreshing telemetry...");
    await handleStatusCommand(chatId, msgId);
    return;
  }

  if (data === "act:ss") {
    await answerCallback(cb.id, "Capturing screen...");
    handleScreenshotCommand(chatId);
    return;
  }

  if (data === "act:lock_prompt") {
    await answerCallback(cb.id);
    await callTg("sendMessage", {
      chat_id: chatId,
      text: "<b>Confirm Action:</b> Lock Windows workstation immediately?",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔒 Confirm Lock", callback_data: "act:lock_confirm" },
            { text: "Cancel", callback_data: "act:dismiss" },
          ],
        ],
      },
    });
    return;
  }

  if (data === "act:lock_confirm") {
    await answerCallback(cb.id, "Locking PC...");
    spawn("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true });
    await editMessageHtml(chatId, msgId, "🔒 Workstation locked, Boss.");
    return;
  }

  if (data === "act:dismiss") {
    await answerCallback(cb.id, "Cancelled.");
    await deleteMessageSafe(chatId, msgId);
    return;
  }

  if (data === "act:sleep_confirm") {
    await answerCallback(cb.id, "Entering sleep mode...");
    await editMessageHtml(chatId, msgId, "💤 <b>Workstation entering sleep mode, Boss.</b> Standing by on wake.");
    spawn("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { windowsHide: true });
    return;
  }

  // --- Git Quick Actions ---
  if (data === "git:status") {
    await answerCallback(cb.id, "Checking git status...");
    const cwd = config.workDir;
    const res = runShellCommand("git status -s -b", cwd, 15000);
    const branchRes = runShellCommand("git rev-parse --abbrev-ref HEAD", cwd, 5000);
    const branch = branchRes.output.trim() || "unknown";
    const lines = res.output.trim().split("\n").filter(Boolean);
    const text = [
      `<b>Git Status</b> • <code>${escapeHtml(path.basename(cwd))}</code>`,
      `• <b>Branch:</b> <code>${escapeHtml(branch)}</code>`,
      `• <b>Modified:</b> ${Math.max(0, lines.length - 1)} files`,
      lines.length ? `<pre>${escapeHtml(lines.slice(0, 15).join("\n"))}</pre>` : `<i>Working tree clean</i>`,
    ].join("\n");
    await editMessageHtml(chatId, msgId, text, {
      inline_keyboard: [
        [
          { text: "📝 Diff Stat", callback_data: "git:diff" },
          { text: "⬇️ Git Pull", callback_data: "git:pull" },
        ],
        [
          { text: "📜 Recent Commits", callback_data: "git:log" },
          { text: "🔄 Refresh", callback_data: "git:status" },
        ],
      ],
    });
    return;
  }

  if (data === "git:diff") {
    await answerCallback(cb.id);
    const cwd = config.workDir;
    const res = runShellCommand("git diff --stat", cwd, 15000);
    const diffText = res.output.trim() || "No local unstaged changes.";
    await editMessageHtml(chatId, msgId, `<b>Git Diff Stat</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(diffText.slice(0, 3000))}</pre>`, {
      inline_keyboard: [[{ text: "🔄 Back to Status", callback_data: "git:status" }]],
    });
    return;
  }

  if (data === "git:pull") {
    await answerCallback(cb.id, "Pulling latest changes...");
    const cwd = config.workDir;
    const res = runShellCommand("git pull", cwd, 30000);
    await editMessageHtml(chatId, msgId, `<b>Git Pull Result</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(res.output.trim() || "(clean)")}</pre>`, {
      inline_keyboard: [[{ text: "🔄 Back to Status", callback_data: "git:status" }]],
    });
    return;
  }

  if (data === "git:log") {
    await answerCallback(cb.id);
    const cwd = config.workDir;
    const res = runShellCommand("git log -n 5 --oneline", cwd, 10000);
    await editMessageHtml(chatId, msgId, `<b>Recent Commits</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(res.output.trim())}</pre>`, {
      inline_keyboard: [[{ text: "🔄 Back to Status", callback_data: "git:status" }]],
    });
    return;
  }

  if (data === "sentinel:refresh") {
    await answerCallback(cb.id, "Scanning upstream PRs...");
    try {
      await checkTargets(false);
      const stateFile = path.join(__dirname, "sentinel-state.json");
      let state = {};
      if (fs.existsSync(stateFile)) {
        state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      }
      const card = [
        `<b>🚀 Sentinel // Upstream Telemetry</b>`,
        `Active upstream PR & Issue telemetry:`,
        ``,
        `• <b>Langfuse PR #20495:</b> <a href="https://github.com/langfuse/langfuse/pull/20495">#20495</a> (${state.langfuse?.state || "OPEN"})`,
        `  Labels: <code>${(state.langfuse?.labels || []).join(", ") || "none"}</code>`,
        `  Comments: ${state.langfuse?.commentsCount || 0}`,
        ``,
        `• <b>Cal.com PR #30598:</b> <a href="https://github.com/calcom/cal.diy/pull/30598">#30598</a> (${state.calcom?.state || "OPEN"})`,
        `  Labels: <code>${(state.calcom?.labels || []).join(", ") || "none"}</code>`,
        `  Comments: ${state.calcom?.commentsCount || 0}`,
        ``,
        `• <b>Twenty Issue #30760:</b> <a href="https://github.com/twentyhq/twenty/issues/30760">#30760</a> (${state.twenty?.state || "OPEN"})`,
        `  Comments: ${state.twenty?.commentsCount || 0}`,
      ].join("\n");
      await editMessageHtml(chatId, msgId, card, {
        inline_keyboard: [[{ text: "🔄 Refresh Sentinel Now", callback_data: "sentinel:refresh" }]],
      });
    } catch (e) {
      await answerCallback(cb.id, `Error: ${e.message}`);
    }
    return;
  }

  if (data.startsWith("proj_page:")) {
    const page = Number(data.split(":")[1]) || 0;
    await answerCallback(cb.id);
    const view = buildProjectsKeyboard(page);
    await editMessageHtml(chatId, msgId, view.text, view.reply_markup);
    return;
  }

  if (data.startsWith("proj_set:")) {
    const idx = Number(data.split(":")[1]);
    if (!cachedProjects.length) scanProjects();
    const chosen = cachedProjects[idx];
    if (!chosen || !fs.existsSync(chosen.path)) {
      await answerCallback(cb.id, "Project folder not found.");
      return;
    }
    await answerCallback(cb.id, `Switched to ${chosen.name}`);
    await deleteMessageSafe(chatId, msgId);
    await switchWorkspace(chatId, chosen.path);
    return;
  }

  await answerCallback(cb.id);
}

// ---------------------------------------------------------------------------
// 13. Main Telegram Polling Loop (`message` + `callback_query`)
// ---------------------------------------------------------------------------
log("INFO", `Shaila Telegram Bridge Initialized (v6 - PID ${process.pid})`);
registerBotCommands();

let offset = 0;

async function poll() {
  while (true) {
    try {
      const data = await callTg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      }, 35000);

      if (!data.ok) {
        log("TG_ERROR", data.description || "Unknown getUpdates error");
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      if (Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            handleCallbackQuery(update.callback_query);
            continue;
          }

          const msg = update.message;
          if (!msg) continue;

          const chatId = msg.chat.id;
          const fromName = msg.from?.first_name || "Boss";

          if (!config.allowedChatId) {
            config.allowedChatId = chatId;
            saveConfig(config);
            log("SECURITY", `Bridge locked to Chat ID: ${chatId}`);
            await callTg("sendMessage", {
              chat_id: chatId,
              text: "Bridge locked to this device, Boss. Shaila is online and listening.",
            });
            continue;
          }

          if (chatId !== config.allowedChatId) {
            log("BLOCKED", `Unauthorized attempt from ${chatId}`);
            await callTg("sendMessage", {
              chat_id: chatId,
              text: "Access denied. This terminal is locked to an authorized operator.",
            });
            continue;
          }

          // -----------------------------------------------------------
          // Instant Commands (0 Tokens, Immediate Execution)
          // -----------------------------------------------------------
          const rawTrimmed = (msg.text || "").trim();
          const quickLower = rawTrimmed.toLowerCase();
          const QUICK_ACTION_MAP = {
            "📸 screenshot": "/ss",
            "📸 screen": "/ss",
            "⚡ status": "/status",
            "⚡ telemetry": "/status",
            "📁 projects": "/projects",
            "🔄 git status": "/git",
            "🔄 git": "/git",
            "🚀 sentinel": "/sentinel",
            "📋 briefing": "/brief",
            "📋 brief": "/brief",
            "🔒 lock": "/lock",
            "🔌 ports": "/ports",
          };
          const rawText = QUICK_ACTION_MAP[quickLower] || rawTrimmed;
          const cmdMatch = rawText.match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
          if (cmdMatch) {
            const cmd = cmdMatch[1].toLowerCase();
            const argRaw = (cmdMatch[2] || "").trim();
            const arg = argRaw.toLowerCase();

            if (cmd === "menu") {
              await callTg("sendMessage", {
                chat_id: chatId,
                text: "<b>Quick Actions</b>\nShortcuts ready below.",
                parse_mode: "HTML",
                reply_markup: MAIN_KEYBOARD,
              });
              continue;
            }

            if (cmd === "git") {
              const sub = (argRaw.split(/\s+/)[0] || "status").toLowerCase();
              const cwd = config.workDir;

              if (sub === "status" || sub === "st") {
                const res = runShellCommand("git status -s -b", cwd, 15000);
                const branchRes = runShellCommand("git rev-parse --abbrev-ref HEAD", cwd, 5000);
                const branch = branchRes.output.trim() || "unknown";
                const lines = res.output.trim().split("\n").filter(Boolean);
                const text = [
                  `<b>Git Status</b> • <code>${escapeHtml(path.basename(cwd))}</code>`,
                  `• <b>Branch:</b> <code>${escapeHtml(branch)}</code>`,
                  `• <b>Modified:</b> ${Math.max(0, lines.length - 1)} files`,
                  lines.length ? `<pre>${escapeHtml(lines.slice(0, 15).join("\n"))}</pre>` : `<i>Working tree clean</i>`,
                ].join("\n");
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: "📝 Diff Stat", callback_data: "git:diff" },
                        { text: "⬇️ Git Pull", callback_data: "git:pull" },
                      ],
                      [
                        { text: "📜 Recent Commits", callback_data: "git:log" },
                        { text: "🔄 Refresh", callback_data: "git:status" },
                      ],
                    ],
                  },
                });
                continue;
              }

              if (sub === "diff") {
                const res = runShellCommand("git diff --stat", cwd, 15000);
                const diffText = res.output.trim() || "No local unstaged changes.";
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `<b>Git Diff Stat</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(diffText.slice(0, 3000))}</pre>`,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🔄 Back to Status", callback_data: "git:status" }]],
                  },
                });
                continue;
              }

              if (sub === "pull") {
                await sendTyping(chatId, "typing");
                const res = runShellCommand("git pull", cwd, 30000);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `<b>Git Pull Result</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(res.output.trim() || "(clean)")}</pre>`,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🔄 Back to Status", callback_data: "git:status" }]],
                  },
                });
                continue;
              }

              if (sub === "log") {
                const res = runShellCommand("git log -n 5 --oneline", cwd, 10000);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `<b>Recent Commits</b> • <code>${escapeHtml(path.basename(cwd))}</code>\n<pre>${escapeHtml(res.output.trim())}</pre>`,
                  parse_mode: "HTML",
                });
                continue;
              }
            }

            if (cmd === "sentinel") {
              await sendTyping(chatId, "typing");
              try {
                await checkTargets(false);
                const stateFile = path.join(__dirname, "sentinel-state.json");
                let state = {};
                if (fs.existsSync(stateFile)) {
                  state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
                }
                const card = [
                  `<b>🚀 Sentinel // Upstream Telemetry</b>`,
                  `Active upstream PR & Issue telemetry:`,
                  ``,
                  `• <b>Langfuse PR #20495:</b> <a href="https://github.com/langfuse/langfuse/pull/20495">#20495</a> (${state.langfuse?.state || "OPEN"})`,
                  `  Labels: <code>${(state.langfuse?.labels || []).join(", ") || "none"}</code>`,
                  `  Comments: ${state.langfuse?.commentsCount || 0}`,
                  ``,
                  `• <b>Cal.com PR #30598:</b> <a href="https://github.com/calcom/cal.diy/pull/30598">#30598</a> (${state.calcom?.state || "OPEN"})`,
                  `  Labels: <code>${(state.calcom?.labels || []).join(", ") || "none"}</code>`,
                  `  Comments: ${state.calcom?.commentsCount || 0}`,
                  ``,
                  `• <b>Twenty Issue #30760:</b> <a href="https://github.com/twentyhq/twenty/issues/30760">#30760</a> (${state.twenty?.state || "OPEN"})`,
                  `  Comments: ${state.twenty?.commentsCount || 0}`,
                ].join("\n");

                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: card,
                  parse_mode: "HTML",
                  disable_web_page_preview: true,
                  reply_markup: {
                    inline_keyboard: [[{ text: "🔄 Refresh Sentinel Now", callback_data: "sentinel:refresh" }]],
                  },
                });
              } catch (e) {
                await callTg("sendMessage", { chat_id: chatId, text: `Sentinel error: ${e.message}` });
              }
              continue;
            }

            if (cmd === "sticker") {
              const stickerId = pickSticker(argRaw);
              if (stickerId) {
                await callTg("sendSticker", { chat_id: chatId, sticker: stickerId });
              } else {
                await callTg("sendMessage", { chat_id: chatId, text: "No stickers indexed yet." });
              }
              continue;
            }

            if (cmd === "ports") {
              const script = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -First 12 LocalPort, OwningProcess | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; [PSCustomObject]@{ Port = $_.LocalPort; PID = $_.OwningProcess; Process = $p.ProcessName } } | Format-Table -AutoSize | Out-String -Width 70`;
              const res = runShellCommand(`powershell -Command "${script.replace(/"/g, '`"')}"`, config.workDir, 10000);
              await callTg("sendMessage", {
                chat_id: chatId,
                text: `<b>Active Listening Ports</b>\n<pre>${escapeHtml(res.output.trim() || "No listening ports found.")}</pre>\nUse <code>/killport &lt;port&gt;</code> to terminate a stuck process.`,
                parse_mode: "HTML",
              });
              continue;
            }

            if (cmd === "killport") {
              const port = parseInt(argRaw, 10);
              if (!port) {
                await callTg("sendMessage", { chat_id: chatId, text: "Usage: <code>/killport 3000</code>", parse_mode: "HTML" });
                continue;
              }
              const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; if ($c) { $pidToKill = $c.OwningProcess; Stop-Process -Id $pidToKill -Force; "Killed process $pidToKill on port ${port}" } else { "No process listening on port ${port}" }`;
              const res = runShellCommand(`powershell -Command "${script.replace(/"/g, '`"')}"`, config.workDir, 10000);
              await callTg("sendMessage", {
                chat_id: chatId,
                text: `<b>Port Surgeon</b>\n<pre>${escapeHtml(res.output.trim())}</pre>`,
                parse_mode: "HTML",
              });
              continue;
            }

            if (cmd === "sleep") {
              await callTg("sendMessage", {
                chat_id: chatId,
                text: "<b>Confirm Action:</b> Put Windows workstation to sleep?",
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "💤 Confirm Sleep", callback_data: "act:sleep_confirm" },
                      { text: "Cancel", callback_data: "act:dismiss" },
                    ],
                  ],
                },
              });
              continue;
            }

            if (cmd === "start" || cmd === "help") {
              const helpHtml = [
                `<b>⚡ Shaila Console</b>`,
                `• <b>Repo:</b> <code>${escapeHtml(path.basename(config.workDir))}</code> | <b>Voice:</b> <code>${config.voiceMode}</code>`,
                ``,
                `• <b>DEV:</b> <code>/git</code> • <code>/ports</code> • <code>/killport &lt;p&gt;</code> • <code>/sentinel</code>`,
                `• <b>SYS:</b> <code>/status</code> • <code>/ss</code> • <code>/projects</code> • <code>/sh &lt;cmd&gt;</code>`,
                `• <b>OPS:</b> <code>/brief</code> • <code>/remind</code> • <code>/product</code> • <code>/lock</code> • <code>/sleep</code>`,
                `• <b>MENU:</b> Tap buttons on docked mobile grid below.`,
              ].join("\n");
              await callTg("sendMessage", { chat_id: chatId, text: helpHtml, parse_mode: "HTML" });
              continue;
            }

            if (cmd === "remind") {
              const timeMatch = argRaw.match(/^((?:in\s+\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))|(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|(?:tomorrow(?:\s+at)?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?))\s+([\s\S]+)$/i);
              if (timeMatch) {
                const timeExpr = timeMatch[1].trim();
                const title = timeMatch[2].trim();
                const due = parseNaturalTime(timeExpr);
                if (due) {
                  const item = addReminder(title, due, "task");
                  const timeStr = due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  const dateStr = due.toLocaleDateString([], { month: "short", day: "numeric" });
                  await callTg("sendMessage", {
                    chat_id: chatId,
                    text: `⏰ <b>Reminder Set, Boss</b>\n• <b>Task:</b> ${escapeHtml(title)}\n• <b>Scheduled:</b> ${dateStr} at ${timeStr}`,
                    parse_mode: "HTML",
                    reply_markup: getReminderButtons(item.id),
                  });
                } else {
                  await callTg("sendMessage", {
                    chat_id: chatId,
                    text: "Could not parse that time. Examples: <code>in 30m</code>, <code>at 14:00</code>, <code>tomorrow at 9am</code>.",
                    parse_mode: "HTML",
                  });
                }
              } else {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: "Usage: <code>/remind in 30m Check the oven</code>\nOr: <code>/remind tomorrow at 9am Bakery flour stock</code>",
                  parse_mode: "HTML",
                });
              }
              continue;
            }

            if (cmd === "reminders") {
              const view = formatRemindersList();
              await callTg("sendMessage", { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
              continue;
            }

            if (cmd === "product") {
              const addMatch = argRaw.match(/^add\s+([^\[\]\n\r]+?)(?:\s+\[([^\]]+)\])?$/i);
              if (addMatch) {
                const name = addMatch[1].trim();
                const notes = (addMatch[2] || "").trim();
                addProduct(name, notes, path.basename(config.workDir));
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `📦 <b>Product Logged, Boss</b>\n• <b>Item:</b> ${escapeHtml(name)}\n• <b>Notes:</b> ${escapeHtml(notes || "(none)")}`,
                  parse_mode: "HTML",
                });
              } else {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: "Usage:\n• <code>/product add Vanilla Extract [5kg bulk]</code>\n• <code>/products</code> : View all active items",
                  parse_mode: "HTML",
                });
              }
              continue;
            }

            if (cmd === "products") {
              const view = formatProductsList();
              await callTg("sendMessage", { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
              continue;
            }

            if (cmd === "brief") {
              await sendTyping(chatId);
              const brief = await generateDailyBriefing("Live");
              await callTg("sendMessage", { chat_id: chatId, text: brief, parse_mode: "HTML", reply_markup: STATUS_KEYBOARD });
              continue;
            }

            if (cmd === "briefing") {
              if (arg === "on" || arg === "off") {
                config.briefingEnabled = arg === "on";
                saveConfig(config);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Scheduled morning/evening briefings turned <b>${arg}</b>.`,
                  parse_mode: "HTML",
                });
              } else {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Daily briefings are <b>${config.briefingEnabled ? "on" : "off"}</b>.\nMorning: ${config.morningBriefingHour}:${config.morningBriefingMinute} | Evening: ${config.eveningBriefingHour}:${config.eveningBriefingMinute}\nUse <code>/briefing on|off</code>.`,
                  parse_mode: "HTML",
                });
              }
              continue;
            }

            if (cmd === "status") {
              handleStatusCommand(chatId);
              continue;
            }

            if (cmd === "ss" || cmd === "screenshot") {
              handleScreenshotCommand(chatId);
              continue;
            }

            if (cmd === "projects" || cmd === "cd") {
              if (argRaw) {
                const list = scanProjects();
                const exact = list.find((p) => p.name.toLowerCase() === arg);
                const partial = exact || list.find((p) => p.name.toLowerCase().includes(arg));
                if (partial) {
                  await switchWorkspace(chatId, partial.path);
                } else {
                  await callTg("sendMessage", {
                    chat_id: chatId,
                    text: `No project matching <code>${escapeHtml(argRaw)}</code> found.`,
                    parse_mode: "HTML",
                  });
                }
              } else {
                const view = buildProjectsKeyboard(0);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: view.text,
                  parse_mode: "HTML",
                  reply_markup: view.reply_markup,
                });
              }
              continue;
            }

            if (cmd === "sh") {
              if (!argRaw) {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Usage: <code>/sh git status</code> (runs in <code>${escapeHtml(path.basename(config.workDir))}</code>)`,
                  parse_mode: "HTML",
                });
                continue;
              }
              (async () => {
                await sendTyping(chatId);
                log("SHELL", `[${path.basename(config.workDir)}]: ${argRaw}`);
                const res = await runShellCommand(argRaw, config.workDir, 30000);
                const header = `<b>$ ${escapeHtml(argRaw)}</b> <i>(exit ${res.code})</i>`;
                if (res.output.length > 3400) {
                  const outFile = path.join(RECEIVED_DIR, `sh_out_${Date.now()}.txt`);
                  fs.writeFileSync(outFile, res.output, "utf-8");
                  await callTg("sendMessage", {
                    chat_id: chatId,
                    text: `${header}\nOutput exceeded 3,400 chars; attached as file:`,
                    parse_mode: "HTML",
                  });
                  await sendDocument(chatId, outFile, "shell_output.txt");
                } else {
                  await callTg("sendMessage", {
                    chat_id: chatId,
                    text: `${header}\n<pre>${escapeHtml(res.output)}</pre>`,
                    parse_mode: "HTML",
                  });
                }
              })();
              continue;
            }

            if (cmd === "lock") {
              await callTg("sendMessage", {
                chat_id: chatId,
                text: "<b>Confirm Action:</b> Lock Windows workstation immediately?",
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "🔒 Confirm Lock", callback_data: "act:lock_confirm" },
                      { text: "Cancel", callback_data: "act:dismiss" },
                    ],
                  ],
                },
              });
              continue;
            }

            if (cmd === "cancel" || cmd === "stop") {
              if (activeRun) {
                activeRun.aborted = true;
                killProcessTree(activeRun.child.pid);
                activeRun = null;
                log("CANCEL", "Active task aborted by Boss");
                await callTg("sendMessage", { chat_id: chatId, text: "Active operation cancelled, Boss." });
              } else {
                await callTg("sendMessage", { chat_id: chatId, text: "Nothing running right now, Boss." });
              }
              continue;
            }

            if (cmd === "new" || cmd === "reset") {
              config.startFreshNext = true;
              delete config.projectSessions[path.resolve(config.workDir).toLowerCase()];
              saveConfig(config);
              await callTg("sendMessage", {
                chat_id: chatId,
                text: `Fresh session ready for <code>${escapeHtml(path.basename(config.workDir))}</code>, Boss.`,
                parse_mode: "HTML",
              });
              continue;
            }

            if (cmd === "voice") {
              if (["auto", "on", "off"].includes(arg)) {
                config.voiceMode = arg;
                saveConfig(config);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Voice reply mode set to <b>${arg}</b>.`,
                  parse_mode: "HTML",
                });
              } else {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Voice mode is <b>${config.voiceMode}</b>. Use <code>/voice auto|on|off</code>.`,
                  parse_mode: "HTML",
                });
              }
              continue;
            }

            if (cmd === "alerts") {
              if (arg === "on" || arg === "off") {
                config.alertsEnabled = arg === "on";
                saveConfig(config);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Proactive hardware alerts turned <b>${arg}</b>.`,
                  parse_mode: "HTML",
                });
              } else {
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Hardware alerts: <b>${config.alertsEnabled ? "on" : "off"}</b>.`,
                  parse_mode: "HTML",
                });
              }
              continue;
            }
          }

          if (activeRun) {
            await callTg("sendMessage", {
              chat_id: chatId,
              text: "Still working on your previous request, Boss. Send /cancel to stop it, or wait a moment.",
            });
            continue;
          }

          // Case 1: Inbound Voice Note
          if (msg.voice || msg.audio) {
            (async () => {
              await sendTyping(chatId, "record_voice");
              let statusMsgId = null;
              try {
                const statusRes = await callTg("sendMessage", {
                  chat_id: chatId,
                  text: "🎙️ Transcribing voice note...",
                });
                statusMsgId = statusRes?.result?.message_id || null;

                const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
                const ext = msg.voice
                  ? "ogg"
                  : (path.extname(msg.audio.file_name || "") || ".ogg").replace(/^\./, "");
                const savedAudio = await downloadTgFile(fileId, `voice_${Date.now()}.${ext}`);

                const transcribedText = await transcribeAudio(savedAudio);
                log("VOICE_TEXT", `[${fromName}]: "${transcribedText}"`);

                if (statusMsgId) {
                  await editMessageHtml(
                    chatId,
                    statusMsgId,
                    `🎧 <i>"${escapeHtml(transcribedText)}"</i>`
                  );
                }

                await executeTurn(chatId, transcribedText, true);
              } catch (err) {
                log("VOICE_ERROR", err.message);
                const errText = `Audio processing error: ${err.message}`;
                if (statusMsgId) await editMessageHtml(chatId, statusMsgId, escapeHtml(errText));
                else await callTg("sendMessage", { chat_id: chatId, text: errText });
              }
            })();
            continue;
          }

          // Case 1.5: Inbound Sticker
          if (msg.sticker) {
            (async () => {
              try {
                const s = msg.sticker;
                const fileId = s.file_id;
                const emoji = s.emoji || "✨";
                const setName = s.set_name || "custom";
                log("STICKER", `Received sticker ${fileId} (${emoji}) from set ${setName}`);

                const stickersPath = path.join(__dirname, "stickers.json");
                let list = [];
                try {
                  if (fs.existsSync(stickersPath)) list = JSON.parse(fs.readFileSync(stickersPath, "utf-8"));
                } catch (e) {}
                if (!list.find((x) => x.fileId === fileId)) {
                  list.push({ fileId, emoji, setName, addedAt: new Date().toISOString() });
                  fs.writeFileSync(stickersPath, JSON.stringify(list, null, 2), "utf-8");
                }

                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Sticker logged ${emoji} (<code>${escapeHtml(setName)}</code>). Added to rotation.`,
                  parse_mode: "HTML",
                });
              } catch (err) {
                log("STICKER_ERROR", err.message);
              }
            })();
            continue;
          }

          // Case 2: Inbound Document / Photo
          if (msg.document || msg.photo) {
            (async () => {
              try {
                const fileId = msg.document
                  ? msg.document.file_id
                  : msg.photo[msg.photo.length - 1].file_id;
                const originalName = msg.document ? msg.document.file_name : "photo.jpg";
                const savedPath = await downloadTgFile(fileId, originalName);
                const caption = msg.caption ? ` Caption: "${msg.caption}"` : "";
                const inboundPrompt = `Boss delivered a file: "${savedPath}".${caption} Acknowledge receipt and inspect the contents if requested.`;
                await executeTurn(chatId, inboundPrompt, false);
              } catch (err) {
                log("INBOUND_ERROR", err.message);
                await callTg("sendMessage", {
                  chat_id: chatId,
                  text: `Diagnostic error processing uploaded file: ${err.message}`,
                });
              }
            })();
            continue;
          }

          // Case 3: Text Message
          if (!rawText) continue;
          log("MSG", `[${fromName} (${chatId})]: ${rawText}`);

          const explicitFilePath = extractFilePathFromText(rawText);
          const wantsFileSent = isSendRequest(rawText);

          if (explicitFilePath && wantsFileSent) {
            const cleanedPrompt = rawText
              .replace(explicitFilePath, "")
              .replace(/["']/g, "")
              .replace(/\b(send|give|me|this|the|file|please)\b/gi, "")
              .trim();

            await sendTyping(chatId);
            await dispatchMedia(chatId, explicitFilePath, new Set(), `Delivered: ${path.basename(explicitFilePath)}`);
            if (cleanedPrompt.length < 5) continue;
          }

          executeTurn(chatId, rawText, false);
        }
      }
    } catch (err) {
      log("POLL_ERROR", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

poll();
