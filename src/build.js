"use strict";

// `hukt build` -- read the local spec, validate it, and generate the
// deployable program config: the ExtraAccountMetaList layout the composed
// presets need (extra-account-metas.json, same account model as
// @hukt/hook-builder) plus deploy.md with the exact anchor steps against the
// public hukt-labs/hukt anchor program. Build is codegen only; it makes no
// chain calls and deploys nothing.

const fs = require("fs");
const path = require("path");
const { CliError, printKv } = require("./util");
const { findConflicts } = require("./presets");
const { DEFAULT_SPEC_PATH, loadSpec, specPathFor } = require("./spec");

const DEFAULT_OUT_DIR = "./hukt-dist";
const BASE_ACCOUNT_COUNT = 5; // source, mint, destination, authority, validation
const TRANSACTION_ACCOUNT_LIMIT = 64;

const DEVNET_HOOKS_PROGRAM = "4q7Tgd9A1XfTB2i6WLUjmFXNocw6GrshZwcKgarGV9aC";
const DEVNET_REGISTRY_PROGRAM = "HkTcGxnRqmyBqrmMb63cad7sfJjzUo5jY4Y3ErQWBrGv";

// --- per-preset extra-account requirements ----------------------------------
// Mirrors @hukt/hook-builder requirementsFor() (hook-spec section 8): the same
// labels, seeds, flags, and descriptions, serialized for the JSON artifact.

const literal = (bytes) => ({ type: "literal", bytes });
const MINT_KEY = { type: "account-key", accountIndex: 1 };
const SOURCE_OWNER = { type: "account-data", accountIndex: 0, offset: 32, length: 32 };
const DEST_OWNER = { type: "account-data", accountIndex: 2, offset: 32, length: 32 };

const clockAccount = (preset, description) => ({
  label: "clock",
  preset,
  isSigner: false,
  isWritable: false,
  address: { type: "sysvar", name: "clock" },
  seeds: [],
  description,
});

function requirementsFor(key) {
  switch (key) {
    case "royalty":
      return [
        {
          label: "royalty-config",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("royalty"), MINT_KEY],
          description: "Royalty policy config PDA (approved routes / receipt rules).",
        },
        {
          label: "creator-token-account",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "provided", role: "creator-token-account" },
          seeds: [],
          description:
            "Creator token account that must receive royalty. The hook verifies, it does not move funds.",
        },
      ];
    case "whitelist":
      return [
        {
          label: "whitelist",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("whitelist"), DEST_OWNER],
          description: "Per-recipient whitelist PDA keyed on the destination owner.",
        },
      ];
    case "blacklist":
      return [
        {
          label: "blacklist",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("blacklist"), SOURCE_OWNER],
          description: "Per-sender blacklist PDA keyed on the source owner.",
        },
      ];
    case "vesting":
      return [
        {
          label: "vesting",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("vesting"), MINT_KEY, SOURCE_OWNER],
          description: "Vesting state PDA (mint + source owner); checked against the unlock schedule.",
        },
        clockAccount(key, "Clock sysvar for unlock-time checks."),
      ];
    case "antibot":
      return [
        {
          label: "cooldown",
          preset: key,
          isSigner: false,
          isWritable: true,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("cooldown"), MINT_KEY, SOURCE_OWNER],
          description: "Per-sender cooldown/limit state PDA; updated on each transfer.",
        },
        clockAccount(key, "Clock sysvar for cooldown checks."),
      ];
    case "kycgate":
      return [
        {
          label: "kyc-gatekeeper",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "provided", role: "kyc-gatekeeper-program" },
          seeds: [],
          description: "External gatekeeper program that owns KYC attestations.",
        },
        {
          label: "kyc-attestation",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "account", programLabel: "kyc-gatekeeper" },
          seeds: [literal("kyc"), DEST_OWNER],
          description: "KYC attestation PDA for the recipient, owned by the gatekeeper program.",
        },
      ];
    case "fee-on-transfer":
      return [
        {
          label: "fee-config",
          preset: key,
          isSigner: false,
          isWritable: false,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("fee-config"), MINT_KEY],
          description: "Fee policy config PDA. Native Token-2022 TransferFee moves the funds.",
        },
        {
          label: "fee-vault",
          preset: key,
          isSigner: false,
          isWritable: true,
          address: { type: "pda", owner: "hook" },
          seeds: [literal("fee-vault"), MINT_KEY],
          description: "Fee vault PDA for custom fee-policy accounting.",
        },
      ];
    case "soulbound":
      // Pure soulbound validates by construction and needs no extra accounts.
      return [];
    default:
      throw new CliError(`unknown preset '${key}' in spec`);
  }
}

