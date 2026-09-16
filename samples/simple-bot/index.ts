/*
 * Sample ForgeScript bot for binary compilation testing
 */

import { ForgeClient } from "@tryforge/forgescript";

export const client = new ForgeClient({
	token: process.env.DISCORD_TOKEN ?? "DISCORD_BOT_TOKEN_SAMPLE",
	intents: ["GuildMessages", "Guilds", "MessageContent"],
	prefixes: ["!"],
});

client.commands.add({
	name: "ping",
	type: "messageCreate",
	code: "$sendMessage[$channelID;Pong! Latency: $pingms]",
});

client.commands.add({
	name: "arch",
	type: "messageCreate",
	code: "$sendMessage[$channelID;Running on ForgeGraal binary: $packageManager]",
});

console.log("[SampleBot] ForgeScript bot initialized successfully.");
