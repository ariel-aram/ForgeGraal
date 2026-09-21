/*
 * Node-API (N-API) for the Graak native host.
 *
 * quickjs-ng has no notion of a native addon, but a `.node` file is only a shared library that
 * imports `napi_*` functions from whatever process loads it and registers itself through one of
 * two entry points. Nothing about that contract needs Node.js: this file exports the same
 * functions from the Graak executable, on top of the QuickJS C API, and loads the library
 * with dlopen / LoadLibrary. Addons built on Node-API (lmdb, @napi-rs/canvas, sharp, bcrypt,
 * argon2, sodium-native, bufferutil, ...) then run unmodified, on the architecture they were built
 * for, exactly as they would under Node.js.
 *
 * What this cannot load: addons written directly against V8 or through NAN (better-sqlite3 is the
 * well-known one). They import `v8::` symbols, which have no meaning outside V8, and are reported as
 * such instead of failing with a linker error.
 *
 * Model
 *   napi_value   a pointer to a slot in one handle arena. Slots hold owned JSValues and are released
 *                when the native call that created them returns, or when a handle scope closes.
 *   napi_env     one per loaded addon. Holds the pending exception, the last error and instance data.
 *   finalizers   never run from inside the engine's GC: they are queued and run at the next safe
 *                point (end of a native call, or the event-loop pump), so a finalizer can call back
 *                into napi_* the way addons expect.
 *   async work / thread-safe functions
 *                execute on real OS threads; anything that touches JavaScript is posted back to the
 *                main thread and delivered by `drain()`, which the JS side calls from a timer while
 *                any work is outstanding (see napiInit in node-compat.js).
 */

#include "quickjs-libc.h"
#include "quickjs.h"

#define NAPI_EXPERIMENTAL
#include "node_api.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef FG_NO_DLOPEN
#include <dlfcn.h>
#endif
/* libuv's public types: an addon that talks to libuv directly lays its requests out by these headers. */
#include <uv.h>
#endif

/* ---- platform ---------------------------------------------------------------------------- */

#ifdef _WIN32
typedef CRITICAL_SECTION fg_mutex;
static void fg_mutex_init(fg_mutex *m) { InitializeCriticalSection(m); }
static void fg_mutex_lock(fg_mutex *m) { EnterCriticalSection(m); }
static void fg_mutex_unlock(fg_mutex *m) { LeaveCriticalSection(m); }

typedef struct { void (*fn)(void *); void *arg; } fg_thread_pack;
static DWORD WINAPI fg_thread_main(LPVOID p)
{
    fg_thread_pack pack = *(fg_thread_pack *) p;
    free(p);
    pack.fn(pack.arg);
    return 0;
}
static int fg_thread_start(void (*fn)(void *), void *arg)
{
    fg_thread_pack *pack = malloc(sizeof(*pack));
    HANDLE h;
    if (!pack) return -1;
    pack->fn = fn;
    pack->arg = arg;
    h = CreateThread(NULL, 0, fg_thread_main, pack, 0, NULL);
    if (!h) { free(pack); return -1; }
    CloseHandle(h);
    return 0;
}
#else
typedef pthread_mutex_t fg_mutex;
static void fg_mutex_init(fg_mutex *m) { pthread_mutex_init(m, NULL); }
static void fg_mutex_lock(fg_mutex *m) { pthread_mutex_lock(m); }
static void fg_mutex_unlock(fg_mutex *m) { pthread_mutex_unlock(m); }

typedef struct { void (*fn)(void *); void *arg; } fg_thread_pack;
static void *fg_thread_main(void *p)
{
    fg_thread_pack pack = *(fg_thread_pack *) p;
    free(p);
    pack.fn(pack.arg);
    return NULL;
}
static int fg_thread_start(void (*fn)(void *), void *arg)
{
    pthread_t t;
    fg_thread_pack *pack = malloc(sizeof(*pack));
    if (!pack) return -1;
    pack->fn = fn;
    pack->arg = arg;
    if (pthread_create(&t, NULL, fg_thread_main, pack) != 0) { free(pack); return -1; }
    pthread_detach(t);
    return 0;
}
#endif

/* ---- state ------------------------------------------------------------------------------- */

#define CHUNK 512
#define MAX_CHUNKS 4096

struct napi_env__ {
    JSContext *ctx;
    napi_extended_error_info err;
    JSValue pending;
    int has_pending;
    void *instance_data;
    napi_finalize instance_fin;
    void *instance_hint;
    int32_t api_version;
    char *filename;
};

typedef struct fg_holder {
    napi_env env;
    void *data;
    void *fn;      /* napi_callback for functions, napi_finalize for everything else */
    void *hint;
    uint64_t tag[2];
    int has_tag;
} fg_holder;

typedef struct fg_cbinfo {
    JSValueConst this_val;
    JSValueConst new_target;
    int argc;
    JSValueConst *argv;
    void *data;
} fg_cbinfo;

typedef struct fg_scope { size_t mark; size_t slot; int escapable; int escaped; } fg_scope;

struct napi_ref__ {
    napi_env env;
    JSValue strong;
    JSValue weak;
    uint32_t count;
    int primitive;
};

typedef struct fg_deferred { JSValue resolve, reject; } fg_deferred;

typedef struct fg_fin {
    struct fg_fin *next;
    napi_env env;
    napi_finalize cb;
    void *data;
    void *hint;
} fg_fin;

typedef struct fg_task {
    struct fg_task *next;
    int kind; /* 0 async-work complete, 1 tsf call, 2 tsf close, 3 libuv work complete, 4 libuv fs complete */
    void *target;
    void *data;
} fg_task;

struct napi_async_work__ {
    napi_env env;
    napi_async_execute_callback execute;
    napi_async_complete_callback complete;
    void *data;
    int status; /* 0 idle, 1 queued/running, 2 finished, 3 cancelled */
};

struct napi_threadsafe_function__ {
    napi_env env;
    JSValue func;
    void *context;
    napi_threadsafe_function_call_js call_js;
    napi_finalize fin;
    void *fin_data;
    size_t max_queue;
    size_t queued;
    size_t threads;
    int closing;
    int refd;
    int finalized;
};

typedef struct fg_hook { struct fg_hook *next; napi_cleanup_hook fun; void *arg; } fg_hook;

static JSContext *g_ctx;
static JSRuntime *g_rt;
static JSClassID cls_fn, cls_ext, cls_holder;
static int g_ready;
static int g_shutdown;

static JSValue *g_chunks[MAX_CHUNKS];
static size_t g_top;

static JSValue g_prelude;
static JSValue g_class_factory;
static JSValue g_buffer;
static JSValue g_pump_start;
static JSValue g_pump_stop;
static size_t g_live;

static fg_mutex g_lock;
static fg_task *g_tasks_head, *g_tasks_tail;
static fg_fin *g_fin_head, *g_fin_tail;
static fg_hook *g_hooks;
static napi_module *g_registered_module;
static int64_t g_external_memory;
static JSAtom g_atom_wrap, g_atom_tag;

/* ---- handles ----------------------------------------------------------------------------- */

#define V(h) (*(JSValue *) (h))

static JSValue *slot_at(size_t index) { return &g_chunks[index / CHUNK][index % CHUNK]; }

static napi_value H(JSValue v)
{
    size_t c = g_top / CHUNK;
    JSValue *slot;
    if (c >= MAX_CHUNKS) {
        fprintf(stderr, "graak: N-API handle arena exhausted\n");
        abort();
    }
    if (!g_chunks[c]) {
        g_chunks[c] = malloc(sizeof(JSValue) * CHUNK);
        if (!g_chunks[c]) abort();
    }
    slot = slot_at(g_top);
    *slot = v;
    g_top++;
    return (napi_value) slot;
}

static void handles_close(size_t mark)
{
    while (g_top > mark) {
        g_top--;
        JS_FreeValue(g_ctx, *slot_at(g_top));
    }
}

/* ---- status / errors --------------------------------------------------------------------- */

static const char *const error_messages[] = {
    NULL,
    "Invalid argument",
    "An object was expected",
    "A string was expected",
    "A string or symbol was expected",
    "A function was expected",
    "A number was expected",
    "A boolean was expected",
    "An array was expected",
    "Unknown failure",
    "An exception is pending",
    "The async work item was cancelled",
    "napi_escape_handle already called on scope",
    "Invalid handle scope usage",
    "Invalid callback scope usage",
    "Thread-safe function queue is full",
    "Thread-safe function handle is closing",
    "A bigint was expected",
    "A date was expected",
    "An arraybuffer was expected",
    "A detachable arraybuffer was expected",
    "Main thread would deadlock",
    "External buffers are not allowed",
    "Cannot run JavaScript",
};

static napi_status set_err(napi_env env, napi_status status)
{
    if (env) {
        env->err.error_code = status;
        env->err.engine_error_code = 0;
        env->err.engine_reserved = NULL;
        env->err.error_message = NULL;
    }
    return status;
}

#define OK(env) return set_err((env), napi_ok)
#define FAIL(env, s) return set_err((env), (s))
#define CHECK_ENV(env) do { if (!(env)) return napi_invalid_arg; } while (0)
#define CHECK_ARG(env, a) do { if (!(a)) FAIL((env), napi_invalid_arg); } while (0)
#define PREAMBLE(env) do { CHECK_ENV(env); if ((env)->has_pending) FAIL((env), napi_pending_exception); set_err((env), napi_ok); } while (0)

static napi_status catch_exception(napi_env env)
{
    JSValue e = JS_GetException(env->ctx);
    if (env->has_pending) JS_FreeValue(env->ctx, env->pending);
    env->pending = e;
    env->has_pending = 1;
    return set_err(env, napi_pending_exception);
}

static void set_pending(napi_env env, JSValue e)
{
    if (env->has_pending) JS_FreeValue(env->ctx, env->pending);
    env->pending = e;
    env->has_pending = 1;
}

/* ---- prelude: the few operations easier to express in JS than through the C API --------- */

static const char PRELUDE[] =
    "({"
    "keys(o,ownOnly,filter,numToStr){"
    "const out=[],seen=new Set();"
    "for(let cur=o;cur!=null;cur=ownOnly?null:Object.getPrototypeOf(cur)){"
    "for(const k of Reflect.ownKeys(cur)){"
    "if(seen.has(k))continue;seen.add(k);"
    "const sym=typeof k==='symbol';"
    "if(sym?(filter&16):(filter&8))continue;"
    "const d=Object.getOwnPropertyDescriptor(cur,k);"
    "if((filter&1)&&!d.writable)continue;"
    "if((filter&2)&&!d.enumerable)continue;"
    "if((filter&4)&&!d.configurable)continue;"
    "out.push(!sym&&!numToStr&&/^(0|[1-9]\\d*)$/.test(k)&&+k<4294967295?+k:k)}}"
    "return out},"
    "mkerr(K,code,msg){const e=new K(msg);if(code!==undefined)e.code=code;return e},"
    "mkdate(t){return new Date(t)},"
    "dateval(d){return d.getTime()},"
    "isdate(d){return d instanceof Date},"
    "mkview(b,o,l){return new DataView(b,o,l)},"
    "bigwords(neg,hex){const v=BigInt('0x'+hex);return neg?-v:v},"
    "bigparts(v){const neg=v<0n;return [neg,(neg?-v:v).toString(16)]},"
    "weak(o){return new WeakRef(o)},"
    "deref(w){return w.deref()},"
    "freeze(o){Object.freeze(o)},"
    "seal(o){Object.seal(o)},"
    "isbuf(v){return ArrayBuffer.isView(v)},"
    "instof(o,c){return o instanceof c}"
    "})";

static JSValue prelude_call(napi_env env, const char *name, int argc, JSValueConst *argv)
{
    JSValue fn = JS_GetPropertyStr(env->ctx, g_prelude, name);
    JSValue res = JS_Call(env->ctx, fn, g_prelude, argc, argv);
    JS_FreeValue(env->ctx, fn);
    return res;
}

/* ---- finalizer queue --------------------------------------------------------------------- */

static void queue_finalizer(napi_env env, napi_finalize cb, void *data, void *hint)
{
    fg_fin *f;
    if (!cb) return;
    f = malloc(sizeof(*f));
    if (!f) return;
    f->next = NULL;
    f->env = env;
    f->cb = cb;
    f->data = data;
    f->hint = hint;
    if (g_fin_tail) g_fin_tail->next = f; else g_fin_head = f;
    g_fin_tail = f;
}

static void run_finalizers(void)
{
    while (g_fin_head && !g_shutdown) {
        fg_fin *f = g_fin_head;
        size_t mark = g_top;
        g_fin_head = f->next;
        if (!g_fin_head) g_fin_tail = NULL;
        f->cb(f->env, f->data, f->hint);
        handles_close(mark);
        free(f);
    }
}

static void holder_finalizer(JSRuntime *rt, JSValueConst val)
{
    fg_holder *h = JS_GetOpaque(val, JS_GetClassID(val));
    if (!h) return;
    queue_finalizer(h->env, (napi_finalize) h->fn, h->data, h->hint);
    free(h);
}

static void fn_finalizer(JSRuntime *rt, JSValueConst val)
{
    free(JS_GetOpaque(val, cls_fn));
}

static fg_holder *new_holder(napi_env env, void *data, void *fn, void *hint)
{
    fg_holder *h = calloc(1, sizeof(*h));
    if (!h) return NULL;
    h->env = env;
    h->data = data;
    h->fn = fn;
    h->hint = hint;
    return h;
}

/* ---- event-loop liveness ------------------------------------------------------------------ */

static void live_inc(void)
{
    if (g_live++ == 0 && JS_IsFunction(g_ctx, g_pump_start)) {
        JSValue r = JS_Call(g_ctx, g_pump_start, JS_UNDEFINED, 0, NULL);
        JS_FreeValue(g_ctx, r);
    }
}

static void live_dec(void)
{
    if (g_live == 0) return;
    if (--g_live == 0 && JS_IsFunction(g_ctx, g_pump_stop)) {
        JSValue r = JS_Call(g_ctx, g_pump_stop, JS_UNDEFINED, 0, NULL);
        JS_FreeValue(g_ctx, r);
    }
}

