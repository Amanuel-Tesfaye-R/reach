# Contributing to Agent Telegram Bridge

Thank you for your interest in contributing!

## Development Setup

1. Fork and clone the repository.
2. Install Node.js dependencies:
   ```bash
   npm install
   ```
3. Setup the Python voice virtual environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
4. Copy configuration template:
   ```bash
   cp .env.example .env
   ```
5. Run syntax checks:
   ```bash
   npm test
   ```

## Pull Request Guidelines

- Ensure your branch is up to date with `main`.
- Never commit private tokens, chat IDs, or personal directory paths.
- Write clear commit messages and describe changes in your PR.
