/*
 * Foreign function calls for the native host, on libffi (MIT licensed), which knows the calling convention of
 * every architecture this host is built for (x86, x86-64 and, when built for it, ARM, on Windows and on Linux).
 *
 * This is the engine half of `Deno.dlopen`: load a shared library, look up a symbol, call it with values
 * described by type names, hand it a JavaScript function as a C callback, and read and write raw memory at an
 * address. quickjs/runtime/deno-ffi.js builds Deno's API (UnsafePointer, UnsafePointerView, UnsafeCallback,
 * UnsafeFnPointer) on it.
 *
 * Addresses are bigints. Nothing here is checked against what the callee will do with them: FFI is the one place a
 * program can crash the process, as it can in any runtime that has it, and Deno's own name for the API says so.
 * What is checked is what the host can know: a type name it does not recognise, an argument that does not fit its
 * declared type, a library that will not load, a symbol that is not there.
 *
 * Callbacks run on the JavaScript thread only. A library that calls one from another thread gets zero back and a
 * message on stderr, because entering the engine from a second thread would corrupt it.
 */

#include "quickjs.h"

#include <ffi.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#include <pthread.h>
#endif

#define FG_MAX_LIBS 64
#define FG_MAX_ARGS 32
#define FG_MAX_CALLBACKS 1024
#define FG_MAX_FIELDS 32

#ifdef _WIN32
static HMODULE fg_libs[FG_MAX_LIBS];
static DWORD fg_js_thread;
#else
static void *fg_libs[FG_MAX_LIBS];
static pthread_t fg_js_thread;
static int fg_js_thread_set;
#endif

typedef enum { T_VOID, T_BOOL, T_U8, T_I8, T_U16, T_I16, T_U32, T_I32, T_U64, T_I64, T_F32, T_F64, T_PTR, T_BUF, T_STRUCT } fg_kind;

typedef struct {
    fg_kind kind;
    ffi_type *type;
    ffi_type *fields[FG_MAX_FIELDS + 1]; /* a struct's own element list */
    ffi_type self;                       /* a struct's type */
    fg_kind field_kinds[FG_MAX_FIELDS];
    size_t field_offsets[FG_MAX_FIELDS];
    int nfields;
    size_t size;
} fg_type;

typedef union {
    uint8_t u8;
    int8_t i8;
    uint16_t u16;
    int16_t i16;
    uint32_t u32;
    int32_t i32;
    uint64_t u64;
    int64_t i64;
    float f32;
    double f64;
    void *ptr;
} fg_value;

typedef struct {
    int in_use;
    JSContext *ctx;
    JSValue fn;
    ffi_cif cif;
    ffi_closure *closure;
    void *code;
    fg_type ret;
    fg_type args[FG_MAX_ARGS];
    ffi_type *arg_types[FG_MAX_ARGS];
    int nargs;
} fg_callback;

static fg_callback fg_callbacks[FG_MAX_CALLBACKS];

static void fg_ffi_mark_thread(void)
{
#ifdef _WIN32
    fg_js_thread = GetCurrentThreadId();
#else
    if (!fg_js_thread_set) {
        fg_js_thread = pthread_self();
        fg_js_thread_set = 1;
    }
#endif
}

static int fg_on_js_thread(void)
{
#ifdef _WIN32
    return GetCurrentThreadId() == fg_js_thread;
#else
    return pthread_equal(pthread_self(), fg_js_thread);
#endif
}

/* ---------------------------------------------------------------- types */