static void post_task(int kind, void *target, void *data)
{
    fg_task *t = malloc(sizeof(*t));
    if (!t) return;
    t->next = NULL;
    t->kind = kind;
    t->target = target;
    t->data = data;
    fg_mutex_lock(&g_lock);
    if (g_tasks_tail) g_tasks_tail->next = t; else g_tasks_head = t;
    g_tasks_tail = t;
    fg_mutex_unlock(&g_lock);
}

/* ---- function / class trampolines --------------------------------------------------------- */

static JSValue tramp(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic,
                     JSValueConst *fdata)
{
    fg_holder *r = JS_GetOpaque(fdata[0], cls_fn);
    napi_env env = r->env;
    size_t mark = g_top;
    fg_cbinfo info;
    napi_value ret;
    JSValue out;

    info.this_val = this_val;
    info.new_target = JS_UNDEFINED;
    if (magic == 1 && argc > 0) {
        info.new_target = argv[0];
        argc--;
        argv++;
    }
    info.argc = argc;
    info.argv = argv;
    info.data = r->data;

    ret = ((napi_callback) r->fn)(env, (napi_callback_info) &info);
    if (env->has_pending) {
        JSValue e = env->pending;
        env->has_pending = 0;
        out = JS_Throw(ctx, e);
    } else {
        out = ret ? JS_DupValue(ctx, V(ret)) : JS_UNDEFINED;
    }
    handles_close(mark);
    run_finalizers();
    return out;
}

static JSValue make_function(napi_env env, const char *name, napi_callback cb, void *data, int magic)
{
    JSValue holder, fn;
    fg_holder *h = new_holder(env, data, (void *) cb, NULL);
    if (!h) return JS_EXCEPTION;
    holder = JS_NewObjectClass(env->ctx, cls_fn);
    JS_SetOpaque(holder, h);
    fn = JS_NewCFunctionData2(env->ctx, tramp, name ? name : "", 0, magic, 1, &holder);
    JS_FreeValue(env->ctx, holder);
    return fn;
}

/* ---- creating values --------------------------------------------------------------------- */

napi_status napi_get_undefined(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_UNDEFINED); OK(env);
}
napi_status napi_get_null(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NULL); OK(env);
}
napi_status napi_get_global(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_GetGlobalObject(env->ctx)); OK(env);
}
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewBool(env->ctx, value)); OK(env);
}
napi_status napi_create_object(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewObject(env->ctx)); OK(env);
}
napi_status napi_create_array(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewArray(env->ctx)); OK(env);
}
napi_status napi_create_array_with_length(napi_env env, size_t length, napi_value *result)
{
    JSValue a;
    CHECK_ENV(env); CHECK_ARG(env, result);
    a = JS_NewArray(env->ctx);
    JS_SetPropertyStr(env->ctx, a, "length", JS_NewInt64(env->ctx, (int64_t) length));
    *result = H(a); OK(env);
}
napi_status napi_create_double(napi_env env, double value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewFloat64(env->ctx, value)); OK(env);
}
napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewInt32(env->ctx, value)); OK(env);
}
napi_status napi_create_uint32(napi_env env, uint32_t value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewUint32(env->ctx, value)); OK(env);
}
napi_status napi_create_int64(napi_env env, int64_t value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewFloat64(env->ctx, (double) value)); OK(env);
}
napi_status napi_create_bigint_int64(napi_env env, int64_t value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewBigInt64(env->ctx, value)); OK(env);
}
napi_status napi_create_bigint_uint64(napi_env env, uint64_t value, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = H(JS_NewBigUint64(env->ctx, value)); OK(env);
}

napi_status napi_create_bigint_words(napi_env env, int sign_bit, size_t word_count, const uint64_t *words,
                                     napi_value *result)
{
    char *hex;
    size_t i, at = 0;
    JSValue args[2], big;
    PREAMBLE(env); CHECK_ARG(env, words); CHECK_ARG(env, result);
    if (word_count > 0x7fffffff) FAIL(env, napi_invalid_arg);
    hex = malloc(word_count * 16 + 2);
    if (!hex) FAIL(env, napi_generic_failure);
    for (i = word_count; i-- > 0;) at += (size_t) snprintf(hex + at, 17, "%016llx", (unsigned long long) words[i]);
    if (!at) { hex[0] = '0'; at = 1; }
    hex[at] = '\0';
    args[0] = JS_NewBool(env->ctx, sign_bit != 0);
    args[1] = JS_NewString(env->ctx, hex);
    free(hex);
    big = prelude_call(env, "bigwords", 2, args);
    JS_FreeValue(env->ctx, args[1]);
    if (JS_IsException(big)) return catch_exception(env);
    *result = H(big); OK(env);
}

napi_status napi_get_value_bigint_words(napi_env env, napi_value value, int *sign_bit, size_t *word_count,
                                        uint64_t *words)
{
    JSValue parts, hexv;
    const char *hex;
    size_t len, need, i, cap;
    int neg;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, word_count);
    if (!JS_IsBigInt(V(value))) FAIL(env, napi_bigint_expected);
    parts = prelude_call(env, "bigparts", 1, &V(value));
    if (JS_IsException(parts)) return catch_exception(env);
    neg = JS_ToBool(env->ctx, JS_GetPropertyUint32(env->ctx, parts, 0));
    hexv = JS_GetPropertyUint32(env->ctx, parts, 1);
    hex = JS_ToCStringLen(env->ctx, &len, hexv);
    need = (len + 15) / 16;
    if (!need) need = 1;
    if (!sign_bit && !words) {
        *word_count = need;
    } else {
        cap = *word_count;
        for (i = 0; i < need && i < cap; i++) {
            size_t end = len - i * 16, start = end > 16 ? end - 16 : 0;
            char tmp[17];
            memcpy(tmp, hex + start, end - start);
            tmp[end - start] = '\0';
            words[i] = strtoull(tmp, NULL, 16);
        }
        *word_count = need < cap ? need : cap;
        if (sign_bit) *sign_bit = neg;
    }
    JS_FreeCString(env->ctx, hex);
    JS_FreeValue(env->ctx, hexv);
    JS_FreeValue(env->ctx, parts);
    OK(env);
}

napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (!str && length) FAIL(env, napi_invalid_arg);
    if (length == NAPI_AUTO_LENGTH) length = str ? strlen(str) : 0;
    *result = H(JS_NewStringLen(env->ctx, str ? str : "", length)); OK(env);
}
napi_status node_api_create_property_key_utf8(napi_env env, const char *str, size_t length, napi_value *result)
{
    return napi_create_string_utf8(env, str, length, result);
}

napi_status napi_create_string_latin1(napi_env env, const char *str, size_t length, napi_value *result)
{
    size_t i;
    char *buf;
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (!str && length) FAIL(env, napi_invalid_arg);
    if (length == NAPI_AUTO_LENGTH) length = str ? strlen(str) : 0;
    buf = malloc(length * 2 + 1);
    if (!buf) FAIL(env, napi_generic_failure);
    {
        size_t at = 0;
        for (i = 0; i < length; i++) {
            unsigned char c = (unsigned char) str[i];
            if (c < 0x80) {
                buf[at++] = (char) c;
            } else {
                buf[at++] = (char) (0xC0 | (c >> 6));
                buf[at++] = (char) (0x80 | (c & 0x3F));
            }
        }
        *result = H(JS_NewStringLen(env->ctx, buf, at));
    }
    free(buf);
    OK(env);
}
napi_status node_api_create_external_string_latin1(napi_env env, char *str, size_t length,
                                                   napi_finalize fin, void *hint, napi_value *result,
                                                   bool *copied)
{
    napi_status s = napi_create_string_latin1(env, str, length, result);
    if (s == napi_ok) {
        if (copied) *copied = true;
        if (fin) fin(env, str, hint);
    }
    return s;
}
napi_status node_api_create_property_key_latin1(napi_env env, const char *str, size_t length, napi_value *result)
{
    return napi_create_string_latin1(env, str, length, result);
}

napi_status napi_create_string_utf16(napi_env env, const char16_t *str, size_t length, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (!str && length) FAIL(env, napi_invalid_arg);
    if (length == NAPI_AUTO_LENGTH) {
        length = 0;
        if (str) while (str[length]) length++;
    }
    *result = H(JS_NewStringUTF16(env->ctx, (const uint16_t *) str, length)); OK(env);
}
napi_status node_api_create_external_string_utf16(napi_env env, char16_t *str, size_t length,
                                                  napi_finalize fin, void *hint, napi_value *result,
                                                  bool *copied)
{
    napi_status s = napi_create_string_utf16(env, str, length, result);
    if (s == napi_ok) {
        if (copied) *copied = true;
        if (fin) fin(env, str, hint);
    }
    return s;
}
napi_status node_api_create_property_key_utf16(napi_env env, const char16_t *str, size_t length, napi_value *result)
{
    return napi_create_string_utf16(env, str, length, result);
}

napi_status napi_create_symbol(napi_env env, napi_value description, napi_value *result)
{
    const char *desc = NULL;
    JSValue s;
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (description) {
        if (!JS_IsString(V(description))) FAIL(env, napi_string_expected);
        desc = JS_ToCString(env->ctx, V(description));
    }
    s = JS_NewSymbol(env->ctx, desc ? desc : "", false);
    if (desc) JS_FreeCString(env->ctx, desc);
    *result = H(s); OK(env);
}
napi_status node_api_symbol_for(napi_env env, const char *utf8description, size_t length, napi_value *result)
{
    char *copy;
    JSValue s;
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (length == NAPI_AUTO_LENGTH) length = utf8description ? strlen(utf8description) : 0;
    copy = malloc(length + 1);
    if (!copy) FAIL(env, napi_generic_failure);
    if (length) memcpy(copy, utf8description, length);
    copy[length] = '\0';
    s = JS_NewSymbol(env->ctx, copy, true);
    free(copy);
    *result = H(s); OK(env);
}

napi_status napi_create_function(napi_env env, const char *utf8name, size_t length, napi_callback cb, void *data,
                                 napi_value *result)
{
    char *name = NULL;
    JSValue fn;
    CHECK_ENV(env); CHECK_ARG(env, cb); CHECK_ARG(env, result);
    if (utf8name) {
        if (length == NAPI_AUTO_LENGTH) length = strlen(utf8name);
        name = malloc(length + 1);
        if (!name) FAIL(env, napi_generic_failure);
        memcpy(name, utf8name, length);
        name[length] = '\0';
    }
    fn = make_function(env, name, cb, data, 0);
    free(name);
    if (JS_IsException(fn)) FAIL(env, napi_generic_failure);
    *result = H(fn); OK(env);
}

napi_status napi_create_date(napi_env env, double time, napi_value *result)
{
    JSValue arg, d;
    PREAMBLE(env); CHECK_ARG(env, result);
    arg = JS_NewFloat64(env->ctx, time);
    d = prelude_call(env, "mkdate", 1, &arg);
    if (JS_IsException(d)) return catch_exception(env);
    *result = H(d); OK(env);
}
napi_status napi_is_date(napi_env env, napi_value value, bool *is_date)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, is_date);
    *is_date = JS_IsDate(V(value)); OK(env);
}
napi_status napi_get_date_value(napi_env env, napi_value value, double *result)
{
    JSValue r;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsDate(V(value))) FAIL(env, napi_date_expected);
    r = prelude_call(env, "dateval", 1, &V(value));
    if (JS_IsException(r)) return catch_exception(env);
    JS_ToFloat64(env->ctx, result, r);
    JS_FreeValue(env->ctx, r);
    OK(env);
}

/* ---- reading values ---------------------------------------------------------------------- */

napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result)
{
    JSValueConst v;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    v = V(value);
    if (JS_IsNumber(v)) *result = napi_number;
    else if (JS_IsBigInt(v)) *result = napi_bigint;
    else if (JS_IsString(v)) *result = napi_string;
    else if (JS_IsFunction(env->ctx, v)) *result = napi_function;
    else if (JS_IsBool(v)) *result = napi_boolean;
    else if (JS_IsUndefined(v)) *result = napi_undefined;
    else if (JS_IsNull(v)) *result = napi_null;
    else if (JS_IsSymbol(v)) *result = napi_symbol;
    else if (JS_IsObject(v)) *result = JS_GetOpaque(v, cls_ext) ? napi_external : napi_object;
    else FAIL(env, napi_invalid_arg);
    OK(env);
}

napi_status napi_get_value_double(napi_env env, napi_value value, double *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsNumber(V(value))) FAIL(env, napi_number_expected);
    JS_ToFloat64(env->ctx, result, V(value)); OK(env);
}
napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t *result)
{
    double d;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsNumber(V(value))) FAIL(env, napi_number_expected);
    JS_ToFloat64(env->ctx, &d, V(value));
    if (!isfinite(d)) *result = 0;
    else *result = (int32_t) (uint32_t) (uint64_t) (int64_t) fmod(trunc(d), 4294967296.0);
    OK(env);
}
napi_status napi_get_value_uint32(napi_env env, napi_value value, uint32_t *result)
{
    double d;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsNumber(V(value))) FAIL(env, napi_number_expected);
    JS_ToFloat64(env->ctx, &d, V(value));
    if (!isfinite(d)) *result = 0;
    else *result = (uint32_t) (uint64_t) (int64_t) fmod(trunc(d), 4294967296.0);
    OK(env);
}
napi_status napi_get_value_int64(napi_env env, napi_value value, int64_t *result)
{
    double d;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsNumber(V(value))) FAIL(env, napi_number_expected);
    JS_ToFloat64(env->ctx, &d, V(value));
    if (!isfinite(d)) *result = 0;
    else if (d >= 9223372036854775808.0) *result = INT64_MAX;
    else if (d <= -9223372036854775808.0) *result = INT64_MIN;
    else *result = (int64_t) d;
    OK(env);
}
napi_status napi_get_value_bool(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsBool(V(value))) FAIL(env, napi_boolean_expected);
    *result = JS_ToBool(env->ctx, V(value)) != 0; OK(env);
}
napi_status napi_get_value_bigint_int64(napi_env env, napi_value value, int64_t *result, bool *lossless)
{
    JSValue v;
    int64_t out = 0;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result); CHECK_ARG(env, lossless);
    if (!JS_IsBigInt(V(value))) FAIL(env, napi_bigint_expected);
    JS_ToBigInt64(env->ctx, &out, V(value));
    *result = out;
    v = JS_NewBigInt64(env->ctx, out);
    *lossless = JS_IsStrictEqual(env->ctx, v, V(value));
    JS_FreeValue(env->ctx, v);
    OK(env);
}
napi_status napi_get_value_bigint_uint64(napi_env env, napi_value value, uint64_t *result, bool *lossless)
{
    JSValue v;
    uint64_t out = 0;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result); CHECK_ARG(env, lossless);
    if (!JS_IsBigInt(V(value))) FAIL(env, napi_bigint_expected);
    JS_ToBigUint64(env->ctx, &out, V(value));
    *result = out;
    v = JS_NewBigUint64(env->ctx, out);
    *lossless = JS_IsStrictEqual(env->ctx, v, V(value));
    JS_FreeValue(env->ctx, v);
    OK(env);
}

napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result)
{
    const char *s;
    size_t len;
    CHECK_ENV(env); CHECK_ARG(env, value);
    if (!JS_IsString(V(value))) FAIL(env, napi_string_expected);
    s = JS_ToCStringLen(env->ctx, &len, V(value));
    if (!s) FAIL(env, napi_generic_failure);
    if (!buf) {
        CHECK_ARG(env, result);
        *result = len;
    } else if (bufsize) {
        size_t n = len < bufsize - 1 ? len : bufsize - 1;
        /* never cut a multi-byte sequence in half */
        while (n > 0 && n < len && ((unsigned char) s[n] & 0xC0) == 0x80) n--;
        memcpy(buf, s, n);
        buf[n] = '\0';
        if (result) *result = n;
    } else if (result) {
        *result = 0;
    }
    JS_FreeCString(env->ctx, s);
    OK(env);
}

napi_status napi_get_value_string_latin1(napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result)
{
    const uint16_t *s;
    size_t len, i;
    CHECK_ENV(env); CHECK_ARG(env, value);
    if (!JS_IsString(V(value))) FAIL(env, napi_string_expected);
    s = JS_ToCStringLenUTF16(env->ctx, &len, V(value));
    if (!s) FAIL(env, napi_generic_failure);
    if (!buf) {
        CHECK_ARG(env, result);
        *result = len;
    } else if (bufsize) {
        size_t n = len < bufsize - 1 ? len : bufsize - 1;
        for (i = 0; i < n; i++) buf[i] = (char) (s[i] & 0xFF);
        buf[n] = '\0';
        if (result) *result = n;
    } else if (result) {
        *result = 0;
    }
    JS_FreeCStringUTF16(env->ctx, s);
    OK(env);
}

napi_status napi_get_value_string_utf16(napi_env env, napi_value value, char16_t *buf, size_t bufsize,
                                        size_t *result)
{
    const uint16_t *s;
    size_t len;
    CHECK_ENV(env); CHECK_ARG(env, value);
    if (!JS_IsString(V(value))) FAIL(env, napi_string_expected);
    s = JS_ToCStringLenUTF16(env->ctx, &len, V(value));
    if (!s) FAIL(env, napi_generic_failure);
    if (!buf) {
        CHECK_ARG(env, result);
        *result = len;
    } else if (bufsize) {
        size_t n = len < bufsize - 1 ? len : bufsize - 1;
        memcpy(buf, s, n * sizeof(char16_t));
        buf[n] = 0;
        if (result) *result = n;
    } else if (result) {
        *result = 0;
    }
    JS_FreeCStringUTF16(env->ctx, s);
    OK(env);
}

napi_status napi_coerce_to_bool(napi_env env, napi_value value, napi_value *result)
{
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = H(JS_NewBool(env->ctx, JS_ToBool(env->ctx, V(value)))); OK(env);
}
napi_status napi_coerce_to_number(napi_env env, napi_value value, napi_value *result)
{
    double d;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (JS_ToFloat64(env->ctx, &d, V(value)) < 0) return catch_exception(env);
    *result = H(JS_NewFloat64(env->ctx, d)); OK(env);
}
napi_status napi_coerce_to_string(napi_env env, napi_value value, napi_value *result)
{
    JSValue s;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    s = JS_ToString(env->ctx, V(value));
    if (JS_IsException(s)) return catch_exception(env);
    *result = H(s); OK(env);
}
napi_status napi_coerce_to_object(napi_env env, napi_value value, napi_value *result)
{
    JSValue o;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    o = JS_ToObject(env->ctx, V(value));
    if (JS_IsException(o)) return catch_exception(env);
    *result = H(o); OK(env);
}

/* ---- objects and properties -------------------------------------------------------------- */

static int to_object_check(napi_env env, napi_value object, JSValueConst *out)
{
    if (!object) return 0;
    if (!JS_IsObject(V(object)) && !JS_IsFunction(env->ctx, V(object))) return 0;
    *out = V(object);
    return 1;
}

napi_status napi_get_prototype(napi_env env, napi_value object, napi_value *result)
{
    JSValue p;
    PREAMBLE(env); CHECK_ARG(env, object); CHECK_ARG(env, result);
    p = JS_GetPrototype(env->ctx, V(object));
    if (JS_IsException(p)) return catch_exception(env);
    *result = H(p); OK(env);
}

napi_status napi_get_property_names(napi_env env, napi_value object, napi_value *result)
{
    JSValue args[4], r;
    PREAMBLE(env); CHECK_ARG(env, object); CHECK_ARG(env, result);
    args[0] = V(object);
    args[1] = JS_FALSE;
    args[2] = JS_NewInt32(env->ctx, 2 | 16);
    args[3] = JS_TRUE;
    r = prelude_call(env, "keys", 4, args);
    if (JS_IsException(r)) return catch_exception(env);
    *result = H(r); OK(env);
}
napi_status napi_get_all_property_names(napi_env env, napi_value object, napi_key_collection_mode key_mode,
                                        napi_key_filter key_filter, napi_key_conversion key_conversion,
                                        napi_value *result)
{
    JSValue args[4], r;
    PREAMBLE(env); CHECK_ARG(env, object); CHECK_ARG(env, result);
    args[0] = V(object);
    args[1] = JS_NewBool(env->ctx, key_mode == napi_key_own_only);
    args[2] = JS_NewInt32(env->ctx, (int) key_filter);
    args[3] = JS_NewBool(env->ctx, key_conversion == napi_key_numbers_to_strings);
    r = prelude_call(env, "keys", 4, args);
    if (JS_IsException(r)) return catch_exception(env);
    *result = H(r); OK(env);
}

napi_status napi_set_property(napi_env env, napi_value object, napi_value key, napi_value value)
{
    JSAtom a;
    JSValueConst o;
    int r;
    PREAMBLE(env); CHECK_ARG(env, key); CHECK_ARG(env, value);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_ValueToAtom(env->ctx, V(key));
    r = JS_SetProperty(env->ctx, o, a, JS_DupValue(env->ctx, V(value)));
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    OK(env);
}
napi_status napi_has_property(napi_env env, napi_value object, napi_value key, bool *result)
{
    JSAtom a;
    JSValueConst o;
    int r;
    PREAMBLE(env); CHECK_ARG(env, key); CHECK_ARG(env, result);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_ValueToAtom(env->ctx, V(key));
    r = JS_HasProperty(env->ctx, o, a);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    *result = r != 0; OK(env);
}
napi_status napi_get_property(napi_env env, napi_value object, napi_value key, napi_value *result)
{
    JSAtom a;
    JSValueConst o;
    JSValue v;
    PREAMBLE(env); CHECK_ARG(env, key); CHECK_ARG(env, result);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_ValueToAtom(env->ctx, V(key));
    v = JS_GetProperty(env->ctx, o, a);
    JS_FreeAtom(env->ctx, a);
    if (JS_IsException(v)) return catch_exception(env);
    *result = H(v); OK(env);
}
napi_status napi_delete_property(napi_env env, napi_value object, napi_value key, bool *result)
{
    JSAtom a;
    JSValueConst o;
    int r;
    PREAMBLE(env); CHECK_ARG(env, key);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_ValueToAtom(env->ctx, V(key));
    r = JS_DeleteProperty(env->ctx, o, a, 0);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    if (result) *result = r != 0;
    OK(env);
}
napi_status napi_has_own_property(napi_env env, napi_value object, napi_value key, bool *result)
{
    JSAtom a;
    JSValueConst o;
    JSPropertyDescriptor desc;
    int r;
    PREAMBLE(env); CHECK_ARG(env, key); CHECK_ARG(env, result);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    if (!JS_IsString(V(key)) && !JS_IsSymbol(V(key))) FAIL(env, napi_name_expected);
    a = JS_ValueToAtom(env->ctx, V(key));
    r = JS_GetOwnProperty(env->ctx, &desc, o, a);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    if (r) {
        JS_FreeValue(env->ctx, desc.value);
        JS_FreeValue(env->ctx, desc.getter);
        JS_FreeValue(env->ctx, desc.setter);
    }
    *result = r != 0; OK(env);
}

napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name, napi_value value)
{
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, utf8name);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    if (JS_SetPropertyStr(env->ctx, o, utf8name, JS_DupValue(env->ctx, V(value))) < 0) return catch_exception(env);
    OK(env);
}
napi_status napi_has_named_property(napi_env env, napi_value object, const char *utf8name, bool *result)
{
    JSValueConst o;
    JSAtom a;
    int r;
    PREAMBLE(env); CHECK_ARG(env, result); CHECK_ARG(env, utf8name);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_NewAtom(env->ctx, utf8name);
    r = JS_HasProperty(env->ctx, o, a);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    *result = r != 0; OK(env);
}
napi_status napi_get_named_property(napi_env env, napi_value object, const char *utf8name, napi_value *result)
{
    JSValueConst o;
    JSValue v;
    PREAMBLE(env); CHECK_ARG(env, result); CHECK_ARG(env, utf8name);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    v = JS_GetPropertyStr(env->ctx, o, utf8name);
    if (JS_IsException(v)) return catch_exception(env);
    *result = H(v); OK(env);
}

napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value)
{
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, value);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    if (JS_SetPropertyUint32(env->ctx, o, index, JS_DupValue(env->ctx, V(value))) < 0) return catch_exception(env);
    OK(env);
}
napi_status napi_has_element(napi_env env, napi_value object, uint32_t index, bool *result)
{
    JSValueConst o;
    JSAtom a;
    int r;
    PREAMBLE(env); CHECK_ARG(env, result);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_NewAtomUInt32(env->ctx, index);
    r = JS_HasProperty(env->ctx, o, a);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    *result = r != 0; OK(env);
}
napi_status napi_get_element(napi_env env, napi_value object, uint32_t index, napi_value *result)
{
    JSValueConst o;
    JSValue v;
    PREAMBLE(env); CHECK_ARG(env, result);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    v = JS_GetPropertyUint32(env->ctx, o, index);
    if (JS_IsException(v)) return catch_exception(env);
    *result = H(v); OK(env);
}
napi_status napi_delete_element(napi_env env, napi_value object, uint32_t index, bool *result)
{
    JSValueConst o;
    JSAtom a;
    int r;
    PREAMBLE(env);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    a = JS_NewAtomUInt32(env->ctx, index);
    r = JS_DeleteProperty(env->ctx, o, a, 0);
    JS_FreeAtom(env->ctx, a);
    if (r < 0) return catch_exception(env);
    if (result) *result = r != 0;
    OK(env);
}
napi_status napi_is_array(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_IsArray(V(value)) != 0; OK(env);
}
napi_status napi_get_array_length(napi_env env, napi_value value, uint32_t *result)
{
    JSValue len;
    int64_t n = 0;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    if (!JS_IsArray(V(value))) FAIL(env, napi_array_expected);
    len = JS_GetPropertyStr(env->ctx, V(value), "length");
    JS_ToInt64(env->ctx, &n, len);
    JS_FreeValue(env->ctx, len);
    *result = (uint32_t) n; OK(env);
}
napi_status napi_strict_equals(napi_env env, napi_value lhs, napi_value rhs, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, lhs); CHECK_ARG(env, rhs); CHECK_ARG(env, result);
    *result = JS_IsStrictEqual(env->ctx, V(lhs), V(rhs)) != 0; OK(env);
}
napi_status napi_object_freeze(napi_env env, napi_value object)
{
    JSValue r;
    PREAMBLE(env); CHECK_ARG(env, object);
    r = prelude_call(env, "freeze", 1, &V(object));
    if (JS_IsException(r)) return catch_exception(env);
    JS_FreeValue(env->ctx, r); OK(env);
}
napi_status napi_object_seal(napi_env env, napi_value object)
{
    JSValue r;
    PREAMBLE(env); CHECK_ARG(env, object);
    r = prelude_call(env, "seal", 1, &V(object));
    if (JS_IsException(r)) return catch_exception(env);
    JS_FreeValue(env->ctx, r); OK(env);
}

