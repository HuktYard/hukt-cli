"use strict";

// Command dispatch for hukt-cli. Every command returns its exit code; CliError
// messages are printed as one clean line.

const { CliError, parseArgs } = require("./util");
const { PLACEHOLDER_DEST_OWNER, PLACEHOLDER_SOURCE_OWNER } = require("./chain");

const VERSION = require("../package.json").version;

const BOOLEAN_FLAGS = ["json", "help"];

const USAGE = `hukt-cli ${VERSION}
Solana Token-2022 transfer hooks from the command line.

Usage: hukt <command> [options]

Commands:
  inspect <mint>       Inspect the transfer hook attached to a mint
  resolve <mint>       Print the resolved extra accounts a transfer needs
  attest <mint>        Check the hook program's attestation in the HUKT registry
  hook add <preset>    Validate a preset and merge it into the local hook spec
  build                Generate the deployable program config from the spec

Chain options (inspect / resolve / attest):
  --cluster <name>     devnet (default) or mainnet-beta
  --rpc <url>          RPC endpoint override (public RPC is enough)
  --api <url>          HUKT indexer base URL (default https://api.hukt.fun)
  --json               Machine-readable JSON output

resolve options:
  --source <addr>      Source token account. Default: a token account observed
                       in a real hooked transfer of the mint (HUKT indexer),
                       else the mint's largest live holder, else the ATA of
                       placeholder wallet ${PLACEHOLDER_SOURCE_OWNER}
  --destination <addr> Destination token account (same fallback chain, ending
                       at the ATA of ${PLACEHOLDER_DEST_OWNER})
  --amount <n>         Transfer amount in base units (default 1)

attest options:
  --fail-on <level>    Exit 1 when the verdict is at or worse than the level
                       (caution | malicious); unreviewed hooks also fail the gate

hook add options:
  --bps <n>            royalty / fee-on-transfer basis points
  --addresses <a,b>    whitelist / blacklist addresses (comma-separated base58)
  --cliff <n>          vesting cliff in seconds
  --duration <n>       vesting duration in seconds
  --cooldown <n>       antibot cooldown in seconds
  --max-per-tx <n>     antibot per-transfer cap in base units
  --provider <name>    kycgate attestation provider
  --name <name>        spec name (default composed-hook)
  --spec <path>        spec file (default ./hukt.json)

build options:
  --spec <path>        spec file (default ./hukt.json)
  --out <dir>          output directory (default ./hukt-dist)

Presets:
  royalty, whitelist, blacklist, vesting, antibot, kycgate,
  fee-on-transfer, soulbound

Examples:
  hukt inspect 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29
  hukt resolve 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29 --json
  hukt attest 6rEQuznf2awpSEnrC8DsPbqq6cAHN3Vkk6xRRoYL9V29 --fail-on caution
  hukt hook add royalty --bps 500
  hukt build --out ./hukt-dist`;

function printUsage(stream) {
  stream.write(`${USAGE}\n`);
}

async function run(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    printUsage(process.stdout);
    return 0;
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    console.log(VERSION);
    return 0;
  }

  const [command, ...rest] = argv;

  try {
    if (command === "inspect" || command === "resolve" || command === "attest") {
      const { positionals, flags } = parseArgs(rest, BOOLEAN_FLAGS);
      if (flags.help) {
        printUsage(process.stdout);
        return 0;
      }
      const mint = positionals[0];
      if (!mint) throw new CliError(`${command} requires a mint address`);
      if (positionals.length > 1) {
        throw new CliError(`unexpected argument '${positionals[1]}'`);
      }
      if (command === "inspect") return await require("./inspect").cmdInspect(mint, flags);
      if (command === "resolve") return await require("./resolve").cmdResolve(mint, flags);
      return await require("./attest").cmdAttest(mint, flags);
    }

    if (command === "hook") {
      const { positionals, flags } = parseArgs(rest, BOOLEAN_FLAGS);
      const [sub, preset, ...extra] = positionals;
      if (sub !== "add") {
        throw new CliError(`unknown hook subcommand '${sub || ""}' (expected: hukt hook add <preset>)`);
      }
      if (extra.length > 0) throw new CliError(`unexpected argument '${extra[0]}'`);
      return await require("./spec").cmdHookAdd(preset, flags);
    }

    if (command === "build") {
      const { positionals, flags } = parseArgs(rest, BOOLEAN_FLAGS);
      if (positionals.length > 0) throw new CliError(`unexpected argument '${positionals[0]}'`);
      return await require("./build").cmdBuild(flags);
    }

    console.error(`hukt: unrecognized command '${command}'\n`);
    printUsage(process.stderr);
    return 1;
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`hukt: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

module.exports = { run };
