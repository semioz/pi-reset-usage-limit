import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	consumeResetCredit,
	discoverResetCredits,
	extractChatGptAccountId,
	formatConsumeOutcome,
	selectResetCredit,
	type ConsumeOutcome,
	type DiscoveredResetCredits,
} from "./core.ts";

interface CommandDependencies {
	discover(options: {
		accessToken: string;
		accountId: string;
	}): Promise<DiscoveredResetCredits>;
	consume(options: {
		accessToken: string;
		accountId: string;
		idempotencyKey: string;
		creditId?: string;
	}): Promise<ConsumeOutcome>;
	randomUUID(): string;
}

const defaultDependencies: CommandDependencies = {
	discover: discoverResetCredits,
	consume: consumeResetCredit,
	randomUUID,
};

function confirmationMessage(discovery: DiscoveredResetCredits): {
	message: string;
	creditId?: string;
} {
	const credit = selectResetCredit(discovery.credits);
	const lines = [
		credit?.title ?? "Codex rate-limit reset credit",
		`Available reset credits: ${discovery.availableCount}`,
	];
	if (credit?.expiresAt !== null && credit?.expiresAt !== undefined) {
		lines.push(`Expires: ${new Date(credit.expiresAt * 1000).toISOString()}`);
	}
	lines.push("Consume one credit and reset your current Codex usage limits?");
	return { message: lines.join("\n"), creditId: credit?.id };
}

export function createResetRateLimitExtension(dependencies: CommandDependencies = defaultDependencies) {
	return function resetRateLimitExtension(pi: ExtensionAPI): void {
		pi.registerCommand("reset-rate-limit", {
			description: "Consume a Codex rate-limit reset credit",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/reset-rate-limit requires an interactive Pi session.", "error");
					return;
				}

				try {
					const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
					if (!accessToken) {
						ctx.ui.notify("OpenAI Codex authentication is unavailable. Run /login first.", "error");
						return;
					}
					const accountId = extractChatGptAccountId(accessToken);
					const discovery = await dependencies.discover({ accessToken, accountId });
					if (discovery.availableCount <= 0) {
						ctx.ui.notify("No Codex rate-limit reset credit is available.", "info");
						return;
					}

					const confirmation = confirmationMessage(discovery);
					const confirmed = await ctx.ui.confirm("Reset Codex rate limits?", confirmation.message);
					if (!confirmed) {
						ctx.ui.notify("Codex rate-limit reset cancelled.", "info");
						return;
					}

					const outcome = await dependencies.consume({
						accessToken,
						accountId,
						idempotencyKey: dependencies.randomUUID(),
						creditId: confirmation.creditId,
					});
					const formatted = formatConsumeOutcome(outcome);
					ctx.ui.notify(formatted.message, formatted.level);
				} catch {
					ctx.ui.notify(
						"Unable to reset Codex rate limits. Check your OpenAI Codex login and try again.",
						"error",
					);
				}
			},
		});
	};
}

export default createResetRateLimitExtension();
