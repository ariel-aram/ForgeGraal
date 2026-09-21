"use strict";
/**
 * Compatibility notes for official BotForge / ForgeScript extensions.
 *
 * `legacySafe` means the extension runs on targets that cannot load native addons
 * (Windows XP / Vista / 7, iSH, linux-x86, freebsd-x86) — that is, it either has no native
 * dependency or Graak's native shim has a replacement that behaves like the real one.
 * Extensions whose features genuinely need a native addon are marked unsafe: the shim
 * refuses to stub them, because empty images or broken voice encryption are worse than a
 * clear failure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionRegistry = exports.FORGE_EXTENSIONS_MAP = void 0;
exports.FORGE_EXTENSIONS_MAP = {
    "forge.canvas": {
        id: "forge.canvas",
        name: "ForgeCanvas",
        package: "@tryforge/forge.canvas",
        description: "Image generation and manipulation using canvas APIs",
        nativeAddons: ["@napi-rs/canvas", "canvas", "@gifsx/gifsx"],
        requiresNetwork: false,
        legacySafe: false,
        notes: "Rendering is done by a native addon with no pure JavaScript equivalent. On targets that cannot load it the bot fails at require() with an explanation instead of silently producing blank images.",
    },
    "forge.music": {
        id: "forge.music",
        name: "ForgeMusic",
        package: "@tryforge/forge.music",
        description: "Audio streaming and music playback",
        nativeAddons: ["@snazzah/davey", "sodium-native", "@discordjs/opus", "mediaplex"],
        requiresNetwork: true,
        legacySafe: false,
        notes: "Discord voice needs XChaCha20-Poly1305 and Opus, which Node's crypto and zlib cannot provide. Use forge.linked (Lavalink) on legacy targets instead.",
    },
    "forge.minecraft": {
        id: "forge.minecraft",
        name: "ForgeMinecraft",
        package: "@tryforge/forge.minecraft",
        description: "Minecraft server ping, RCON, and skin avatar integration",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Pure JS socket and protocol handling; runs on every target.",
    },
    "forge.linked": {
        id: "forge.linked",
        name: "ForgeLinked",
        package: "@tryforge/forge.linked",
        description: "Lavalink audio client integration for ForgeScript",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Audio work happens on a remote Lavalink server, which is what makes it the workable music option on legacy targets.",
    },
    "forge.topgg": {
        id: "forge.topgg",
        name: "ForgeTopGG",
        package: "@tryforge/forge.topgg",
        description: "Top.gg stats poster and webhook server",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "HTTP client and server only.",
    },
    "forge.giveaways": {
        id: "forge.giveaways",
        name: "ForgeGiveaways",
        package: "@tryforge/forge.giveaways",
        description: "Giveaway manager for ForgeScript",
        nativeAddons: [],
        requiresNetwork: false,
        legacySafe: true,
        notes: "Stores state through ForgeDB, so the database driver's own compatibility applies (see $dbDriverCompat).",
    },
    "forge.api": {
        id: "forge.api",
        name: "ForgeAPI",
        package: "@tryforge/forge.api",
        description: "REST API server for interacting with ForgeScript bots",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Standard HTTP/HTTPS routing.",
    },
    "forge.webserver": {
        id: "forge.webserver",
        name: "WebServer",
        package: "@tryforge/forge.webserver",
        description: "Lightweight web server extension for dashboards and endpoints",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Built on Node's HTTP server; no native addons.",
    },
};
class ExtensionRegistry {
    static listExtensions() {
        return Object.values(exports.FORGE_EXTENSIONS_MAP);
    }
    static getExtension(id) {
        const normalized = id
            .trim()
            .toLowerCase()
            .replace(/^@tryforge\//, "")
            .replace(/^tryforge\//, "");
        return exports.FORGE_EXTENSIONS_MAP[normalized] ?? null;
    }
    /**
     * `null` for extensions this registry does not know, so callers can say "unknown"
     * instead of claiming an unlisted extension is safe.
     */
    static isLegacySafe(id) {
        return ExtensionRegistry.getExtension(id)?.legacySafe ?? null;
    }
}
exports.ExtensionRegistry = ExtensionRegistry;
//# sourceMappingURL=ExtensionRegistry.js.map