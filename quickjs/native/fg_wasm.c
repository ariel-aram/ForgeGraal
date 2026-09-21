/*
 * WebAssembly for the native host, on wasm3 (a small interpreter in portable C, MIT licensed).
 *
 * Programs use WebAssembly more than they admit: undici (which discord.js and Node's own fetch are built on)
 * parses HTTP with a wasm build of llhttp, and sql.js, esbuild-wasm, tiktoken and many image and crypto packages ship
 * their core as wasm. quickjs-ng has no WebAssembly, so without this they cannot even load.
 *
 * This file is the native half: it instantiates a module, calls its exports, lets it call back into JavaScript, and
 * exposes its linear memory. node-wasm.js is the JavaScript half that builds the `WebAssembly` API on top: it
 * parses the module's sections itself (imports, exports, types), so wasm3 is asked only to run code.
 *
 * Limits, stated rather than hidden: wasm3 interprets (no SIMD, no threads, no exception handling, no reference
 * types beyond funcref), it links imported functions but not imported memories, tables or globals, and tables are
 * not exposed to JavaScript. A module needing those fails to instantiate with a LinkError or CompileError.
 */

#include "quickjs.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "m3_env.h"
#include "wasm3.h"

#define FG_MAX_WASM 128
#define FG_MAX_FUNCS 512
#define FG_WASM_STACK (1024 * 1024)

typedef struct fg_winst fg_winst;

typedef struct {
    fg_winst *inst;
    JSValue fn;
    char argt[24]; /* i I f F per argument */
    int nargs;
    char rett; /* 0, i, I, f or F */
} fg_wimport;

struct fg_winst {
    int in_use;
    IM3Runtime rt;
    IM3Module mod;
    uint8_t *bytes;
    fg_wimport *imports;
    int nimports;
    IM3Function funcs[FG_MAX_FUNCS];
    int nfuncs;
    JSContext *ctx;
    int has_exc;
    JSValue exc;
    uint8_t *mem_ptr;
    uint32_t mem_size;
    JSValue mem_buf;
};

static fg_winst fg_winsts[FG_MAX_WASM];
static IM3Environment fg_wenv = NULL;

static fg_winst *fg_winst_get(JSContext *ctx, int32_t id)
{
    if (id < 0 || id >= FG_MAX_WASM || !fg_winsts[id].in_use) {
        JS_ThrowInternalError(ctx, "WebAssembly instance %d does not exist", id);
        return NULL;
    }
    return &fg_winsts[id];
}

static JSValue fg_wasm_throw(JSContext *ctx, const char *kind, const char *message)
{
    JSValue err = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message ? message : "unknown WebAssembly error"));
    JS_SetPropertyStr(ctx, err, "wasmKind", JS_NewString(ctx, kind));
    return JS_Throw(ctx, err);
}

