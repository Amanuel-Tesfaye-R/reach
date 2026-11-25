# Reach

[![CI](https://github.com/Amanuel-Tesfaye-R/reach/actions/workflows/lint-and-test.yml/badge.svg)](https://github.com/Amanuel-Tesfaye-R/reach/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-yellow.svg)](https://python.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Text your PC. Text your AI. Get answers right from your desktop 24/7.**

Reach turns Telegram into a direct, always-on portal into your personal computer and the local AI coding agent persona running on it. Inspect live telemetry, pull screenshots and files, run zero-token shell checks, or talk to your desktop agent by text or voice from anywhere.

---

## Core Capabilities

- **Desktop Persona in Your Pocket:** Routes messages straight to your configured local AI agent CLI (Antigravity, Claude Code, Gemini CLI, OpenCode) so your custom rules, memory, and personality work identically on mobile.
- **Direct PC & File Access:** Capture multi-monitor screenshots, switch active project directories, check git status, pull physical files from disk, and run instant shell commands via `/sh <cmd>`.
- **Two-Way Local Voice I/O:** Transcribes voice notes locally on CPU with `faster-whisper` (int8 quantization) and sends natural Opus voice replies via Edge Neural TTS.
- **24/7 Self-Healing Daemon:** `supervisor.mjs` monitors `bridge.mjs` continuously with single-instance PID locks and exponential backoff restarts.
- **Proactive Briefings & Alerts:** Scheduled morning/evening system briefings, battery/disk floor warnings, and upstream GitHub PR/issue tracking via Sentinel.

---

## Architecture

```
 Mobile Telegram Client
          |
          v  (Long Polling + Mobile HUD Keyboards)
  [ src/bridge.mjs ] <======> [ src/supervisor.mjs ] (24/7 Watchdog)
          |
          +---> [ src/telemetry.ps1 ]       -> Host CPU / RAM / Disk / Battery
          +---> [ src/capture-screen.ps1 ]  -> Desktop Screenshot Capture
          +---> [ src/whisper_worker.py ]   -> Local faster-whisper STT
          +---> [ src/speak.py ]            -> Edge-TTS Opus Voice Replies
          +---> [ src/sentinel.mjs ]        -> Upstream PR & Issue Monitor
          |
          v  (Local Workspace + Persona Context)
  [ Local Agent CLI & Workstation Shell ]
```

---

## Quickstart

### 1. Prerequisites
- **Node.js:** 18.0.0 or higher
- **Python:** 3.10 or higher (optional, for voice I/O)
- **FFmpeg:** Installed in system PATH (optional, for Opus voice conversion)
- A Telegram Bot token from [@BotFather](https://t.me/BotFather)

### 2. Clone & Setup

```bash
git clone https://github.com/Amanuel-Tesfaye-R/reach.git
cd reach

# Scaffold .env and config.json from templates
npm run setup
```

Optional voice environment setup:

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Configure & Verify

Add your `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID`, and `AGENT_CLI_PATH` in `config.json` or `.env`, then run preflight diagnostics and unit tests:

```bash
npm run verify
npm test
```

### 4. Start Reach 24/7

```bash
npm start
```

---

## Mobile Commands

| Command | Action |
| :--- | :--- |
| `/status` | Live CPU, RAM, disk, battery, and active agent session telemetry |
| `/screenshot` | Capture and send an instant desktop screenshot |
| `/projects` | Browse and switch active project directories on your PC |
| `/git` | Check git status across active repositories |
| `/sh <cmd>` | Execute a shell command immediately (0 LLM tokens) |
| `/fresh` | Start the next conversation in a clean session |
| `/voice` | Toggle voice reply mode (`auto`, `on`, `off`) |
| `/briefing` | Trigger an on-demand system and reminder briefing |
| `/sentinel` | Run an immediate check on watched upstream PRs/issues |

---

## Project Structure

```
reach/
├── .github/              # CI workflows, issue forms, and PR template
├── scripts/
│   ├── setup.mjs         # One-command .env and config.json bootstrap
│   └── verify.mjs        # Runtime, binary, and syntax verifier
├── src/
│   ├── bridge.mjs        # Core Telegram portal and local agent runner
│   ├── supervisor.mjs    # 24/7 crash-recovery watchdog
│   ├── notify.mjs        # Reminders, product tracking, and alert dispatcher
│   ├── sentinel.mjs      # Upstream PR & issue monitor
│   ├── telemetry.ps1     # Host system metrics extractor
│   ├── capture-screen.ps1# Desktop screenshot utility
│   ├── whisper_worker.py # Persistent local faster-whisper worker
│   └── speak.py          # Edge-TTS Opus speech synthesizer
├── tests/
│   └── reach.test.mjs    # Unit test suite (node --test)
├── VISION.md             # Product philosophy
├── SECURITY.md           # Allowlist and privacy safeguards
├── CONTRIBUTING.md       # Contributor setup and PR rules
└── package.json
```

---

## Security

Reach enforces strict single-user `ALLOWED_CHAT_ID` verification, keeps voice transcription 100% local, and blocks lock-screen captures automatically. Read [SECURITY.md](SECURITY.md) before deploying on an unattended workstation.

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb?style=for-the-badge&labelColor=0f172a)](LICENSE)

Copyright © 2026 **Amanuel Tesfaye**.  
Open-source software distributed under the terms of the [MIT License](LICENSE).

| Permissions | Conditions | Limitations |
| :--- | :--- | :--- |
| Commercial use, modification, distribution, and private use | License and copyright notice must be included | No liability or warranty |