/**
 * Merge presets into one ordered ExtraAccountMetaList layout: concatenate each
 * preset's requirements, de-duplicate structurally identical accounts (a Clock
 * shared by vesting and antibot appears once, escalated to writable if any
 * contributor writes), then assign Execute indices from 5 upward.
 */
function composeExtraAccounts(presetKeys) {
  const requirements = presetKeys.flatMap((key) => requirementsFor(key));

  const byKey = new Map();
  const order = [];
  for (const req of requirements) {
    const dedupeKey = JSON.stringify({ address: req.address, seeds: req.seeds, isSigner: req.isSigner });
    const existing = byKey.get(dedupeKey);
    if (existing) {
      if (req.isWritable) existing.isWritable = true;
    } else {
      byKey.set(dedupeKey, { ...req });
      order.push(dedupeKey);
    }
  }
  const deduped = order.map((k) => byKey.get(k));

  const accountIndexMap = { source: 0, mint: 1, destination: 2, authority: 3, validation: 4 };
  deduped.forEach((req, i) => {
    accountIndexMap[req.label] = BASE_ACCOUNT_COUNT + i;
  });

  const extraAccounts = deduped.map((req, i) => {
    let address = req.address;
    if (address.type === "pda" && address.owner === "account") {
      const programIndex = accountIndexMap[address.programLabel];
      if (programIndex === undefined) {
        throw new CliError(`external PDA references unknown account '${address.programLabel}'`);
      }
      address = { type: "pda", owner: "account", programIndex };
    }
    return {
      index: BASE_ACCOUNT_COUNT + i,
      label: req.label,
      preset: req.preset,
      isSigner: req.isSigner,
      isWritable: req.isWritable,
      address,
      seeds: req.seeds,
      description: req.description,
    };
  });

  const totalAccounts = BASE_ACCOUNT_COUNT + extraAccounts.length;
  return {
    accountIndexMap,
    extraAccounts,
    totalAccounts,
    withinTransactionLimit: totalAccounts <= TRANSACTION_ACCOUNT_LIMIT,
  };
}