/* A raw import: arguments were placed on the wasm3 stack after the return slot; call the JavaScript function. */
static const void *fg_wasm_import(IM3Runtime rt, IM3ImportContext ic, uint64_t *sp, void *mem)
{
    fg_wimport *imp = (fg_wimport *) ic->userdata;
    fg_winst *inst = imp->inst;
    JSContext *ctx = inst->ctx;
    JSValue argv[24];
    JSValue ret;
    uint64_t *args = sp + (imp->rett ? 1 : 0);
    int i;

    (void) rt;
    (void) mem;
    for (i = 0; i < imp->nargs; i++) {
        switch (imp->argt[i]) {
        case 'i':
            argv[i] = JS_NewInt32(ctx, *(int32_t *) &args[i]);
            break;
        case 'I':
            argv[i] = JS_NewBigInt64(ctx, *(int64_t *) &args[i]);
            break;
        case 'f':
            argv[i] = JS_NewFloat64(ctx, (double) *(float *) &args[i]);
            break;
        default:
            argv[i] = JS_NewFloat64(ctx, *(double *) &args[i]);
            break;
        }
    }
    ret = JS_Call(ctx, imp->fn, JS_UNDEFINED, imp->nargs, argv);
    for (i = 0; i < imp->nargs; i++) {
        JS_FreeValue(ctx, argv[i]);
    }
    if (JS_IsException(ret)) {
        /* Carry the JavaScript exception out through the trap so the caller of the export can rethrow it. */
        if (!inst->has_exc) {
            inst->exc = JS_GetException(ctx);
            inst->has_exc = 1;
        }
        return m3Err_trapAbort;
    }
    switch (imp->rett) {
    case 0:
        break;
    case 'i': {
        int32_t v = 0;
        JS_ToInt32(ctx, &v, ret);
        sp[0] = 0;
        *(int32_t *) &sp[0] = v;
        break;
    }
    case 'I': {
        int64_t v = 0;
        if (JS_IsBigInt(ret)) {
            JS_ToBigInt64(ctx, &v, ret);
        } else {
            double d = 0;
            JS_ToFloat64(ctx, &d, ret);
            v = (int64_t) d;
        }
        *(int64_t *) &sp[0] = v;
        break;
    }
    case 'f': {
        double d = 0;
        JS_ToFloat64(ctx, &d, ret);
        sp[0] = 0;
        *(float *) &sp[0] = (float) d;
        break;
    }
    default: {
        double d = 0;
        JS_ToFloat64(ctx, &d, ret);
        *(double *) &sp[0] = d;
        break;
    }
    }
    JS_FreeValue(ctx, ret);
    return m3Err_none;
}

static void fg_winst_release(fg_winst *inst)
{
    int i;
    if (!inst->in_use) {
        return;
    }
    for (i = 0; i < inst->nimports; i++) {
        JS_FreeValue(inst->ctx, inst->imports[i].fn);
    }
    free(inst->imports);
    if (!JS_IsUndefined(inst->mem_buf)) {
        JS_DetachArrayBuffer(inst->ctx, inst->mem_buf);
        JS_FreeValue(inst->ctx, inst->mem_buf);
    }
    if (inst->has_exc) {
        JS_FreeValue(inst->ctx, inst->exc);
    }
    if (inst->rt) {
        m3_FreeRuntime(inst->rt); /* frees the module it loaded too */
    }
    free(inst->bytes);
    memset(inst, 0, sizeof(*inst));
}

static int fg_wasm_type_char(char c)
{
    return c == 'i' || c == 'I' || c == 'f' || c == 'F';
}

/*
 * wasmInstantiate(bytes, imports, compileOnly) -> id
 *   imports: [{ module, name, sig: "i(iI)", fn }]   sig is ret(args) in wasm3's letters: v i I f F
 * Instantiates the module (linking imported functions, running the start function). With compileOnly it compiles
 * every function, to report an error the way `new WebAssembly.Module` must, and frees everything again.
 */