static int fg_scalar_type(const char *name, fg_type *out)
{
    static const struct {
        const char *name;
        fg_kind kind;
        ffi_type *type;
    } table[] = {
        {"void", T_VOID, &ffi_type_void},
        {"bool", T_BOOL, &ffi_type_uint8},
        {"u8", T_U8, &ffi_type_uint8},
        {"i8", T_I8, &ffi_type_sint8},
        {"u16", T_U16, &ffi_type_uint16},
        {"i16", T_I16, &ffi_type_sint16},
        {"u32", T_U32, &ffi_type_uint32},
        {"i32", T_I32, &ffi_type_sint32},
        {"u64", T_U64, &ffi_type_uint64},
        {"i64", T_I64, &ffi_type_sint64},
        {"usize", T_U64, NULL},
        {"isize", T_I64, NULL},
        {"f32", T_F32, &ffi_type_float},
        {"f64", T_F64, &ffi_type_double},
        {"pointer", T_PTR, &ffi_type_pointer},
        {"buffer", T_BUF, &ffi_type_pointer},
        {"function", T_PTR, &ffi_type_pointer},
    };
    for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        if (!strcmp(name, table[i].name)) {
            out->kind = table[i].kind;
            out->type = table[i].type;
            if (!out->type) { /* usize / isize follow the pointer width */
                out->type = table[i].kind == T_U64 ? (sizeof(void *) == 8 ? &ffi_type_uint64 : &ffi_type_uint32)
                                                   : (sizeof(void *) == 8 ? &ffi_type_sint64 : &ffi_type_sint32);
                out->kind = sizeof(void *) == 8 ? table[i].kind : (table[i].kind == T_U64 ? T_U32 : T_I32);
            }
            out->size = out->type->size;
            return 0;
        }
    }
    return -1;
}

/* A type is a name ("i32"), or an array of names for a struct passed or returned by value. */
static int fg_parse_type(JSContext *ctx, JSValueConst v, fg_type *out)
{
    memset(out, 0, sizeof(*out));
    if (JS_IsString(v)) {
        const char *name = JS_ToCString(ctx, v);
        int rc;
        if (!name) {
            return -1;
        }
        rc = fg_scalar_type(name, out);
        if (rc != 0) {
            JS_ThrowTypeError(ctx, "unknown FFI type '%s'", name);
        }
        JS_FreeCString(ctx, name);
        return rc;
    }
    if (JS_IsArray(v)) {
        JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
        uint32_t n = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);
        if (n == 0 || n > FG_MAX_FIELDS) {
            JS_ThrowTypeError(ctx, "a struct needs between 1 and %d fields", FG_MAX_FIELDS);
            return -1;
        }
        out->kind = T_STRUCT;
        out->nfields = (int) n;
        for (uint32_t i = 0; i < n; i++) {
            JSValue f = JS_GetPropertyUint32(ctx, v, i);
            fg_type field;
            int rc = fg_parse_type(ctx, f, &field);
            JS_FreeValue(ctx, f);
            if (rc != 0) {
                return -1;
            }
            if (field.kind == T_STRUCT || field.kind == T_VOID) {
                JS_ThrowTypeError(ctx, "a struct field must be a scalar type");
                return -1;
            }
            out->fields[i] = field.type;
            out->field_kinds[i] = field.kind;
        }
        out->fields[n] = NULL;
        out->self.size = 0;
        out->self.alignment = 0;
        out->self.type = FFI_TYPE_STRUCT;
        out->self.elements = out->fields;
        out->type = &out->self;
        {
            /* Let libffi compute the layout, then read the offsets back. */
            size_t offsets[FG_MAX_FIELDS];
            ffi_cif probe;
            if (ffi_prep_cif(&probe, FFI_DEFAULT_ABI, 0, out->type, NULL) != FFI_OK ||
                ffi_get_struct_offsets(FFI_DEFAULT_ABI, out->type, offsets) != FFI_OK) {
                JS_ThrowInternalError(ctx, "libffi could not lay out the struct");
                return -1;
            }
            for (uint32_t i = 0; i < n; i++) {
                out->field_offsets[i] = offsets[i];
            }
        }
        out->size = out->self.size;
        return 0;
    }
    JS_ThrowTypeError(ctx, "an FFI type is a name or an array of names");
    return -1;
}

/* ---------------------------------------------------------------- values */

static int fg_to_pointer(JSContext *ctx, JSValueConst v, void **out)
{
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        *out = NULL;
        return 0;
    }
    if (JS_IsBigInt(v)) {
        uint64_t x;
        if (JS_ToBigUint64(ctx, &x, v)) {
            return -1;
        }
        *out = (void *) (uintptr_t) x;
        return 0;
    }
    if (JS_IsNumber(v)) {
        double d;
        JS_ToFloat64(ctx, &d, v);
        *out = (void *) (uintptr_t) (uint64_t) d;
        return 0;
    }
    JS_ThrowTypeError(ctx, "a pointer is a bigint or null");
    return -1;
}

