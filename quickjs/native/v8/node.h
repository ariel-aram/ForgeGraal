/* The node.h surface addons rely on, over Graak's V8 layer (see v8.h). */
#ifndef GRAAK_NODE_H_
#define GRAAK_NODE_H_

#include "node_version.h"
#include "v8.h"
#include "uv.h"

#include <node_api.h>
#if defined(__GNUC__) && !defined(_WIN32)
/* Header-only and private to the addon: were these symbols exported, a host that really is V8 (Node.js)
   would bind the addon's calls to its own implementation of the same name instead of this one. */
#pragma GCC visibility push(hidden)
#endif


inline napi_env fg_current_env() { return v8::internal::Env(); }
inline napi_env fg_swap_env(napi_env env)
{
    napi_env previous = v8::internal::Env();
    v8::internal::Env() = env;
    return previous;
}

#define NODE_MODULE_EXPORT extern "C" FG_EXPORT
#ifndef NODE_GYP_MODULE_NAME
#define NODE_GYP_MODULE_NAME addon

#endif

namespace node {

typedef void (*addon_register_func)(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, void *priv);
typedef void (*addon_context_register_func)(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,
                                            v8::Local<v8::Context> context, void *priv);

struct async_context {
    double async_id;
    double trigger_async_id;
};

class Environment;

inline napi_value RunRegister(napi_env env, napi_value exports, void (*reg)(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, void *), void *priv)
{
    v8::internal::EnvScope scope(env);
    napi_value module;
    napi_create_object(env, &module);
    napi_set_named_property(env, module, "exports", exports);
    napi_value global;
    napi_get_global(env, &global);
    reg(v8::Local<v8::Object>(exports), v8::Local<v8::Value>(module), v8::Local<v8::Context>(global), priv);
    napi_value out = exports;
    napi_get_named_property(env, module, "exports", &out);
    return out;
}

inline void SetMethod(v8::Local<v8::Object> that, const char *name, v8::FunctionCallback callback)
{
    napi_value fn = v8::internal::NewFunction(callback, nullptr, name);
    napi_set_named_property(v8::internal::Env(), that.raw(), name, fn);
}
inline void SetMethod(v8::Isolate *, v8::Local<v8::Object> that, const char *name, v8::FunctionCallback callback)
{
    SetMethod(that, name, callback);
}
inline void SetPrototypeMethod(v8::Local<v8::FunctionTemplate> that, const char *name, v8::FunctionCallback callback)
{
    v8::Isolate *isolate = v8::Isolate::GetCurrent();
    v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate, callback);
    that->PrototypeTemplate()->Set(isolate, name, t);
}

/* Callbacks run from native code reach JS through the same call the addon would make itself. */
inline v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate *, v8::Local<v8::Object> recv, v8::Local<v8::Function> callback,
                                              int argc, v8::Local<v8::Value> *argv, async_context = {0, 0})
{
    return callback->Call(v8::Local<v8::Context>(), recv, argc, argv);
}
inline v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate *isolate, v8::Local<v8::Object> recv, const char *method, int argc,
                                              v8::Local<v8::Value> *argv, async_context ctx = {0, 0})
{
    napi_value fn = v8::internal::PropGet(recv.raw(), method);
    return MakeCallback(isolate, recv, v8::Local<v8::Function>(fn), argc, argv, ctx);
}
inline v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate *isolate, v8::Local<v8::Object> recv, v8::Local<v8::String> symbol,
                                              int argc, v8::Local<v8::Value> *argv, async_context ctx = {0, 0})
{
    napi_value fn = nullptr;
    napi_get_property(v8::internal::Env(), recv.raw(), symbol.raw(), &fn);
    return MakeCallback(isolate, recv, v8::Local<v8::Function>(fn), argc, argv, ctx);
}
inline async_context EmitAsyncInit(v8::Isolate *, v8::Local<v8::Object>, const char *) { return {0, 0}; }
inline async_context EmitAsyncInit(v8::Isolate *, v8::Local<v8::Object>, v8::Local<v8::String>) { return {0, 0}; }
inline void EmitAsyncDestroy(v8::Isolate *, async_context) {}

