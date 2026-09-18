import { type BinaryFormat, type TargetArch } from "../structures";
export interface BinaryInfo {
    format: BinaryFormat;
    arch: TargetArch | "unknown";
    bits: 32 | 64;
    /** ELF only: "freebsd" when EI_OSABI says so, otherwise "sysv". */
    elfAbi?: "sysv" | "freebsd";
    /** ELF only: dynamic loader path, e.g. /lib/ld-musl-i386.so.1 (null when static). */
    interpreter?: string | null;
}
export declare class BinaryInspector {
    static readHeader(filePath: string, bytes?: number): Buffer;
    /**
     * Identifies ELF, PE and Mach-O executables (and native `.node` addons) from their headers.
     */
    static inspect(input: string | Buffer): BinaryInfo | null;
    /**
     * Whether a binary can execute on the given target.
     */
    static matchesTarget(info: BinaryInfo, target: unknown): boolean;
    private static inspectElf;
    private static inspectPe;
    private static inspectMachO;
}
//# sourceMappingURL=BinaryInspector.d.ts.map