static int define_one(napi_env env, JSValueConst obj, const napi_property_descriptor *p, JSValueConst proto_holder)
{
    JSAtom atom;
    int flags = 0;
    int ok;
    (void) proto_holder;
    if (p->utf8name) atom = JS_NewAtom(env->ctx, p->utf8name);
    else if (p->name) atom = JS_ValueToAtom(env->ctx, V(p->name));
    else return -1;
    if (p->attributes & napi_enumerable) flags |= JS_PROP_ENUMERABLE;
    if (p->attributes & napi_configurable) flags |= JS_PROP_CONFIGURABLE;
    if (p->getter || p->setter) {
        JSValue g = JS_UNDEFINED, s = JS_UNDEFINED;
        if (p->getter) g = make_function(env, p->utf8name, p->getter, p->data, 0);
        if (p->setter) s = make_function(env, p->utf8name, p->setter, p->data, 0);
        ok = JS_DefinePropertyGetSet(env->ctx, obj, atom, g, s, flags);
    } else if (p->method) {
        JSValue f = make_function(env, p->utf8name, p->method, p->data, 0);
        if (p->attributes & napi_writable) flags |= JS_PROP_WRITABLE;
        ok = JS_DefinePropertyValue(env->ctx, obj, atom, f, flags);
    } else {
        if (p->attributes & napi_writable) flags |= JS_PROP_WRITABLE;
        ok = JS_DefinePropertyValue(env->ctx, obj, atom, p->value ? JS_DupValue(env->ctx, V(p->value)) : JS_UNDEFINED,
                                    flags);
    }
    JS_FreeAtom(env->ctx, atom);
    return ok;
}

napi_status napi_define_properties(napi_env env, napi_value object, size_t property_count,
                                   const napi_property_descriptor *properties)
{
    size_t i;
    JSValueConst o;
    PREAMBLE(env);
    if (property_count) CHECK_ARG(env, properties);
    if (!to_object_check(env, object, &o)) FAIL(env, napi_object_expected);
    for (i = 0; i < property_count; i++) {
        if (define_one(env, o, &properties[i], JS_UNDEFINED) < 0) return catch_exception(env);
    }
    OK(env);
}

napi_status napi_define_class(napi_env env, const char *utf8name, size_t length, napi_callback constructor,
                              void *data, size_t property_count, const napi_property_descriptor *properties,
                              napi_value *result)
{
    char *name;
    JSValue inner, args[2], ctor, proto;
    size_t i;
    PREAMBLE(env); CHECK_ARG(env, constructor); CHECK_ARG(env, result);
    if (property_count) CHECK_ARG(env, properties);
    if (length == NAPI_AUTO_LENGTH) length = strlen(utf8name);
    name = malloc(length + 1);
    if (!name) FAIL(env, napi_generic_failure);
    memcpy(name, utf8name, length);
    name[length] = '\0';

    inner = make_function(env, name, constructor, data, 1);
    args[0] = inner;
    args[1] = JS_NewString(env->ctx, name);
    free(name);
    ctor = JS_Call(env->ctx, g_class_factory, JS_UNDEFINED, 2, args);
    JS_FreeValue(env->ctx, inner);
    JS_FreeValue(env->ctx, args[1]);
    if (JS_IsException(ctor)) return catch_exception(env);

    proto = JS_GetPropertyStr(env->ctx, ctor, "prototype");
    for (i = 0; i < property_count; i++) {
        JSValueConst target = (properties[i].attributes & napi_static) ? ctor : proto;
        if (define_one(env, target, &properties[i], JS_UNDEFINED) < 0) {
            JS_FreeValue(env->ctx, proto);
            JS_FreeValue(env->ctx, ctor);
            return catch_exception(env);
        }
    }
    JS_FreeValue(env->ctx, proto);
    *result = H(ctor); OK(env);
}

/* ---- functions --------------------------------------------------------------------------- */

napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc, napi_value *argv,
                             napi_value *this_arg, void **data)
{
    fg_cbinfo *info = (fg_cbinfo *) cbinfo;
    CHECK_ENV(env); CHECK_ARG(env, info);
    if (argv) {
        size_t i, want;
        CHECK_ARG(env, argc);
        want = *argc;
        for (i = 0; i < want; i++) {
            argv[i] = H((int) i < info->argc ? JS_DupValue(env->ctx, info->argv[i]) : JS_UNDEFINED);
        }
    }
    if (argc) *argc = (size_t) info->argc;
    if (this_arg) *this_arg = H(JS_DupValue(env->ctx, info->this_val));
    if (data) *data = info->data;
    OK(env);
}
napi_status napi_get_new_target(napi_env env, napi_callback_info cbinfo, napi_value *result)
{
    fg_cbinfo *info = (fg_cbinfo *) cbinfo;
    CHECK_ENV(env); CHECK_ARG(env, info); CHECK_ARG(env, result);
    *result = JS_IsUndefined(info->new_target) ? NULL : H(JS_DupValue(env->ctx, info->new_target));
    OK(env);
}

napi_status napi_call_function(napi_env env, napi_value recv, napi_value func, size_t argc,
                               const napi_value *argv, napi_value *result)
{
    JSValue *args = NULL, r;
    size_t i;
    PREAMBLE(env); CHECK_ARG(env, func);
    if (argc) CHECK_ARG(env, argv);
    if (!JS_IsFunction(env->ctx, V(func))) FAIL(env, napi_function_expected);
    if (argc) {
        args = malloc(sizeof(JSValue) * argc);
        if (!args) FAIL(env, napi_generic_failure);
        for (i = 0; i < argc; i++) args[i] = V(argv[i]);
    }
    r = JS_Call(env->ctx, V(func), recv ? V(recv) : JS_UNDEFINED, (int) argc, args);
    free(args);
    if (JS_IsException(r)) return catch_exception(env);
    if (result) *result = H(r); else JS_FreeValue(env->ctx, r);
    OK(env);
}

napi_status napi_new_instance(napi_env env, napi_value constructor, size_t argc, const napi_value *argv,
                              napi_value *result)
{
    JSValue *args = NULL, r;
    size_t i;
    PREAMBLE(env); CHECK_ARG(env, constructor); CHECK_ARG(env, result);
    if (argc) CHECK_ARG(env, argv);
    if (!JS_IsFunction(env->ctx, V(constructor))) FAIL(env, napi_function_expected);
    if (argc) {
        args = malloc(sizeof(JSValue) * argc);
        if (!args) FAIL(env, napi_generic_failure);
        for (i = 0; i < argc; i++) args[i] = V(argv[i]);
    }
    r = JS_CallConstructor(env->ctx, V(constructor), (int) argc, args);
    free(args);
    if (JS_IsException(r)) return catch_exception(env);
    *result = H(r); OK(env);
}

napi_status napi_instanceof(napi_env env, napi_value object, napi_value constructor, bool *result)
{
    int r;
    PREAMBLE(env); CHECK_ARG(env, object); CHECK_ARG(env, result);
    CHECK_ARG(env, constructor);
    if (!JS_IsFunction(env->ctx, V(constructor))) {
        JS_FreeValue(env->ctx, JS_ThrowTypeError(env->ctx, "Constructor must be a function"));
        catch_exception(env);
        FAIL(env, napi_function_expected);
    }
    r = JS_IsInstanceOf(env->ctx, V(object), V(constructor));
    if (r < 0) return catch_exception(env);
    *result = r != 0; OK(env);
}

napi_status napi_run_script(napi_env env, napi_value script, napi_value *result)
{
    const char *src;
    size_t len;
    JSValue r;
    PREAMBLE(env); CHECK_ARG(env, script); CHECK_ARG(env, result);
    if (!JS_IsString(V(script))) FAIL(env, napi_string_expected);
    src = JS_ToCStringLen(env->ctx, &len, V(script));
    r = JS_Eval(env->ctx, src, len, "<napi_run_script>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(env->ctx, src);
    if (JS_IsException(r)) return catch_exception(env);
    *result = H(r); OK(env);
}

/* ---- errors ------------------------------------------------------------------------------ */

static napi_status make_error(napi_env env, const char *kind, napi_value code, napi_value msg, napi_value *result)
{
    JSValue ctor, args[3], e;
    CHECK_ENV(env); CHECK_ARG(env, msg); CHECK_ARG(env, result);
    if (!JS_IsString(V(msg))) FAIL(env, napi_string_expected);
    if (code && !JS_IsString(V(code))) FAIL(env, napi_string_expected);
    {
        JSValue global = JS_GetGlobalObject(env->ctx);
        ctor = JS_GetPropertyStr(env->ctx, global, kind);
        JS_FreeValue(env->ctx, global);
    }
    args[0] = ctor;
    args[1] = code ? V(code) : JS_UNDEFINED;
    args[2] = V(msg);
    e = prelude_call(env, "mkerr", 3, args);
    JS_FreeValue(env->ctx, ctor);
    if (JS_IsException(e)) return catch_exception(env);
    *result = H(e); OK(env);
}
napi_status napi_create_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
{ return make_error(env, "Error", code, msg, result); }
napi_status napi_create_type_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
{ return make_error(env, "TypeError", code, msg, result); }
napi_status napi_create_range_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
{ return make_error(env, "RangeError", code, msg, result); }
napi_status node_api_create_syntax_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
{ return make_error(env, "SyntaxError", code, msg, result); }

static napi_status throw_kind(napi_env env, const char *kind, const char *code, const char *msg)
{
    napi_value c = NULL, m, e;
    size_t mark = g_top;
    napi_status s;
    CHECK_ENV(env);
    if (env->has_pending) FAIL(env, napi_pending_exception);
    if (code) c = H(JS_NewString(env->ctx, code));
    m = H(JS_NewString(env->ctx, msg ? msg : ""));
    s = make_error(env, kind, c, m, &e);
    if (s == napi_ok) set_pending(env, JS_DupValue(env->ctx, V(e)));
    handles_close(mark);
    return s == napi_ok ? set_err(env, napi_ok) : s;
}
napi_status napi_throw_error(napi_env env, const char *code, const char *msg) { return throw_kind(env, "Error", code, msg); }
napi_status napi_throw_type_error(napi_env env, const char *code, const char *msg) { return throw_kind(env, "TypeError", code, msg); }
napi_status napi_throw_range_error(napi_env env, const char *code, const char *msg) { return throw_kind(env, "RangeError", code, msg); }
napi_status node_api_throw_syntax_error(napi_env env, const char *code, const char *msg) { return throw_kind(env, "SyntaxError", code, msg); }

napi_status napi_throw(napi_env env, napi_value error)
{
    CHECK_ENV(env); CHECK_ARG(env, error);
    if (env->has_pending) FAIL(env, napi_pending_exception);
    set_pending(env, JS_DupValue(env->ctx, V(error))); OK(env);
}
napi_status napi_is_error(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_IsError(V(value)) != 0; OK(env);
}
napi_status napi_is_exception_pending(napi_env env, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = env->has_pending != 0; OK(env);
}
napi_status napi_get_and_clear_last_exception(napi_env env, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (!env->has_pending) {
        *result = H(JS_UNDEFINED);
    } else {
        *result = H(env->pending);
        env->has_pending = 0;
    }
    OK(env);
}
napi_status napi_get_last_error_info(napi_env benv, const napi_extended_error_info **result)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, result);
    env->err.error_message = error_messages[env->err.error_code];
    *result = &env->err;
    return napi_ok;
}
napi_status napi_fatal_exception(napi_env env, napi_value err)
{
    CHECK_ENV(env); CHECK_ARG(env, err);
    JS_Throw(env->ctx, JS_DupValue(env->ctx, V(err)));
    js_std_dump_error(env->ctx);
    exit(1);
}
NAPI_NO_RETURN void napi_fatal_error(const char *location, size_t location_len, const char *message,
                                     size_t message_len)
{
    fprintf(stderr, "FATAL ERROR: %.*s %.*s\n", location ? (int) (location_len == NAPI_AUTO_LENGTH ? strlen(location) : location_len) : 0,
            location ? location : "", message ? (int) (message_len == NAPI_AUTO_LENGTH ? strlen(message) : message_len) : 0,
            message ? message : "");
    fflush(stderr);
    abort();
}

/* ---- scopes ------------------------------------------------------------------------------ */

napi_status napi_open_handle_scope(napi_env env, napi_handle_scope *result)
{
    fg_scope *s;
    CHECK_ENV(env); CHECK_ARG(env, result);
    s = malloc(sizeof(*s));
    if (!s) FAIL(env, napi_generic_failure);
    s->mark = g_top;
    s->escapable = 0;
    *result = (napi_handle_scope) s; OK(env);
}
napi_status napi_close_handle_scope(napi_env env, napi_handle_scope scope)
{
    fg_scope *s = (fg_scope *) scope;
    CHECK_ENV(env); CHECK_ARG(env, scope);
    handles_close(s->mark);
    free(s); OK(env);
}
napi_status napi_open_escapable_handle_scope(napi_env env, napi_escapable_handle_scope *result)
{
    fg_scope *s;
    CHECK_ENV(env); CHECK_ARG(env, result);
    s = malloc(sizeof(*s));
    if (!s) FAIL(env, napi_generic_failure);
    s->slot = g_top;
    H(JS_UNDEFINED);
    s->mark = g_top;
    s->escapable = 1;
    s->escaped = 0;
    *result = (napi_escapable_handle_scope) s; OK(env);
}
napi_status napi_close_escapable_handle_scope(napi_env env, napi_escapable_handle_scope scope)
{
    fg_scope *s = (fg_scope *) scope;
    CHECK_ENV(env); CHECK_ARG(env, scope);
    handles_close(s->mark);
    free(s); OK(env);
}
napi_status napi_escape_handle(napi_env env, napi_escapable_handle_scope scope, napi_value escapee,
                               napi_value *result)
{
    fg_scope *s = (fg_scope *) scope;
    JSValue *slot;
    CHECK_ENV(env); CHECK_ARG(env, scope); CHECK_ARG(env, escapee); CHECK_ARG(env, result);
    if (s->escaped) FAIL(env, napi_escape_called_twice);
    slot = slot_at(s->slot);
    JS_FreeValue(env->ctx, *slot);
    *slot = JS_DupValue(env->ctx, V(escapee));
    s->escaped = 1;
    *result = (napi_value) slot; OK(env);
}

/* ---- references, wrapping, externals ------------------------------------------------------ */

static int is_weakable(JSContext *ctx, JSValueConst v) { return JS_IsObject(v) || JS_IsSymbol(v); }

static void ref_make_weak(napi_ref ref)
{
    JSValue arg = ref->strong, w;
    if (!ref->primitive) {
        napi_env env = ref->env;
        w = prelude_call(env, "weak", 1, &arg);
        if (JS_IsException(w)) { JS_FreeValue(env->ctx, JS_GetException(env->ctx)); return; }
        ref->weak = w;
        JS_FreeValue(env->ctx, ref->strong);
        ref->strong = JS_UNDEFINED;
    }
}

