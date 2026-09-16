// Sample ForgeScript bot used to try ForgeGraal builds.
// Build:  npx forgegraal compile index.js --target ios-ish-x86
const { ForgeClient } = require("@tryforge/forgescript");
const { ForgeGraal } = require("forgegraal");

const client = new ForgeClient({
	intents: ["Guilds", "GuildMessages", "MessageContent"],
	prefixes: ["!"],
	extensions: [new ForgeGraal()],
});

client.commands.add({
	name: "ping",
	type: "messageCreate",
	code: "Pong! Latency: $ping ms",
});

client.commands.add({
	name: "runtime",
	type: "messageCreate",
	code: "Running $graalVersion on $nodeVersion ($env[FORGEGRAAL_TARGET])",
});

client.login(process.env.DISCORD_TOKEN);
