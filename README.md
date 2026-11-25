# Agent Telegram Bridge

[![CI](https://github.com/Amanuel-Tesfaye-R/agent-telegram-bridge/actions/workflows/lint-and-test.yml/badge.svg)](https://github.com/Amanuel-Tesfaye-R/agent-telegram-bridge/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-yellow.svg)](https://python.org/)

Production-grade bi-directional Telegram bridge connecting autonomous AI coding agents (Antigravity, Claude Code, Gemini CLI, OpenCode) to your mobile phone.

Features real-time Mobile HUD progress streaming, zero-latency local voice transcription (faster-whisper), natural speech synthesis (Edge-TTS), host telemetry, self-healing supervisor daemons, and proactive morning/evening briefings.

---

## Key Features

- **Bi-Directional Agent Telemetry:** Stream agent prompts, tool executions, and file edits directly to Telegram with progress bars and dynamic HUD message edits.
- **Local Whisper Voice Engine:** Fast voice note transcription using `faster-whisper` running locally on CPU with int8 quantization.
- **Edge Speech Synthesis:** Convert agent replies into native Telegram Opus voice notes using Microsoft Edge Neural TTS.
- **Self-Healing Supervisor Daemon:** Automatic crash detection and exponential backoff restart loops for 24/7 background operation.
- **Host Metrics & Remote Telemetry:** Inspect live CPU load, RAM utilization, storage thresholds, battery state, and active terminal sessions.
- **Direct Shell Execution:** Instant remote shell commands via `/sh <cmd>` for rapid diagnostic actions without incurring LLM token costs.
- **Sentinel Upstream Watchdog:** Automated tracking of external PRs and issues across open-source dependencies with proactive push alerts.

---

## Architecture

```
 Mobile Telegram App
         |
         v (HTTPS Webhook / Long Polling)
 [ src/bridge.mjs ] <=======> [ src/supervisor.mjs ] (Daemon watchdog)
         |
         +---> [ src/telemetry.ps1 ]       -> Host CPU/RAM/Battery metrics
         +---> [ src/capture-screen.ps1 ]  -> Desktop screen capture
         +---> [ src/whisper_worker.py ]   -> Local faster-whisper speech-to-text
         +---> [ src/speak.py ]            -> Edge-TTS text-to-speech audio
         +---> [ src/sentinel.mjs ]        -> Upstream PR & issue monitor
         |
         v (Stdio / Process Stream)
 [ Local Agent CLI ] (Antigravity / Claude Code / Gemini)
```

---

## Quickstart

### 1. Prerequisites
- **Node.js:** 18.0.0 or higher
- **Python:** 3.10 or higher
- **FFmpeg:** Installed and added to system PATH (required for audio conversion)
- A Telegram Bot token from [@BotFather](https://t.me/BotFather)

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Amanuel-Tesfaye-R/agent-telegram-bridge.git
cd agent-telegram-bridge

# Install Node dependencies
npm install

# Setup Python voice environment
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Configuration

Copy the example configuration:

```bash
cp .env.example .env
# Or copy config.example.json to config.json
cp config.example.json config.json
```

Populate your `.env` or `config.json`:
- `TELEGRAM_BOT_TOKEN`: The bot API token provided by BotFather.
- `ALLOWED_CHAT_ID`: Your numerical Telegram user/chat ID (only authorized requests will be processed).
- `AGENT_CLI_PATH`: Path or alias of your agent executable (e.g. `agy`, `claude`).

### 4. Running the Bridge

Start the bridge with self-healing supervision:

```bash
npm start
```

Or run the bridge script directly:

```bash
npm run bridge
```

---

## Mobile Slash Commands

| Command | Action |
| :--- | :--- |
| `/status` | View system health, battery, CPU, RAM, and active sessions |
| `/screenshot` | Capture and deliver an instant desktop screenshot |
| `/projects` | Switch active workspace directories on the host PC |
| `/git` | View git status across active repositories |
| `/sh <cmd>` | Execute a PowerShell / shell command instantly (0 tokens) |
| `/fresh` | Toggle fresh session start on the next prompt |
| `/voice` | Toggle voice response mode (`auto`, `on`, `off`) |
| `/briefing` | Trigger an on-demand system and schedule briefing |
| `/sentinel` | Run immediate audit on watched upstream PRs |

---

## Project Structure

```
agent-telegram-bridge/
├── .github/              # CI workflows and issue templates
├── src/
│   ├── bridge.mjs         # Core Telegram bot and agent process engine
│   ├── supervisor.mjs     # Daemon watchdog with exponential backoff
│   ├── notify.mjs         # Standalone Telegram alert dispatcher
│   ├── sentinel.mjs       # Upstream pull request and issue watchdog
│   ├── telemetry.ps1      # Host metrics extractor
│   ├── capture-screen.ps1 # Multi-monitor screenshot utility
│   ├── whisper_worker.py  # Persistent faster-whisper transcription worker
│   └── speak.py           # Edge-TTS speech generator
├── .env.example           # Environment template
├── config.example.json    # JSON configuration template
├── package.json           # Node configuration and scripts
├── requirements.txt       # Python voice dependencies
└── README.md
```

---

## Security & Privacy

- **Authorized Access Only:** The bridge enforces strict single-user verification using `ALLOWED_CHAT_ID`. Unrecognized IDs are ignored.
- **Zero Cloud Audio Leakage:** Voice transcription runs locally via `faster-whisper` on your hardware without sending raw audio to third-party APIs.
- **Single-Instance Locks:** Process ID lockfiles (`bridge.pid`, `supervisor.pid`) prevent duplicate process execution.

---

## License

This project is licensed under the MIT License: see the [LICENSE](LICENSE) file for details.