napi_status napi_create_reference(napi_env env, napi_value value, uint32_t initial_refcount, napi_ref *result)
{
    napi_ref ref;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    ref = calloc(1, sizeof(*ref));
    if (!ref) FAIL(env, napi_generic_failure);
    ref->env = env;
    ref->count = initial_refcount;
    ref->weak = JS_UNDEFINED;
    ref->strong = JS_DupValue(env->ctx, V(value));
    ref->primitive = !is_weakable(env->ctx, ref->strong);
    if (initial_refcount == 0) ref_make_weak(ref);
    *result = ref; OK(env);
}
napi_status napi_delete_reference(napi_env env, napi_ref ref)
{
    CHECK_ENV(env); CHECK_ARG(env, ref);
    JS_FreeValue(env->ctx, ref->strong);
    JS_FreeValue(env->ctx, ref->weak);
    free(ref); OK(env);
}
napi_status napi_reference_ref(napi_env env, napi_ref ref, uint32_t *result)
{
    CHECK_ENV(env); CHECK_ARG(env, ref);
    if (ref->count++ == 0 && !ref->primitive) {
        JSValue target = prelude_call(env, "deref", 1, &ref->weak);
        if (JS_IsException(target)) { JS_FreeValue(env->ctx, JS_GetException(env->ctx)); target = JS_UNDEFINED; }
        JS_FreeValue(env->ctx, ref->strong);
        ref->strong = target;
        JS_FreeValue(env->ctx, ref->weak);
        ref->weak = JS_UNDEFINED;
    }
    if (result) *result = ref->count;
    OK(env);
}
napi_status napi_reference_unref(napi_env env, napi_ref ref, uint32_t *result)
{
    CHECK_ENV(env); CHECK_ARG(env, ref);
    if (ref->count == 0) FAIL(env, napi_generic_failure);
    if (--ref->count == 0 && !JS_IsUndefined(ref->strong)) ref_make_weak(ref);
    if (result) *result = ref->count;
    OK(env);
}
napi_status napi_get_reference_value(napi_env env, napi_ref ref, napi_value *result)
{
    CHECK_ENV(env); CHECK_ARG(env, ref); CHECK_ARG(env, result);
    if (ref->count > 0 || ref->primitive) {
        *result = H(JS_DupValue(env->ctx, ref->strong));
    } else {
        JSValue target = prelude_call(env, "deref", 1, &ref->weak);
        if (JS_IsException(target)) { JS_FreeValue(env->ctx, JS_GetException(env->ctx)); target = JS_UNDEFINED; }
        *result = JS_IsUndefined(target) ? NULL : H(target);
    }
    OK(env);
}

static JSAtom wrap_atom(void)
{
    if (!g_atom_wrap) g_atom_wrap = JS_NewAtom(g_ctx, "__graak_napi_wrap");
    return g_atom_wrap;
}
static JSAtom tag_atom(void)
{
    if (!g_atom_tag) g_atom_tag = JS_NewAtom(g_ctx, "__graak_napi_tag");
    return g_atom_tag;
}

static fg_holder *own_holder(napi_env env, JSValueConst obj, JSAtom atom, JSValue *holder_out)
{
    JSPropertyDescriptor desc;
    fg_holder *h;
    if (JS_GetOwnProperty(env->ctx, &desc, obj, atom) <= 0) return NULL;
    h = JS_GetOpaque(desc.value, cls_holder);
    if (holder_out) *holder_out = desc.value; else JS_FreeValue(env->ctx, desc.value);
    return h;
}

napi_status napi_wrap(napi_env env, napi_value js_object, void *native_object, napi_finalize finalize_cb,
                      void *finalize_hint, napi_ref *result)
{
    JSValue holder;
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, js_object);
    if (!to_object_check(env, js_object, &o)) FAIL(env, napi_object_expected);
    if (own_holder(env, o, wrap_atom(), NULL)) FAIL(env, napi_invalid_arg);
    h = new_holder(env, native_object, (void *) finalize_cb, finalize_hint);
    if (!h) FAIL(env, napi_generic_failure);
    holder = JS_NewObjectClass(env->ctx, cls_holder);
    JS_SetOpaque(holder, h);
    JS_DefinePropertyValue(env->ctx, o, wrap_atom(), holder, 0);
    if (result) return napi_create_reference(env, js_object, 0, result);
    OK(env);
}
napi_status napi_unwrap(napi_env env, napi_value js_object, void **result)
{
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, js_object); CHECK_ARG(env, result);
    if (!to_object_check(env, js_object, &o)) FAIL(env, napi_object_expected);
    h = own_holder(env, o, wrap_atom(), NULL);
    if (!h) FAIL(env, napi_invalid_arg);
    *result = h->data; OK(env);
}
napi_status napi_remove_wrap(napi_env env, napi_value js_object, void **result)
{
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, js_object);
    if (!to_object_check(env, js_object, &o)) FAIL(env, napi_object_expected);
    h = own_holder(env, o, wrap_atom(), NULL);
    if (!h) FAIL(env, napi_invalid_arg);
    if (result) *result = h->data;
    h->fn = NULL; /* removed on purpose: the finalizer must not run for it */
    JS_DeleteProperty(env->ctx, o, wrap_atom(), 0);
    OK(env);
}
napi_status napi_add_finalizer(napi_env env, napi_value js_object, void *finalize_data, napi_finalize finalize_cb,
                               void *finalize_hint, napi_ref *result)
{
    JSValue holder, sym;
    JSAtom key;
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, js_object); CHECK_ARG(env, finalize_cb);
    if (!to_object_check(env, js_object, &o)) FAIL(env, napi_object_expected);
    h = new_holder(env, finalize_data, (void *) finalize_cb, finalize_hint);
    if (!h) FAIL(env, napi_generic_failure);
    holder = JS_NewObjectClass(env->ctx, cls_holder);
    JS_SetOpaque(holder, h);
    sym = JS_NewSymbol(env->ctx, "fg.finalizer", false);
    key = JS_ValueToAtom(env->ctx, sym);
    JS_DefinePropertyValue(env->ctx, o, key, holder, 0);
    JS_FreeAtom(env->ctx, key);
    JS_FreeValue(env->ctx, sym);
    if (result) return napi_create_reference(env, js_object, 0, result);
    OK(env);
}
napi_status node_api_post_finalizer(napi_env benv, napi_finalize finalize_cb, void *finalize_data,
                                    void *finalize_hint)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, finalize_cb);
    queue_finalizer(env, finalize_cb, finalize_data, finalize_hint); OK(env);
}

napi_status napi_type_tag_object(napi_env env, napi_value value, const napi_type_tag *type_tag)
{
    JSValue holder;
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, type_tag);
    if (!to_object_check(env, value, &o)) FAIL(env, napi_object_expected);
    if (own_holder(env, o, tag_atom(), NULL)) FAIL(env, napi_invalid_arg);
    h = new_holder(env, NULL, NULL, NULL);
    if (!h) FAIL(env, napi_generic_failure);
    h->tag[0] = type_tag->lower;
    h->tag[1] = type_tag->upper;
    h->has_tag = 1;
    holder = JS_NewObjectClass(env->ctx, cls_holder);
    JS_SetOpaque(holder, h);
    JS_DefinePropertyValue(env->ctx, o, tag_atom(), holder, 0);
    OK(env);
}
napi_status napi_check_object_type_tag(napi_env env, napi_value value, const napi_type_tag *type_tag, bool *result)
{
    fg_holder *h;
    JSValueConst o;
    PREAMBLE(env); CHECK_ARG(env, value); CHECK_ARG(env, type_tag); CHECK_ARG(env, result);
    if (!to_object_check(env, value, &o)) FAIL(env, napi_object_expected);
    h = own_holder(env, o, tag_atom(), NULL);
    *result = h && h->has_tag && h->tag[0] == type_tag->lower && h->tag[1] == type_tag->upper;
    OK(env);
}

napi_status napi_create_external(napi_env env, void *data, napi_finalize finalize_cb, void *finalize_hint,
                                 napi_value *result)
{
    JSValue o;
    fg_holder *h;
    CHECK_ENV(env); CHECK_ARG(env, result);
    h = new_holder(env, data, (void *) finalize_cb, finalize_hint);
    if (!h) FAIL(env, napi_generic_failure);
    o = JS_NewObjectClass(env->ctx, cls_ext);
    JS_SetOpaque(o, h);
    *result = H(o); OK(env);
}
napi_status napi_get_value_external(napi_env env, napi_value value, void **result)
{
    fg_holder *h;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    h = JS_GetOpaque(V(value), cls_ext);
    if (!h) FAIL(env, napi_invalid_arg);
    *result = h->data; OK(env);
}

napi_status napi_set_instance_data(napi_env benv, void *data, napi_finalize finalize_cb, void *finalize_hint)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env);
    env->instance_data = data;
    env->instance_fin = finalize_cb;
    env->instance_hint = finalize_hint; OK(env);
}
napi_status napi_get_instance_data(napi_env benv, void **data)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, data);
    *data = env->instance_data; OK(env);
}
napi_status napi_adjust_external_memory(napi_env benv, int64_t change_in_bytes, int64_t *adjusted_value)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, adjusted_value);
    g_external_memory += change_in_bytes;
    *adjusted_value = g_external_memory; OK(env);
}
napi_status napi_get_version(napi_env benv, uint32_t *result)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = 10; OK(env);
}

static const napi_node_version node_version = { 22, 12, 0, "node" };
napi_status napi_get_node_version(napi_env benv, const napi_node_version **version)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, version);
    *version = &node_version; OK(env);
}
napi_status node_api_get_module_file_name(napi_env benv, const char **result)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = env->filename ? env->filename : ""; OK(env);
}
#ifndef _WIN32
/* The loop an addon is handed is never used to run anything: the functions below that take one queue their work
   here and finish it on the JavaScript thread, so a zeroed loop of the right size is all it has to be. */
static uv_loop_t g_uv_loop;
#endif
napi_status napi_get_uv_event_loop(napi_env benv, struct uv_loop_s **loop)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env);
#ifndef _WIN32
    CHECK_ARG(env, loop);
    *loop = &g_uv_loop;
    OK(env);
#else
    (void) loop;
    FAIL(env, napi_generic_failure);
#endif
}

/* ---- promises ---------------------------------------------------------------------------- */

napi_status napi_create_promise(napi_env env, napi_deferred *deferred, napi_value *promise)
{
    fg_deferred *d;
    JSValue funcs[2], p;
    PREAMBLE(env); CHECK_ARG(env, deferred); CHECK_ARG(env, promise);
    p = JS_NewPromiseCapability(env->ctx, funcs);
    if (JS_IsException(p)) return catch_exception(env);
    d = malloc(sizeof(*d));
    if (!d) { JS_FreeValue(env->ctx, p); FAIL(env, napi_generic_failure); }
    d->resolve = funcs[0];
    d->reject = funcs[1];
    *deferred = (napi_deferred) d;
    *promise = H(p); OK(env);
}
static napi_status conclude(napi_env env, napi_deferred deferred, napi_value value, int reject)
{
    fg_deferred *d = (fg_deferred *) deferred;
    JSValue r;
    PREAMBLE(env); CHECK_ARG(env, deferred); CHECK_ARG(env, value);
    r = JS_Call(env->ctx, reject ? d->reject : d->resolve, JS_UNDEFINED, 1, &V(value));
    JS_FreeValue(env->ctx, d->resolve);
    JS_FreeValue(env->ctx, d->reject);
    free(d);
    if (JS_IsException(r)) return catch_exception(env);
    JS_FreeValue(env->ctx, r); OK(env);
}
napi_status napi_resolve_deferred(napi_env env, napi_deferred deferred, napi_value resolution)
{ return conclude(env, deferred, resolution, 0); }
napi_status napi_reject_deferred(napi_env env, napi_deferred deferred, napi_value rejection)
{ return conclude(env, deferred, rejection, 1); }
napi_status napi_is_promise(napi_env env, napi_value value, bool *is_promise)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, is_promise);
    *is_promise = JS_IsPromise(V(value)); OK(env);
}

/* ---- array buffers, typed arrays, Buffers ------------------------------------------------- */

static void *owned_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size)
{
    if (size == 0) { free(ptr); return NULL; }
    return realloc(ptr, size);
}

typedef struct { napi_env env; napi_finalize cb; void *hint; } ext_buf;
static void *external_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size)
{
    ext_buf *e = opaque;
    if (size != 0) return NULL;
    if (e) {
        queue_finalizer(e->env, e->cb, ptr, e->hint);
        free(e);
    }
    return NULL;
}

static JSValue new_owned_buffer(napi_env env, size_t len, void **data)
{
    uint8_t *mem = calloc(len ? len : 1, 1);
    JSValue ab;
    if (!mem) return JS_EXCEPTION;
    ab = JS_NewArrayBuffer(env->ctx, mem, len, 0, owned_realloc, NULL, false);
    if (JS_IsException(ab)) { free(mem); return ab; }
    if (data) *data = mem;
    return ab;
}

static JSValue new_external_buffer(napi_env env, void *data, size_t len, napi_finalize fin, void *hint)
{
    ext_buf *e = NULL;
    JSValue ab;
    if (fin) {
        e = malloc(sizeof(*e));
        if (!e) return JS_EXCEPTION;
        e->env = env;
        e->cb = fin;
        e->hint = hint;
    }
    ab = JS_NewArrayBuffer(env->ctx, data, len, 0, external_realloc, e, false);
    if (JS_IsException(ab)) free(e);
    return ab;
}

