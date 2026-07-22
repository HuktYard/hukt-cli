"use strict";

// `hukt resolve <mint>` -- print the fully resolved extra account list for a
// transfer of the mint, following the same live-chain resolution the
// @hukt/account-resolver package performs (spl-token resolveExtraAccountMeta
// against the Execute account order).

const {
  defaultTransferContext,
  makeConnection,
  parsePubkey,
  requireHookedMint,
  resolveExtraAccounts,
} = require("./chain");
const { CliError, apiUrlFor, printKv, rpcUrlFor, yesNo } = require("./util");

async function cmdResolve(mintArg, flags) {
  const mintPk = parsePubkey(mintArg, "mint");
  const rpcUrl = rpcUrlFor(flags);
  const apiUrl = apiUrlFor(flags);
  const connection = makeConnection(rpcUrl);

  const { hookProgramId } = await requireHookedMint(connection, mintPk);
  const context = await defaultTransferContext(connection, mintPk, flags, apiUrl);
  let resolution;
  try {
    resolution = await resolveExtraAccounts(connection, mintPk, hookProgramId, context);
  } catch (err) {
    const tag = `${err && err.name} ${err && err.message}`;
    if (tag.includes("TokenTransferHookAccount")) {
      throw new CliError(
        "this hook derives accounts from live token-account data, but the source or " +
          "destination token account does not exist on chain; pass --source and " +
          "--destination pointing at real token accounts of this mint",
      );
    }
    throw err;
  }
  const { validationPda, accounts } = resolution;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          mint: mintPk.toBase58(),
          programId: hookProgramId.toBase58(),
          validationPda: validationPda.toBase58(),
          source: context.source.toBase58(),
          destination: context.destination.toBase58(),
          authority: context.authority.toBase58(),
          amount: context.amount.toString(),
          extraAccounts: accounts,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  printKv([
    ["Mint", mintPk.toBase58()],
    ["Hook program", hookProgramId.toBase58()],
    ["Validation PDA", validationPda.toBase58()],
    [
      "Source",
      `${context.source.toBase58()}${
        flags.source ? "" : context.sourceIsPlaceholder ? "  (placeholder ATA)" : "  (live token account)"
      }`,
    ],
    [
      "Destination",
      `${context.destination.toBase58()}${
        flags.destination ? "" : context.destinationIsPlaceholder ? "  (placeholder ATA)" : "  (live token account)"
      }`,
    ],
    ["Amount", context.amount.toString()],
  ]);

  console.log("");
  if (accounts === null) {
    console.log("ExtraAccountMetaList not initialized: a transfer needs no extra accounts yet.");
    return 0;
  }
  console.log(`Resolved extra accounts (${accounts.length}, Execute indices 5+)`);
  accounts.forEach((a, i) => {
    const derived = a.derivedFromSeeds ? "seed-derived" : "fixed";
    console.log(
      `  [${5 + i}] ${a.pubkey}  signer=${yesNo(a.isSigner)}  writable=${yesNo(a.isWritable)}  ${derived}`,
    );
  });
  console.log("");
  console.log(
    "A full transfer instruction appends the hook program and the validation PDA;",
  );
  console.log(
    "use @hukt-labs/resolver buildTransfer() or spl-token's createTransferCheckedWithTransferHookInstruction.",
  );
  return 0;
}

module.exports = { cmdResolve };
