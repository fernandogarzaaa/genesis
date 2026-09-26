# Security policy

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/fernandogarzaaa/genesis/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you would need to reproduce it yourself: version or commit,
the component involved, and a minimal case. You should get an initial
response within a week.

## Supported versions

Only the latest published minor release receives security fixes. Genesis
is pre-1.0, so older minors are not patched — upgrade first, then report
if the issue persists.

## Scope notes

A few things about Genesis's design are worth knowing before reporting:

- **The ledger is a local SQLite database.** Genesis persists run
  records and personal context to a local database file. The optional
  `better-sqlite3` driver is loaded lazily; ledger functionality is
  unavailable without it, and no data is written in that case. Treat the
  ledger file as sensitive and do not publish it without review.
- **Evaluations execute subject code.** `genesis eval` runs the
  subjects under test, including Python classifiers resolved via the
  local interpreter. Only evaluate code you trust, in an environment
  you control.
- **Personal context is sensitive by design.** Genesis is a personal
  context runtime. Configuration and stored context may include details
  from your notes, files, and chat history. Do not commit configuration
  files containing secrets or personal data.
