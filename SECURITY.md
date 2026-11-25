# Security Policy

**Reach** grants a remote messaging client direct command, file, and AI agent access to your personal computer. Treat configuration security as critical.

## Built-In Safeguards

1. **Single-Operator Allowlist (`ALLOWED_CHAT_ID`):** Every incoming Telegram update is checked against `ALLOWED_CHAT_ID`. Messages, callbacks, and voice notes from any other chat ID are dropped immediately.
2. **Local Voice Processing:** Incoming voice notes are transcribed locally via `faster-whisper` (`src/whisper_worker.py`). No raw user audio is sent to cloud transcription APIs.
3. **Secret Isolation:** `config.json`, `.env`, session state, logs, and screenshots are excluded in `.gitignore`. Never commit real bot tokens or personal chat IDs.
4. **Single-Instance PID Locking:** `bridge.pid` and `supervisor.pid` prevent duplicate daemons from racing over Telegram polling or file writes.

## Operator Best Practices

- Keep your host machine locked behind a strong OS account password; `capture-screen.ps1` intentionally halts if `LogonUI` is active so lock screens are not leaked.
- Store tokens in `.env` or a chmod-restricted `config.json` and rotate your Telegram Bot token immediately via [@BotFather](https://t.me/BotFather) if exposed.

## Reporting a Vulnerability

Do not open a public issue with sensitive reproduction details. Report security concerns privately via [GitHub Security Advisories](https://github.com/Amanuel-Tesfaye-R/reach/security/advisories/new).
