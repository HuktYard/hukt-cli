"use strict";

// Shared plumbing for hukt-cli: argument parsing, output alignment, defaults,
// and the indexer fetch helper. Plain text output only -- no color, no emoji.

const DEFAULT_API_URL = "https://api.hukt.fun";

const CLUSTER_URLS = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Error whose message is already user-facing (printed without a stack). */
class CliError extends Error {}

/**
 * Parse argv into { positionals, flags }. Flags in `booleanFlags` take no
 * value; every other `--flag` consumes the next token as its value.
 */
function parseArgs(argv, booleanFlags = []) {
  const positionals = [];
  const flags = {};
  const booleans = new Set(booleanFlags);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (booleans.has(name)) {
        flags[name] = true;
      } else {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new CliError(`--${name} requires a value`);
        }
        flags[name] = value;
        i++;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

/** RPC URL for the run: --rpc wins, then --cluster, then devnet. */
function rpcUrlFor(flags) {
  if (flags.rpc) return flags.rpc;
  const cluster = flags.cluster || "devnet";
  const url = CLUSTER_URLS[cluster];
  if (!url) {
    throw new CliError(
      `unknown cluster '${cluster}' (expected devnet or mainnet-beta; use --rpc for anything else)`,
    );
  }
  return url;
}

function apiUrlFor(flags) {
  return (flags.api || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** GET a JSON endpoint with a hard timeout. Throws on network/HTTP failure. */
async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

/** Print label/value rows with the labels left-aligned to one width. */
function printKv(rows, indent = "") {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  for (const [label, value] of rows) {
    console.log(`${indent}${label.padEnd(width)}  ${value}`);
  }
}

function yesNo(value) {
  return value ? "yes" : "no";
}

module.exports = {
  CLUSTER_URLS,
  CliError,
  DEFAULT_API_URL,
  apiUrlFor,
  fetchJson,
  parseArgs,
  printKv,
  rpcUrlFor,
  yesNo,
};
