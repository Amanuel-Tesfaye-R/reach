# Contributing to Reach

Thank you for contributing to **Reach**.

## Development Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/Amanuel-Tesfaye-R/reach.git
   cd reach
   ```
2. Bootstrap local configuration:
   ```bash
   npm run setup
   ```
3. Optional Python voice environment:
   ```bash
   python -m venv .venv
   # Windows: .venv\Scripts\activate
   # Linux/macOS: source .venv/bin/activate
   pip install -r requirements.txt
   ```
4. Verify syntax, runtime bins, and unit tests:
   ```bash
   npm run verify
   npm test
   ```

## Pull Request Guidelines

- Keep `config.json`, `.env`, logs, and personal paths out of commits.
- Add unit tests in `tests/` for new parsing, scheduling, or routing logic.
- Update `README.md` or `SECURITY.md` when introducing new remote commands or capabilities.