napi_status napi_create_arraybuffer(napi_env env, size_t byte_length, void **data, napi_value *result)
{
    JSValue ab;
    PREAMBLE(env); CHECK_ARG(env, result);
    ab = new_owned_buffer(env, byte_length, data);
    if (JS_IsException(ab)) return catch_exception(env);
    *result = H(ab); OK(env);
}
napi_status napi_create_external_arraybuffer(napi_env env, void *external_data, size_t byte_length,
                                             napi_finalize finalize_cb, void *finalize_hint, napi_value *result)
{
    JSValue ab;
    PREAMBLE(env); CHECK_ARG(env, result);
    ab = new_external_buffer(env, external_data, byte_length, finalize_cb, finalize_hint);
    if (JS_IsException(ab)) return catch_exception(env);
    *result = H(ab); OK(env);
}
napi_status napi_is_arraybuffer(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_IsArrayBuffer(V(value)); OK(env);
}
napi_status napi_get_arraybuffer_info(napi_env env, napi_value arraybuffer, void **data, size_t *byte_length)
{
    size_t len = 0;
    uint8_t *p;
    CHECK_ENV(env); CHECK_ARG(env, arraybuffer);
    if (!JS_IsArrayBuffer(V(arraybuffer))) FAIL(env, napi_invalid_arg);
    p = JS_GetArrayBuffer(env->ctx, &len, V(arraybuffer));
    if (data) *data = p;
    if (byte_length) *byte_length = len;
    OK(env);
}
napi_status napi_detach_arraybuffer(napi_env env, napi_value arraybuffer)
{
    CHECK_ENV(env); CHECK_ARG(env, arraybuffer);
    if (!JS_IsArrayBuffer(V(arraybuffer))) FAIL(env, napi_arraybuffer_expected);
    JS_DetachArrayBuffer(env->ctx, V(arraybuffer)); OK(env);
}
napi_status napi_is_detached_arraybuffer(napi_env env, napi_value value, bool *result)
{
    size_t len = 0;
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_IsArrayBuffer(V(value)) && JS_GetArrayBuffer(env->ctx, &len, V(value)) == NULL;
    if (*result) JS_FreeValue(env->ctx, JS_GetException(env->ctx));
    OK(env);
}

/* napi_typedarray_type -> quickjs's JSTypedArrayEnum */
static int ta_to_js(napi_typedarray_type t)
{
    switch (t) {
    case napi_int8_array: return JS_TYPED_ARRAY_INT8;
    case napi_uint8_array: return JS_TYPED_ARRAY_UINT8;
    case napi_uint8_clamped_array: return JS_TYPED_ARRAY_UINT8C;
    case napi_int16_array: return JS_TYPED_ARRAY_INT16;
    case napi_uint16_array: return JS_TYPED_ARRAY_UINT16;
    case napi_int32_array: return JS_TYPED_ARRAY_INT32;
    case napi_uint32_array: return JS_TYPED_ARRAY_UINT32;
    case napi_float32_array: return JS_TYPED_ARRAY_FLOAT32;
    case napi_float64_array: return JS_TYPED_ARRAY_FLOAT64;
    case napi_bigint64_array: return JS_TYPED_ARRAY_BIG_INT64;
    case napi_biguint64_array: return JS_TYPED_ARRAY_BIG_UINT64;
    default: return -1;
    }
}
static int ta_from_js(int t, napi_typedarray_type *out)
{
    switch (t) {
    case JS_TYPED_ARRAY_INT8: *out = napi_int8_array; return 1;
    case JS_TYPED_ARRAY_UINT8: *out = napi_uint8_array; return 1;
    case JS_TYPED_ARRAY_UINT8C: *out = napi_uint8_clamped_array; return 1;
    case JS_TYPED_ARRAY_INT16: *out = napi_int16_array; return 1;
    case JS_TYPED_ARRAY_UINT16: *out = napi_uint16_array; return 1;
    case JS_TYPED_ARRAY_INT32: *out = napi_int32_array; return 1;
    case JS_TYPED_ARRAY_UINT32: *out = napi_uint32_array; return 1;
    case JS_TYPED_ARRAY_FLOAT32: *out = napi_float32_array; return 1;
    case JS_TYPED_ARRAY_FLOAT64: *out = napi_float64_array; return 1;
    case JS_TYPED_ARRAY_BIG_INT64: *out = napi_bigint64_array; return 1;
    case JS_TYPED_ARRAY_BIG_UINT64: *out = napi_biguint64_array; return 1;
    default: return 0;
    }
}
static size_t ta_size(napi_typedarray_type t)
{
    switch (t) {
    case napi_int8_array: case napi_uint8_array: case napi_uint8_clamped_array: return 1;
    case napi_int16_array: case napi_uint16_array: return 2;
    case napi_int32_array: case napi_uint32_array: case napi_float32_array: return 4;
    default: return 8;
    }
}

napi_status napi_create_typedarray(napi_env env, napi_typedarray_type type, size_t length, napi_value arraybuffer,
                                   size_t byte_offset, napi_value *result)
{
    JSValue args[3], ta;
    int jt;
    PREAMBLE(env); CHECK_ARG(env, arraybuffer); CHECK_ARG(env, result);
    if (!JS_IsArrayBuffer(V(arraybuffer))) FAIL(env, napi_invalid_arg);
    jt = ta_to_js(type);
    if (jt < 0) FAIL(env, napi_invalid_arg);
    if (byte_offset % ta_size(type) != 0) {
        JS_FreeValue(env->ctx, JS_ThrowRangeError(env->ctx, "start offset of %s should be a multiple of %zu",
                                                  "typed array", ta_size(type)));
        catch_exception(env);
        FAIL(env, napi_pending_exception);
    }
    args[0] = V(arraybuffer);
    args[1] = JS_NewInt64(env->ctx, (int64_t) byte_offset);
    args[2] = JS_NewInt64(env->ctx, (int64_t) length);
    ta = JS_NewTypedArray(env->ctx, 3, args, jt);
    if (JS_IsException(ta)) return catch_exception(env);
    *result = H(ta); OK(env);
}
napi_status napi_is_typedarray(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_GetTypedArrayType(V(value)) >= 0; OK(env);
}
napi_status napi_get_typedarray_info(napi_env env, napi_value typedarray, napi_typedarray_type *type, size_t *length,
                                     void **data, napi_value *arraybuffer, size_t *byte_offset)
{
    size_t off = 0, blen = 0, per = 1, total = 0;
    JSValue buf;
    uint8_t *base;
    napi_typedarray_type nt;
    int jt;
    PREAMBLE(env); CHECK_ARG(env, typedarray);
    jt = JS_GetTypedArrayType(V(typedarray));
    if (jt < 0 || !ta_from_js(jt, &nt)) FAIL(env, napi_invalid_arg);
    buf = JS_GetTypedArrayBuffer(env->ctx, V(typedarray), &off, &blen, &per);
    if (JS_IsException(buf)) return catch_exception(env);
    base = JS_GetArrayBuffer(env->ctx, &total, buf);
    if (type) *type = nt;
    if (length) *length = per ? blen / per : 0;
    if (data) *data = base ? base + off : NULL;
    if (arraybuffer) *arraybuffer = H(buf); else JS_FreeValue(env->ctx, buf);
    if (byte_offset) *byte_offset = off;
    OK(env);
}
napi_status napi_create_dataview(napi_env env, size_t length, napi_value arraybuffer, size_t byte_offset,
                                 napi_value *result)
{
    JSValue args[3], dv;
    PREAMBLE(env); CHECK_ARG(env, arraybuffer); CHECK_ARG(env, result);
    if (!JS_IsArrayBuffer(V(arraybuffer))) FAIL(env, napi_invalid_arg);
    args[0] = V(arraybuffer);
    args[1] = JS_NewInt64(env->ctx, (int64_t) byte_offset);
    args[2] = JS_NewInt64(env->ctx, (int64_t) length);
    dv = prelude_call(env, "mkview", 3, args);
    if (JS_IsException(dv)) return catch_exception(env);
    *result = H(dv); OK(env);
}
napi_status napi_is_dataview(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_IsDataView(V(value)); OK(env);
}
napi_status napi_get_dataview_info(napi_env env, napi_value dataview, size_t *bytelength, void **data,
                                   napi_value *arraybuffer, size_t *byte_offset)
{
    JSValue buf, len, off;
    size_t total = 0;
    int64_t l = 0, o = 0;
    uint8_t *base;
    PREAMBLE(env); CHECK_ARG(env, dataview);
    if (!JS_IsDataView(V(dataview))) FAIL(env, napi_invalid_arg);
    buf = JS_GetPropertyStr(env->ctx, V(dataview), "buffer");
    len = JS_GetPropertyStr(env->ctx, V(dataview), "byteLength");
    off = JS_GetPropertyStr(env->ctx, V(dataview), "byteOffset");
    JS_ToInt64(env->ctx, &l, len);
    JS_ToInt64(env->ctx, &o, off);
    JS_FreeValue(env->ctx, len);
    JS_FreeValue(env->ctx, off);
    base = JS_GetArrayBuffer(env->ctx, &total, buf);
    if (bytelength) *bytelength = (size_t) l;
    if (data) *data = base ? base + o : NULL;
    if (byte_offset) *byte_offset = (size_t) o;
    if (arraybuffer) *arraybuffer = H(buf); else JS_FreeValue(env->ctx, buf);
    OK(env);
}

/* Node's Buffer is a Uint8Array subclass that lives in node-compat.js, so a Buffer is made by
   handing that class an ArrayBuffer over the same memory rather than by copying. */
static napi_status wrap_buffer(napi_env env, JSValue ab, size_t len, napi_value *result)
{
    JSValue args[3], from, buf;
    if (JS_IsUndefined(g_buffer)) {
        JS_FreeValue(env->ctx, ab);
        FAIL(env, napi_generic_failure);
    }
    from = JS_GetPropertyStr(env->ctx, g_buffer, "from");
    args[0] = ab;
    args[1] = JS_NewInt32(env->ctx, 0);
    args[2] = JS_NewInt64(env->ctx, (int64_t) len);
    buf = JS_Call(env->ctx, from, g_buffer, 3, args);
    JS_FreeValue(env->ctx, from);
    JS_FreeValue(env->ctx, ab);
    if (JS_IsException(buf)) return catch_exception(env);
    *result = H(buf); OK(env);
}
napi_status napi_create_buffer(napi_env env, size_t length, void **data, napi_value *result)
{
    JSValue ab;
    PREAMBLE(env); CHECK_ARG(env, result);
    ab = new_owned_buffer(env, length, data);
    if (JS_IsException(ab)) return catch_exception(env);
    return wrap_buffer(env, ab, length, result);
}
napi_status napi_create_buffer_copy(napi_env env, size_t length, const void *data, void **result_data,
                                    napi_value *result)
{
    void *mem = NULL;
    JSValue ab;
    PREAMBLE(env); CHECK_ARG(env, result);
    ab = new_owned_buffer(env, length, &mem);
    if (JS_IsException(ab)) return catch_exception(env);
    if (length && data) memcpy(mem, data, length);
    if (result_data) *result_data = mem;
    return wrap_buffer(env, ab, length, result);
}
napi_status napi_create_external_buffer(napi_env env, size_t length, void *data, napi_finalize finalize_cb,
                                        void *finalize_hint, napi_value *result)
{
    JSValue ab;
    PREAMBLE(env); CHECK_ARG(env, result);
    ab = new_external_buffer(env, data, length, finalize_cb, finalize_hint);
    if (JS_IsException(ab)) return catch_exception(env);
    return wrap_buffer(env, ab, length, result);
}
napi_status node_api_create_buffer_from_arraybuffer(napi_env env, napi_value arraybuffer, size_t byte_offset,
                                                    size_t byte_length, napi_value *result)
{
    return napi_create_typedarray(env, napi_uint8_array, byte_length, arraybuffer, byte_offset, result);
}
napi_status napi_is_buffer(napi_env env, napi_value value, bool *result)
{
    CHECK_ENV(env); CHECK_ARG(env, value); CHECK_ARG(env, result);
    *result = JS_GetTypedArrayType(V(value)) >= 0 || JS_IsDataView(V(value)); OK(env);
}
napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data, size_t *length)
{
    CHECK_ENV(env); CHECK_ARG(env, value);
    if (JS_GetTypedArrayType(V(value)) >= 0) {
        return napi_get_typedarray_info(env, value, NULL, length, data, NULL, NULL);
    }
    if (JS_IsDataView(V(value))) return napi_get_dataview_info(env, value, length, data, NULL, NULL);
    FAIL(env, napi_invalid_arg);
}

/* ---- async work -------------------------------------------------------------------------- */

napi_status napi_create_async_work(napi_env env, napi_value async_resource, napi_value async_resource_name,
                                   napi_async_execute_callback execute, napi_async_complete_callback complete,
                                   void *data, napi_async_work *result)
{
    napi_async_work w;
    CHECK_ENV(env); CHECK_ARG(env, execute); CHECK_ARG(env, result);
    w = calloc(1, sizeof(*w));
    if (!w) FAIL(env, napi_generic_failure);
    w->env = env;
    w->execute = execute;
    w->complete = complete;
    w->data = data;
    *result = w; OK(env);
}
napi_status napi_delete_async_work(napi_env env, napi_async_work work)
{
    CHECK_ENV(env); CHECK_ARG(env, work);
    /* Deleting from inside its own complete callback is the normal case; the task that carried it
       is already gone by then, so the memory is simply released. */
    free(work); OK(env);
}
static void work_thread(void *arg)
{
    napi_async_work w = arg;
    w->execute(w->env, w->data);
    post_task(0, w, NULL);
}
napi_status napi_queue_async_work(napi_env benv, napi_async_work work)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, work);
    work->status = 1;
    live_inc();
    if (fg_thread_start(work_thread, work) != 0) {
        live_dec();
        work->status = 0;
        FAIL(env, napi_generic_failure);
    }
    OK(env);
}
napi_status napi_cancel_async_work(napi_env benv, napi_async_work work)
{
    napi_env env = (napi_env) benv;
    CHECK_ENV(env); CHECK_ARG(env, work);
    /* Work starts running the moment it is queued, so there is never a not-yet-started item to pull back. */
    FAIL(env, napi_generic_failure);
}

