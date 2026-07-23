"use strict";

// The eight verified presets and their parameters. Param names match the web
// Builder's HOOK_META (web/lib/hooks.ts) so a spec produced here and a spec
// produced in the Builder are interchangeable.

const { PublicKey } = require("@solana/web3.js");
const { CliError } = require("./util");

// flag: the CLI flag that supplies the param. kind: how the value is checked.
const PRESETS = {
  royalty: {
    label: "Royalty",
    params: [{ name: "bps", flag: "bps", kind: "number", required: true }],
  },
  whitelist: {
    label: "Whitelist",
    params: [{ name: "addresses", flag: "addresses", kind: "addressList", required: true }],
  },
  blacklist: {
    label: "Blacklist",
    params: [{ name: "addresses", flag: "addresses", kind: "addressList", required: true }],
  },
  vesting: {
    label: "Vesting",
    params: [
      { name: "cliffSeconds", flag: "cliff", kind: "number", required: true },
      { name: "durationSeconds", flag: "duration", kind: "number", required: true },
    ],
  },
  antibot: {
    label: "AntiBot",
    params: [
      { name: "cooldownSeconds", flag: "cooldown", kind: "number", required: true },
      { name: "maxPerTx", flag: "max-per-tx", kind: "number", required: true },
    ],
  },
  kycgate: {
    label: "KYCGate",
    params: [{ name: "provider", flag: "provider", kind: "text", required: true }],
  },
  "fee-on-transfer": {
    label: "FeeOnTransfer",
    params: [{ name: "bps", flag: "bps", kind: "number", required: true }],
  },
  soulbound: {
    label: "Soulbound",
    params: [],
  },
};

const PRESET_KEYS = Object.keys(PRESETS);

// Preset pairs that cannot coexist on one mint (mirrors @hukt/hook-builder).
const INCOMPATIBLE = [
  ["soulbound", "royalty"],
  ["soulbound", "fee-on-transfer"],
  ["whitelist", "blacklist"],
];

function validateParamValue(preset, param, raw) {
  const value = String(raw).trim();
  if (param.kind === "number") {
    if (!/^\d+$/.test(value)) {
      throw new CliError(`--${param.flag} for ${preset} must be a non-negative integer, got: ${raw}`);
    }
    return value;
  }
  if (param.kind === "addressList") {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      throw new CliError(`--${param.flag} for ${preset} needs at least one address`);
    }
    for (const part of parts) {
      try {
        // eslint-disable-next-line no-new
        new PublicKey(part);
      } catch {
        throw new CliError(`--${param.flag}: '${part}' is not a valid base58 address`);
      }
    }
    return parts.join(",");
  }
  if (value.length === 0) {
    throw new CliError(`--${param.flag} for ${preset} must not be empty`);
  }
  return value;
}

/** Validate a preset key + its flags into a spec entry { key, params }. */
function buildPresetEntry(key, flags) {
  const meta = PRESETS[key];
  if (!meta) {
    throw new CliError(
      `unknown preset '${key}' (expected one of: ${PRESET_KEYS.join(", ")})`,
    );
  }
  const params = {};
  for (const param of meta.params) {
    const raw = flags[param.flag];
    if (raw === undefined) {
      if (param.required) {
        throw new CliError(`preset ${key} requires --${param.flag}`);
      }
      continue;
    }
    params[param.name] = validateParamValue(key, param, raw);
  }
  return { key, params };
}

/** Incompatible pairs present among the chosen preset keys. */
function findConflicts(keys) {
  const chosen = new Set(keys);
  return INCOMPATIBLE.filter(([a, b]) => chosen.has(a) && chosen.has(b));
}

module.exports = {
  INCOMPATIBLE,
  PRESETS,
  PRESET_KEYS,
  buildPresetEntry,
  findConflicts,
};