function deployMarkdown(spec, composition) {
  const presetLines = spec.presets
    .map((p) => {
      const params = Object.entries(p.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `- \`${p.key}\`${params ? ` (${params})` : ""}`;
    })
    .join("\n");

  const accountLines = composition.extraAccounts
    .map((a) => {
      const seeds = a.seeds.length
        ? a.seeds
            .map((s) => {
              if (s.type === "literal") return `b"${s.bytes}"`;
              if (s.type === "account-key") return `account-key #${s.accountIndex}`;
              return `account-data #${s.accountIndex} [${s.offset}..${s.offset + s.length}]`;
            })
            .join(", ")
        : "none (fixed or sysvar)";
      return `| ${a.index} | ${a.label} | ${a.preset} | ${a.isWritable ? "yes" : "no"} | ${seeds} |`;
    })
    .join("\n");

  return `# Deploying this composed hook

Generated by \`hukt build\` from \`${spec.name}\`. This directory is program
config only -- nothing has touched a cluster. Deployment happens through the
Anchor program in the public repo.

## Composed presets

${presetLines}

## ExtraAccountMetaList

Base Execute accounts are fixed by the transfer-hook interface:
0 source, 1 mint, 2 destination, 3 authority, 4 validation PDA. The composed
extras start at index 5 and are described in \`extra-account-metas.json\`:

| Index | Account | Preset | Writable | Seeds |
| --- | --- | --- | --- | --- |
${accountLines}

Total accounts per transfer: ${composition.totalAccounts} (limit ${TRANSACTION_ACCOUNT_LIMIT} without address lookup tables).

## Steps

1. Clone the framework and build the hook program (Anchor 0.31.1 toolchain):

   \`\`\`bash
   git clone https://github.com/hukt-labs/hukt.git
   cd hukt/anchor
   anchor build
   \`\`\`

2. Deploy \`hukt_hooks\` under your own program keypair and wallet:

   \`\`\`bash
   anchor deploy --program-name hukt_hooks \\
     --provider.cluster devnet \\
     --provider.wallet ~/.config/solana/id.json
   \`\`\`

   The reference devnet deployment is \`${DEVNET_HOOKS_PROGRAM}\`
   (registry: \`${DEVNET_REGISTRY_PROGRAM}\`).

3. Create your Token-2022 mint with the TransferHook extension pointing at the
   deployed program, then initialize the per-mint config with this spec's
   preset mask and parameters, and the ExtraAccountMetaList PDA
   (seeds \`["extra-account-metas", mint]\` under the hook program) with the
   layout in \`extra-account-metas.json\`. The anchor tests in
   \`anchor/tests\` show the exact instruction sequence per preset.

4. Verify the wiring against the live chain:

   \`\`\`bash
   hukt inspect <mint> --cluster devnet
   hukt resolve <mint> --cluster devnet
   \`\`\`
`;
}

async function cmdBuild(flags) {
  const specPath = specPathFor(flags);
  const spec = loadSpec(specPath);
  if (spec === null) {
    throw new CliError(
      `no spec found at ${specPath}; run 'hukt hook add <preset>' first or pass --spec (default ${DEFAULT_SPEC_PATH})`,
    );
  }
  if (spec.presets.length === 0) {
    throw new CliError(`${specPath} has no presets; run 'hukt hook add <preset>' first`);
  }
  const conflicts = findConflicts(spec.presets.map((p) => p.key));
  if (conflicts.length > 0) {
    const pairs = conflicts.map(([a, b]) => `${a} + ${b}`).join("; ");
    throw new CliError(`spec contains incompatible presets (${pairs}); remove one of each pair`);
  }

  const composition = composeExtraAccounts(spec.presets.map((p) => p.key));

  const outDir = path.resolve(process.cwd(), flags.out || DEFAULT_OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  const metasPath = path.join(outDir, "extra-account-metas.json");
  fs.writeFileSync(
    metasPath,
    `${JSON.stringify(
      {
        name: spec.name,
        specVersion: spec.version,
        presets: spec.presets,
        baseAccounts: ["source", "mint", "destination", "authority", "validation"],
        accountIndexMap: composition.accountIndexMap,
        extraAccounts: composition.extraAccounts,
        totalAccounts: composition.totalAccounts,
        withinTransactionLimit: composition.withinTransactionLimit,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const deployPath = path.join(outDir, "deploy.md");
  fs.writeFileSync(deployPath, deployMarkdown(spec, composition), "utf8");

  printKv([
    ["Spec", specPath],
    ["Presets", spec.presets.map((p) => p.key).join(", ")],
    ["Extra accounts", String(composition.extraAccounts.length)],
    ["Total accounts", `${composition.totalAccounts} of ${TRANSACTION_ACCOUNT_LIMIT} per transfer`],
    ["Output", outDir],
  ]);
  console.log("");
  console.log(`Wrote ${metasPath}`);
  console.log(`Wrote ${deployPath}`);
  console.log("");
  console.log("Build is codegen: nothing was deployed. Follow deploy.md to deploy with anchor.");
  return 0;
}

module.exports = { cmdBuild };
