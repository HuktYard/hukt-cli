"use strict";

// On-chain reads shared by inspect / resolve / attest: load a Token-2022 mint,
// read its TransferHook extension, derive the ExtraAccountMetaList PDA
// (seeds ["extra-account-metas", mint] under the hook program), and decode the
// raw ExtraAccountMeta entries for display.
//
// The resolution logic mirrors @hukt/account-resolver: seed previousMetas with
// spl-token's Execute instruction (0 source, 1 mint, 2 destination,
// 3 authority, 4 validation PDA) so AccountKey / AccountData / InstructionData
// seeds index into exactly what the hook program sees on-chain.

const { Connection, PublicKey } = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID,
  createExecuteInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getExtraAccountMetas,
  getMint,
  getTransferHook,
  resolveExtraAccountMeta,
} = require("@solana/spl-token");
const { CliError, fetchJson } = require("./util");

// Placeholder wallets used only when --source / --destination are not given
// AND the mint has no live token accounts to borrow. They are ordinary,
// throwaway system-program wallets whose associated token accounts stand in
// for the transfer's endpoints; hooks whose seeds read live token-account data
// need real accounts, which is why existing holders are preferred.
const PLACEHOLDER_SOURCE_OWNER = "J6iWLiiskEMN3Gk8CKRDEo9XtvGxmtL5KyQh9BPjNifu";
const PLACEHOLDER_DEST_OWNER = "EdT3YqxbkMSZ5GF4Ef4vKSVwksqpwbQH1TQr24dt6jsb";

function parsePubkey(value, what) {
  try {
    return new PublicKey(value);
  } catch {
    throw new CliError(`${what} is not a valid base58 public key: ${value}`);
  }
}

function makeConnection(rpcUrl) {
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Load the mint and its transfer hook. Throws CliError with a precise reason
 * when the account does not exist, is not a Token-2022 mint, or has no hook.
 */
async function loadHookedMint(connection, mintPk) {
  let mintInfo;
  try {
    mintInfo = await getMint(connection, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
  } catch (err) {
    const name = err && err.name ? err.name : "";
    if (name === "TokenAccountNotFoundError") {
      throw new CliError(
        `mint ${mintPk.toBase58()} does not exist on this cluster (try --cluster or --rpc)`,
      );
    }
    if (name === "TokenInvalidAccountOwnerError") {
      throw new CliError(
        `${mintPk.toBase58()} is not a Token-2022 mint (owned by another program); ` +
          "transfer hooks only exist on Token-2022 mints",
      );
    }
    throw err;
  }

  const hook = getTransferHook(mintInfo);
  const hookProgramId =
    hook && !hook.programId.equals(PublicKey.default) ? hook.programId : null;
  return { mintInfo, hook, hookProgramId };
}

/** Like loadHookedMint but errors when the mint carries no transfer hook. */
async function requireHookedMint(connection, mintPk) {
  const loaded = await loadHookedMint(connection, mintPk);
  if (!loaded.hookProgramId) {
    throw new CliError(
      `mint ${mintPk.toBase58()} is a Token-2022 mint but has no transfer hook extension`,
    );
  }
  return loaded;
}

// --- raw ExtraAccountMeta decoding (for `hukt inspect`) ----------------------

const EXECUTE_ACCOUNT_LABELS = ["source", "mint", "destination", "authority", "validation"];

function accountLabel(index) {
  const label = EXECUTE_ACCOUNT_LABELS[index];
  return label ? `#${index} (${label})` : `#${index}`;
}

function printableUtf8(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  return /^[\x20-\x7e]+$/.test(text) ? text : null;
}

/**
 * Decode the packed seed configs of a PDA-style ExtraAccountMeta into
 * human-readable strings, per spl-tlv-account-resolution's Seed layout:
 *   1 literal {len, bytes} | 2 instruction-data {offset, len}
 *   3 account-key {index}  | 4 account-data {index, offset, len}
 */
function decodeSeeds(addressConfig) {
  const bytes = Buffer.from(addressConfig);
  const seeds = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i];
    if (tag === 0) break; // padding: no further seeds
    if (tag === 1) {
      const len = bytes[i + 1];
      const raw = bytes.subarray(i + 2, i + 2 + len);
      const text = printableUtf8(raw);
      seeds.push(text ? `literal "${text}"` : `literal 0x${Buffer.from(raw).toString("hex")}`);
      i += 2 + len;
    } else if (tag === 2) {
      seeds.push(`instruction-data [${bytes[i + 1]}..${bytes[i + 1] + bytes[i + 2]}]`);
      i += 3;
    } else if (tag === 3) {
      seeds.push(`account-key ${accountLabel(bytes[i + 1])}`);
      i += 2;
    } else if (tag === 4) {
      seeds.push(
        `account-data ${accountLabel(bytes[i + 1])} [${bytes[i + 2]}..${bytes[i + 2] + bytes[i + 3]}]`,
      );
      i += 4;
    } else {
      seeds.push(`unknown seed tag ${tag}`);
      break;
    }
  }
  return seeds;
}