/* The bytes of a TypedArray or ArrayBuffer, as a pointer. */
static uint8_t *fg_buffer_pointer(JSContext *ctx, JSValueConst v, size_t *len)
{
    size_t offset, size, elem, total;
    JSValue buffer = JS_GetTypedArrayBuffer(ctx, v, &offset, &size, &elem);
    uint8_t *data;

    if (JS_IsException(buffer)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        data = JS_GetArrayBuffer(ctx, &total, v);
        if (len) *len = total;
        return data;
    }
    data = JS_GetArrayBuffer(ctx, &total, buffer);
    JS_FreeValue(ctx, buffer);
    if (len) *len = size;
    return data ? data + offset : NULL;
}

static int fg_store(JSContext *ctx, const fg_type *t, JSValueConst v, fg_value *slot, void **ptr_slot, uint8_t **struct_data)
{
    int64_t i;
    uint64_t u;
    double d;

    switch (t->kind) {
    case T_BOOL:
        slot->u8 = (uint8_t) (JS_ToBool(ctx, v) ? 1 : 0);
        return 0;
    case T_U8: case T_I8: case T_U16: case T_I16: case T_U32: case T_I32:
        if (JS_IsBigInt(v)) {
            if (JS_ToBigInt64(ctx, &i, v)) return -1;
        } else if (JS_ToInt64(ctx, &i, v)) {
            return -1;
        }
        switch (t->kind) {
        case T_U8: slot->u8 = (uint8_t) i; break;
        case T_I8: slot->i8 = (int8_t) i; break;
        case T_U16: slot->u16 = (uint16_t) i; break;
        case T_I16: slot->i16 = (int16_t) i; break;
        case T_U32: slot->u32 = (uint32_t) i; break;
        default: slot->i32 = (int32_t) i;
        }
        return 0;
    case T_U64:
        if (JS_IsBigInt(v)) {
            if (JS_ToBigUint64(ctx, &u, v)) return -1;
        } else {
            if (JS_ToFloat64(ctx, &d, v)) return -1;
            u = (uint64_t) d;
        }
        slot->u64 = u;
        return 0;
    case T_I64:
        if (JS_IsBigInt(v)) {
            if (JS_ToBigInt64(ctx, &i, v)) return -1;
        } else {
            if (JS_ToFloat64(ctx, &d, v)) return -1;
            i = (int64_t) d;
        }
        slot->i64 = i;
        return 0;
    case T_F32:
        if (JS_ToFloat64(ctx, &d, v)) return -1;
        slot->f32 = (float) d;
        return 0;
    case T_F64:
        if (JS_ToFloat64(ctx, &d, v)) return -1;
        slot->f64 = d;
        return 0;
    case T_PTR:
        if (fg_to_pointer(ctx, v, &slot->ptr)) return -1;
        return 0;
    case T_BUF: {
        size_t len;
        if (JS_IsNull(v) || JS_IsUndefined(v)) {
            slot->ptr = NULL;
            return 0;
        }
        slot->ptr = fg_buffer_pointer(ctx, v, &len);
        if (!slot->ptr && len != 0) {
            JS_ThrowTypeError(ctx, "a buffer argument is a TypedArray or an ArrayBuffer");
            return -1;
        }
        return 0;
    }
    case T_STRUCT: {
        size_t len;
        uint8_t *data = fg_buffer_pointer(ctx, v, &len);
        if (!data || len < t->size) {
            JS_ThrowTypeError(ctx, "a struct argument needs a TypedArray of at least %d bytes", (int) t->size);
            return -1;
        }
        *struct_data = data;
        return 0;
    }
    default:
        return 0;
    }
}

static JSValue fg_load(JSContext *ctx, const fg_type *t, const void *raw)
{
    const fg_value *v = raw;
    switch (t->kind) {
    case T_VOID: return JS_UNDEFINED;
    case T_BOOL: return JS_NewBool(ctx, v->u8 != 0);
    case T_U8: return JS_NewInt32(ctx, v->u8);
    case T_I8: return JS_NewInt32(ctx, v->i8);
    case T_U16: return JS_NewInt32(ctx, v->u16);
    case T_I16: return JS_NewInt32(ctx, v->i16);
    case T_U32: return JS_NewUint32(ctx, v->u32);
    case T_I32: return JS_NewInt32(ctx, v->i32);
    case T_U64: return JS_NewBigUint64(ctx, v->u64);
    case T_I64: return JS_NewBigInt64(ctx, v->i64);
    case T_F32: return JS_NewFloat64(ctx, (double) v->f32);
    case T_F64: return JS_NewFloat64(ctx, v->f64);
    case T_PTR: case T_BUF:
        return v->ptr ? JS_NewBigUint64(ctx, (uint64_t) (uintptr_t) v->ptr) : JS_NULL;
    default: return JS_UNDEFINED;
    }
}

