import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseNaturalTime } from "../src/notify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("parseNaturalTime parses relative offsets like 'in 30m' and 'in 2h'", () => {
  const before = Date.now();
  const in30 = parseNaturalTime("in 30m");
  assert.ok(in30 instanceof Date);
  const diffMin = Math.round((in30.getTime() - before) / 60000);
  assert.equal(diffMin, 30);

  const in2h = parseNaturalTime("in 2h");
  assert.ok(in2h instanceof Date);
  const diffHr = Math.round((in2h.getTime() - before) / 3600000);
  assert.equal(diffHr, 2);
});

test("parseNaturalTime parses explicit clock times and rejects empty inputs", () => {
  const atNine = parseNaturalTime("at 9:30am");
  assert.ok(atNine instanceof Date);
  assert.equal(atNine.getHours(), 9);
  assert.equal(atNine.getMinutes(), 30);

  assert.equal(parseNaturalTime(""), null);
  assert.equal(parseNaturalTime("not a real time expr"), null);
});

test("config.example.json stays free of real secrets and matches expected defaults", () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(ROOT, "config.example.json"), "utf-8")
  );
  assert.equal(example.botToken, "YOUR_TELEGRAM_BOT_TOKEN");
  assert.equal(example.voiceMode, "auto");
  assert.equal(typeof example.alertsEnabled, "boolean");
});
