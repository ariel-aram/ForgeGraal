"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinaryPackager = exports.DEFAULT_OUTPUT_DIR = exports.MIN_TRANSPILABLE_NODE_MAJOR = exports.MIN_MODERN_API_NODE_MAJOR = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const ForgeDBIntegration_1 = require("../integrations/ForgeDBIntegration");
const launcher_1 = require("../runtime/launcher");
const nativeShim_1 = require("../runtime/nativeShim");
const structures_1 = require("../structures");
const Archive_1 = require("./Archive");
const BinaryInspector_1 = require("./BinaryInspector");
const BunTranspiler_1 = require("./BunTranspiler");
const LegacyRuntimeAssets_1 = require("./LegacyRuntimeAssets");
const LegacyTranspiler_1 = require("./LegacyTranspiler");
const NodeRuntime_1 = require("./NodeRuntime");
const PolicyEnforcer_1 = require("./PolicyEnforcer");
const PortablePackager_1 = require("./PortablePackager");
const ProjectCollector_1 = require("./ProjectCollector");
const QuickJsPackager_1 = require("./QuickJsPackager");
const RuntimeRegistry_1 = require("./RuntimeRegistry");
const SeaPackager_1 = require("./SeaPackager");
const V8AddonBuilder_1 = require("./V8AddonBuilder");
const YarnPnpCompat_1 = require("./YarnPnpCompat");
/**
 * Runtimes below this major need their bundled code lowered and the modern platform APIs
 * supplied. Node.js 20 is the floor because that is where the last of what current discord.js
 * reaches for lands: `fetch`, Web Streams and `AbortController` are Node 18, but undici also
 * calls `String.prototype.toWellFormed`, which is Node 20.
 */
exports.MIN_MODERN_API_NODE_MAJOR = 20;
/**
 * Lowest runtime the legacy pipeline can actually serve. esbuild refuses to emit below ES6
 * ("Transforming const to the configured target environment is not supported yet"), so a
 * runtime older than Node.js 6 cannot have modern code lowered for it at all. That is a real
 * ceiling, not a setting: the Windows Vista pin (Node.js 5.12.0) sits below it.
 */