static JSValue fg_wasm_instantiate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t len = 0;
    uint8_t *bytes;
    int compile_only = argc > 2 && JS_ToBool(ctx, argv[2]);
    int id = -1, i;
    fg_winst *inst;
    M3Result res;
    uint32_t n = 0;
    JSValue lenv;

    bytes = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!bytes) {
        return JS_EXCEPTION;
    }
    for (i = 0; i < FG_MAX_WASM; i++) {
        if (!fg_winsts[i].in_use) {
            id = i;
            break;
        }
    }
    if (id < 0) {
        return JS_ThrowInternalError(ctx, "too many WebAssembly instances (limit is %d)", FG_MAX_WASM);
    }
    if (!fg_wenv) {
        fg_wenv = m3_NewEnvironment();
        if (!fg_wenv) {
            return JS_ThrowOutOfMemory(ctx);
        }
    }

    inst = &fg_winsts[id];
    memset(inst, 0, sizeof(*inst));
    inst->ctx = ctx;
    inst->mem_buf = JS_UNDEFINED;
    inst->exc = JS_UNDEFINED;
    inst->in_use = 1;
    /* wasm3 keeps pointing at the bytes it parsed, so it gets its own copy. */
    inst->bytes = (uint8_t *) malloc(len ? len : 1);
    if (!inst->bytes) {
        fg_winst_release(inst);
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(inst->bytes, bytes, len);

    inst->rt = m3_NewRuntime(fg_wenv, FG_WASM_STACK, NULL);
    if (!inst->rt) {
        fg_winst_release(inst);
        return JS_ThrowOutOfMemory(ctx);
    }
    res = m3_ParseModule(fg_wenv, &inst->mod, inst->bytes, (uint32_t) len);
    if (res) {
        JSValue err = fg_wasm_throw(ctx, "CompileError", res);
        fg_winst_release(inst);
        return err;
    }
    res = m3_LoadModule(inst->rt, inst->mod);
    if (res) {
        JSValue err = fg_wasm_throw(ctx, "LinkError", res);
        m3_FreeModule(inst->mod);
        inst->mod = NULL;
        fg_winst_release(inst);
        return err;
    }

    lenv = JS_GetPropertyStr(ctx, argv[1], "length");
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);
    inst->imports = (fg_wimport *) calloc(n ? n : 1, sizeof(fg_wimport));
    if (!inst->imports) {
        fg_winst_release(inst);
        return JS_ThrowOutOfMemory(ctx);
    }
    for (i = 0; i < (int) n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[1], (uint32_t) i);
        JSValue vmod = JS_GetPropertyStr(ctx, item, "module");
        JSValue vname = JS_GetPropertyStr(ctx, item, "name");
        JSValue vsig = JS_GetPropertyStr(ctx, item, "sig");
        JSValue vfn = JS_GetPropertyStr(ctx, item, "fn");
        const char *m = JS_ToCString(ctx, vmod);
        const char *nm = JS_ToCString(ctx, vname);
        const char *sig = JS_ToCString(ctx, vsig);
        fg_wimport *imp = &inst->imports[inst->nimports];
        int ok = m && nm && sig && JS_IsFunction(ctx, vfn) && sig[1] == '(';
        if (ok) {
            const char *p = sig + 2;
            imp->rett = sig[0] == 'v' ? 0 : sig[0];
            imp->inst = inst;
            imp->fn = JS_DupValue(ctx, vfn);
            inst->nimports++;
            while (*p && *p != ')' && imp->nargs < 24) {
                if (!fg_wasm_type_char(*p)) {
                    ok = 0;
                    break;
                }
                imp->argt[imp->nargs++] = *p++;
            }
            if (ok) {
                /* A module may not import a function it does not declare; wasm3 reports that as not found, which is fine. */
                m3_LinkRawFunctionEx(inst->mod, m, nm, sig, fg_wasm_import, imp);
            }
        }
        if (m) JS_FreeCString(ctx, m);
        if (nm) JS_FreeCString(ctx, nm);
        if (sig) JS_FreeCString(ctx, sig);
        JS_FreeValue(ctx, vmod);
        JS_FreeValue(ctx, vname);
        JS_FreeValue(ctx, vsig);
        JS_FreeValue(ctx, vfn);
        JS_FreeValue(ctx, item);
        if (!ok) {
            fg_winst_release(inst);
            return JS_ThrowTypeError(ctx, "invalid WebAssembly import description");
        }
    }
    if (compile_only) {
        /* Compile everything now; wasm3 otherwise compiles a function on its first call. */
        for (i = 0; i < (int) inst->mod->numFunctions; i++) {
            IM3Function f = &inst->mod->functions[i];
            if (f->wasm && !f->compiled) {
                res = CompileFunction(f);
                if (res) {
                    JSValue err = fg_wasm_throw(ctx, "CompileError", res);
                    fg_winst_release(inst);
                    return err;
                }
            }
        }
        fg_winst_release(inst);
        return JS_NewInt32(ctx, -1);
    }

    /* The start function runs at instantiation, after imports are linked. */
    res = m3_RunStart(inst->mod);
    if (res) {
        JSValue err;
        if (inst->has_exc) {
            err = JS_Throw(ctx, inst->exc);
            inst->has_exc = 0;
            inst->exc = JS_UNDEFINED;
        } else {
            err = fg_wasm_throw(ctx, "RuntimeError", res);
        }
        fg_winst_release(inst);
        return err;
    }
    return JS_NewInt32(ctx, id);
}

