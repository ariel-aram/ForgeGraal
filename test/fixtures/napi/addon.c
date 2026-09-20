/*
 * A small Node-API addon used to test the ForgeGraal native host's Node-API layer. It is compiled
 * against the vendored headers with nothing else linked: every napi_* function it calls is resolved
 * from the host executable when the library is loaded, exactly as a real addon's would be.
 */
#include <node_api.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#define CALL(expr) do { if ((expr) != napi_ok) return NULL; } while (0)

static napi_value add(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2], result;
    double a, b;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_value_double(env, argv[0], &a));
    CALL(napi_get_value_double(env, argv[1], &b));
    CALL(napi_create_double(env, a + b, &result));
    return result;
}

static napi_value greet(napi_env env, napi_callback_info info)
{
    size_t argc = 1, len;
    napi_value argv[1], result;
    char name[64], out[96];
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len));
    strcpy(out, "hello, ");
    strcat(out, name);
    CALL(napi_create_string_utf8(env, out, NAPI_AUTO_LENGTH, &result));
    return result;
}

static napi_value make_object(napi_env env, napi_callback_info info)
{
    napi_value obj, n, s, arr, item;
    CALL(napi_create_object(env, &obj));
    CALL(napi_create_int32(env, 42, &n));
    CALL(napi_set_named_property(env, obj, "answer", n));
    CALL(napi_create_string_utf8(env, "ünï", NAPI_AUTO_LENGTH, &s));
    CALL(napi_set_named_property(env, obj, "text", s));
    CALL(napi_create_array_with_length(env, 2, &arr));
    CALL(napi_create_int32(env, 7, &item));
    CALL(napi_set_element(env, arr, 0, item));
    CALL(napi_create_int32(env, 8, &item));
    CALL(napi_set_element(env, arr, 1, item));
    CALL(napi_set_named_property(env, obj, "list", arr));
    return obj;
}

static napi_value buffer_sum(napi_env env, napi_callback_info info)
{
    size_t argc = 1, len, i;
    napi_value argv[1], result;
    void *data;
    uint32_t sum = 0;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_buffer_info(env, argv[0], &data, &len));
    for (i = 0; i < len; i++) sum += ((unsigned char *) data)[i];
    CALL(napi_create_uint32(env, sum, &result));
    return result;
}

static napi_value make_buffer(napi_env env, napi_callback_info info)
{
    napi_value result;
    void *data;
    CALL(napi_create_buffer(env, 4, &data, &result));
    memcpy(data, "\x01\x02\x03\x04", 4);
    return result;
}

static napi_value call_back(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], arg, global, result;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_create_int32(env, 20, &arg));
    CALL(napi_get_global(env, &global));
    CALL(napi_call_function(env, global, argv[0], 1, &arg, &result));
    return result;
}

static napi_value throws(napi_env env, napi_callback_info info)
{
    napi_throw_type_error(env, "E_FIXTURE", "the addon threw");
    return NULL;
}

/* ---- a wrapped native object behind a class ------------------------------------------------ */

typedef struct { double value; } counter;
static int counters_freed;

static void counter_finalize(napi_env env, void *data, void *hint)
{
    free(data);
    counters_freed++;
}

static napi_value counter_new(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], self;
    counter *c = malloc(sizeof(*c));
    CALL(napi_get_cb_info(env, info, &argc, argv, &self, NULL));
    c->value = 0;
    if (argc > 0) napi_get_value_double(env, argv[0], &c->value);
    CALL(napi_wrap(env, self, c, counter_finalize, NULL, NULL));
    return self;
}

static napi_value counter_inc(napi_env env, napi_callback_info info)
{
    napi_value self, result;
    counter *c;
    CALL(napi_get_cb_info(env, info, NULL, NULL, &self, NULL));
    CALL(napi_unwrap(env, self, (void **) &c));
    c->value += 1;
    CALL(napi_create_double(env, c->value, &result));
    return result;
}

static napi_value counter_get(napi_env env, napi_callback_info info)
{
    napi_value self, result;
    counter *c;
    CALL(napi_get_cb_info(env, info, NULL, NULL, &self, NULL));
    CALL(napi_unwrap(env, self, (void **) &c));
    CALL(napi_create_double(env, c->value, &result));
    return result;
}

static napi_value freed_count(napi_env env, napi_callback_info info)
{
    napi_value result;
    CALL(napi_create_int32(env, counters_freed, &result));
    return result;
}

/* ---- async work resolving a promise -------------------------------------------------------- */

typedef struct { napi_async_work work; napi_deferred deferred; double input, output; } job;

static void job_execute(napi_env env, void *data)
{
    job *j = data;
    j->output = j->input * 2; /* runs on another thread; touches no JS */
}

static void job_complete(napi_env env, napi_status status, void *data)
{
    job *j = data;
    napi_value result;
    napi_create_double(env, j->output, &result);
    napi_resolve_deferred(env, j->deferred, result);
    napi_delete_async_work(env, j->work);
    free(j);
}

