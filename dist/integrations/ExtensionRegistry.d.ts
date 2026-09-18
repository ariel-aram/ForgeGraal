/**
 * Extension Ecosystem Integrations for BotForge / ForgeScript
 * Provides compatibility metadata, native dependency analysis, and fallback suggestions
 * for official and community extensions.
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
    static isLegacySafe(id: string): boolean;
}
//# sourceMappingURL=ExtensionRegistry.d.ts.map