static JSValue fg_new_uint8array(JSContext *ctx, const void *data, size_t size)
{
    JSValue buf = JS_NewArrayBufferCopy(ctx, data, size);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
    JSValue arr = JS_CallConstructor(ctx, ctor, 1, (JSValueConst[]) {buf});
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, buf);
    return arr;
}

/* ---------------------------------------------------------------- libraries and symbols */

/* ffiOpen(path | null) -> library id. null is the running program itself and what it links. */
static JSValue fg_ffi_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *path = NULL;
    int id;
#ifdef _WIN32
    HMODULE h;
#else
    void *h;
#endif

    fg_ffi_mark_thread();
#ifdef FG_NO_DLOPEN
    return JS_ThrowInternalError(ctx, "this is a statically linked host, which has no dynamic loader to load a library with; "
                                      "build for a dynamically linked host (--native-libc glibc or musl-dynamic)");
#endif
    if (argc > 0 && JS_IsString(argv[0])) {
        path = JS_ToCString(ctx, argv[0]);
        if (!path) {
            return JS_EXCEPTION;
        }
    }
    for (id = 0; id < FG_MAX_LIBS; id++) {
        if (!fg_libs[id]) {
            break;
        }
    }
    if (id == FG_MAX_LIBS) {
        if (path) JS_FreeCString(ctx, path);
        return JS_ThrowInternalError(ctx, "too many open libraries (limit is %d)", FG_MAX_LIBS);
    }
#ifdef _WIN32
    h = path ? LoadLibraryA(path) : GetModuleHandleA(NULL);
    if (!h) {
        JSValue err = JS_ThrowInternalError(ctx, "could not load '%s' (Windows error %lu)", path ? path : "(self)", GetLastError());
        if (path) JS_FreeCString(ctx, path);
        return err;
    }
#else
    h = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
    if (!h) {
        JSValue err = JS_ThrowInternalError(ctx, "%s", dlerror());
        if (path) JS_FreeCString(ctx, path);
        return err;
    }
#endif
    if (path) JS_FreeCString(ctx, path);
    fg_libs[id] = h;
    return JS_NewInt32(ctx, id);
}

static JSValue fg_ffi_symbol(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    const char *name;
    void *addr;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    if (id < 0 || id >= FG_MAX_LIBS || !fg_libs[id]) {
        return JS_ThrowInternalError(ctx, "library is not open");
    }
    name = JS_ToCString(ctx, argv[1]);
    if (!name) {
        return JS_EXCEPTION;
    }
#ifdef _WIN32
    addr = (void *) GetProcAddress(fg_libs[id], name);
#else
    addr = dlsym(fg_libs[id], name);
#endif
    if (!addr) {
        JSValue err = JS_ThrowReferenceError(ctx, "symbol '%s' was not found in the library", name);
        JS_FreeCString(ctx, name);
        return err;
    }
    JS_FreeCString(ctx, name);
    return JS_NewBigUint64(ctx, (uint64_t) (uintptr_t) addr);
}

static JSValue fg_ffi_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    if (id >= 0 && id < FG_MAX_LIBS && fg_libs[id]) {
#ifdef _WIN32
        FreeLibrary(fg_libs[id]);
#else
        dlclose(fg_libs[id]);
#endif
        fg_libs[id] = NULL;
    }
    return JS_UNDEFINED;
}

/* ---------------------------------------------------------------- calls */

