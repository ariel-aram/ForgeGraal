/*
 * The slice of libuv that NAN and typical addons touch, mapped onto Node-API: a uv_work_t is an async
 * work item, a uv_async_t is a thread-safe function, and the mutex/key types are the platform's own.
 * Loops are not real (there is no libuv here); a uv_loop_t exists only so addons can pass one around.
 */
#ifndef GRAAK_UV_H_
#define GRAAK_UV_H_

#include <node_api.h>
#include <cstdlib>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <pthread.h>


#endif
#if defined(__GNUC__) && !defined(_WIN32)
/* Header-only and private to the addon: were these symbols exported, a host that really is V8 (Node.js)
   would bind the addon's calls to its own implementation of the same name instead of this one. */
#pragma GCC visibility push(hidden)
#endif

/* Defined by node.h, which owns the V8 layer's notion of the current env. */
napi_env fg_current_env();
napi_env fg_swap_env(napi_env env);

#define UV_VERSION_MAJOR 1
#define UV_VERSION_MINOR 44
#define UV_VERSION_PATCH 2
#define UV_VERSION_HEX ((UV_VERSION_MAJOR << 16) | (UV_VERSION_MINOR << 8) | UV_VERSION_PATCH)
#define UV_UVVERSION "1.44.2"
#define UV_ENOMEM (-12)
#define UV_EINVAL (-22)

typedef struct uv_loop_s { void *data; } uv_loop_t;
typedef struct uv_handle_s uv_handle_t;
typedef void (*uv_close_cb)(uv_handle_t *handle);

struct uv_handle_s {
    void *data;
    uv_loop_t *loop;
    void *internal;
};

inline uv_loop_t *uv_default_loop()
{
    static uv_loop_t loop = {nullptr};
    return &loop;
}

/* ---- work queue ---------------------------------------------------------------------------- */

struct uv_work_s;
typedef struct uv_work_s uv_work_t;
typedef void (*uv_work_cb)(uv_work_t *req);
typedef void (*uv_after_work_cb)(uv_work_t *req, int status);
#define UV_WORK_CB(name) void name(uv_work_t *req)

struct uv_work_s {
    void *data;
    uv_loop_t *loop;
    uv_work_cb work_cb;
    uv_after_work_cb after_work_cb;
    napi_async_work work;
};

extern "C" inline void fg_uv_work_execute(napi_env, void *data)
{
    uv_work_t *req = static_cast<uv_work_t *>(data);
    if (req->work_cb) req->work_cb(req);
}

extern "C" inline void fg_uv_work_complete(napi_env env, napi_status status, void *data)
{
    uv_work_t *req = static_cast<uv_work_t *>(data);
    napi_env previous = fg_swap_env(env);
    napi_delete_async_work(env, req->work);
    req->work = nullptr;
    if (req->after_work_cb) req->after_work_cb(req, status == napi_ok ? 0 : -125);
    fg_swap_env(previous);
}

/* Needs the env of the call in flight, which the V8 layer keeps (see v8::internal::Env). Completion
   callbacks arrive from Node-API rather than through a V8-style entry point, so they install their own. */

inline int uv_queue_work(uv_loop_t *loop, uv_work_t *req, uv_work_cb work_cb, uv_after_work_cb after_work_cb)
{
    napi_env env = fg_current_env();
    napi_value name;
    req->loop = loop;
    req->work_cb = work_cb;
    req->after_work_cb = after_work_cb;
    napi_create_string_utf8(env, "uv_queue_work", NAPI_AUTO_LENGTH, &name);
    if (napi_create_async_work(env, nullptr, name, fg_uv_work_execute, fg_uv_work_complete, req, &req->work) != napi_ok) return UV_ENOMEM;
    return napi_queue_async_work(env, req->work) == napi_ok ? 0 : UV_ENOMEM;
}

/* ---- async handles ------------------------------------------------------------------------- */

struct uv_async_s;
typedef struct uv_async_s uv_async_t;
typedef void (*uv_async_cb)(uv_async_t *handle);

struct uv_async_s {
    void *data;
    uv_loop_t *loop;
    void *internal;
    uv_async_cb cb;
    napi_threadsafe_function tsfn;
    uv_close_cb close_cb;
};

extern "C" inline void fg_uv_async_call(napi_env env, napi_value, void *context, void *)
{
    uv_async_t *handle = static_cast<uv_async_t *>(context);
    napi_env previous = fg_swap_env(env);
    if (handle->cb) handle->cb(handle);
    fg_swap_env(previous);
}

inline int uv_async_init(uv_loop_t *loop, uv_async_t *handle, uv_async_cb cb)
{
    napi_env env = fg_current_env();
    napi_value name;
    handle->loop = loop;
    handle->cb = cb;
    handle->close_cb = nullptr;
    napi_create_string_utf8(env, "uv_async", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, nullptr, nullptr, handle, fg_uv_async_call, &handle->tsfn) != napi_ok)
        return UV_ENOMEM;
    return 0;
}

inline int uv_async_send(uv_async_t *handle)
{
    return napi_call_threadsafe_function(handle->tsfn, nullptr, napi_tsfn_nonblocking) == napi_ok ? 0 : UV_EINVAL;
}

inline void uv_close(uv_handle_t *handle, uv_close_cb close_cb)
{
    uv_async_t *async = reinterpret_cast<uv_async_t *>(handle);
    if (async->tsfn) {
        napi_release_threadsafe_function(async->tsfn, napi_tsfn_release);
        async->tsfn = nullptr;
    }
    if (close_cb) close_cb(handle);
}

/* ---- threads and locks --------------------------------------------------------------------- */

#ifdef _WIN32
typedef CRITICAL_SECTION uv_mutex_t;
inline int uv_mutex_init(uv_mutex_t *m) { InitializeCriticalSection(m); return 0; }
inline void uv_mutex_destroy(uv_mutex_t *m) { DeleteCriticalSection(m); }
inline void uv_mutex_lock(uv_mutex_t *m) { EnterCriticalSection(m); }
inline void uv_mutex_unlock(uv_mutex_t *m) { LeaveCriticalSection(m); }
typedef DWORD uv_key_t;
inline int uv_key_create(uv_key_t *k) { *k = TlsAlloc(); return *k == TLS_OUT_OF_INDEXES ? UV_ENOMEM : 0; }
inline void uv_key_delete(uv_key_t *k) { TlsFree(*k); }
inline void *uv_key_get(uv_key_t *k) { return TlsGetValue(*k); }
inline void uv_key_set(uv_key_t *k, void *v) { TlsSetValue(*k, v); }
#else
typedef pthread_mutex_t uv_mutex_t;
inline int uv_mutex_init(uv_mutex_t *m) { return pthread_mutex_init(m, nullptr); }
inline void uv_mutex_destroy(uv_mutex_t *m) { pthread_mutex_destroy(m); }
inline void uv_mutex_lock(uv_mutex_t *m) { pthread_mutex_lock(m); }
inline void uv_mutex_unlock(uv_mutex_t *m) { pthread_mutex_unlock(m); }
typedef pthread_key_t uv_key_t;
inline int uv_key_create(uv_key_t *k) { return pthread_key_create(k, nullptr); }
inline void uv_key_delete(uv_key_t *k) { pthread_key_delete(*k); }
inline void *uv_key_get(uv_key_t *k) { return pthread_getspecific(*k); }
inline void uv_key_set(uv_key_t *k, void *v) { pthread_setspecific(*k, v); }

#endif



#if defined(__GNUC__) && !defined(_WIN32)
#pragma GCC visibility pop
#endif
#endif
