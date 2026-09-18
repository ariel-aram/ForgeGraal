/**
 * Compatibility notes for official BotForge / ForgeScript extensions.
 *
 * `legacySafe` means the extension runs on targets that cannot load native addons
 * (Windows XP / Vista / 7, iSH, linux-x86, freebsd-x86) — that is, it either has no native
 * dependency or ForgeGraal's native shim has a replacement that behaves like the real one.
 * Extensions whose features genuinely need a native addon are marked unsafe: the shim
 * refuses to stub them, because empty images or broken voice encryption are worse than a
 * clear failure.
 */
export interface ExtensionInfo {
    id: string;
    name: string;
    package: string;
    description: string;
    nativeAddons: string[];
    requiresNetwork: boolean;
    legacySafe: boolean;
    notes: string;
}
export declare const FORGE_EXTENSIONS_MAP: Record<string, ExtensionInfo>;
export declare class ExtensionRegistry {
    static listExtensions(): ExtensionInfo[];
    static getExtension(id: string): ExtensionInfo | null;
    /**
     * `null` for extensions this registry does not know, so callers can say "unknown"
     * instead of claiming an unlisted extension is safe.
     */
    static isLegacySafe(id: string): boolean | null;
}
//# sourceMappingURL=ExtensionRegistry.d.ts.map