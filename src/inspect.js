"use strict";

// `hukt inspect <mint>` -- read the mint on-chain (Token-2022 getMint +
// TransferHook extension), derive and decode the ExtraAccountMetaList, then
// enrich with indexer data from GET {api}/hooks/{mint}. Chain data is the
// source of truth; the indexer adds presets, attestation, and transfer counts
// and is allowed to be unreachable.

const {
  describeRawMeta,
  loadHookedMint,
  makeConnection,
  parsePubkey,
  readExtraAccountMetaList,
} = require("./chain");
const { apiUrlFor, fetchJson, printKv, rpcUrlFor, yesNo } = require("./util");

async function fetchIndexerHook(apiUrl, mint, programId) {
  const payload = await fetchJson(`${apiUrl}/hooks/${mint}`);
  const hooks = Array.isArray(payload.hooks) ? payload.hooks : [];
  const entry = hooks.find((h) => h.programId === programId) || hooks[0] || null;
  return { entry, summary: payload.summary || null };
}

function metaLine(described) {
  const target =
    described.kind === "fixed" ? described.pubkey : `${described.kind} [${described.seeds.join(", ")}]`;
  const flags = `signer=${yesNo(described.isSigner)} writable=${yesNo(described.isWritable)}`;
  return [`[${described.index}]`, target, flags];
}

async function cmdInspect(mintArg, flags) {
  const mintPk = parsePubkey(mintArg, "mint");
  const rpcUrl = rpcUrlFor(flags);
  const apiUrl = apiUrlFor(flags);
  const connection = makeConnection(rpcUrl);

  const { mintInfo, hook, hookProgramId } = await loadHookedMint(connection, mintPk);
  if (!hookProgramId) {
    console.error(
      `hukt: mint ${mintPk.toBase58()} is a Token-2022 mint but has no transfer hook extension`,
    );
    return 1;
  }

  const { validationPda, rawMetas } = await readExtraAccountMetaList(
    connection,
    mintPk,
    hookProgramId,
  );
  const described = rawMetas
    ? rawMetas.map((meta, i) => describeRawMeta(meta, 5 + i))
    : [];

  // Indexer enrichment -- optional by contract.
  let indexer = null;
  let indexerError = null;
  try {
    indexer = await fetchIndexerHook(apiUrl, mintPk.toBase58(), hookProgramId.toBase58());
  } catch (err) {
    indexerError = err && err.message ? err.message : String(err);
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          mint: mintPk.toBase58(),
          rpcUrl,
          decimals: mintInfo.decimals,
          supply: mintInfo.supply.toString(),
          transferHook: {
            programId: hookProgramId.toBase58(),
            authority: hook.authority ? hook.authority.toBase58() : null,
            validationPda: validationPda.toBase58(),
            extraAccountMetas: described,
          },
          indexer: indexer
            ? {
                presets: indexer.entry ? indexer.entry.presets : null,
                attested: indexer.entry ? indexer.entry.attested : null,
                attestation: indexer.entry ? indexer.entry.attestation : null,
                summary: indexer.summary,
              }
            : { unreachable: indexerError },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  printKv([
    ["Mint", mintPk.toBase58()],
    ["RPC", rpcUrl],
    ["Token program", "Token-2022"],
    ["Decimals", String(mintInfo.decimals)],
    ["Supply", mintInfo.supply.toString()],
  ]);

  console.log("");
  console.log("Transfer hook");
  printKv(
    [
      ["Program", hookProgramId.toBase58()],
      ["Hook authority", hook.authority ? hook.authority.toBase58() : "none"],
      ["Validation PDA", `${validationPda.toBase58()}  seeds [\"extra-account-metas\", mint]`],
    ],
    "  ",
  );

  console.log("");
  if (rawMetas === null) {
    console.log("ExtraAccountMetaList: not initialized (no PDA account found)");
  } else {
    console.log(`ExtraAccountMetaList (${described.length} extra accounts, Execute indices 5+)`);
    const lines = described.map(metaLine);
    const targetWidth = lines.reduce((m, l) => Math.max(m, l[1].length), 0);
    for (const [idx, target, flagsCol] of lines) {
      console.log(`  ${idx} ${target.padEnd(targetWidth)}  ${flagsCol}`);
    }
  }

  console.log("");
  if (!indexer) {
    console.log(`Indexer: unreachable (${indexerError}); showing chain data only.`);
    return 0;
  }
  console.log(`Indexer (${apiUrl})`);
  const entry = indexer.entry;
  const rows = [];
  if (entry) {
    rows.push(["Presets", entry.presets && entry.presets.length ? entry.presets.join(", ") : "unknown"]);
    if (entry.attested && entry.attestation) {
      rows.push([
        "Attested",
        `yes (${entry.attestation.level}) by ${entry.attestation.authority} at ${entry.attestation.timestamp}`,
      ]);
    } else {
      rows.push(["Attested", "no"]);
    }
    if (Array.isArray(entry.executions)) {
      rows.push(["Recent executions", String(entry.executions.length)]);
    }
  } else {
    rows.push(["Hook", "not indexed for this mint"]);
  }
  if (indexer.summary) {
    rows.push([
      "Transfers",
      `${indexer.summary.totalTransfers} total, ${indexer.summary.hookedTransfers} hooked, last slot ${indexer.summary.lastSlot}`,
    ]);
  }
  printKv(rows, "  ");
  return 0;
}

module.exports = { cmdInspect };
