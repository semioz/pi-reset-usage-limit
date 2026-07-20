import assert from "node:assert/strict";
import test from "node:test";

import {
	consumeResetCredit,
	discoverResetCredits,
	extractChatGptAccountId,
	formatConsumeOutcome,
	parseConsumeOutcome,
	parseDetailedCredits,
	parseUsageCreditSummary,
	selectResetCredit,
} from "../core.ts";
import { createResetUsageLimitExtension } from "../index.ts";

const AUTH = { accessToken: "secret-token", accountId: "acct-123" };

interface CommandHarnessOverrides {
	accessToken?: string;
	confirmed?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function tokenWithPayload(payload: Record<string, unknown>): string {
	const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

test("extractChatGptAccountId reads Pi's Codex JWT account claim", () => {
	const token = tokenWithPayload({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
	});
	assert.equal(extractChatGptAccountId(token), "acct-123");
});

test("extractChatGptAccountId rejects malformed or incomplete tokens", () => {
	assert.throws(() => extractChatGptAccountId("not-a-jwt"), /account/i);
	assert.throws(() => extractChatGptAccountId(tokenWithPayload({})), /account/i);
});

test("parseUsageCreditSummary preserves available and applicable counts", () => {
	assert.deepEqual(
		parseUsageCreditSummary({
			rate_limit_reset_credits: { available_count: 3, applicable_available_count: 1 },
		}),
		{ availableCount: 3, applicableCount: 1 },
	);
});

test("parseUsageCreditSummary rejects a missing reset-credit summary", () => {
	assert.throws(() => parseUsageCreditSummary({ plan_type: "plus" }), /usage response/i);
});

test("parseUsageCreditSummary rejects negative or fractional counts", () => {
	for (const applicable_available_count of [-1, 0.5]) {
		assert.throws(
			() => parseUsageCreditSummary({
				rate_limit_reset_credits: { available_count: 1, applicable_available_count },
			}),
			/usage response/i,
		);
	}
});

test("parseDetailedCredits accepts current Codex snake_case fields", () => {
	assert.deepEqual(
		parseDetailedCredits({
			available_count: 2,
			credits: [
				{
					id: "credit-1",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-06-17T00:00:00Z",
					expires_at: "2026-07-17T00:00:00Z",
					title: "Codex reset",
					description: "Reset both windows",
				},
			],
		}),
		{
			availableCount: 2,
			credits: [
				{
					id: "credit-1",
					resetType: "codexRateLimits",
					status: "available",
					grantedAt: 1_781_654_400,
					expiresAt: 1_784_246_400,
					title: "Codex reset",
					description: "Reset both windows",
				},
			],
		},
	);
});

test("parseDetailedCredits rejects malformed credit rows", () => {
	assert.throws(
		() => parseDetailedCredits({
			available_count: 1,
			credits: [{ id: "credit-1", granted_at: "not-a-timestamp" }],
		}),
		/reset-credit response/i,
	);
});

test("parseDetailedCredits rejects invalid expiry and non-RFC3339 timestamps", () => {
	const credit = {
		id: "credit-1",
		granted_at: "2026-06-17T00:00:00Z",
	};
	for (const expires_at of ["not-a-timestamp", "June 17, 2026", "2026-13-17T00:00:00Z"]) {
		assert.throws(
			() => parseDetailedCredits({ available_count: 1, credits: [{ ...credit, expires_at }] }),
			/reset-credit response/i,
		);
	}
});

test("selectResetCredit prioritizes expiry, then grant time, then id", () => {
	const credits = [
		{ id: "never", expiresAt: null, grantedAt: 1 },
		{ id: "z", expiresAt: 200, grantedAt: 20 },
		{ id: "b", expiresAt: 100, grantedAt: 10 },
		{ id: "a", expiresAt: 100, grantedAt: 10 },
	];
	assert.equal(selectResetCredit(credits)?.id, "a");
});

test("parseConsumeOutcome normalizes backend and app-server outcomes", () => {
	assert.equal(parseConsumeOutcome({ code: "reset", windows_reset: ["primary"] }), "reset");
	assert.equal(parseConsumeOutcome({ code: "nothing_to_reset" }), "nothingToReset");
	assert.equal(parseConsumeOutcome({ code: "no_credit" }), "noCredit");
	assert.equal(parseConsumeOutcome({ outcome: "alreadyRedeemed" }), "alreadyRedeemed");
});

test("formatConsumeOutcome returns concise user-facing messages", () => {
	assert.deepEqual(formatConsumeOutcome("reset"), {
		message: "Codex usage limits reset successfully.",
		level: "info",
	});
	assert.equal(formatConsumeOutcome("noCredit").level, "warning");
	assert.equal(formatConsumeOutcome("alreadyRedeemed").level, "info");
});

test("discoverResetCredits reads usage then enriches available credits", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		if (String(url).endsWith("/wham/usage")) {
			return jsonResponse({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
			});
		}
		return jsonResponse({
			available_count: 2,
			credits: [{
				id: "c1",
				reset_type: "codex_rate_limits",
				status: "available",
				granted_at: "2026-06-17T00:00:00Z",
			}],
		});
	};

	const result = await discoverResetCredits({ ...AUTH, fetchImpl });

	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(calls[1].url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
	assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-123");
	assert.ok(calls[0].init.signal instanceof AbortSignal);
	assert.deepEqual(result, { availableCount: 2, applicableCount: 1, credits: [result.credits[0]] });
	assert.equal(result.credits[0].id, "c1");
});

test("discoverResetCredits enriches available credits even when none are marked applicable", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return calls === 1
			? jsonResponse({
				rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
			})
			: jsonResponse({
				available_count: 2,
				credits: [{
					id: "c1",
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: "2026-06-17T00:00:00Z",
				}],
			});
	};

