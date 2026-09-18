"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeGraal = exports.VERSION = void 0;
const forgescript_1 = require("@tryforge/forgescript");
__exportStar(require("./compiler"), exports);
__exportStar(require("./integrations"), exports);
__exportStar(require("./runtime/bunCompat"), exports);
__exportStar(require("./runtime/launcher"), exports);
__exportStar(require("./runtime/legacyPolyfills"), exports);
__exportStar(require("./runtime/nativeShim"), exports);
__exportStar(require("./structures"), exports);
exports.VERSION = require("../package.json").version;
class ForgeGraal extends forgescript_1.ForgeExtension {
    options;
    name = "forgegraal";
    description = "Compile ForgeScript bots into standalone executables for 32-bit (iSH, x86, ARMv7), legacy Windows and modern targets.";
    version = exports.VERSION;
    constructor(options = {}) {
        super();
        this.options = options;
    }
    init(_client) {
        this.load(`${__dirname}/functions`);
    }
}
exports.ForgeGraal = ForgeGraal;
exports.default = ForgeGraal;
//# sourceMappingURL=index.js.map