/**
 * Describe one raw ExtraAccountMeta for display:
 *   discriminator 0        fixed pubkey (addressConfig is the key itself)
 *   discriminator 1        PDA of the hook program, from packed seeds
 *   discriminator 128 + i  PDA of the program at Execute account index i
 */
function describeRawMeta(meta, index) {
  const base = {
    index,
    isSigner: meta.isSigner,
    isWritable: meta.isWritable,
  };
  if (meta.discriminator === 0) {
    return {
      ...base,
      kind: "fixed",
      pubkey: new PublicKey(meta.addressConfig).toBase58(),
      seeds: [],
    };
  }
  const seeds = decodeSeeds(meta.addressConfig);
  if (meta.discriminator === 1) {
    return { ...base, kind: "pda(hook program)", pubkey: null, seeds };
  }
  if (meta.discriminator >= 128) {
    return {
      ...base,
      kind: `pda(program at ${accountLabel(meta.discriminator - 128)})`,
      pubkey: null,
      seeds,
    };
  }
  return { ...base, kind: `unknown discriminator ${meta.discriminator}`, pubkey: null, seeds };
}

/** Read and decode the mint's ExtraAccountMetaList; null when the PDA is absent. */
async function readExtraAccountMetaList(connection, mintPk, hookProgramId) {
  const validationPda = getExtraAccountMetaAddress(mintPk, hookProgramId);
  const account = await connection.getAccountInfo(validationPda, "confirmed");
  if (account === null) {
    return { validationPda, rawMetas: null };
  }
  return { validationPda, rawMetas: getExtraAccountMetas(account) };
}

// --- full resolution (for `hukt resolve`) ------------------------------------

/**
 * Resolve every extra account against live chain state, exactly the way
 * @hukt/account-resolver does. Returns { validationPda, accounts } where each
 * account is { pubkey, isSigner, isWritable, derivedFromSeeds }.
 */
async function resolveExtraAccounts(connection, mintPk, hookProgramId, context) {
  const { validationPda, rawMetas } = await readExtraAccountMetaList(
    connection,
    mintPk,
    hookProgramId,
  );
  if (rawMetas === null) {
    return { validationPda, accounts: null };
  }

  const executeIx = createExecuteInstruction(
    hookProgramId,
    context.source,
    mintPk,
    context.destination,
    context.authority,
    validationPda,
    context.amount,
  );
  const previousMetas = executeIx.keys;

  const accounts = [];
  for (const meta of rawMetas) {
    const resolved = await resolveExtraAccountMeta(
      connection,
      meta,
      previousMetas,
      executeIx.data,
      hookProgramId,
    );
    // De-escalate: an extra meta can never raise privileges a pubkey already
    // holds among the accounts resolved so far (mirrors spl-token).
    const highest = previousMetas
      .filter((x) => x.pubkey.equals(resolved.pubkey))
      .reduce(
        (acc, x) =>
          acc
            ? { isSigner: acc.isSigner || x.isSigner, isWritable: acc.isWritable || x.isWritable }
            : { isSigner: x.isSigner, isWritable: x.isWritable },
        null,
      );
    if (highest) {
      if (!highest.isSigner && resolved.isSigner) resolved.isSigner = false;
      if (!highest.isWritable && resolved.isWritable) resolved.isWritable = false;
    }
    previousMetas.push(resolved);
    accounts.push({
      pubkey: resolved.pubkey.toBase58(),
      isSigner: resolved.isSigner,
      isWritable: resolved.isWritable,
      derivedFromSeeds: meta.discriminator !== 0,
    });
  }
  return { validationPda, accounts };
}

