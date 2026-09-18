"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMPORT_HELPER_PATH = exports.IMPORT_HELPER_SOURCE = exports.PORTABLE_LAUNCHER_NAME = exports.PORTABLE_ARCHIVE_NAME = exports.SEA_ASSET_NAME = void 0;
exports.createLauncherSource = createLauncherSource;
const Archive_1 = require("../compiler/Archive");
const nativeShim_1 = require("./nativeShim");
exports.SEA_ASSET_NAME = "app.fgar";
exports.PORTABLE_ARCHIVE_NAME = "app.fgar";
exports.PORTABLE_LAUNCHER_NAME = "boot.cjs";
/**
 * Builds the CommonJS bootstrap that runs inside the Node.js SEA or portable bundle.
 *
 * It is deliberately written in ES5 without optional APIs so that outdated runtimes
 * (e.g. on Windows XP / Vista or iSH) reach the version check and print a readable error
 * instead of a SyntaxError.
 */
function createLauncherSource(config) {
    const shim = config.nativeShim ? (0, nativeShim_1.createNativeShimSource)({ target: config.target }) : "";
    return `"use strict";
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

var CONFIG = ${JSON.stringify(config)};
var MAGIC = ${JSON.stringify(Archive_1.ARCHIVE_MAGIC)};
var IS_WINDOWS = process.platform === "win32";

function fail(message) {
	process.stderr.write("[ForgeGraal] " + message + "\\n");
	process.exit(1);
}

function compareVersions(a, b) {
	var pa = a.split("."), pb = b.split(".");
	for (var i = 0; i < 3; i++) {
		var d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function getSea() {
	try {
		var sea = require("node:sea");
		return sea.isSea() ? sea : null;
	} catch (e) {
		return null;
	}
}

function mkdirp(dir) {
	if (fs.existsSync(dir)) return;
	mkdirp(path.dirname(dir));
	fs.mkdirSync(dir);
}

function assertSafe(p) {
	var parts = p.split("/");
	if (!p || p.indexOf("\\\\") !== -1 || p.indexOf("\\0") !== -1 || p.charAt(0) === "/" || /^[a-zA-Z]:/.test(p)) {
		fail("Refusing unsafe archive path: " + p);
	}
	for (var i = 0; i < parts.length; i++) {
		if (parts[i] === "" || parts[i] === "." || parts[i] === "..") fail("Refusing unsafe archive path: " + p);
	}
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return fallback;
	}
}

function extract(archive, appDir, baseDir) {
	var raw = zlib.gunzipSync(archive);
	if (raw.toString("latin1", 0, MAGIC.length) !== MAGIC) fail("Embedded application archive is corrupt.");
	var manifestLength = raw.readUInt32LE(MAGIC.length);
	var offset = MAGIC.length + 4;
	var manifest = JSON.parse(raw.toString("utf8", offset, offset + manifestLength));
	offset += manifestLength;

	var listFile = path.join(baseDir, ".forgegraal-files.json");
	var previous = readJson(listFile, []);
	var current = {};

	for (var i = 0; i < manifest.files.length; i++) {
		var file = manifest.files[i];
		assertSafe(file.path);
		var dest = path.join(appDir, file.path);
		mkdirp(path.dirname(dest));
		fs.writeFileSync(dest, raw.slice(offset, offset + file.size));
		if (!IS_WINDOWS) fs.chmodSync(dest, file.mode || 420);
		offset += file.size;
		current[file.path] = true;
	}

	for (var j = 0; j < previous.length; j++) {
		var old = previous[j];
		if (typeof old !== "string" || current[old]) continue;
		assertSafe(old);
		try {
			fs.unlinkSync(path.join(appDir, old));
		} catch (e) {}
	}

	fs.writeFileSync(listFile, JSON.stringify(Object.keys(current)));
}

function main() {
	if (CONFIG.minNode && compareVersions(process.versions.node, CONFIG.minNode) < 0) {
		fail("This bot requires Node.js >= " + CONFIG.minNode + " but the runtime is " + process.version + ".");
	}

	// Node.js verifies TLS against its own bundled Mozilla CA snapshot by default, not the
	// OS certificate store, so an outdated store (e.g. Windows XP / Vista / 7) normally isn't
	// a problem. --use-system-ca / --use-openssl-ca opt back into the OS store; warn instead
	// of failing outright, since the OS store may still be fine.
	if (CONFIG.windowsLegacy) {
		var nodeOptions = process.env.NODE_OPTIONS || "";
		if (nodeOptions.indexOf("--use-system-ca") !== -1 || nodeOptions.indexOf("--use-openssl-ca") !== -1) {
			process.stderr.write(
				"[ForgeGraal] Warning: NODE_OPTIONS forces the OS certificate store, which is likely outdated on " +
					"this platform and can fail TLS handshakes (e.g. to Discord). Unset --use-system-ca / " +
					"--use-openssl-ca to use Node's bundled CA store instead.\\n",
			);
		}
	}

	var sea = getSea();
	var baseDir = process.env.FORGEGRAAL_HOME
		? path.resolve(process.env.FORGEGRAAL_HOME)
		: sea
			? path.join(path.dirname(process.execPath), CONFIG.name + ".forgegraal")
			: __dirname;
	var appDir = path.join(baseDir, "app");
	var stampFile = path.join(baseDir, ".forgegraal-stamp");

	var stamp = null;
	try {
		stamp = fs.readFileSync(stampFile, "utf8");
	} catch (e) {}

	if (stamp !== CONFIG.hash || !fs.existsSync(path.join(appDir, CONFIG.entry))) {
		var archive = sea
			? Buffer.from(sea.getAsset(${JSON.stringify(exports.SEA_ASSET_NAME)}))
			: fs.readFileSync(path.join(__dirname, ${JSON.stringify(exports.PORTABLE_ARCHIVE_NAME)}));
		mkdirp(appDir);
		extract(archive, appDir, baseDir);
		fs.writeFileSync(stampFile, CONFIG.hash);
	}

	var entry = path.join(appDir, CONFIG.entry);
	process.chdir(appDir);
	process.env.FORGEGRAAL = "1";
	process.env.FORGEGRAAL_TARGET = CONFIG.target;
	process.env.FORGEGRAAL_APP_DIR = appDir;
	process.env.FORGEGRAAL_EXECUTABLE = sea ? process.execPath : __filename;
	process.argv[1] = entry;

	// undici picks a SIMD build of its HTTP parser when the CPU claims support; older 32-bit
	// CPUs trap on it. Opt out before undici is first required (unless the user decided).
	if (CONFIG.simdUnsafe && process.env.UNDICI_NO_WASM_SIMD === undefined) {
		process.env.UNDICI_NO_WASM_SIMD = "1";
	}

${shim}
	var Module = require("module");
	var load = sea ? Module.createRequire(entry) : require;
	try {
		load(entry);
	} catch (err) {
		if (!err || (err.code !== "ERR_REQUIRE_ESM" && err.code !== "ERR_REQUIRE_ASYNC_MODULE")) throw err;
		var importer = load(path.join(appDir, ".forgegraal-import.cjs"));
		importer(require("url").pathToFileURL(entry).href).catch(function (e) {
			process.stderr.write((e && e.stack ? e.stack : String(e)) + "\\n");
			process.exit(1);
		});
	}
}

main();
`;
}
/** Helper loaded from disk so that dynamic import() works for ESM entrypoints inside a SEA. */
exports.IMPORT_HELPER_SOURCE = `"use strict";\nmodule.exports = function (url) { return import(url); };\n`;
exports.IMPORT_HELPER_PATH = ".forgegraal-import.cjs";
//# sourceMappingURL=launcher.js.map