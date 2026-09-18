"use strict";
/**
 * Extension Ecosystem Integrations for BotForge / ForgeScript
 * Provides compatibility metadata, native dependency analysis, and fallback suggestions
 * for official and community extensions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionRegistry = exports.FORGE_EXTENSIONS_MAP = void 0;
exports.FORGE_EXTENSIONS_MAP = {
    "forge.canvas": {
        id: "forge.canvas",
        name: "ForgeCanvas",
        package: "@tryforge/forge.canvas",
        description: "Image generation and manipulation using canvas APIs",
        nativeAddons: ["canvas", "@napi-rs/canvas"],
        requiresNetwork: false,
        legacySafe: true, // Polyfilled by ForgeGraal WasmLayer
        notes: "Pure-JS / Wasm canvas stub prevents ERR_DLOPEN_FAILED on legacy Windows and iSH.",
    },
    "forge.music": {
        id: "forge.music",
        name: "ForgeMusic",
        package: "@tryforge/forge.music",
        description: "Audio streaming and music playback",
        nativeAddons: ["@snazzah/davey", "sodium-native", "@discordjs/opus"],
        requiresNetwork: true,
        legacySafe: true, // Polyfilled by ForgeGraal WasmLayer
        notes: "Voice encryption routed to Node crypto; ffmpeg/opus fallbacks applied.",
    },
    "forge.minecraft": {
        id: "forge.minecraft",
        name: "ForgeMinecraft",
        package: "@tryforge/forge.minecraft",
        description: "Minecraft server ping, RCON, and skin avatar integration",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Pure JS socket and protocol handling; runs natively on all targets.",
    },
    "forge.linked": {
        id: "forge.linked",
        name: "ForgeLinked",
        package: "@tryforge/forge.linked",
        description: "Lavalink audio client integration for ForgeScript",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Offloads heavy audio processing to remote Lavalink servers; optimal for legacy OS.",
    },
    "forge.topgg": {
        id: "forge.topgg",
        name: "ForgeTopGG",
        package: "@tryforge/forge.topgg",
        description: "Top.gg stats poster and webhook server",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Uses HTTP client and express/native HTTP server; fully safe across all platforms.",
    },
    "forge.giveaways": {
        id: "forge.giveaways",
        name: "ForgeGiveaways",
        package: "@tryforge/forge.giveaways",
        description: "Giveaway manager for ForgeScript",
        nativeAddons: [],
        requiresNetwork: false,
        legacySafe: true,
        notes: "Integrates with ForgeDB / QuorielDB; database compatibility rules apply.",
    },
    "forge.api": {
        id: "forge.api",
        name: "ForgeAPI",
        package: "@tryforge/forge.api",
        description: "REST API server for interacting with ForgeScript bots",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Standard HTTP/HTTPS routing; fully compatible with legacy systems.",
    },
    "forge.webserver": {
        id: "forge.webserver",
        name: "WebServer",
        package: "@tryforge/forge.webserver",
        description: "Lightweight web server extension for dashboards and endpoints",
        nativeAddons: [],
        requiresNetwork: true,
        legacySafe: true,
        notes: "Native Node.js HTTP server backend; zero native addon friction.",
    },
};
class ExtensionRegistry {
    static listExtensions() {
        return Object.values(exports.FORGE_EXTENSIONS_MAP);
    }
    static getExtension(id) {
        const normalized = id
            .toLowerCase()
            .replace("@tryforge/", "")
            .replace("tryforge/", "");
        return exports.FORGE_EXTENSIONS_MAP[normalized] ?? null;
    }
    static isLegacySafe(id) {
        const ext = ExtensionRegistry.getExtension(id);
        return ext ? ext.legacySafe : true;
    }
}
exports.ExtensionRegistry = ExtensionRegistry;
//# sourceMappingURL=ExtensionRegistry.js.map