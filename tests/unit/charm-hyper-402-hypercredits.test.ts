// OMN-1: Charm Hyper's depleted-account 402 body says "Insufficient Hypercredits" —
// the word "hyper" splits the existing "insufficient credit(s)" substring signals, so
// the error was only caught by the bare status_402 rule, which does NOT set
// creditsExhausted. On a passthroughModels provider (charm-hyper) a bare 402 is
// classified as PER-MODEL billing (#12242), so a drained account burned one failed
// upstream call per model (locked out one-by-one, re-selected after the model-lockout
// ceiling) instead of the whole connection going terminal `credits_exhausted`.
// Fix: add "insufficient hypercredits" to CREDITS_EXHAUSTED_SIGNALS — the provider's
// own explicit classification stays unconditionally terminal (authTerminalStatus.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-omn1-charmhyper-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const { resolveTerminalConnectionStatus } =
  await import("../../src/sse/services/authTerminalStatus.ts");
const { RateLimitReason } = await import("../../open-sse/config/constants.ts");

const { isCreditsExhausted, checkFallbackError, getProviderProfile } = accountFallback;

const CHARM_402_BODY = JSON.stringify({
  error: { type: "billing_error", message: "Insufficient Hypercredits" },
});

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedCharmHyper() {
  return providersDb.createProviderConnection({
    provider: "charm-hyper",
    authType: "apikey",
    apiKey: "charm-key",
    isActive: true,
    testStatus: "active",
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("isCreditsExhausted matches 'Insufficient Hypercredits'", () => {
  assert.equal(isCreditsExhausted("Insufficient Hypercredits"), true);
  assert.equal(isCreditsExhausted("insufficient hypercredits"), true);
  assert.equal(isCreditsExhausted(CHARM_402_BODY), true);
  // Neighbouring phrasings must not newly match: the signal is anchored, and
  // Gemini's rate-limit boilerplate must stay RATE_LIMIT_EXCEEDED.
  assert.equal(isCreditsExhausted("Resource has been exhausted (e.g. check quota)."), false);
});

test("checkFallbackError classifies charm-hyper 402 'Insufficient Hypercredits' as credits-exhausted", () => {
  const result = checkFallbackError(
    402,
    CHARM_402_BODY,
    0,
    null,
    "charm-hyper",
    null,
    getProviderProfile("charm-hyper")
  );
  assert.equal(result.shouldFallback, true);
  assert.equal(result.creditsExhausted, true, "402 must set the explicit creditsExhausted flag");
  assert.equal(result.reason, RateLimitReason.QUOTA_EXHAUSTED);
  assert.ok(result.cooldownMs > 0, "cooldownMs should be positive");
});

test("resolveTerminalConnectionStatus: explicit creditsExhausted is terminal even for passthrough providers", () => {
  // The per-model scoping from #12242 only applies to a bare 402 without an
  // explicit provider classification — creditsExhausted:true is unconditional.
  assert.equal(
    resolveTerminalConnectionStatus(
      402,
      { creditsExhausted: true },
      null,
      "charm-hyper",
      true,
      CHARM_402_BODY
    ),
    "credits_exhausted"
  );
});

test("charm-hyper 402 'Insufficient Hypercredits' terminalizes the whole connection", async () => {
  await resetStorage();
  const conn = await seedCharmHyper();

  const result = await auth.markAccountUnavailable(
    (conn as { id: string }).id,
    402,
    CHARM_402_BODY,
    "charm-hyper",
    "zai-org/glm-4.6"
  );
  assert.equal(result.shouldFallback, true);

  const after = await providersDb.getProviderConnectionById((conn as { id: string }).id);
  assert.equal(
    after.testStatus,
    "credits_exhausted",
    "depleted Hypercredits account must park the connection until the operator tops up"
  );
});

test("generic passthrough 402 without a credits phrase stays per-model (#12242 unchanged)", async () => {
  await resetStorage();
  const conn = await seedCharmHyper();

  await auth.markAccountUnavailable(
    (conn as { id: string }).id,
    402,
    "Add credits to continue, or switch to a free model",
    "charm-hyper",
    "paid-model"
  );

  const after = await providersDb.getProviderConnectionById((conn as { id: string }).id);
  assert.equal(after.testStatus, "active", "bare per-model 402 must not terminalize");
  const paidLockout = accountFallback.getModelLockoutInfo(
    "charm-hyper",
    (conn as { id: string }).id,
    "paid-model"
  );
  assert.equal(paidLockout?.reason, "credits");
  const freeLockout = accountFallback.getModelLockoutInfo(
    "charm-hyper",
    (conn as { id: string }).id,
    "free-model"
  );
  assert.equal(freeLockout, null);
});
