# Contributing

`hukt-cli` is the command-line surface for HUKT's Token-2022 transfer-hook
framework. The programs, shared Rust libraries, and lower-level SDK live in the
[HuktYard/hukt](https://github.com/HuktYard/hukt) monorepo.

## Development

    npm install
    node bin/hukt.js --help

The CLI is plain Node (18+) with no build step. Chain commands read from a
public RPC (devnet by default) and the HUKT indexer at `https://api.hukt.fun`.

## Ground rules

- The CLI is read-and-codegen only. `inspect`, `resolve`, and `attest` read
  chain and indexer state; `hook add` and `build` write local files. No command
  sends a transaction or deploys a program -- deployment is an explicit
  `anchor deploy` under your own keypair.
- Keep the resolved account order in lockstep with the on-chain Execute order
  (0 source, 1 mint, 2 destination, 3 authority, 4 validation PDA, 5+ extras).
- Match the captured output in the README when you change a command's format.

## Reporting issues

Open an issue with the command, the mint or program id, and the output you saw.
For anything security-sensitive, follow [SECURITY.md](./SECURITY.md).
