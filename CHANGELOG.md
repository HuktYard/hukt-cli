# Changelog

All notable changes to `hukt-cli` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

First published release.

### Added

- `hukt inspect <mint>` reads a Token-2022 mint, derives the
  `ExtraAccountMetaList` PDA (seeds `["extra-account-metas", mint]`), decodes
  each entry, and enriches the result with HUKT indexer data.
- `hukt resolve <mint>` prints the fully resolved extra accounts a transfer
  needs, following the on-chain Execute account order.
- `hukt attest <mint>` checks a hook program's attestation in the HUKT
  registry, with `--fail-on caution|malicious` as a CI gate.
- `hukt hook add <preset>` and `hukt build` compose the eight presets into a
  deployable program config; build is codegen only and never touches a cluster.
- `--cluster`, `--rpc`, `--api`, and `--json` flags on the chain commands.

[0.1.0]: https://github.com/HuktYard/hukt-cli/releases/tag/v0.1.0
