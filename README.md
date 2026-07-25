# hukt-cli

Command-line tool for Solana Token-2022 transfer hooks: inspect a hooked mint,
resolve the extra accounts a transfer needs, check a hook program's registry
attestation, and compose the eight verified HUKT presets into a deployable
program config.

Runs against any public RPC (devnet by default) and the HUKT indexer at
`https://api.hukt.fun`. Node 18 or newer.

## Install

```bash
npm install -g hukt-cli
```

Or from source:

```bash
git clone https://github.com/HuktYard/hukt-cli.git
cd hukt-cli
npm install
npm install -g .
```

Both install the `hukt` (and `hukt-cli`) binary.

## Commands

```
hukt inspect <mint>       Inspect the transfer hook attached to a mint
hukt resolve <mint>       Print the resolved extra accounts a transfer needs
hukt attest <mint>        Check the hook program's attestation in the HUKT registry
hukt hook add <preset>    Validate a preset and merge it into the local hook spec
hukt build                Generate the deployable program config from the spec
```

Chain commands accept `--cluster devnet|mainnet-beta`, `--rpc <url>`,
`--api <url>`, and `--json`. `hukt --help` documents every flag.

### hukt inspect

Reads the mint on-chain (Token-2022 `getMint` plus the TransferHook extension),
derives the `ExtraAccountMetaList` PDA (seeds `["extra-account-metas", mint]`
under the hook program), decodes each entry, and enriches the result with
indexer data. If the indexer is unreachable, chain data still prints.

```
$ hukt inspect 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
Mint           6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
RPC            https://api.devnet.solana.com
Token program  Token-2022
Decimals       0
Supply         200000

Transfer hook
  Program         4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC
  Hook authority  472iAFz5YD3mNpmp4TKSVuksm9rYjXHYmqLkfs3rpjzt
  Validation PDA  DVeBHJWmc3rsp7yNcj5MJuXic8CAiHooRzHSjbyR7tjz  seeds ["extra-account-metas", mint]

ExtraAccountMetaList (3 extra accounts, Execute indices 5+)
  [5] pda(hook program) [literal "hook-config", account-key #1 (mint)]                                         signer=no writable=no
  [6] pda(hook program) [literal "royalty", account-key #1 (mint)]                                             signer=no writable=no
  [7] pda(hook program) [literal "royalty-receipt", account-key #1 (mint), account-data #0 (source) [32..64]]  signer=no writable=no

Indexer (https://api.hukt.fun)
  Presets            royalty
  Attested           yes (safe) by 472iAFz5YD3mNpmp4TKSVuksm9rYjXHYmqLkfs3rpjzt at 2026-07-12T03:29:13+00:00
  Recent executions  5
  Transfers          5 total, 5 hooked, last slot 475663391
```

### hukt resolve

Prints the fully resolved extra account list for a transfer, following the
on-chain Execute account order (0 source, 1 mint, 2 destination, 3 authority,
4 validation PDA, 5+ extras) so seed-derived accounts resolve exactly the way
the hook program derives them. When `--source` / `--destination` are omitted,
the CLI prefers token accounts observed in a real hooked transfer of the mint,
then the mint's largest live holder, then a documented placeholder ATA.

```
$ hukt resolve 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
Mint            6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
Hook program    4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC
Validation PDA  DVeBHJWmc3rsp7yNcj5MJuXic8CAiHooRzHSjbyR7tjz
Source          BLfm7oQn9NCPT6KY3paSs4BxMeWW3GcesxVKdQ8JaJsd  (live token account)
Destination     EafiHuR6pxd1Z9d1Df6jL5s4UJRd1tmP8FCqnw8TJc9x  (live token account)
Amount          1

Resolved extra accounts (3, Execute indices 5+)
  [5] 5ztfBpMR4tqFZHqdtxkm34K9kPrqd2VGfMwzzsVKpWKJ  signer=no  writable=no  seed-derived
  [6] 31B4LSMMpaGSEgUtPtdya25UvC7uyKUo3ymJF2KbzRND  signer=no  writable=no  seed-derived
  [7] FU4WVjHHiZ35gnSmWyy6jdpysAJLBVYYWREdRsiXyqhG  signer=no  writable=no  seed-derived
```

### hukt attest

Resolves the mint's hook program from chain, then asks the HUKT registry for
its attestation. `--fail-on caution` (or `malicious`) makes the command a CI
gate: exit code 1 when the worst live verdict is at or worse than the level,
or when the hook is not in the registry at all.

```
$ hukt attest 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29 --fail-on caution
Mint          6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
Hook program  4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC
Registry      https://api.hukt.fun/registry/4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC

Attestation
  Status        attested
  Verdict       safe
  Authority     472iAFz5YD3mNpmp4TKSVuksm9rYjXHYmqLkfs3rpjzt
  Bond          20000000 lamports
  Attested at   2026-07-12T03:29:13+00:00
  Safety score  62
  Deployments   2
  Executions    11

--fail-on caution: PASS
```

A hook program that is not in the registry is reported honestly as unreviewed
(exit 0 without `--fail-on`, exit 1 with it).

### hukt hook add and hukt build

`hook add` validates one of the eight presets (royalty, whitelist, blacklist,
vesting, antibot, kycgate, fee-on-transfer, soulbound) and merges it into a
local spec file (default `./hukt.json`). `build` validates the composed spec,
rejects incompatible pairs (for example whitelist + blacklist), and generates
the deployable program config.

```
$ hukt hook add royalty --bps 500
Preset 'royalty' added.

Spec     /work/hukt.json
Name     composed-hook
Presets  1
  - royalty  bps=500

$ hukt hook add whitelist --addresses 472iAFz5YD3mNpmp4TKSVuksm9rYjXHYmqLkfs3rpjzt,BLfm7oQn9NCPT6KY3paSs4BxMeWW3GcesxVKdQ8JaJsd
$ hukt build
Spec            /work/hukt.json
Presets         royalty, whitelist
Extra accounts  3
Total accounts  8 of 64 per transfer
Output          /work/hukt-dist

Wrote /work/hukt-dist/extra-account-metas.json
Wrote /work/hukt-dist/deploy.md

Build is codegen: nothing was deployed. Follow deploy.md to deploy with anchor.
```

`extra-account-metas.json` is the ordered `ExtraAccountMetaList` layout the
composed presets require (labels, flags, and PDA seeds per account), and
`deploy.md` walks through deploying the Anchor program from the
[HuktYard/hukt](https://github.com/HuktYard/hukt) repo and initializing the
per-mint config. Build never touches a cluster; deployment is an explicit
`anchor deploy` under your own keypair.

## Related packages

- `@hukt-labs/resolver` -- one-line TypeScript integration: `resolver.resolve(mint)`
  and `resolver.buildTransfer(...)`.
- `@hukt/account-resolver` -- the underlying `ExtraAccountMetaList` resolution
  library, in the [HuktYard/hukt](https://github.com/HuktYard/hukt) repo.

MIT (c) hukt-labs