napi_status napi_async_init(napi_env env, napi_value async_resource, napi_value async_resource_name,
                            napi_async_context *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = (napi_async_context) 1; OK(env);
}
napi_status napi_async_destroy(napi_env env, napi_async_context async_context)
{
    CHECK_ENV(env); OK(env);
}
napi_status napi_make_callback(napi_env env, napi_async_context async_context, napi_value recv, napi_value func,
                               size_t argc, const napi_value *argv, napi_value *result)
{
    return napi_call_function(env, recv, func, argc, argv, result);
}
napi_status napi_open_callback_scope(napi_env env, napi_value resource_object, napi_async_context context,
                                     napi_callback_scope *result)
{
    CHECK_ENV(env); CHECK_ARG(env, result);
    *result = (napi_callback_scope) 1; OK(env);
}
napi_status napi_close_callback_scope(napi_env env, napi_callback_scope scope)
{
    CHECK_ENV(env); OK(env);
}

/* ---- thread-safe functions --------------------------------------------------------------- */

napi_status napi_create_threadsafe_function(napi_env env, napi_value func, napi_value async_resource,
                                            napi_value async_resource_name, size_t max_queue_size,
                                            size_t initial_thread_count, void *thread_finalize_data,
                                            napi_finalize thread_finalize_cb, void *context,
                                            napi_threadsafe_function_call_js call_js_cb,
                                            napi_threadsafe_function *result)
{
    napi_threadsafe_function t;
    CHECK_ENV(env); CHECK_ARG(env, result);
    if (initial_thread_count == 0) FAIL(env, napi_invalid_arg);
    if (!func && !call_js_cb) FAIL(env, napi_invalid_arg);
    if (func && !JS_IsFunction(env->ctx, V(func))) FAIL(env, napi_function_expected);
    t = calloc(1, sizeof(*t));
    if (!t) FAIL(env, napi_generic_failure);
    t->env = env;
    t->func = func ? JS_DupValue(env->ctx, V(func)) : JS_UNDEFINED;
    t->context = context;
    t->call_js = call_js_cb;
    t->fin = thread_finalize_cb;
    t->fin_data = thread_finalize_data;
    t->max_queue = max_queue_size;
    t->threads = initial_thread_count;
    t->refd = 1;
    live_inc();
    *result = t; OK(env);
}
napi_status napi_get_threadsafe_function_context(napi_threadsafe_function func, void **result)
{
    if (!func || !result) return napi_invalid_arg;
    *result = func->context;
    return napi_ok;
}
napi_status napi_call_threadsafe_function(napi_threadsafe_function func, void *data,
                                          napi_threadsafe_function_call_mode is_blocking)
{
    napi_status status = napi_ok;
    if (!func) return napi_invalid_arg;
    fg_mutex_lock(&g_lock);
    if (func->closing) {
        status = napi_closing;
    } else if (func->max_queue && func->queued >= func->max_queue && is_blocking == napi_tsfn_nonblocking) {
        status = napi_queue_full;
    } else {
        fg_task *t = malloc(sizeof(*t));
        if (!t) { status = napi_generic_failure; }
        else {
            t->next = NULL;
            t->kind = 1;
            t->target = func;
            t->data = data;
            func->queued++;
            if (g_tasks_tail) g_tasks_tail->next = t; else g_tasks_head = t;
            g_tasks_tail = t;
        }
    }
    fg_mutex_unlock(&g_lock);
    return status;
}
napi_status napi_acquire_threadsafe_function(napi_threadsafe_function func)
{
    napi_status status = napi_ok;
    if (!func) return napi_invalid_arg;
    fg_mutex_lock(&g_lock);
    if (func->closing) status = napi_closing; else func->threads++;
    fg_mutex_unlock(&g_lock);
    return status;
}
napi_status napi_release_threadsafe_function(napi_threadsafe_function func, napi_threadsafe_function_release_mode mode)
{
    int close = 0;
    if (!func) return napi_invalid_arg;
    fg_mutex_lock(&g_lock);
    if (func->threads == 0) {
        fg_mutex_unlock(&g_lock);
        return napi_invalid_arg;
    }
    func->threads--;
    if (mode == napi_tsfn_abort) func->closing = 1;
    if (func->threads == 0 || mode == napi_tsfn_abort) {
        if (!func->closing || mode == napi_tsfn_abort) {
            func->closing = 1;
            close = 1;
        }
    }
    fg_mutex_unlock(&g_lock);
    if (close) post_task(2, func, NULL);
    return napi_ok;
}
napi_status napi_unref_threadsafe_function(napi_env benv, napi_threadsafe_function func)
{
    if (!func) return napi_invalid_arg;
    if (func->refd) { func->refd = 0; live_dec(); }
    return napi_ok;
}
napi_status napi_ref_threadsafe_function(napi_env benv, napi_threadsafe_function func)
{
    if (!func) return napi_invalid_arg;
    if (!func->refd) { func->refd = 1; live_inc(); }
    return napi_ok;
}

/* ---- cleanup hooks ----------------------------------------------------------------------- */

napi_status napi_add_env_cleanup_hook(napi_env benv, napi_cleanup_hook fun, void *arg)
{
    napi_env env = (napi_env) benv;
    fg_hook *h;
    CHECK_ENV(env); CHECK_ARG(env, fun);
    h = malloc(sizeof(*h));
    if (!h) FAIL(env, napi_generic_failure);
    h->fun = fun;
    h->arg = arg;
    h->next = g_hooks;
    g_hooks = h; OK(env);
}
napi_status napi_remove_env_cleanup_hook(napi_env benv, napi_cleanup_hook fun, void *arg)
{
    napi_env env = (napi_env) benv;
    fg_hook **p;
    CHECK_ENV(env);
    for (p = &g_hooks; *p; p = &(*p)->next) {
        if ((*p)->fun == fun && (*p)->arg == arg) {
            fg_hook *dead = *p;
            *p = dead->next;
            free(dead);
            break;
        }
    }
    OK(env);
}
struct napi_async_cleanup_hook_handle__ { napi_env env; napi_async_cleanup_hook fun; void *arg; };
static void async_hook_thunk(void *p)
{
    struct napi_async_cleanup_hook_handle__ *h = p;
    h->fun(h, h->arg);
}
napi_status napi_add_async_cleanup_hook(napi_env benv, napi_async_cleanup_hook hook, void *arg,
                                        napi_async_cleanup_hook_handle *remove_handle)
{
    napi_env env = (napi_env) benv;
    struct napi_async_cleanup_hook_handle__ *h;
    CHECK_ENV(env); CHECK_ARG(env, hook);
    h = malloc(sizeof(*h));
    if (!h) FAIL(env, napi_generic_failure);
    h->env = env;
    h->fun = hook;
    h->arg = arg;
    napi_add_env_cleanup_hook(benv, async_hook_thunk, h);
    if (remove_handle) *remove_handle = h;
    OK(env);
}
napi_status napi_remove_async_cleanup_hook(napi_async_cleanup_hook_handle remove_handle)
{
    if (!remove_handle) return napi_invalid_arg;
    napi_remove_env_cleanup_hook(remove_handle->env, async_hook_thunk, remove_handle);
    free(remove_handle);
    return napi_ok;
}

/* ---- module loading ---------------------------------------------------------------------- */

void napi_module_register(napi_module *mod) { g_registered_module = mod; }

static napi_env env_new(JSContext *ctx, const char *filename)
{
    napi_env env = calloc(1, sizeof(*env));
    if (!env) return NULL;
    env->ctx = ctx;
    env->pending = JS_UNDEFINED;
    env->api_version = 8;
    env->filename = filename ? strdup(filename) : NULL;
    return env;
}

#if defined(_WIN32)
static void *open_library(const char *path, char *err, size_t errlen)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, NULL, 0);
    wchar_t *wide = malloc((size_t) n * sizeof(wchar_t));
    HMODULE m;
    if (!wide) { snprintf(err, errlen, "out of memory"); return NULL; }
    MultiByteToWideChar(CP_UTF8, 0, path, -1, wide, n);
    m = LoadLibraryExW(wide, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    free(wide);
    if (!m) {
        DWORD code = GetLastError();
        char text[256] = "";
        const char *hint = "";
        FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0, text, sizeof(text), NULL);
        {
            size_t len = strlen(text);
            while (len && (text[len - 1] == '\r' || text[len - 1] == '\n' || text[len - 1] == ' ')) text[--len] = '\0';
        }
        /* The two codes an addon built for a newer Windows than this one usually fails with. */
        if (code == 127) hint = " -- the addon imports a Windows function this version of Windows does not have (it was built for a newer Windows)";
        else if (code == 126) hint = " -- the addon, or a DLL it depends on, was not found (it may need the Visual C++ runtime)";
        else if (code == 193) hint = " -- the addon was built for a different architecture than this program";
        snprintf(err, errlen, "%s (Windows error %lu)%s", text[0] ? text : "LoadLibrary failed", (unsigned long) code, hint);
    }
    return m;
}
static void *find_symbol(void *lib, const char *name) { return (void *) GetProcAddress((HMODULE) lib, name); }
#elif defined(FG_NO_DLOPEN)
static void *open_library(const char *path, char *err, size_t errlen)
{
    snprintf(err, errlen,
             "this Graak build is statically linked, and a static executable cannot load shared "
             "libraries. Build the dynamic variant for this target to use native addons");
    return NULL;
}
static void *find_symbol(void *lib, const char *name) { return NULL; }
#else
static void *open_library(const char *path, char *err, size_t errlen)
{
    /* Lazy binding: an addon that imports an N-API function this host lacks still loads, and only
       fails if it actually calls it, instead of refusing to start over one unused symbol. */
    void *lib = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
    if (!lib) {
        const char *e = dlerror();
        snprintf(err, errlen, "%s", e ? e : "dlopen failed");
    }
    return lib;
}
static void *find_symbol(void *lib, const char *name) { return dlsym(lib, name); }
#endif

static JSValue fg_dlopen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *path;
    char err[512];
    void *lib;
    napi_env env;
    napi_addon_register_func init;
    napi_module *legacy = NULL;
    int32_t (*get_version)(void);
    size_t mark = g_top;
    napi_value ret;
    JSValue out;

    if (argc < 2) return JS_ThrowTypeError(ctx, "dlopen(path, exports) expects two arguments");
    path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;

    g_registered_module = NULL;
    lib = open_library(path, err, sizeof(err));
    if (!lib) {
        JSValue e = JS_ThrowInternalError(ctx, "Cannot load native addon '%s': %s", path, err);
        JS_FreeCString(ctx, path);
        return e;
    }
    init = (napi_addon_register_func) find_symbol(lib, "napi_register_module_v1");
    if (!init) {
        legacy = g_registered_module;
        if (legacy) init = legacy->nm_register_func;
    }
    if (!init) {
        /* An addon built against Graak's V8 layer (quickjs/native/v8) whose registration function
           is the one NAN generates itself: `node_register_module_v72(exports, module, context)`. The
           layer needs to be told which env it is running in first, which is what fg_v8_set_env is for.
           Its presence also proves the addon was built for this host, so calling the registration
           function is safe; an addon built against real V8 has neither and is refused below. */
        void (*set_env)(napi_env) = (void (*)(napi_env)) find_symbol(lib, "fg_v8_set_env");
        void (*v8_init)(napi_value, napi_value, napi_value) =
            (void (*)(napi_value, napi_value, napi_value)) find_symbol(lib, "node_register_module_v72");
        if (set_env && v8_init) {
            napi_value module_obj, global, exports_value;
            size_t mark_v8 = g_top;
            napi_env venv = env_new(ctx, path);
            JSValue result;
            if (!venv) {
                JS_FreeCString(ctx, path);
                return JS_ThrowOutOfMemory(ctx);
            }
            set_env(venv);
            exports_value = H(JS_DupValue(ctx, argv[1]));
            module_obj = H(JS_NewObject(ctx));
            JS_SetPropertyStr(ctx, V(module_obj), "exports", JS_DupValue(ctx, V(exports_value)));
            global = H(JS_GetGlobalObject(ctx));
            v8_init(exports_value, module_obj, global);
            JS_FreeCString(ctx, path);
            if (venv->has_pending) {
                JSValue e = venv->pending;
                venv->has_pending = 0;
                handles_close(mark_v8);
                return JS_Throw(ctx, e);
            }
            result = JS_GetPropertyStr(ctx, V(module_obj), "exports");
            handles_close(mark_v8);
            run_finalizers();
            return result;
        }
    }
    if (!init) {
        JSValue e = JS_ThrowInternalError(ctx,
            "'%s' is not a Node-API addon, and was not built against Graak's V8 layer either. An addon "
            "compiled against V8 or NAN reads V8's own memory layout, which exists only inside Node.js, so a "
            "prebuilt binary of one cannot load here. Rebuild it from source with the Graak V8 headers "
            "(quickjs/native/v8), which `graak compile` does for a project that ships the source.", path);
        JS_FreeCString(ctx, path);
        return e;
    }

    env = env_new(ctx, path);
    JS_FreeCString(ctx, path);
    if (!env) return JS_ThrowOutOfMemory(ctx);
    get_version = (int32_t (*)(void)) find_symbol(lib, "node_api_module_get_api_version_v1");
    if (get_version) env->api_version = get_version();

    ret = init(env, H(JS_DupValue(ctx, argv[1])));
    if (env->has_pending) {
        JSValue e = env->pending;
        env->has_pending = 0;
        handles_close(mark);
        return JS_Throw(ctx, e);
    }
    out = ret ? JS_DupValue(ctx, V(ret)) : JS_DupValue(ctx, argv[1]);
    handles_close(mark);
    run_finalizers();
    return out;
}


/* ---- libuv subset ------------------------------------------------------------------------ */