	const result = await discoverResetCredits({ ...AUTH, fetchImpl });
	assert.equal(result.availableCount, 2);
	assert.equal(result.applicableCount, 0);
	assert.equal(result.credits[0].id, "c1");
	assert.equal(calls, 2);
});

test("discoverResetCredits falls back to count-only data when details are unavailable", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return calls === 1
			? jsonResponse({ rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } })
			: jsonResponse({ error: "not found" }, 404);
	};

	assert.deepEqual(await discoverResetCredits({ ...AUTH, fetchImpl }), {
		availableCount: 1,
		applicableCount: 1,
		credits: [],
	});
});

test("discoverResetCredits does not hide detail authentication or server failures", async () => {
	for (const status of [401, 503]) {
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return calls === 1
				? jsonResponse({ rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } })
				: jsonResponse({ error: "failure" }, status);
		};
		await assert.rejects(discoverResetCredits({ ...AUTH, fetchImpl }), new RegExp(String(status)));
	}
});

test("consumeResetCredit posts one idempotent consume request", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return jsonResponse({ code: "reset", windows_reset: ["primary", "secondary"] });
	};

	const outcome = await consumeResetCredit({
		...AUTH,
		fetchImpl,
		idempotencyKey: "uuid-1",
		creditId: "credit-1",
	});

	assert.equal(outcome, "reset");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body), {
		redeem_request_id: "uuid-1",
		credit_id: "credit-1",
	});
});

test("consumeResetCredit omits credit_id for count-only fallback", async () => {
	let body;
	const fetchImpl = async (_url, init) => {
		body = JSON.parse(init.body);
		return jsonResponse({ code: "nothing_to_reset", windows_reset: [] });
	};

	assert.equal(
		await consumeResetCredit({ ...AUTH, fetchImpl, idempotencyKey: "uuid-2" }),
		"nothingToReset",
	);
	assert.deepEqual(body, { redeem_request_id: "uuid-2" });
});

test("usage-limit wording preserves the Codex rate-limit wire contract", async () => {
	const usagePayload = {
		rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
	};
	const creditRow = {
		id: "credit-1",
		reset_type: "codex_rate_limits",
		status: "available",
		granted_at: "2026-06-17T00:00:00Z",
	};
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		if (calls.length === 1) return jsonResponse(usagePayload);
		if (calls.length === 2) return jsonResponse({ available_count: 1, credits: [creditRow] });
		return jsonResponse({ code: "nothing_to_reset" });
	};

	const discovery = await discoverResetCredits({ ...AUTH, fetchImpl });
	await consumeResetCredit({
		...AUTH,
		fetchImpl,
		idempotencyKey: "uuid-1",
		creditId: discovery.credits[0].id,
	});

	assert.equal(usagePayload.rate_limit_reset_credits.applicable_available_count, 0);
	assert.equal(creditRow.reset_type, "codex_rate_limits");
	assert.equal(calls[1], "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(calls[2], "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
});

test("HTTP errors are concise and do not expose response bodies", async () => {
	const fetchImpl = async () => jsonResponse({ error: "sensitive backend detail" }, 500);
	await assert.rejects(
		discoverResetCredits({ ...AUTH, fetchImpl }),
		(error) => /500/.test(error.message) && !error.message.includes("sensitive"),
	);
});

