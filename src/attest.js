"use strict";

// `hukt attest <mint>` -- resolve the mint's hook program from chain, then ask
// the HUKT registry (GET {api}/registry/{programId}) for its attestation.
// `--fail-on caution|malicious` turns the verdict into a CI gate: exit 1 when
// the worst live verdict is at or worse than the threshold, or when the
// program is simply not attested at all.

const { makeConnection, parsePubkey, requireHookedMint } = require("./chain");
const { CliError, apiUrlFor, fetchJson, printKv, rpcUrlFor } = require("./util");

const VERDICT_RANK = { safe: 0, caution: 1, malicious: 2 };

/** Worst non-slashed verdict, or null when nothing is live. */
function worstVerdict(attestations) {
  let worst = null;
  for (const a of attestations) {
    if (a.slashed) continue;
    const rank = VERDICT_RANK[a.verdict];
    if (rank === undefined) continue;
    if (worst === null || rank > VERDICT_RANK[worst.verdict]) worst = a;
  }
  return worst;
}

function isRegistered(record) {
  const hasAttestations = Array.isArray(record.attestations) && record.attestations.length > 0;
  const hasPresets = Array.isArray(record.presets) && record.presets.length > 0;
  return hasAttestations || hasPresets || record.deployments > 0 || record.executions > 0;
}

async function cmdAttest(mintArg, flags) {
  const mintPk = parsePubkey(mintArg, "mint");
  const rpcUrl = rpcUrlFor(flags);
  const apiUrl = apiUrlFor(flags);

  const failOn = flags["fail-on"];
  if (failOn !== undefined && VERDICT_RANK[failOn] === undefined) {
    throw new CliError(`--fail-on expects caution or malicious, got: ${failOn}`);
  }
  if (failOn === "safe") {
    throw new CliError("--fail-on safe would fail every attested hook; use caution or malicious");
  }

  const connection = makeConnection(rpcUrl);
  const { hookProgramId } = await requireHookedMint(connection, mintPk);
  const programId = hookProgramId.toBase58();

  let record;
  try {
    record = await fetchJson(`${apiUrl}/registry/${programId}`);
  } catch (err) {
    throw new CliError(
      `registry unreachable (${err && err.message ? err.message : err}); cannot attest`,
    );
  }

  const registered = isRegistered(record);
  const worst = registered ? worstVerdict(record.attestations || []) : null;

  const gate = () => {
    if (!failOn) return 0;
    if (!registered || !worst) return 1; // unknown hook fails a CI gate
    return VERDICT_RANK[worst.verdict] >= VERDICT_RANK[failOn] ? 1 : 0;
  };

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          mint: mintPk.toBase58(),
          programId,
          registered,
          verdict: worst ? worst.verdict : null,
          attestation: worst
            ? {
                authority: worst.attestor,
                verdict: worst.verdict,
                bondAmount: worst.bondAmount,
                attestedAt: worst.attestedAt,
              }
            : null,
          safetyScore: registered ? record.safetyScore : null,
          deployments: registered ? record.deployments : null,
          executions: registered ? record.executions : null,
        },
        null,
        2,
      ),
    );
    return gate();
  }

  printKv([
    ["Mint", mintPk.toBase58()],
    ["Hook program", programId],
    ["Registry", `${apiUrl}/registry/${programId}`],
  ]);
  console.log("");

  if (!registered) {
    console.log("This hook program is not in the HUKT registry: no attestation exists for it.");
    console.log("Absence of an attestation is not a verdict; treat the hook as unreviewed.");
    if (failOn) {
      console.log(`--fail-on ${failOn}: failing because the hook is unreviewed.`);
    }
    return gate();
  }

  console.log("Attestation");
  const rows = [];
  if (worst) {
    rows.push(["Status", "attested"]);
    rows.push(["Verdict", worst.verdict]);
    rows.push(["Authority", worst.attestor]);
    rows.push(["Bond", `${worst.bondAmount} lamports`]);
    rows.push(["Attested at", worst.attestedAt]);
  } else {
    rows.push(["Status", "registered, but no live attestation (all slashed or none posted)"]);
  }
  rows.push(["Safety score", String(record.safetyScore)]);
  rows.push(["Deployments", String(record.deployments)]);
  rows.push(["Executions", String(record.executions)]);
  printKv(rows, "  ");

  const exitCode = gate();
  if (failOn) {
    console.log("");
    if (exitCode === 1) {
      const reason = worst ? `verdict '${worst.verdict}' is at or worse than '${failOn}'` : "no live attestation";
      console.log(`--fail-on ${failOn}: FAIL (${reason})`);
    } else {
      console.log(`--fail-on ${failOn}: PASS`);
    }
  }
  return exitCode;
}

module.exports = { cmdAttest };