static napi_value async_double(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], promise, name;
    job *j = calloc(1, sizeof(*j));
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_value_double(env, argv[0], &j->input));
    CALL(napi_create_promise(env, &j->deferred, &promise));
    CALL(napi_create_string_utf8(env, "async_double", NAPI_AUTO_LENGTH, &name));
    CALL(napi_create_async_work(env, NULL, name, job_execute, job_complete, j, &j->work));
    CALL(napi_queue_async_work(env, j->work));
    return promise;
}

/* ---- a thread-safe function called from a real second thread ------------------------------- */

typedef struct { napi_threadsafe_function tsfn; int count; } ticker;

static void tick_call_js(napi_env env, napi_value js_cb, void *context, void *data)
{
    napi_value arg, global;
    napi_create_int32(env, (int) (intptr_t) data, &arg);
    napi_get_global(env, &global);
    napi_call_function(env, global, js_cb, 1, &arg, NULL);
}

static void *tick_thread(void *p)
{
    ticker *t = p;
    int i;
    for (i = 1; i <= t->count; i++) napi_call_threadsafe_function(t->tsfn, (void *) (intptr_t) i, napi_tsfn_blocking);
    napi_release_threadsafe_function(t->tsfn, napi_tsfn_release);
    free(t);
    return NULL;
}

static napi_value ticks(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value argv[2], name;
    ticker *t = calloc(1, sizeof(*t));
    pthread_t th;
    int32_t count;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_value_int32(env, argv[1], &count));
    t->count = count;
    CALL(napi_create_string_utf8(env, "ticks", NAPI_AUTO_LENGTH, &name));
    CALL(napi_create_threadsafe_function(env, argv[0], NULL, name, 0, 1, NULL, NULL, NULL, tick_call_js, &t->tsfn));
    pthread_create(&th, NULL, tick_thread, t);
    pthread_detach(th);
    return NULL;
}

/* ---- references, externals, BigInt --------------------------------------------------------- */

static napi_value ref_roundtrip(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], out;
    napi_ref ref;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_create_reference(env, argv[0], 1, &ref));
    CALL(napi_get_reference_value(env, ref, &out));
    CALL(napi_delete_reference(env, ref));
    return out;
}

static napi_value big_double(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], result;
    int64_t v;
    bool lossless;
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_get_value_bigint_int64(env, argv[0], &v, &lossless));
    CALL(napi_create_bigint_int64(env, v * 2, &result));
    return result;
}

static napi_value type_name(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value argv[1], result;
    napi_valuetype t;
    static const char *names[] = { "undefined", "null", "boolean", "number", "string", "symbol", "object", "function",
                                   "external", "bigint" };
    CALL(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    CALL(napi_typeof(env, argv[0], &t));
    CALL(napi_create_string_utf8(env, names[t], NAPI_AUTO_LENGTH, &result));
    return result;
}

static napi_value init(napi_env env, napi_value exports)
{
    napi_value cls;
    napi_property_descriptor methods[] = {
        { "inc", NULL, counter_inc, NULL, NULL, NULL, napi_default, NULL },
        { "value", NULL, NULL, counter_get, NULL, NULL, napi_default, NULL },
    };
    napi_property_descriptor props[] = {
        { "add", NULL, add, NULL, NULL, NULL, napi_default, NULL },
        { "greet", NULL, greet, NULL, NULL, NULL, napi_default, NULL },
        { "makeObject", NULL, make_object, NULL, NULL, NULL, napi_default, NULL },
        { "bufferSum", NULL, buffer_sum, NULL, NULL, NULL, napi_default, NULL },
        { "makeBuffer", NULL, make_buffer, NULL, NULL, NULL, napi_default, NULL },
        { "callBack", NULL, call_back, NULL, NULL, NULL, napi_default, NULL },
        { "throws", NULL, throws, NULL, NULL, NULL, napi_default, NULL },
        { "freedCount", NULL, freed_count, NULL, NULL, NULL, napi_default, NULL },
        { "asyncDouble", NULL, async_double, NULL, NULL, NULL, napi_default, NULL },
        { "ticks", NULL, ticks, NULL, NULL, NULL, napi_default, NULL },
        { "refRoundtrip", NULL, ref_roundtrip, NULL, NULL, NULL, napi_default, NULL },
        { "bigDouble", NULL, big_double, NULL, NULL, NULL, napi_default, NULL },
        { "typeName", NULL, type_name, NULL, NULL, NULL, napi_default, NULL },
    };
    CALL(napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
    CALL(napi_define_class(env, "Counter", NAPI_AUTO_LENGTH, counter_new, NULL,
                           sizeof(methods) / sizeof(methods[0]), methods, &cls));
    CALL(napi_set_named_property(env, exports, "Counter", cls));
    return exports;
}

NAPI_MODULE_INIT()
{
    return init(env, exports);
}