#ifndef _WIN32
/*
 * Addons in the Holepunch family (rocksdb-native, and others built on the same toolkit) call libuv directly, next to
 * Node-API: they queue work on its thread pool and do file I/O through uv_fs_*. The host exports the part of libuv's
 * ABI they use, so their prebuilt binaries bind to it as they bind to Node's own libuv:
 *
 *   uv_queue_work, uv_fs_open/close/read/write/mkdir/req_cleanup, uv_buf_init, uv_err_name, uv_strerror.
 *
 * Work runs on an operating-system thread and its completion callback is delivered on the JavaScript thread by the
 * same pump as Node-API async work. A request without a callback runs at once, as libuv's synchronous mode does.
 * Requests are laid out by libuv's own headers (uv.h), so the fields an addon reads are where it expects them.
 * Not provided: the rest of libuv (handles, timers, sockets); an addon that needs those fails to bind, naming them.
 */

uv_buf_t uv_buf_init(char *base, unsigned int len)
{
    uv_buf_t buf;
    buf.base = base;
    buf.len = len;
    return buf;
}

const char *uv_err_name(int err)
{
    switch (err) {
    case UV_ENOENT: return "ENOENT";
    case UV_EEXIST: return "EEXIST";
    case UV_EACCES: return "EACCES";
    case UV_EPERM: return "EPERM";
    case UV_EINVAL: return "EINVAL";
    case UV_EIO: return "EIO";
    case UV_ENOSPC: return "ENOSPC";
    case UV_EBADF: return "EBADF";
    case UV_EISDIR: return "EISDIR";
    case UV_ENOTDIR: return "ENOTDIR";
    case UV_ENOTEMPTY: return "ENOTEMPTY";
    case UV_EMFILE: return "EMFILE";
    case UV_EAGAIN: return "EAGAIN";
    case UV_ENOMEM: return "ENOMEM";
    case UV_EBUSY: return "EBUSY";
    case UV_EROFS: return "EROFS";
    case UV_ENAMETOOLONG: return "ENAMETOOLONG";
    default: return "UNKNOWN";
    }
}

const char *uv_strerror(int err)
{
    return err < 0 ? strerror(-err) : "success";
}

static void uv_work_thread(void *arg)
{
    uv_work_t *req = arg;
    req->work_cb(req);
    post_task(3, req, NULL);
}

int uv_queue_work(uv_loop_t *loop, uv_work_t *req, uv_work_cb work_cb, uv_after_work_cb after_work_cb)
{
    if (!req || !work_cb) return UV_EINVAL;
    req->type = UV_WORK;
    req->loop = loop;
    req->work_cb = work_cb;
    req->after_work_cb = after_work_cb;
    live_inc();
    if (fg_thread_start(uv_work_thread, req) != 0) {
        live_dec();
        return UV_ENOMEM;
    }
    return 0;
}

/* Runs the operation a uv_fs_t describes and stores its result (a count or descriptor, or a negative errno). */
static void uv_fs_execute(uv_fs_t *req)
{
    ssize_t r = 0;
    switch (req->fs_type) {
    case UV_FS_OPEN:
        r = open(req->path, req->flags, req->mode);
        break;
    case UV_FS_CLOSE:
        r = close(req->file);
        break;
    case UV_FS_MKDIR:
        r = mkdir(req->path, (mode_t) req->mode);
        break;
    case UV_FS_READ:
    case UV_FS_WRITE: {
        int is_read = req->fs_type == UV_FS_READ;
        off_t at = req->off;
        ssize_t total = 0;
        for (unsigned int i = 0; i < req->nbufs && r >= 0; i++) {
            char *base = req->bufs[i].base;
            size_t left = req->bufs[i].len;
            while (left > 0) {
                ssize_t n;
                if (at < 0) n = is_read ? read(req->file, base, left) : write(req->file, base, left);
                else n = is_read ? pread(req->file, base, left, at + total) : pwrite(req->file, base, left, at + total);
                if (n < 0) {
                    if (errno == EINTR) continue;
                    r = -1;
                    break;
                }
                if (n == 0) break;
                base += n;
                left -= (size_t) n;
                total += n;
            }
            if (left > 0) break; /* a short read: the file ended */
        }
        if (r >= 0) r = total;
        break;
    }
    default:
        r = -1;
        errno = ENOSYS;
    }
    req->result = r < 0 ? -errno : r;
}

static void uv_fs_thread(void *arg)
{
    uv_fs_t *req = arg;
    uv_fs_execute(req);
    post_task(4, req, NULL);
}

/* Fills the request, then runs it now (no callback) or on a thread with the callback delivered later. */
static int uv_fs_submit(uv_loop_t *loop, uv_fs_t *req, uv_fs_type type, uv_fs_cb cb)
{
    req->type = UV_FS;
    req->fs_type = type;
    req->loop = loop;
    req->cb = cb;
    req->result = 0;
    req->ptr = NULL;
    if (!cb) {
        uv_fs_execute(req);
        return (int) req->result;
    }
    live_inc();
    if (fg_thread_start(uv_fs_thread, req) != 0) {
        live_dec();
        return UV_ENOMEM;
    }
    return 0;
}

int uv_fs_open(uv_loop_t *loop, uv_fs_t *req, const char *path, int flags, int mode, uv_fs_cb cb)
{
    req->path = strdup(path);
    req->flags = flags;
    req->mode = mode;
    return uv_fs_submit(loop, req, UV_FS_OPEN, cb);
}

int uv_fs_close(uv_loop_t *loop, uv_fs_t *req, uv_file file, uv_fs_cb cb)
{
    req->path = NULL;
    req->file = file;
    return uv_fs_submit(loop, req, UV_FS_CLOSE, cb);
}

int uv_fs_mkdir(uv_loop_t *loop, uv_fs_t *req, const char *path, int mode, uv_fs_cb cb)
{
    req->path = strdup(path);
    req->mode = mode;
    return uv_fs_submit(loop, req, UV_FS_MKDIR, cb);
}

static int uv_fs_transfer(uv_loop_t *loop, uv_fs_t *req, uv_fs_type type, uv_file file, const uv_buf_t bufs[],
                          unsigned int nbufs, int64_t offset, uv_fs_cb cb)
{
    req->path = NULL;
    req->file = file;
    req->nbufs = nbufs;
    /* The addon's array may be a stack variable that is gone when a threaded request runs: keep a copy. */
    req->bufs = malloc(sizeof(uv_buf_t) * (nbufs ? nbufs : 1));
    if (!req->bufs) return UV_ENOMEM;
    memcpy(req->bufs, bufs, sizeof(uv_buf_t) * nbufs);
    req->off = (off_t) offset;
    return uv_fs_submit(loop, req, type, cb);
}

int uv_fs_read(uv_loop_t *loop, uv_fs_t *req, uv_file file, const uv_buf_t bufs[], unsigned int nbufs, int64_t offset,
               uv_fs_cb cb)
{
    return uv_fs_transfer(loop, req, UV_FS_READ, file, bufs, nbufs, offset, cb);
}

int uv_fs_write(uv_loop_t *loop, uv_fs_t *req, uv_file file, const uv_buf_t bufs[], unsigned int nbufs, int64_t offset,
                uv_fs_cb cb)
{
    return uv_fs_transfer(loop, req, UV_FS_WRITE, file, bufs, nbufs, offset, cb);
}

void uv_fs_req_cleanup(uv_fs_t *req)
{
    if (!req) return;
    if (req->path) {
        free((void *) req->path);
        req->path = NULL;
    }
    if ((req->fs_type == UV_FS_READ || req->fs_type == UV_FS_WRITE) && req->bufs) {
        free(req->bufs);
        req->bufs = NULL;
    }
}
#endif /* !_WIN32 */

/* ---- pump -------------------------------------------------------------------------------- */

static void report_uncaught(napi_env env)
{
    JSValue e = env->pending;
    env->has_pending = 0;
    JS_Throw(env->ctx, e);
    js_std_dump_error(env->ctx);
    exit(1);
}

static void finish_tsf(napi_threadsafe_function t)
{
    if (t->finalized) return;
    t->finalized = 1;
    if (t->fin) {
        size_t mark = g_top;
        t->fin(t->env, t->fin_data, t->context);
        handles_close(mark);
    }
    if (t->refd) live_dec();
    JS_FreeValue(t->env->ctx, t->func);
    free(t);
}

static JSValue fg_drain(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int processed = 0;
    for (;;) {
        fg_task *t;
        size_t mark = g_top;
        fg_mutex_lock(&g_lock);
        t = g_tasks_head;
        if (t) {
            g_tasks_head = t->next;
            if (!g_tasks_head) g_tasks_tail = NULL;
        }
        fg_mutex_unlock(&g_lock);
        if (!t) break;
        processed++;

        if (t->kind == 0) {
            napi_async_work w = t->target;
            napi_env env = w->env;
            w->status = 2;
            if (w->complete) w->complete(env, napi_ok, w->data);
            live_dec();
            if (env->has_pending) report_uncaught(env);
#ifndef _WIN32
        } else if (t->kind == 3) {
            uv_work_t *w = t->target;
            if (w->after_work_cb) w->after_work_cb(w, 0);
            live_dec();
        } else if (t->kind == 4) {
            uv_fs_t *f = t->target;
            if (f->cb) f->cb(f);
            live_dec();
#endif
        } else if (t->kind == 1) {
            napi_threadsafe_function f = t->target;
            napi_env env = f->env;
            fg_mutex_lock(&g_lock);
            if (f->queued) f->queued--;
            fg_mutex_unlock(&g_lock);
            if (f->call_js) {
                f->call_js(env, JS_IsUndefined(f->func) ? NULL : H(JS_DupValue(ctx, f->func)), f->context, t->data);
            } else if (!JS_IsUndefined(f->func)) {
                JSValue r = JS_Call(ctx, f->func, JS_UNDEFINED, 0, NULL);
                if (JS_IsException(r)) catch_exception(env); else JS_FreeValue(ctx, r);
            }
            if (env->has_pending) report_uncaught(env);
        } else {
            finish_tsf((napi_threadsafe_function) t->target);
        }
        handles_close(mark);
        free(t);
    }
    run_finalizers();
    return JS_NewInt32(ctx, processed);
}

/* ---- setup and shutdown ------------------------------------------------------------------ */

static JSClassDef def_holder = { "NapiHolder", holder_finalizer };
static JSClassDef def_ext = { "External", holder_finalizer };
static JSClassDef def_fn = { "NapiFunctionData", fn_finalizer };

void graak_napi_shutdown(void);

static void napi_atexit(void)
{
    graak_napi_shutdown();
}

void graak_napi_shutdown(void)
{
    if (g_shutdown || !g_ready) return;
    g_shutdown = 1;
    while (g_hooks) {
        fg_hook *h = g_hooks;
        g_hooks = h->next;
        h->fun(h->arg);
        free(h);
    }
    /* What the addons still hold (references, wrapped objects) is theirs to leak at exit, as in
       Node.js; only the runtime's own bookkeeping is released, so the engine can shut down. */
    handles_close(0);
    JS_FreeValue(g_ctx, g_prelude);
    JS_FreeValue(g_ctx, g_class_factory);
    JS_FreeValue(g_ctx, g_buffer);
    JS_FreeValue(g_ctx, g_pump_start);
    JS_FreeValue(g_ctx, g_pump_stop);
    g_prelude = g_class_factory = g_buffer = g_pump_start = g_pump_stop = JS_UNDEFINED;
    if (g_atom_wrap) JS_FreeAtom(g_ctx, g_atom_wrap);
    if (g_atom_tag) JS_FreeAtom(g_ctx, g_atom_tag);
    g_atom_wrap = g_atom_tag = 0;
}

/* napiInit({ Buffer, start, stop }): hands the runtime the JS-side pieces the N-API layer needs. */
static JSValue fg_napi_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsObject(argv[0])) return JS_ThrowTypeError(ctx, "napiInit(options) expects an object");
    JS_FreeValue(ctx, g_buffer);
    JS_FreeValue(ctx, g_pump_start);
    JS_FreeValue(ctx, g_pump_stop);
    g_buffer = JS_GetPropertyStr(ctx, argv[0], "Buffer");
    g_pump_start = JS_GetPropertyStr(ctx, argv[0], "start");
    g_pump_stop = JS_GetPropertyStr(ctx, argv[0], "stop");
    return JS_UNDEFINED;
}

const JSCFunctionListEntry graak_napi_funcs[] = {
    JS_CFUNC_DEF("dlopen", 2, fg_dlopen),
    JS_CFUNC_DEF("napiDrain", 0, fg_drain),
    JS_CFUNC_DEF("napiInit", 1, fg_napi_init),
};
const size_t graak_napi_funcs_count = sizeof(graak_napi_funcs) / sizeof(graak_napi_funcs[0]);

void graak_napi_init(JSContext *ctx)
{
    JSValue factory;
    if (g_ready) return;
    g_ctx = ctx;
    g_rt = JS_GetRuntime(ctx);
    g_buffer = g_pump_start = g_pump_stop = JS_UNDEFINED;
    fg_mutex_init(&g_lock);

    JS_NewClassID(g_rt, &cls_fn);
    JS_NewClassID(g_rt, &cls_ext);
    JS_NewClassID(g_rt, &cls_holder);
    JS_NewClass(g_rt, cls_fn, &def_fn);
    JS_NewClass(g_rt, cls_ext, &def_ext);
    JS_NewClass(g_rt, cls_holder, &def_holder);

    g_prelude = JS_Eval(ctx, PRELUDE, sizeof(PRELUDE) - 1, "<napi-prelude>", JS_EVAL_TYPE_GLOBAL);
    /* A class is an ordinary constructor function whose `this` is the fresh instance, with new.target
       forwarded as the first argument so napi_get_new_target has something to return. */
    factory = JS_Eval(ctx,
        "(function (f, n) { const c = function (...a) { return f.call(this, new.target, ...a); };"
        " Object.defineProperty(c, 'name', { value: n }); return c; })",
        strlen("(function (f, n) { const c = function (...a) { return f.call(this, new.target, ...a); };"
               " Object.defineProperty(c, 'name', { value: n }); return c; })"),
        "<napi-class>", JS_EVAL_TYPE_GLOBAL);
    g_class_factory = factory;
    g_ready = 1;
    atexit(napi_atexit);
}