/** Owner of a token account, or null when the account cannot be read. */
async function tokenAccountOwner(connection, tokenAccountPk) {
  try {
    const account = await getAccount(connection, tokenAccountPk, "confirmed", TOKEN_2022_PROGRAM_ID);
    return account.owner;
  } catch {
    return null;
  }
}

/**
 * Token accounts observed in real hooked transfers of the mint, newest first,
 * from the HUKT indexer. Best-effort: [] when the indexer is unreachable.
 */
async function observedTransferEndpoints(apiUrl, mintPk) {
  try {
    const payload = await fetchJson(`${apiUrl}/hooks/${mintPk.toBase58()}`);
    const hooks = Array.isArray(payload.hooks) ? payload.hooks : [];
    for (const hook of hooks) {
      const executions = Array.isArray(hook.executions) ? hook.executions : [];
      for (const execution of executions) {
        try {
          return {
            source: new PublicKey(execution.source),
            destination: new PublicKey(execution.destination),
          };
        } catch {
          // malformed entry; try the next one
        }
      }
    }
  } catch {
    // indexer unreachable
  }
  return null;
}

/**
 * Transfer context for `hukt resolve`. Defaults prefer token accounts that
 * really moved this mint (from the HUKT indexer's execution log), then the
 * mint's largest live holders (public getTokenLargestAccounts, which many
 * public RPCs throttle per-method), then placeholder-owner ATAs. The authority
 * defaults to the source token account's actual owner.
 */
async function defaultTransferContext(connection, mintPk, flags, apiUrl) {
  let source = flags.source ? parsePubkey(flags.source, "--source") : null;
  let destination = flags.destination ? parsePubkey(flags.destination, "--destination") : null;
  let sourceIsPlaceholder = false;
  let destinationIsPlaceholder = false;

  if (source === null || destination === null) {
    const observed = apiUrl ? await observedTransferEndpoints(apiUrl, mintPk) : null;
    let holders = [];
    if (!observed) {
      try {
        const largest = await connection.getTokenLargestAccounts(mintPk, "confirmed");
        holders = largest.value.map((v) => v.address);
      } catch {
        holders = [];
      }
    }
    if (source === null) {
      if (observed) {
        source = observed.source;
      } else if (holders[0]) {
        source = holders[0];
      } else {
        source = getAssociatedTokenAddressSync(
          mintPk,
          new PublicKey(PLACEHOLDER_SOURCE_OWNER),
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        sourceIsPlaceholder = true;
      }
    }
    if (destination === null) {
      const holderCandidate = holders.find((h) => !h.equals(source)) || holders[0];
      if (observed) {
        destination = observed.destination;
      } else if (holderCandidate) {
        destination = holderCandidate;
      } else {
        destination = getAssociatedTokenAddressSync(
          mintPk,
          new PublicKey(PLACEHOLDER_DEST_OWNER),
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        destinationIsPlaceholder = true;
      }
    }
  }

  const authority =
    (await tokenAccountOwner(connection, source)) || new PublicKey(PLACEHOLDER_SOURCE_OWNER);

  let amount = 1n;
  if (flags.amount !== undefined) {
    try {
      amount = BigInt(flags.amount);
    } catch {
      throw new CliError(`--amount must be an integer, got: ${flags.amount}`);
    }
    if (amount < 0n) throw new CliError("--amount must not be negative");
  }
  return { source, destination, authority, amount, sourceIsPlaceholder, destinationIsPlaceholder };
}

module.exports = {
  PLACEHOLDER_DEST_OWNER,
  PLACEHOLDER_SOURCE_OWNER,
  TOKEN_2022_PROGRAM_ID,
  defaultTransferContext,
  describeRawMeta,
  loadHookedMint,
  makeConnection,
  parsePubkey,
  readExtraAccountMetaList,
  requireHookedMint,
  resolveExtraAccounts,
};