exports.MIN_TRANSPILABLE_NODE_MAJOR = 6;
exports.DEFAULT_OUTPUT_DIR = "forgegraal-out";
class BinaryPackager {
    /**
     * Builds a ForgeScript bot into a Node.js Single Executable Application when the target
     * runtime supports it, otherwise into a portable bundle (launcher + archive + runtime).
     */
    static async compile(options) {
        const startTime = performance.now();
        const log = options.onLog ?? (() => { });
        const strategy = options.strategy ?? "auto";
        if (!["auto", "sea", "portable"].includes(strategy)) {
            throw new structures_1.RuntimeError(`Unknown strategy '${strategy}' (expected auto, sea or portable)`);
        }
        const root = ProjectCollector_1.ProjectCollector.findProjectRoot((0, node_path_1.resolve)(options.entrypoint));
        const pm = PolicyEnforcer_1.PolicyEnforcer.resolvePackageManager(options.packageManager, root);
        const target = PolicyEnforcer_1.PolicyEnforcer.assertTargetAllowed(options.target, pm);
        const meta = structures_1.TARGET_METADATA_MAP[target];
        const warnings = [];
        const defaultOutDir = (0, node_path_1.join)(root, exports.DEFAULT_OUTPUT_DIR);
        const excludePaths = [defaultOutDir];
        if (options.output)
            excludePaths.push((0, node_path_1.resolve)(options.output));
        // Bun projects are frequently run straight from .ts with no separate build step.
        // Node.js cannot require() that directly; transpile it with Bun's own bundler rather
        // than asking the user to pre-build, keeping installed packages external so
        // ProjectCollector resolves them from the real node_modules afterward.
        let entrypoint = (0, node_path_1.resolve)(options.entrypoint);
        let cleanupTranspiled = null;
        if (pm === "bun" && BunTranspiler_1.BUN_TRANSPILABLE_EXTENSIONS.has((0, node_path_1.extname)(entrypoint))) {
            if (!BunTranspiler_1.BunTranspiler.isAvailable()) {
                throw new structures_1.RuntimeError(`Entrypoint '${entrypoint}' is not plain JavaScript and 'bun' is not on PATH to transpile it. ` +
                    "Run 'bun build --target=node --outdir dist' (or tsc) first and pass the built file.");
            }
            log(`Transpiling ${options.entrypoint} with 'bun build' (packages kept external)`);
            const transpiled = BunTranspiler_1.BunTranspiler.transpile(entrypoint);
            entrypoint = transpiled.entrypoint;
            cleanupTranspiled = transpiled.cleanup;
        }
        // A Yarn Plug'n'Play project has no node_modules for ProjectCollector to walk. Rather than
        // reading .pnp.cjs or the zip cache directly, Yarn itself is asked to produce a real
        // node_modules tree from the same yarn.lock, in a throwaway copy of the project -- see
        // YarnPnpCompat for why this is a materialization, not a reimplementation.
        let cleanupPnp = null;
        if (pm === "yarn" && YarnPnpCompat_1.YarnPnpCompat.isPnpProject(root)) {
            const materialized = YarnPnpCompat_1.YarnPnpCompat.materialize(root, entrypoint, {
                offline: options.offline,
                excludePaths,
                onLog: log,
            });
            entrypoint = materialized.entrypoint;
            cleanupPnp = materialized.cleanup;
        }
        try {
            log(`Collecting project files from ${root} (${pm})`);
            // The transpiled file (if any) lives inside root and is walked and bundled like any
            // other project file — it is the entrypoint, so it must not be excluded.
            const project = ProjectCollector_1.ProjectCollector.collect({
                entrypoint,
                includeDev: options.includeDev,
                includeEnv: options.includeEnv,
                excludePaths,
            });
            if (project.usesBunApis.length) {
                warnings.push(`Bun APIs detected (${project.usesBunApis.slice(0, 5).join(", ")}). The compiled executable runs on ` +
                    "Node.js: bun:sqlite and common Bun globals (env, file, write, serve, sleep, which) are polyfilled " +
                    "at startup, but anything else (Bun.password, Bun.hash, FFI, Bun.spawn, ...) will fail when reached.");
            }
            if (!options.includeEnv) {
                warnings.push(".env files were not bundled; provide secrets through the environment at runtime.");
            }
            // This target defaults to the ForgeGraal native host (quickjs-ng + quickjs/native/) rather
            // than a bundled Node.js binary -- but it is a default, not a lock-in. Any of these is a
            // deliberate statement that Node.js is wanted here instead, and wins over the new default
            // the same way a registered runtime already won over the old pinned-Node fallback:
            //   - an explicit --node-binary
            //   - a runtime already registered with `forgegraal runtimes add` for this target
            //   - an explicit --strategy sea/portable (asking for a Node-shaped output by name)
            const explicitNodeOverride = Boolean(options.nodeBinary) || strategy !== "auto" || RuntimeRegistry_1.RuntimeRegistry.find(target, root).length > 0;
            if (QuickJsPackager_1.QuickJsPackager.supports(target) && !explicitNodeOverride) {
                // Node-API is implemented by the host itself (quickjs/native/napi.c), so a native addon is
                // not an obstacle here: it loads the way it would under Node.js, provided it was built for
                // this target's architecture and the host can dlopen at all.
                BinaryPackager.rebuildV8Addons(project, target, options, warnings, log);
                BinaryPackager.checkNativeAddons(project.nativeAddons, target, options, warnings, "native");
                const { required, optional } = (0, QuickJsPackager_1.classifyNativeAddons)(project.nativeAddons.map((a) => a.path));
                let nativeLibc = options.nativeLibc;
                if (required.size && !QuickJsPackager_1.QuickJsPackager.loadsAddons(target, nativeLibc ?? "musl")) {
                    const names = [...required.keys()].join(", ");
                    if (nativeLibc === "musl") {
                        throw new structures_1.RuntimeError(`${names} ship native addons, but --native-libc musl builds a statically linked host, and a ` +
                            "static executable has no dynamic loader to load them with. Use --native-libc glibc, or drop the flag " +
                            "and let ForgeGraal pick the dynamically linked host itself.");
                    }
                    if (!nativeLibc && QuickJsPackager_1.QuickJsPackager.loadsAddons(target, "glibc")) {
                        nativeLibc = "glibc";
                        warnings.push(`${names} ship native addons, which a static executable cannot load, so this build uses the ` +
                            "dynamically linked glibc host instead of the default static musl one. It runs on glibc systems " +
                            "(most Linux distributions) but not on Alpine; pass --native-libc musl only for a bot without addons.");
                    }
                    else {
                        throw new structures_1.RuntimeError(`${names} ship native addons, but ${meta.name} only has a statically linked host, and a static ` +
                            "executable cannot load shared libraries. No dynamically linked host is built for this target yet.");
                    }
                }
                if (optional.size && !QuickJsPackager_1.QuickJsPackager.loadsAddons(target, nativeLibc ?? "musl")) {
                    warnings.push(`${[...optional.keys()].join(", ")} ship native addons that this static host cannot load; ` +
                        "their libraries fall back to pure JavaScript on their own.");
                }
                log(`Packaging for the ForgeGraal native host on ${meta.name} (no Node.js runtime bundled)`);
                const nativeHostBinary = await QuickJsPackager_1.QuickJsPackager.ensureNativeHost(target, nativeLibc ?? "musl", log);
                const outputPath = (0, node_path_1.resolve)(options.output ?? (0, node_path_1.join)(defaultOutDir, `${project.name}-${target}`));
                const res = QuickJsPackager_1.QuickJsPackager.build({
                    target,
                    name: project.name,
                    entry: project.entry,
                    entries: project.entries,
                    outputPath,
                    nativeHostBinary,
                });
                warnings.push(...res.warnings);
                return {
                    success: true,
                    strategy: "quickjs",
                    outputPath: res.outputPath,
                    launcherPath: res.launcherPath,
                    target,
                    packageManager: pm,
                    sizeBytes: res.sizeBytes,
                    is32BitOrLegacy: (0, structures_1.is32BitOrLegacy)(target),
                    metadata: meta,
                    runtimeVersion: null,
                    archiveSha256: res.sha256,
                    files: project.entries.length,
                    packages: project.packages,
                    durationMs: Math.round(performance.now() - startTime),
                    warnings,
                };
            }
            BinaryPackager.checkNativeAddons(project.nativeAddons, target, options, warnings);
            const runtime = await BinaryPackager.selectRuntime(target, meta, project.minNode, options, root, log);
            if (meta.pinnedLegacyNode && runtime.version === meta.pinnedLegacyNode.version) {
                warnings.push(meta.pinnedLegacyNode.warning);
            }
            const legacy = BinaryPackager.legacyRuntimePlan(runtime.version);
            if (runtime.version && project.minNode && (0, ProjectCollector_1.compareVersions)(runtime.version, project.minNode) < 0) {
                // A dependency's `engines.node` is that package's own statement about what it needs,
                // and lowering its code plus supplying the missing platform APIs is exactly how this
                // build intends to override it. So the floor is only fatal when nothing is going to
                // be done about it; otherwise it is reported and the build continues.
                if (legacy.kind !== "lower") {
                    throw new structures_1.RuntimeError(`The bundled dependencies require Node.js >= ${project.minNode}, but the target runtime is ${runtime.version}.`);
                }
                warnings.push(`The bundled dependencies declare they need Node.js >= ${project.minNode}, but this build targets ` +
                    `${runtime.version}. Their code is being lowered and the missing APIs polyfilled, which is what makes ` +
                    "that declaration surmountable — but it is an override, not a guarantee, so test the executable before " +
                    "relying on it.");
            }
            let chosen;
            if (strategy === "sea") {
                if (!runtime.seaReady)
                    throw new structures_1.RuntimeError(`Cannot build a SEA for ${meta.name}: ${runtime.reason}`);
                chosen = "sea";
            }
            else if (strategy === "portable") {
                chosen = "portable";
            }
            else {
                chosen = runtime.seaReady ? "sea" : "portable";
                if (!runtime.seaReady && runtime.binary) {
                    warnings.push(`Falling back to a portable bundle: ${runtime.reason}`);
                }
            }
            // A runtime older than the APIs current discord.js is written against needs its code
            // lowered and the missing platform APIs supplied. Decided from the runtime actually
            // selected, not from the target: the same target built with a newer --node-binary
            // needs none of this, and doing it anyway would be pure cost.
            let entries = project.entries;
            let legacyPolyfills = null;
            if (legacy.kind === "unreachable")
                warnings.push(legacy.reason);
            if (legacy.kind === "lower") {
                log(`Runtime is Node.js ${runtime.version}; lowering bundled code to ${legacy.jsTarget}`);
                const transpiled = await LegacyTranspiler_1.LegacyTranspiler.transpile(entries, { jsTarget: legacy.jsTarget, onLog: log });
                entries = transpiled.entries;
                if (transpiled.failures.length) {
                    warnings.push(`${transpiled.failures.length} bundled file(s) could not be lowered to ${legacy.jsTarget} and were ` +
                        `kept as-is; they will only matter if the bot actually loads them. First: ${transpiled.failures[0]}`);
                }
                const assets = await LegacyRuntimeAssets_1.LegacyRuntimeAssets.build({
                    jsTarget: legacy.jsTarget,
                    runtimeCodegen: true,
                    onLog: log,
                });
                entries = [...entries, ...assets.entries];
                legacyPolyfills = {
                    target,
                    jsTarget: legacy.jsTarget,
                    assetDir: LegacyRuntimeAssets_1.LEGACY_ASSET_DIR,
                    runtimeCodegen: true,
                };
                warnings.push(`Built for Node.js ${runtime.version}: bundled code was lowered to ${legacy.jsTarget} and missing ` +
                    "platform APIs are polyfilled at startup. Text segmentation ($segmentTextSplit and friends) throws " +
                    "on this runtime rather than returning wrong results, because Intl.Segmenter needs ICU data this " +
                    "runtime does not ship.");
            }
            const archive = Archive_1.Archive.pack([
                ...entries,
                {
                    path: launcher_1.IMPORT_HELPER_PATH,
                    source: Buffer.from(launcher_1.IMPORT_HELPER_SOURCE),
                    mode: 0o644,
                },
            ]);
            const launcherSource = (0, launcher_1.createLauncherSource)({
                name: project.name,
                entry: project.entry,
                hash: archive.sha256,
                // With the legacy pipeline active, the dependencies' declared floor has deliberately
                // been overridden, so enforcing it at startup would reject the very runtime this
                // build was made for. The guard is kept, just re-aimed at that runtime: running the
                // bundle on something even older than what its code was lowered for is still a
                // mistake worth stopping.
                minNode: legacyPolyfills && runtime.version ? runtime.version : project.minNode,
                target,
                mode: chosen,
                // Resolved here rather than in the launcher: matching substrings of the target id
                // misses targets (`win-xp-x86` contains no "legacy", `linux-x86` no "xp").
                windowsLegacy: meta.os === "windows-legacy",
                simdUnsafe: meta.is32BitOrLegacy,
                nativeShim: meta.is32BitOrLegacy,
                bunCompat: project.usesBunApis.length > 0,
                legacyPolyfills,
            });
            log(`Packed ${archive.files} files from ${project.packages} packages (${(archive.buffer.length / 1048576).toFixed(1)} MiB compressed)`);
            let outputPath;
            let launcherPath;
            let sizeBytes;
            if (chosen === "sea") {
                outputPath = (0, node_path_1.resolve)(options.output ?? (0, node_path_1.join)(defaultOutDir, `${project.name}-${target}${(0, structures_1.executableExtension)(target)}`));
                if ((0, node_fs_1.existsSync)(outputPath) && (0, node_fs_1.statSync)(outputPath).isDirectory()) {
                    throw new structures_1.RuntimeError(`SEA output '${outputPath}' is a directory; pass a file path`);
                }
                const { binary, version } = runtime;
                if (!binary || !version) {
                    throw new structures_1.RuntimeError("SEA builds need a runtime with a known version");
                }
                const generator = await BinaryPackager.selectGenerator(target, binary, version, options, warnings, log);
                log(`Injecting SEA blob into Node.js ${runtime.version ?? "(unknown version)"}`);
                const res = await SeaPackager_1.SeaPackager.build({
                    target,
                    runtimeBinary: binary,
                    generatorBinary: generator,
                    launcherSource,
                    archive: archive.buffer,
                    outputPath,
                });
                warnings.push(...res.warnings);
                launcherPath = outputPath;
                sizeBytes = res.sizeBytes;
            }
            else {
                outputPath = (0, node_path_1.resolve)(options.output ?? (0, node_path_1.join)(defaultOutDir, `${project.name}-${target}`));
                const res = PortablePackager_1.PortablePackager.build({
                    target,
                    name: project.name,
                    launcherSource,
                    archive: archive.buffer,
                    outputPath,
                    runtimeBinary: runtime.binary,
                });
                warnings.push(...res.warnings);
                launcherPath = res.launcherPath;
                sizeBytes = res.sizeBytes;
            }
            return {
                success: true,
                strategy: chosen,
                outputPath,
                launcherPath,
                target,
                packageManager: pm,
                sizeBytes,
                is32BitOrLegacy: (0, structures_1.is32BitOrLegacy)(target),
                metadata: meta,
                runtimeVersion: runtime.version,
                archiveSha256: archive.sha256,
                files: archive.files,
                packages: project.packages,
                durationMs: Math.round(performance.now() - startTime),
                warnings,
            };
        }
        finally {
            cleanupTranspiled?.();
            cleanupPnp?.();
        }
    }
    /**
     * Decides whether a build needs the legacy treatment, and which language level to lower to.
     * `null` means the runtime is modern enough to run current code as published.
     *
     * The esbuild target is built from the runtime's own major and minor rather than a fixed
     * string, so lowering is never more aggressive than the runtime requires.
     */
    static legacyRuntimePlan(runtimeVersion) {
        if (!runtimeVersion)
            return { kind: "modern" };
        const [major, minor] = runtimeVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
        if (major >= exports.MIN_MODERN_API_NODE_MAJOR)
            return { kind: "modern" };
        if (major < exports.MIN_TRANSPILABLE_NODE_MAJOR) {
            return {
                kind: "unreachable",
                reason: `Node.js ${runtimeVersion} predates ES6, and esbuild cannot lower modern JavaScript that far ` +
                    `(its floor is Node.js ${exports.MIN_TRANSPILABLE_NODE_MAJOR}). Bundled code is shipped unchanged, so anything ` +
                    "written in modern syntax — which is all of current discord.js and ForgeScript — will fail to parse " +
                    "on this runtime. Only a bot whose whole dependency tree is ES5 can run here.",
            };
        }
        return { kind: "lower", jsTarget: `node${major}.${minor}` };
    }
    /**
     * A prebuilt addon compiled against V8 cannot load outside Node.js, but the package that ships it
     * usually ships its source too. That source is rebuilt here against ForgeGraal's V8 layer for the
     * target -- from any build machine, whatever platform the installed prebuild was for.
     *
     * Packages that are only optional accelerators, with a host that cannot load addons anyway, are
     * left alone: building them would produce something the host then could not use.
     */
    static rebuildV8Addons(project, target, options, warnings, log) {
        const packages = V8AddonBuilder_1.V8AddonBuilder.find(project.entries);
        if (!packages.length)
            return;
        const hostLoadsAddons = QuickJsPackager_1.QuickJsPackager.loadsAddons(target, options.nativeLibc ?? "musl");
        const needsHost = (0, QuickJsPackager_1.classifyNativeAddons)(project.nativeAddons.map((a) => a.path)).required.size > 0;
        if (!hostLoadsAddons && !needsHost && options.nativeLibc !== "glibc")
            return;
        for (const pkg of packages) {
            const built = V8AddonBuilder_1.V8AddonBuilder.build({ pkg, target, onLog: log });
            const dir = V8AddonBuilder_1.V8AddonBuilder.archiveDirOf(pkg.addonPaths[0]);
            V8AddonBuilder_1.V8AddonBuilder.replace(project.entries, pkg, built, dir);
            project.nativeAddons = project.nativeAddons.filter((a) => !pkg.addonPaths.includes(a.path));
            const path = `${dir}/${built.relativePath}`;
            project.nativeAddons.push({ path, info: BinaryInspector_1.BinaryInspector.inspect(built.file) });
            warnings.push(`${pkg.name} was compiled against V8, which only Node.js has, so it was rebuilt from source against ForgeGraal's ` +
                `V8 layer for ${target}. The prebuilt binary it shipped was not used.`);
        }
    }
    static checkNativeAddons(addons, target, options, warnings, host = "node") {
        // Prebuilt packages often ship addons for several platforms: a package is fine
        // as soon as one of its addons fits the target
        const byPackage = new Map();
        for (const addon of addons) {
            const idx = addon.path.lastIndexOf("node_modules/");
            const rest = idx === -1 ? addon.path : addon.path.slice(idx + 13);
            const pkgName = idx === -1
                ? "(project)"
                : rest
                    .split("/")
                    .slice(0, rest.startsWith("@") ? 2 : 1)
                    .join("/");
            const key = idx === -1 ? pkgName : addon.path.slice(0, idx + 13) + pkgName;
            const entry = byPackage.get(key) ?? { usable: false, mismatched: [] };
            byPackage.set(key, entry);
            if (!addon.info) {
                warnings.push(`Could not identify native addon '${addon.path}'.`);
            }
            else if (BinaryInspector_1.BinaryInspector.matchesTarget(addon.info, target)) {
                entry.usable = true;
            }
            else {
                entry.mismatched.push(`${addon.path} (${addon.info.format} ${addon.info.arch})`);
            }
        }
        const nativeForgeDbPackages = Object.values(ForgeDBIntegration_1.FORGEDB_DRIVERS)
            .filter((d) => d.native)
            .map((d) => d.package);
        // Matching the target's architecture is necessary but not sufficient. A prebuilt addon for
        // win32-x64 is a perfectly valid PE for win-legacy-x64 and still fails to load there,
        // because it was compiled against a newer Node ABI and a newer Windows -- the machine
        // reports "The specified procedure could not be found". That happened on a real Windows
        // install with lmdb, and the build had said nothing, because nothing was mismatched.
        //
        // For legacy targets, warn about the packages the runtime shim deliberately will not
        // substitute: if one of those is bundled, it is the most likely thing to stop the bot, and
        // finding that out at build time beats finding out on the target machine.
        if (host === "native" && structures_1.TARGET_METADATA_MAP[target].is32BitOrLegacy && byPackage.size) {
            // The Node-API layer is the host's own, so there is no Node ABI to be too new for. The addon
            // is still a native binary its authors built for some Windows or glibc, and if that is newer
            // than the target's, loading it fails with the system's own error message, not a build error.
            warnings.push(`Native addons are loaded by the operating system, not by ForgeGraal, so each one must itself run on ${target}. ` +
                "Prebuilt addons are usually built for a recent OS; if one is not, it fails at load time with the system's error.");
        }
        else if (host === "node" && structures_1.TARGET_METADATA_MAP[target].is32BitOrLegacy) {
            const bundled = new Set([...byPackage.keys()].map((key) => key.split("node_modules/").pop() ?? key));
            const risky = nativeShim_1.UNSUBSTITUTABLE_NATIVE.filter((name) => bundled.has(name));
            if (risky.length) {
                warnings.push(`${risky.join(", ")} ship native addons that ForgeGraal will not replace with a stub, because a ` +
                    `stub would lose data or weaken security rather than fail. Their prebuilt binaries match ` +
                    `${target}'s architecture but are built for a newer Node.js ABI and a newer Windows, so they ` +
                    `commonly fail to load on this target with "The specified procedure could not be found". ` +
                    (nativeForgeDbPackages.some((pkg) => risky.includes(pkg))
                        ? `Use a pure JavaScript ForgeDB driver (${ForgeDBIntegration_1.PURE_JS_FORGEDB_DRIVERS.join(", ")}) instead.`
                        : "Rebuild them for this target, or drop the feature that needs them."));
            }
        }
        const mismatched = [...byPackage.values()].filter((p) => !p.usable).flatMap((p) => p.mismatched);
        if (!mismatched.length)
            return;
        const mismatchedPackageNames = new Set([...byPackage.entries()].filter(([, p]) => !p.usable).map(([key]) => key.split("/").pop() ?? key));
        const hint = nativeForgeDbPackages.some((p) => mismatchedPackageNames.has(p))
            ? `ForgeDB: this native database driver has no matching build for ${target}. ` +
                `Switch to a pure JavaScript driver (${ForgeDBIntegration_1.PURE_JS_FORGEDB_DRIVERS.join(", ")}) instead of reinstalling ` +
                "a native one for the target."
            : undefined;
        if (options.allowNativeMismatch) {
            warnings.push(`Native addons that cannot run on ${target} were bundled: ${mismatched.join(", ")}${hint ? ` ${hint}` : ""}`);
            return;
        }
        throw new structures_1.NativeAddonMismatchError(target, mismatched, hint);
    }
    static async selectRuntime(target, meta, minNode, options, root, log) {
        let binary = null;
        if (options.nodeBinary) {
            binary = (0, node_path_1.resolve)(options.nodeBinary);
            if (!(0, node_fs_1.existsSync)(binary) || !(0, node_fs_1.statSync)(binary).isFile()) {
                throw new structures_1.RuntimeError(`Node.js binary not found: ${binary}`);
            }
            if (meta.os === "windows-legacy") {
                log("Make sure the supplied runtime supports Windows 7 / Vista; official Node.js >= 14 does not.");
            }
            const info = BinaryInspector_1.BinaryInspector.inspect(binary);
            if (!info || !BinaryInspector_1.BinaryInspector.matchesTarget(info, target)) {
                throw new structures_1.RuntimeError(`'${binary}' (${info ? `${info.format} ${info.arch}` : "unknown format"}) cannot run on ${meta.name} (${meta.binaryFormat} ${meta.arch}).`);
            }
        }
        else if (meta.officialNodeFile && !options.offline) {
            const version = await NodeRuntime_1.NodeRuntime.resolveOfficialVersion(meta.officialNodeFile, options.nodeVersion, minNode);
            log(`Downloading official Node.js ${version} (${meta.officialNodeFile})`);
            binary = await NodeRuntime_1.NodeRuntime.ensureOfficial(version, meta.officialNodeFile);
        }
        else if (!options.offline) {
            // A user-registered runtime is their own explicit, trusted choice (e.g. a newer
            // unofficial Windows 7 build) and wins over ForgeGraal's own pinned fallback below.
            const [entry] = RuntimeRegistry_1.RuntimeRegistry.find(target, root);
            if (entry) {
                log(`Using registered community runtime for ${target}: Node.js ${entry.version} (${entry.url})`);
                binary = await RuntimeRegistry_1.RuntimeRegistry.ensure(entry);
                const info = BinaryInspector_1.BinaryInspector.inspect(binary);
                if (!info || !BinaryInspector_1.BinaryInspector.matchesTarget(info, target)) {
                    throw new structures_1.RuntimeError(`Registered runtime for '${target}' (${entry.url}) does not match the target after download ` +
                        `(${info ? `${info.format} ${info.arch}` : "unrecognized format"}). ` +
                        "Remove it with 'forgegraal runtimes remove' and register a correct one.");
                }
            }
            else if (meta.pinnedLegacyNode) {
                const { version, fileKey } = meta.pinnedLegacyNode;
                log(`Downloading Node.js ${version} (${fileKey}), the last official release for ${meta.name}`);
                binary = await NodeRuntime_1.NodeRuntime.ensureOfficial(version, fileKey);
            }
        }
        if (!binary) {
            return {
                binary: null,
                version: null,
                seaReady: false,
                reason: meta.officialNodeFile || meta.pinnedLegacyNode
                    ? "runtime downloads are disabled (offline) and no --node-binary was given."
                    : `no Node.js runtime was given and none is registered for this target. ${meta.runtimeHint} ` +
                        `Or register one once with 'forgegraal runtimes add ${target} <version> <url> --sha256 <hex>'.`,
            };
        }
        const version = NodeRuntime_1.NodeRuntime.readVersion(binary);
        const fuse = NodeRuntime_1.NodeRuntime.seaFuseState((0, node_fs_1.readFileSync)(binary));
        let reason = null;
        if (!version)
            reason = "the runtime version could not be determined.";
        else if ((0, ProjectCollector_1.compareVersions)(version, NodeRuntime_1.MIN_SEA_NODE_VERSION) < 0) {
            reason = `Node.js ${version} is older than ${NodeRuntime_1.MIN_SEA_NODE_VERSION}, which SEA assets require.`;
        }
        else if (fuse !== "ready") {
            reason = fuse === "absent" ? "the runtime was built without SEA support." : "the runtime is already a SEA.";
        }
        return { binary, version, seaReady: reason === null, reason };
    }
    /**
     * The SEA blob should be produced by the same Node.js version it is injected into.
     */
    static async selectGenerator(target, binary, version, options, warnings, log) {
        if (NodeRuntime_1.NodeRuntime.canRunOnHost(target))
            return binary;
        if (process.versions.node === version)
            return process.execPath;
        const hostKey = NodeRuntime_1.NodeRuntime.hostFileKey();
        if (hostKey && !options.offline) {
            try {
                log(`Downloading host Node.js ${version} to generate the SEA blob`);
                return await NodeRuntime_1.NodeRuntime.ensureOfficial(version, hostKey);
            }
            catch (err) {
                warnings.push(`Could not get a host Node.js ${version} (${err instanceof Error ? err.message : String(err)}).`);
            }
        }
        if ((0, ProjectCollector_1.compareVersions)(process.versions.node, NodeRuntime_1.MIN_SEA_NODE_VERSION) < 0) {
            throw new structures_1.RuntimeError(`Generating a SEA blob needs Node.js >= ${NodeRuntime_1.MIN_SEA_NODE_VERSION} on the build host.`);
        }
        if (process.versions.node.split(".")[0] !== version.split(".")[0]) {
            warnings.push(`SEA blob generated with Node.js ${process.versions.node} for a ${version} runtime; blob formats can differ between major versions. Test the executable on the target.`);
        }
        return process.execPath;
    }
}
exports.BinaryPackager = BinaryPackager;
//# sourceMappingURL=BinaryPackager.js.map