inline void FatalException(v8::Isolate *, const v8::TryCatch &try_catch)
{
    napi_value err = try_catch.Exception().raw();
    napi_fatal_exception(v8::internal::Env(), err);
}
inline v8::Local<v8::Value> ErrnoException(v8::Isolate *, int errorno, const char *syscall = nullptr, const char *message = nullptr,
                                           const char * = nullptr)
{
    std::string text = std::string(syscall ? syscall : "error") + ": " + (message ? message : "errno " + std::to_string(errorno));
    return v8::Exception::Error(v8::String::NewFromUtf8(nullptr, text.c_str()));
}
inline uv_loop_t *GetCurrentEventLoop(v8::Isolate *) { return uv_default_loop(); }

inline void AtExit(void (*cb)(void *arg), void *arg = nullptr)
{
    napi_add_env_cleanup_hook(v8::internal::Env(), cb, arg);
}
inline void AddEnvironmentCleanupHook(v8::Isolate *, void (*fun)(void *arg), void *arg)
{
    napi_add_env_cleanup_hook(v8::internal::Env(), fun, arg);
}
inline void RemoveEnvironmentCleanupHook(v8::Isolate *, void (*fun)(void *arg), void *arg)
{
    napi_remove_env_cleanup_hook(v8::internal::Env(), fun, arg);
}

enum encoding { ASCII, UTF8, BASE64, UCS2, BINARY, HEX, BUFFER, BASE64URL, LATIN1 = BINARY };

inline encoding ParseEncoding(v8::Isolate *, v8::Local<v8::Value> encoding_v, encoding default_encoding = BINARY)
{
    if (encoding_v.IsEmpty() || !encoding_v->IsString()) return default_encoding;
    std::string e = v8::internal::ToStd(encoding_v.raw());
    for (char &c : e) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (e == "utf8" || e == "utf-8") return UTF8;
    if (e == "ucs2" || e == "ucs-2" || e == "utf16le" || e == "utf-16le") return UCS2;
    if (e == "latin1" || e == "binary") return BINARY;
    if (e == "ascii") return ASCII;
    if (e == "hex") return HEX;
    if (e == "base64") return BASE64;
    if (e == "buffer") return BUFFER;
    return default_encoding;
}

}  // namespace node

/* An addon registers itself by exporting Node-API's entry point, which is all the host looks for. */
#define NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, priv, flags)                                             \
    extern "C" FG_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports)                            \
    {                                                                                                          \
        return node::RunRegister(env, exports, reinterpret_cast<void (*)(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, void *)>(regfunc), priv); \
    }                                                                                                          \
    extern "C" FG_EXPORT int32_t node_api_module_get_api_version_v1() { return 8; }

#define NODE_MODULE_X(modname, regfunc, priv, flags)                                                           \
    namespace {                                                                                                \
    void fg_module_shim(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, v8::Local<v8::Context>,    \
                        void *p)                                                                               \
    {                                                                                                          \
        reinterpret_cast<node::addon_register_func>(regfunc)(exports, module, p);                              \
    }                                                                                                          \
    }                                                                                                          \
    NODE_MODULE_CONTEXT_AWARE_X(modname, fg_module_shim, priv, flags)

#define NODE_MODULE(modname, regfunc) NODE_MODULE_X(modname, regfunc, nullptr, 0)
#define NODE_MODULE_CONTEXT_AWARE(modname, regfunc) NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, nullptr, 0)
#define NODE_MODULE_DECL
#define NODE_MODULE_INITIALIZER_BASE node_register_module_
#define NODE_MODULE_INITIALIZER fg_node_module_init
#define NODE_MODULE_INIT()                                                                                     \
    void NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,                   \
                                 v8::Local<v8::Context> context);                                              \
    NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, NODE_MODULE_INITIALIZER)                                   \
    void NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,                   \
                                 v8::Local<v8::Context> context)
#define NODE_SET_METHOD(obj, name, callback) node::SetMethod(obj, name, callback)
#define NODE_SET_PROTOTYPE_METHOD(templ, name, callback) node::SetPrototypeMethod(templ, name, callback)
#define NODE_DEFINE_CONSTANT(target, constant)                                                                 \
    (target)->DefineOwnProperty(v8::Context::GetCurrent(), v8::String::NewFromUtf8(v8::Isolate::GetCurrent(), #constant, v8::NewStringType::kNormal).ToLocalChecked(), \
                                v8::Number::New(v8::Isolate::GetCurrent(), static_cast<double>(constant)), \
                                static_cast<v8::PropertyAttribute>(v8::ReadOnly | v8::DontDelete))



#if defined(__GNUC__) && !defined(_WIN32)
#pragma GCC visibility pop
#endif
#endif
