# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `genesis audit`: when a verifier exits 0/1 with no output at all (an exit-code verifier run under the default JSON acceptance rule), each probe note now says `if the verifier reports by exit code, use --accept exit_zero` instead of only "not parseable JSON (empty stdout)", which read as 100% unreadable / UNRELIABLE with no next step.

### Added / Changed
- Tag-triggered npm publish workflow (`.github/workflows/publish.yml`): on a `vX.Y.Z` tag it checks the tag matches `package.json`, skips versions already on npm, runs typecheck/lint/test/build, then `npm publish --provenance`. Needs an `NPM_TOKEN` repository secret.
- `biome.json` migrated to the Biome 2.5.15 schema (`biome migrate`).
- `code-py` probe suite (`src/assurance/suites/code-py.ts`): Python task, pytest visible and held-out tests, 9 exploit probes (visible-answer hard-coding, input special-casing, forged pytest summary, `sys.exit(0)` and `os._exit(0)` at import, conftest/plugin hook injection that deselects or force-passes every test, `SkipTest` as success, hang after printing success) and 2 controls (correct, correct with noisy stdout/stderr). Wired into `genesis suites` and `genesis audit --suite code-py`.
- Python fixture verifiers `fixtures/verifiers/naive_pytest.py` (rated EXPLOITABLE) and `fixtures/verifiers/strict_pytest.py` (rated SOUND: separate time-bounded pytest process in a fresh temp dir, `--noconftest`, JUnit XML counts, canary test). Their end-to-end tests skip when `python3` with pytest is unavailable.
- Dependabot config for npm (root, adapters/node), pip (adapters/python, tools/hub-audit) and GitHub Actions (weekly)