/* wasmFind(id, name) -> { index, args: "iIfF", ret: "iIfF" } or null. Compiles the function. */
static JSValue fg_wasm_find(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    fg_winst *inst;
    const char *name;
    IM3Function f = NULL;
    M3Result res;
    JSValue out;
    char args[32], rets[32];
    uint32_t i, na, nr;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    inst = fg_winst_get(ctx, id);
    if (!inst) {
        return JS_EXCEPTION;
    }
    name = JS_ToCString(ctx, argv[1]);
    if (!name) {
        return JS_EXCEPTION;
    }
    res = m3_FindFunction(&f, inst->rt, name);
    JS_FreeCString(ctx, name);
    if (res || !f) {
        return JS_NULL;
    }
    if (inst->nfuncs >= FG_MAX_FUNCS) {
        return JS_ThrowInternalError(ctx, "too many exported WebAssembly functions");
    }
    na = m3_GetArgCount(f);
    nr = m3_GetRetCount(f);
    if (na > 30 || nr > 30) {
        return JS_ThrowInternalError(ctx, "WebAssembly function with too many parameters");
    }
    for (i = 0; i < na; i++) {
        switch (m3_GetArgType(f, i)) {
        case c_m3Type_i32: args[i] = 'i'; break;
        case c_m3Type_i64: args[i] = 'I'; break;
        case c_m3Type_f32: args[i] = 'f'; break;
        default: args[i] = 'F'; break;
        }
    }
    args[na] = '\0';
    for (i = 0; i < nr; i++) {
        switch (m3_GetRetType(f, i)) {
        case c_m3Type_i32: rets[i] = 'i'; break;
        case c_m3Type_i64: rets[i] = 'I'; break;
        case c_m3Type_f32: rets[i] = 'f'; break;
        default: rets[i] = 'F'; break;
        }
    }
    rets[nr] = '\0';
    inst->funcs[inst->nfuncs] = f;
    out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "index", JS_NewInt32(ctx, inst->nfuncs));
    JS_SetPropertyStr(ctx, out, "args", JS_NewString(ctx, args));
    JS_SetPropertyStr(ctx, out, "ret", JS_NewString(ctx, rets));
    inst->nfuncs++;
    return out;
}