/* ffiCall(address, parameterTypes, resultType, args) -> the result as a JavaScript value. */
static JSValue fg_ffi_call(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    void *fn;
    uint32_t nargs = 0;
    fg_type params[FG_MAX_ARGS], ret;
    ffi_type *atypes[FG_MAX_ARGS];
    void *avalues[FG_MAX_ARGS];
    fg_value slots[FG_MAX_ARGS];
    void *ptr_slots[FG_MAX_ARGS];
    uint8_t *struct_data[FG_MAX_ARGS];
    ffi_cif cif;
    JSValue lenv;
    uint8_t *result_struct = NULL;
    fg_value result;
    JSValue out;

    fg_ffi_mark_thread();
    if (fg_to_pointer(ctx, argv[0], &fn)) {
        return JS_EXCEPTION;
    }
    if (!fn) {
        return JS_ThrowTypeError(ctx, "cannot call a null function pointer");
    }
    lenv = JS_GetPropertyStr(ctx, argv[1], "length");
    JS_ToUint32(ctx, &nargs, lenv);
    JS_FreeValue(ctx, lenv);
    if (nargs > FG_MAX_ARGS) {
        return JS_ThrowRangeError(ctx, "too many arguments (limit is %d)", FG_MAX_ARGS);
    }
    for (uint32_t i = 0; i < nargs; i++) {
        JSValue t = JS_GetPropertyUint32(ctx, argv[1], i);
        int rc = fg_parse_type(ctx, t, &params[i]);
        JS_FreeValue(ctx, t);
        if (rc != 0) {
            return JS_EXCEPTION;
        }
        if (params[i].kind == T_VOID) {
            return JS_ThrowTypeError(ctx, "a parameter cannot be void");
        }
        atypes[i] = params[i].type;
    }
    if (fg_parse_type(ctx, argv[2], &ret) != 0) {
        return JS_EXCEPTION;
    }
    /* Argument values follow the declared types, not what JavaScript happened to pass. */
    for (uint32_t i = 0; i < nargs; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[3], i);
        struct_data[i] = NULL;
        memset(&slots[i], 0, sizeof(slots[i]));
        if (fg_store(ctx, &params[i], v, &slots[i], &ptr_slots[i], &struct_data[i]) != 0) {
            JS_FreeValue(ctx, v);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, v);
        avalues[i] = params[i].kind == T_STRUCT ? (void *) struct_data[i] : (void *) &slots[i];
    }
    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, nargs, ret.type, atypes) != FFI_OK) {
        return JS_ThrowInternalError(ctx, "libffi could not prepare the call");
    }
    if (ret.kind == T_STRUCT) {
        result_struct = calloc(1, ret.size > 0 ? ret.size : 1);
        if (!result_struct) {
            return JS_ThrowOutOfMemory(ctx);
        }
        ffi_call(&cif, FFI_FN(fn), result_struct, avalues);
        out = fg_new_uint8array(ctx, result_struct, ret.size);
        free(result_struct);
        return out;
    }
    memset(&result, 0, sizeof(result));
    /* libffi widens a small integer result to a full register: read it through a register-sized slot. */
    {
        ffi_arg wide = 0;
        void *dst = ret.kind == T_VOID ? NULL : (ret.type->size < sizeof(ffi_arg) && ret.kind != T_F32 && ret.kind != T_F64 ? (void *) &wide : (void *) &result);
        ffi_call(&cif, FFI_FN(fn), dst, avalues);
        if (dst == (void *) &wide) {
            switch (ret.kind) {
            case T_BOOL: case T_U8: result.u8 = (uint8_t) wide; break;
            case T_I8: result.i8 = (int8_t) wide; break;
            case T_U16: result.u16 = (uint16_t) wide; break;
            case T_I16: result.i16 = (int16_t) wide; break;
            case T_U32: result.u32 = (uint32_t) wide; break;
            default: result.i32 = (int32_t) wide;
            }
        }
    }
    return fg_load(ctx, &ret, &result);
}

/* ---------------------------------------------------------------- callbacks */