function commandHarness(overrides: CommandHarnessOverrides = {}) {
	let registration;
	const registrations = [];
	const notifications = [];
	const confirmations = [];
	const pi = {
		registerCommand(name, options) {
			registration = { name, ...options };
			registrations.push(registration);
		},
	};
	const ctx = {
		hasUI: true,
		modelRegistry: {
			async getApiKeyForProvider() {
				return overrides.accessToken ?? tokenWithPayload({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
				});
			},
		},
		ui: {
			async confirm(title, message) {
				confirmations.push({ title, message });
				return overrides.confirmed ?? true;
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};
	return { pi, ctx, notifications, confirmations, registrations, get registration() { return registration; } };
}

test("the extension registers only /reset-usage-limit", () => {
	const harness = commandHarness();
	createResetUsageLimitExtension({
		discover: async () => ({ availableCount: 0, applicableCount: 0, credits: [] }),
		consume: async () => "reset",
		randomUUID: () => "uuid",
	})(harness.pi);
	assert.deepEqual(harness.registrations.map(({ name }) => name), ["reset-usage-limit"]);
	assert.match(harness.registration.description, /usage limit/i);
});

test("the command reports missing or invalid Pi Codex authentication", async () => {
	for (const accessToken of [undefined, "invalid-token"]) {
		const harness = commandHarness({ accessToken });
		if (accessToken === undefined) {
			harness.ctx.modelRegistry.getApiKeyForProvider = async () => undefined;
		}
		createResetUsageLimitExtension({
			discover: async () => assert.fail("discovery should not run"),
			consume: async () => assert.fail("consume should not run"),
			randomUUID: () => "uuid",
		})(harness.pi);
		await harness.registration.handler("", harness.ctx);
		assert.equal(harness.notifications.at(-1).level, "error");
		assert.match(harness.notifications.at(-1).message, /login|authentication/i);
	}
});

test("the command offers an available credit even when applicable count is zero", async () => {
	const harness = commandHarness();
	let consumeCalls = 0;
	createResetUsageLimitExtension({
		discover: async () => ({ availableCount: 2, applicableCount: 0, credits: [] }),
		consume: async () => {
			consumeCalls += 1;
			return "reset";
		},
		randomUUID: () => "uuid",
	})(harness.pi);
	await harness.registration.handler("", harness.ctx);
	assert.equal(harness.confirmations.length, 1);
	assert.match(harness.confirmations[0].message, /Available reset credits: 2/);
	assert.equal(consumeCalls, 1);
	assert.equal(harness.notifications.at(-1).level, "info");
	assert.match(harness.notifications.at(-1).message, /success/i);
});

test("confirmation includes selected credit details and cancellation is safe", async () => {
	const harness = commandHarness({ confirmed: false });
	let consumeCalls = 0;
	createResetUsageLimitExtension({
		discover: async () => ({
			availableCount: 3,
			applicableCount: 2,
			credits: [{
				id: "credit-1",
				resetType: "codexRateLimits",
				status: "available",
				grantedAt: 100,
				expiresAt: 1_800_000_000,
				title: "Bonus Codex reset",
				description: null,
			}],
		}),
		consume: async () => { consumeCalls += 1; return "reset"; },
		randomUUID: () => "uuid",
	})(harness.pi);
	await harness.registration.handler("", harness.ctx);
	assert.equal(consumeCalls, 0);
	assert.match(harness.confirmations[0].message, /Bonus Codex reset/);
	assert.match(harness.confirmations[0].message, /2027-01-15T08:00:00.000Z/);
	assert.match(harness.confirmations[0].message, /2/);
});

test("confirmation uses a generic title for count-only credits", async () => {
	const harness = commandHarness({ confirmed: false });
	createResetUsageLimitExtension({
		discover: async () => ({ availableCount: 1, applicableCount: 1, credits: [] }),
		consume: async () => assert.fail("consume should not run"),
		randomUUID: () => "uuid",
	})(harness.pi);
	await harness.registration.handler("", harness.ctx);
	assert.match(harness.confirmations[0].message, /Codex usage limit reset credit/);
});

test("a confirmed command consumes once with one UUID and reports success", async () => {
	const harness = commandHarness();
	const consumeCalls = [];
	createResetUsageLimitExtension({
		discover: async () => ({ availableCount: 1, applicableCount: 1, credits: [] }),
		consume: async (options) => { consumeCalls.push(options); return "reset"; },
		randomUUID: () => "uuid-1",
	})(harness.pi);
	await harness.registration.handler("", harness.ctx);
	assert.equal(consumeCalls.length, 1);
	assert.equal(consumeCalls[0].idempotencyKey, "uuid-1");
	assert.equal(consumeCalls[0].creditId, undefined);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Codex usage limits reset successfully.",
		level: "info",
	});
});

test("unexpected command errors never expose credentials", async () => {
	const harness = commandHarness();
	createResetUsageLimitExtension({
		discover: async () => { throw new Error("secret-token backend detail"); },
		consume: async () => "reset",
		randomUUID: () => "uuid",
	})(harness.pi);
	await harness.registration.handler("", harness.ctx);
	assert.equal(harness.notifications.at(-1).level, "error");
	assert.doesNotMatch(harness.notifications.at(-1).message, /secret-token/);
});