/* wasmCall(id, index, argsArray) -> the result (a value, an array for several, or undefined). */
static JSValue fg_wasm_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, index;
    fg_winst *inst;
    IM3Function f;
    union {
        int32_t i32;
        int64_t i64;
        float f32;
        double f64;
    } vals[32];
    const void *ptrs[32];
    uint32_t na, nr, i;
    M3Result res;
    JSValue result;

    if (JS_ToInt32(ctx, &id, argv[0]) || JS_ToInt32(ctx, &index, argv[1])) {
        return JS_EXCEPTION;
    }
    inst = fg_winst_get(ctx, id);
    if (!inst) {
        return JS_EXCEPTION;
    }
    if (index < 0 || index >= inst->nfuncs) {
        return JS_ThrowRangeError(ctx, "no such WebAssembly function");
    }
    f = inst->funcs[index];
    na = m3_GetArgCount(f);
    nr = m3_GetRetCount(f);
    for (i = 0; i < na; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[2], i);
        int rc = 0;
        switch (m3_GetArgType(f, i)) {
        case c_m3Type_i32:
            rc = JS_ToInt32(ctx, &vals[i].i32, v);
            break;
        case c_m3Type_i64:
            if (JS_IsBigInt(v)) {
                rc = JS_ToBigInt64(ctx, &vals[i].i64, v);
            } else {
                JS_FreeValue(ctx, v);
                return JS_ThrowTypeError(ctx, "Cannot convert a Number to a BigInt (WebAssembly i64 parameters take BigInt)");
            }
            break;
        case c_m3Type_f32: {
            double d = 0;
            rc = JS_ToFloat64(ctx, &d, v);
            vals[i].f32 = (float) d;
            break;
        }
        default:
            rc = JS_ToFloat64(ctx, &vals[i].f64, v);
            break;
        }
        JS_FreeValue(ctx, v);
        if (rc) {
            return JS_EXCEPTION;
        }
        ptrs[i] = &vals[i];
    }
    inst->has_exc = 0;
    res = m3_Call(f, na, ptrs);
    if (res) {
        if (inst->has_exc) {
            JSValue e = inst->exc;
            inst->has_exc = 0;
            inst->exc = JS_UNDEFINED;
            return JS_Throw(ctx, e);
        }
        return fg_wasm_throw(ctx, "RuntimeError", res);
    }
    if (nr == 0) {
        return JS_UNDEFINED;
    }
    {
        union {
            int32_t i32;
            int64_t i64;
            float f32;
            double f64;
        } outs[32];
        const void *optrs[32];
        JSValue items[32];
        for (i = 0; i < nr && i < 32; i++) {
            optrs[i] = &outs[i];
        }
        res = m3_GetResults(f, nr, optrs);
        if (res) {
            return fg_wasm_throw(ctx, "RuntimeError", res);
        }
        for (i = 0; i < nr; i++) {
            switch (m3_GetRetType(f, i)) {
            case c_m3Type_i32: items[i] = JS_NewInt32(ctx, outs[i].i32); break;
            case c_m3Type_i64: items[i] = JS_NewBigInt64(ctx, outs[i].i64); break;
            case c_m3Type_f32: items[i] = JS_NewFloat64(ctx, (double) outs[i].f32); break;
            default: items[i] = JS_NewFloat64(ctx, outs[i].f64); break;
            }
        }
        if (nr == 1) {
            return items[0];
        }
        result = JS_NewArray(ctx);
        for (i = 0; i < nr; i++) {
            JS_SetPropertyUint32(ctx, result, i, items[i]);
        }
        return result;
    }
}

/* wasmMemory(id) -> an ArrayBuffer over the linear memory (a fresh one whenever it grew or moved), or null. */
static JSValue fg_wasm_memory(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    fg_winst *inst;
    uint32_t size = 0;
    uint8_t *p;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    inst = fg_winst_get(ctx, id);
    if (!inst) {
        return JS_EXCEPTION;
    }
    p = m3_GetMemory(inst->rt, &size, 0);
    if (!p) {
        return JS_NULL;
    }
    if (p != inst->mem_ptr || size != inst->mem_size || JS_IsUndefined(inst->mem_buf)) {
        if (!JS_IsUndefined(inst->mem_buf)) {
            /* The old buffer must stop pointing at memory that may have moved or been freed. */
            JS_DetachArrayBuffer(ctx, inst->mem_buf);
            JS_FreeValue(ctx, inst->mem_buf);
        }
        inst->mem_buf = JS_NewArrayBuffer(ctx, p, size, 0, NULL, NULL, 0);
        inst->mem_ptr = p;
        inst->mem_size = size;
    }
    return JS_DupValue(ctx, inst->mem_buf);
}