static void fg_closure_entry(ffi_cif *cif, void *ret, void **args, void *user)
{
    fg_callback *cb = user;
    JSContext *ctx = cb->ctx;
    JSValue argv[FG_MAX_ARGS];
    JSValue result;

    if (!fg_on_js_thread()) {
        fprintf(stderr, "graak: an FFI callback was called from a thread other than the JavaScript thread, which is not supported\n");
        memset(ret, 0, cif->rtype->size < sizeof(ffi_arg) ? sizeof(ffi_arg) : cif->rtype->size);
        return;
    }
    for (int i = 0; i < cb->nargs; i++) {
        if (cb->args[i].kind == T_STRUCT) {
            argv[i] = fg_new_uint8array(ctx, args[i], cb->args[i].size);
        } else {
            argv[i] = fg_load(ctx, &cb->args[i], args[i]);
        }
    }
    result = JS_Call(ctx, cb->fn, JS_UNDEFINED, cb->nargs, argv);
    for (int i = 0; i < cb->nargs; i++) {
        JS_FreeValue(ctx, argv[i]);
    }
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, error);
        fprintf(stderr, "graak: uncaught exception in an FFI callback: %s\n", text ? text : "(unprintable)");
        if (text) JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, error);
        memset(ret, 0, cif->rtype->size < sizeof(ffi_arg) ? sizeof(ffi_arg) : cif->rtype->size);
        return;
    }
    if (cb->ret.kind != T_VOID) {
        fg_value slot;
        uint8_t *sdata = NULL;
        void *pslot = NULL;
        memset(&slot, 0, sizeof(slot));
        if (fg_store(ctx, &cb->ret, result, &slot, &pslot, &sdata) != 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        } else if (cb->ret.kind == T_STRUCT) {
            if (sdata) memcpy(ret, sdata, cb->ret.size);
        } else if (cb->ret.type->size < sizeof(ffi_arg) && cb->ret.kind != T_F32) {
            ffi_arg wide;
            switch (cb->ret.kind) {
            case T_BOOL: case T_U8: wide = slot.u8; break;
            case T_I8: wide = (ffi_arg) (ffi_sarg) slot.i8; break;
            case T_U16: wide = slot.u16; break;
            case T_I16: wide = (ffi_arg) (ffi_sarg) slot.i16; break;
            case T_U32: wide = slot.u32; break;
            default: wide = (ffi_arg) (ffi_sarg) slot.i32;
            }
            *(ffi_arg *) ret = wide;
        } else {
            memcpy(ret, &slot, cb->ret.type->size);
        }
    }
    JS_FreeValue(ctx, result);
}

/* ffiCallback(resultType, parameterTypes, function) -> address of a C function that calls `function`. */
static JSValue fg_ffi_callback(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int id;
    uint32_t nargs = 0;
    fg_callback *cb;
    JSValue lenv;

    fg_ffi_mark_thread();
    if (!JS_IsFunction(ctx, argv[2])) {
        return JS_ThrowTypeError(ctx, "a callback needs a function");
    }
    for (id = 0; id < FG_MAX_CALLBACKS; id++) {
        if (!fg_callbacks[id].in_use) {
            break;
        }
    }
    if (id == FG_MAX_CALLBACKS) {
        return JS_ThrowInternalError(ctx, "too many callbacks (limit is %d)", FG_MAX_CALLBACKS);
    }
    cb = &fg_callbacks[id];
    memset(cb, 0, sizeof(*cb));
    lenv = JS_GetPropertyStr(ctx, argv[1], "length");
    JS_ToUint32(ctx, &nargs, lenv);
    JS_FreeValue(ctx, lenv);
    if (nargs > FG_MAX_ARGS) {
        return JS_ThrowRangeError(ctx, "too many parameters (limit is %d)", FG_MAX_ARGS);
    }
    if (fg_parse_type(ctx, argv[0], &cb->ret) != 0) {
        return JS_EXCEPTION;
    }
    if (cb->ret.kind == T_STRUCT) {
        cb->ret.type = &cb->ret.self;
        cb->ret.self.elements = cb->ret.fields;
    }
    for (uint32_t i = 0; i < nargs; i++) {
        JSValue t = JS_GetPropertyUint32(ctx, argv[1], i);
        int rc = fg_parse_type(ctx, t, &cb->args[i]);
        JS_FreeValue(ctx, t);
        if (rc != 0) {
            return JS_EXCEPTION;
        }
        if (cb->args[i].kind == T_STRUCT) {
            cb->args[i].self.elements = cb->args[i].fields;
            cb->args[i].type = &cb->args[i].self;
        }
        cb->arg_types[i] = cb->args[i].type;
    }
    cb->nargs = (int) nargs;
    cb->closure = ffi_closure_alloc(sizeof(ffi_closure), &cb->code);
    if (!cb->closure) {
        return JS_ThrowInternalError(ctx, "could not allocate executable memory for the callback");
    }
    if (ffi_prep_cif(&cb->cif, FFI_DEFAULT_ABI, nargs, cb->ret.type, cb->arg_types) != FFI_OK ||
        ffi_prep_closure_loc(cb->closure, &cb->cif, fg_closure_entry, cb, cb->code) != FFI_OK) {
        ffi_closure_free(cb->closure);
        return JS_ThrowInternalError(ctx, "libffi could not prepare the callback");
    }
    cb->ctx = ctx;
    cb->fn = JS_DupValue(ctx, argv[2]);
    cb->in_use = 1;
    return JS_NewBigUint64(ctx, (uint64_t) (uintptr_t) cb->code);
}

