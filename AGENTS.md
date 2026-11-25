# Flakefinder repository context

Start with [Project context and build handoff](docs/PROJECT_CONTEXT.md). It maps the code, tests, build artifacts, and release workflow. Check `git status --short --branch` and `git log -1 --oneline` before relying on its dated branch snapshot.

- Use [CONTRIBUTING.md](CONTRIBUTING.md) for development and portability conventions.
- Use [docs/USAGE.md](docs/USAGE.md) for CLI behavior and configuration, and [docs/RELEASING.md](docs/RELEASING.md) for the release procedure.
- Use the current source and colocated tests to resolve discrepancies with historical notes. The ignored `docs/local/` directory contains machine-local historical notes when available.
- Keep build and branch-state claims tied to the commit tested. Refresh the project context when entry points, runtime requirements, CI, or the release process change.