/* wasmGrow(id, pages) -> the previous size in pages, or -1 when it cannot grow. */
static JSValue fg_wasm_grow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, delta = 0;
    fg_winst *inst;
    uint32_t before, want;

    if (JS_ToInt32(ctx, &id, argv[0]) || JS_ToInt32(ctx, &delta, argv[1])) {
        return JS_EXCEPTION;
    }
    inst = fg_winst_get(ctx, id);
    if (!inst) {
        return JS_EXCEPTION;
    }
    before = inst->rt->memory.numPages;
    want = before + (uint32_t) delta;
    if (delta < 0 || want < before || want > 65536 || (inst->rt->memory.maxPages && want > inst->rt->memory.maxPages)) {
        return JS_NewInt32(ctx, -1);
    }
    if (delta == 0) {
        return JS_NewInt32(ctx, (int32_t) before);
    }
    if (ResizeMemory(inst->rt, want)) {
        return JS_NewInt32(ctx, -1);
    }
    return JS_NewInt32(ctx, (int32_t) before);
}

/* wasmGlobal(id, name[, value]) -> the global's value; with a value, sets it. */
static JSValue fg_wasm_global(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    fg_winst *inst;
    const char *name;
    IM3Global g;
    M3TaggedValue tv;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    inst = fg_winst_get(ctx, id);
    if (!inst) {
        return JS_EXCEPTION;
    }
    name = JS_ToCString(ctx, argv[1]);
    if (!name) {
        return JS_EXCEPTION;
    }
    g = m3_FindGlobal(inst->mod, name);
    JS_FreeCString(ctx, name);
    if (!g) {
        return JS_ThrowReferenceError(ctx, "no such WebAssembly global");
    }
    if (argc > 2) {
        double d = 0;
        int64_t i64 = 0;
        memset(&tv, 0, sizeof(tv));
        tv.type = m3_GetGlobalType(g);
        switch (tv.type) {
        case c_m3Type_i32:
            JS_ToInt32(ctx, &tv.value.i32, argv[2]);
            break;
        case c_m3Type_i64:
            JS_ToBigInt64(ctx, &i64, argv[2]);
            tv.value.i64 = i64;
            break;
        case c_m3Type_f32:
            JS_ToFloat64(ctx, &d, argv[2]);
            tv.value.f32 = (float) d;
            break;
        default:
            JS_ToFloat64(ctx, &tv.value.f64, argv[2]);
            break;
        }
        if (m3_SetGlobal(g, &tv)) {
            return JS_ThrowTypeError(ctx, "Cannot set the value of an immutable WebAssembly.Global");
        }
        return JS_UNDEFINED;
    }
    if (m3_GetGlobal(g, &tv)) {
        return JS_ThrowInternalError(ctx, "cannot read the WebAssembly global");
    }
    switch (tv.type) {
    case c_m3Type_i32: return JS_NewInt32(ctx, tv.value.i32);
    case c_m3Type_i64: return JS_NewBigInt64(ctx, tv.value.i64);
    case c_m3Type_f32: return JS_NewFloat64(ctx, (double) tv.value.f32);
    default: return JS_NewFloat64(ctx, tv.value.f64);
    }
}

static JSValue fg_wasm_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    if (id >= 0 && id < FG_MAX_WASM) {
        fg_winst_release(&fg_winsts[id]);
    }
    return JS_UNDEFINED;
}

const JSCFunctionListEntry forgegraal_wasm_funcs[] = {
    JS_CFUNC_DEF("wasmInstantiate", 3, fg_wasm_instantiate),
    JS_CFUNC_DEF("wasmFind", 2, fg_wasm_find),
    JS_CFUNC_DEF("wasmCall", 3, fg_wasm_call),
    JS_CFUNC_DEF("wasmMemory", 1, fg_wasm_memory),
    JS_CFUNC_DEF("wasmGrow", 2, fg_wasm_grow),
    JS_CFUNC_DEF("wasmGlobal", 3, fg_wasm_global),
    JS_CFUNC_DEF("wasmFree", 1, fg_wasm_free),
};
const size_t forgegraal_wasm_funcs_count = sizeof(forgegraal_wasm_funcs) / sizeof(forgegraal_wasm_funcs[0]);