static JSValue fg_ffi_callback_free(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    void *addr;

    if (fg_to_pointer(ctx, argv[0], &addr)) {
        return JS_EXCEPTION;
    }
    for (int i = 0; i < FG_MAX_CALLBACKS; i++) {
        if (fg_callbacks[i].in_use && fg_callbacks[i].code == addr) {
            ffi_closure_free(fg_callbacks[i].closure);
            JS_FreeValue(ctx, fg_callbacks[i].fn);
            memset(&fg_callbacks[i], 0, sizeof(fg_callbacks[i]));
            return JS_TRUE;
        }
    }
    return JS_FALSE;
}

/* ---------------------------------------------------------------- memory */

/* ffiPeek(address, length) -> a copy of length bytes at address, as an ArrayBuffer. */
static JSValue fg_ffi_peek(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    void *addr;
    int64_t len;

    if (fg_to_pointer(ctx, argv[0], &addr) || JS_ToInt64(ctx, &len, argv[1])) {
        return JS_EXCEPTION;
    }
    if (!addr) {
        return JS_ThrowTypeError(ctx, "cannot read from a null pointer");
    }
    if (len < 0) {
        return JS_ThrowRangeError(ctx, "the length cannot be negative");
    }
    return JS_NewArrayBufferCopy(ctx, (const uint8_t *) addr, (size_t) len);
}

static JSValue fg_ffi_poke(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    void *addr;
    size_t len;
    uint8_t *data;

    if (fg_to_pointer(ctx, argv[0], &addr)) {
        return JS_EXCEPTION;
    }
    if (!addr) {
        return JS_ThrowTypeError(ctx, "cannot write to a null pointer");
    }
    data = fg_buffer_pointer(ctx, argv[1], &len);
    if (!data && len) {
        return JS_ThrowTypeError(ctx, "the value to write is a TypedArray or an ArrayBuffer");
    }
    memcpy(addr, data, len);
    return JS_UNDEFINED;
}

/* ffiAddressOf(TypedArray | ArrayBuffer) -> the address of its first byte (valid while the buffer lives). */
static JSValue fg_ffi_address_of(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t len;
    uint8_t *data = fg_buffer_pointer(ctx, argv[0], &len);

    if (!data) {
        return len == 0 ? JS_NULL : JS_ThrowTypeError(ctx, "expected a TypedArray or an ArrayBuffer");
    }
    return JS_NewBigUint64(ctx, (uint64_t) (uintptr_t) data);
}

/* ffiCString(address) -> the NUL-terminated string there, as a JavaScript string (UTF-8). */
static JSValue fg_ffi_cstring(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    void *addr;

    if (fg_to_pointer(ctx, argv[0], &addr)) {
        return JS_EXCEPTION;
    }
    if (!addr) {
        return JS_ThrowTypeError(ctx, "cannot read from a null pointer");
    }
    return JS_NewString(ctx, (const char *) addr);
}

const JSCFunctionListEntry graak_ffi_funcs[] = {
    JS_CFUNC_DEF("ffiOpen", 1, fg_ffi_open),
    JS_CFUNC_DEF("ffiSymbol", 2, fg_ffi_symbol),
    JS_CFUNC_DEF("ffiClose", 1, fg_ffi_close),
    JS_CFUNC_DEF("ffiCall", 4, fg_ffi_call),
    JS_CFUNC_DEF("ffiCallback", 3, fg_ffi_callback),
    JS_CFUNC_DEF("ffiCallbackFree", 1, fg_ffi_callback_free),
    JS_CFUNC_DEF("ffiPeek", 2, fg_ffi_peek),
    JS_CFUNC_DEF("ffiPoke", 2, fg_ffi_poke),
    JS_CFUNC_DEF("ffiAddressOf", 1, fg_ffi_address_of),
    JS_CFUNC_DEF("ffiCString", 1, fg_ffi_cstring),
};
const size_t graak_ffi_funcs_count = sizeof(graak_ffi_funcs) / sizeof(graak_ffi_funcs[0]);
