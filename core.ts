const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TIMEOUT_MS = 15_000;

export type ConsumeOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
export type NotificationLevel = "info" | "warning" | "error";

export interface ResetCredit {
	id: string;
	resetType: "codexRateLimits" | "unknown";
	status: "available" | "redeeming" | "redeemed" | "unknown";
	grantedAt: number;
	expiresAt: number | null;
	title: string | null;
	description: string | null;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface RequestAuth {
	accessToken: string;
	accountId: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}

class CodexRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Codex account request failed with HTTP ${status}.`);
		this.status = status;
	}
}

export interface DiscoveredResetCredits {
	availableCount: number;
	applicableCount: number;
	credits: ResetCredit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function readCount(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	const value = readNumber(record, ...keys);
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseRfc3339Timestamp(value: string): number | undefined {
	const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (day > daysInMonth) return undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? milliseconds / 1000 : undefined;
}

function readTimestamp(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") return parseRfc3339Timestamp(value);
	}
	return undefined;
}

export function extractChatGptAccountId(accessToken: string): string {
	try {
		const payloadSegment = accessToken.split(".")[1];
		if (!payloadSegment) throw new Error("missing payload");
		const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
		if (!isRecord(payload)) throw new Error("invalid payload");
		const auth = payload[CHATGPT_AUTH_CLAIM];
		if (!isRecord(auth)) throw new Error("missing auth claim");
		const accountId = auth.chatgpt_account_id;
		if (typeof accountId !== "string" || accountId.length === 0) throw new Error("missing account id");
		return accountId;
	} catch {
		throw new Error("OpenAI Codex access token does not contain a ChatGPT account ID.");
	}
}

export function parseUsageCreditSummary(payload: unknown): {
	availableCount: number;
	applicableCount: number;
} {
	if (!isRecord(payload)) throw new Error("Invalid Codex usage response.");
	const raw = payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits;
	if (!isRecord(raw)) throw new Error("Invalid Codex usage response.");
	const availableRaw = readNumber(raw, "available_count", "availableCount");
	const applicableRaw = readNumber(raw, "applicable_available_count", "applicableAvailableCount");
	const hasApplicable = Object.hasOwn(raw, "applicable_available_count") || Object.hasOwn(raw, "applicableAvailableCount");
	const availableCount = readCount(raw, "available_count", "availableCount");
	const applicableCount = hasApplicable
		? readCount(raw, "applicable_available_count", "applicableAvailableCount")
		: availableCount;
	if (availableRaw === undefined || availableCount === undefined || (hasApplicable && applicableRaw === undefined) || applicableCount === undefined) {
		throw new Error("Invalid Codex usage response.");
	}
	return { availableCount, applicableCount };
}

function normalizeResetType(value: unknown): ResetCredit["resetType"] {
	return value === "codex_rate_limits" || value === "codexRateLimits" ? "codexRateLimits" : "unknown";
}

function normalizeStatus(value: unknown): ResetCredit["status"] {
	return value === "available" || value === "redeeming" || value === "redeemed" ? value : "unknown";
}

export function parseDetailedCredits(payload: unknown): { availableCount: number; credits: ResetCredit[] } {
	if (!isRecord(payload)) throw new Error("Invalid Codex reset-credit response.");
	const availableRaw = readNumber(payload, "available_count", "availableCount");
	const availableCount = readCount(payload, "available_count", "availableCount");
	if (availableRaw === undefined || availableCount === undefined) {
		throw new Error("Invalid Codex reset-credit response.");
	}
	const rows = payload.credits;
	if (!Array.isArray(rows)) throw new Error("Invalid Codex reset-credit response.");

	const credits = rows.map((row): ResetCredit => {
		if (!isRecord(row)) throw new Error("Invalid Codex reset-credit response.");
		const id = readString(row, "id");
		const grantedAt = readTimestamp(row, "granted_at", "grantedAt");
		if (!id || grantedAt === undefined) throw new Error("Invalid Codex reset-credit response.");
		const expiresKey = Object.hasOwn(row, "expires_at")
			? "expires_at"
			: Object.hasOwn(row, "expiresAt") ? "expiresAt" : undefined;
		let expiresAt: number | null = null;
		if (expiresKey && row[expiresKey] !== null) {
			const parsedExpiry = readTimestamp(row, expiresKey);
			if (parsedExpiry === undefined) throw new Error("Invalid Codex reset-credit response.");
			expiresAt = parsedExpiry;
		}
		return {
			id,
			resetType: normalizeResetType(row.reset_type ?? row.resetType),
			status: normalizeStatus(row.status),
			grantedAt,
			expiresAt,
			title: typeof row.title === "string" ? row.title : null,
			description: typeof row.description === "string" ? row.description : null,
		};
	});

	return { availableCount, credits };
}

export function selectResetCredit<T extends { id: string; expiresAt: number | null; grantedAt: number }>(
	credits: readonly T[],
): T | undefined {
	return [...credits].sort((left, right) => {
		if (left.expiresAt === null && right.expiresAt !== null) return 1;
		if (left.expiresAt !== null && right.expiresAt === null) return -1;
		if (left.expiresAt !== null && right.expiresAt !== null && left.expiresAt !== right.expiresAt) {
			return left.expiresAt - right.expiresAt;
		}
		if (left.grantedAt !== right.grantedAt) return left.grantedAt - right.grantedAt;
		return left.id.localeCompare(right.id);
	})[0];
}

export function parseConsumeOutcome(payload: unknown): ConsumeOutcome {
	if (!isRecord(payload)) throw new Error("Invalid Codex reset response.");
	const raw = payload.outcome ?? payload.code;
	if (raw === "reset") return "reset";
	if (raw === "nothing_to_reset" || raw === "nothingToReset") return "nothingToReset";
	if (raw === "no_credit" || raw === "noCredit") return "noCredit";
	if (raw === "already_redeemed" || raw === "alreadyRedeemed") return "alreadyRedeemed";
	throw new Error("Invalid Codex reset response.");
}

export function formatConsumeOutcome(outcome: ConsumeOutcome): {
	message: string;
	level: NotificationLevel;
} {
	switch (outcome) {
		case "reset":
			return { message: "Codex usage limits reset successfully.", level: "info" };
		case "nothingToReset":
			return { message: "Codex reports that no active usage limit needs resetting.", level: "info" };
		case "noCredit":
			return { message: "No Codex usage limit reset credit is available.", level: "warning" };
		case "alreadyRedeemed":
			return { message: "That Codex reset credit was already redeemed.", level: "info" };
	}
}

function requestHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"chatgpt-account-id": accountId,
		Accept: "application/json",
	};
}

async function requestJson(
	path: string,
	options: RequestAuth & { method?: "GET" | "POST"; body?: Record<string, string> },
): Promise<unknown> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const headers = requestHeaders(options.accessToken, options.accountId);
	if (options.body) headers["Content-Type"] = "application/json";
	const response = await fetchImpl(`${CODEX_BASE_URL}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new CodexRequestError(response.status);
	}
	try {
		return await response.json();
	} catch {
		throw new Error("Codex account request returned invalid JSON.");
	}
}

export async function discoverResetCredits(options: RequestAuth): Promise<DiscoveredResetCredits> {
	const usage = await requestJson("/wham/usage", options);
	const summary = parseUsageCreditSummary(usage);
	if (summary.availableCount <= 0) {
		return { ...summary, credits: [] };
	}

	try {
		const details = parseDetailedCredits(await requestJson("/wham/rate-limit-reset-credits", options));
		const credits = details.credits.filter(
			(credit) => credit.status === "available" && credit.resetType === "codexRateLimits",
		);
		return { ...summary, credits };
	} catch (error) {
		if (error instanceof CodexRequestError && error.status === 404) {
			return { ...summary, credits: [] };
		}
		throw error;
	}
}

export async function consumeResetCredit(
	options: RequestAuth & { idempotencyKey: string; creditId?: string },
): Promise<ConsumeOutcome> {
	const body: Record<string, string> = { redeem_request_id: options.idempotencyKey };
	if (options.creditId) body.credit_id = options.creditId;
	const payload = await requestJson("/wham/rate-limit-reset-credits/consume", {
		...options,
		method: "POST",
		body,
	});
	return parseConsumeOutcome(payload);
}
