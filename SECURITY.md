# Security Policy

`hukt-cli` reads on-chain and indexer state and writes local files. It never
holds keys, signs, or sends transactions, so the main risk it carries is
reporting an incorrect account set or an incorrect attestation.

## Reporting a vulnerability

Please report privately rather than opening a public issue:

- Open a private vulnerability report through GitHub's "Report a vulnerability"
  flow on [HuktYard/hukt](https://github.com/HuktYard/hukt/security/advisories/new), or
- Reach out over [@huktfun](https://x.com/huktfun) and we will open a private
  advisory.

Useful details: the command and flags, the mint or hook program id, the RPC and
indexer you used, and the resolved output you believe is wrong.

## Scope

In scope: the CLI resolving an incorrect or unsafe account set, or misreporting
a registry attestation. Out of scope: an RPC or the indexer being unreachable
(the CLI degrades to chain-only output and says so). The soundness of the hook
and registry programs is tracked in the
[HuktYard/hukt](https://github.com/HuktYard/hukt) repository.
