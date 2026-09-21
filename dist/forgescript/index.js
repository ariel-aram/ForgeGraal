"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Graak = void 0;
const forgescript_1 = require("@tryforge/forgescript");
const index_1 = require("../index");
/**
 * Graak as a ForgeScript extension: the target, policy and binary helpers as `$functions`, and
 * `$compileBinary` to build from inside a bot. Everything else in Graak works without ForgeScript;
 * this adapter is the only part of the package that imports it.
 */
class Graak extends forgescript_1.ForgeExtension {
    options;
    name = "graak";
    description = "Package JavaScript and TypeScript programs into standalone executables for every device, including legacy Windows and 32-bit systems.";
    version = index_1.VERSION;
    constructor(options = {}) {
        super();
        this.options = options;
    }
    init(_client) {
        this.load(`${__dirname}/functions`);
    }
}
exports.Graak = Graak;
exports.default = Graak;
//# sourceMappingURL=index.js.map