/*
 * ForgeGraal's implementation of the V8 embedder API, written on top of Node-API.
 *
 * WHY THIS EXISTS. A native addon written against V8 directly, or through NAN, cannot be loaded as
 * a prebuilt binary anywhere but Node.js: the compiled code reads V8's own heap layout. What it can
 * do is be *compiled* against a different implementation of the same C++ API. This header is that
 * implementation. `v8::Local<v8::Value>` here is a Node-API `napi_value`, `v8::FunctionTemplate` is
 * `napi_define_class`, `v8::Persistent` is a `napi_ref`, and so on; the addon that results imports
 * only `napi_*` symbols, which the ForgeGraal host (and Node.js itself) provides. Because it is
 * header-only there is no library to link, and the same source builds for every target.
 *
 * SCOPE. This is the API surface addons and NAN actually use, not all of V8: values, strings, objects,
 * arrays, functions, templates, persistent handles, exceptions and TryCatch, ArrayBuffers, typed arrays,
 * Buffers, promises, symbols, BigInt, dates, JSON and scripts, ObjectWrap and the libuv work-queue calls
 * NAN wraps. Anything outside it fails to compile with a normal "not a member" error, so a gap is
 * visible when the addon is built, never at runtime.
 */
#ifndef FORGEGRAAL_V8_H_
#define FORGEGRAAL_V8_H_

#include <node_api.h>
#include "v8-version.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>
#if defined(__GNUC__) && !defined(_WIN32)
/* Header-only and private to the addon: were these symbols exported, a host that really is V8 (Node.js)
   would bind the addon's calls to its own implementation of the same name instead of this one. */
#pragma GCC visibility push(hidden)
#endif


#ifdef _WIN32
#define FG_EXPORT __declspec(dllexport)
#else
#define FG_EXPORT __attribute__((visibility("default")))
#endif
#define V8_EXPORT
#define V8_INLINE inline
#define V8_WARN_UNUSED_RESULT
#define V8_DEPRECATED(msg, decl) decl
#define V8_DEPRECATE_SOON(msg, decl) decl
#define V8_NOEXCEPT
#define V8_UNLIKELY(x) (x)
#define V8_LIKELY(x) (x)

namespace v8 {

class Isolate;
class ExtensionConfiguration {};
class Context;
class Value;
class Primitive;
class Name;
class String;
class Symbol;
class Number;
class Integer;
class Int32;
class Uint32;
class BigInt;
class Boolean;
class Object;
class Array;
class Function;
class Date;
class RegExp;
class Promise;
class External;
class ArrayBuffer;
class ArrayBufferView;
class TypedArray;
class Uint8Array;
class Template;
class PropertyDescriptor;
class FunctionTemplate;
class ObjectTemplate;
class Signature;
class Private;
class Message;
class StackTrace;
class Script;
class UnboundScript;
class Data;
template <class T> class Local;
template <class T> class MaybeLocal;
template <class T> class Maybe;
template <class T> class ReturnValue;
template <class T> class FunctionCallbackInfo;
template <class T> class PropertyCallbackInfo;
template <class T> class NonCopyablePersistentTraits;
template <class T> class CopyablePersistentTraits;
template <class T, class M = NonCopyablePersistentTraits<T>> class Persistent;
template <class T> class Global;

namespace internal {

/* The environment the addon is currently running in. Node-API hands an env to every callback, and V8
   code reaches it through Isolate::GetCurrent(), so each entry point records it here. */
inline napi_env& Env()
{
    static thread_local napi_env env = nullptr;
    return env;
}

struct EnvScope {
    napi_env saved;
    explicit EnvScope(napi_env env) : saved(Env()) { Env() = env; }
    ~EnvScope() { Env() = saved; }
};

inline napi_value Undefined()
{
    napi_value v;
    napi_get_undefined(Env(), &v);
    return v;
}

/* A reference that also works for values Node-API cannot reference directly. Before Node-API 10 only
   objects, functions and symbols can be referenced, so anything else (a string name, a number passed
   as `data`) is boxed in a one-element array and unboxed on the way out. */
struct Ref {
    napi_ref ref = nullptr;
    bool boxed = false;
};

inline bool Weakable(napi_value v)
{
    napi_valuetype t;
    return napi_typeof(Env(), v, &t) == napi_ok && (t == napi_object || t == napi_function || t == napi_symbol || t == napi_external);
}

inline Ref KeepRef(napi_value v)
{
    Ref r;
    if (!v) return r;
    if (Weakable(v)) {
        napi_create_reference(Env(), v, 1, &r.ref);
    } else {
        napi_value box;
        napi_create_array_with_length(Env(), 1, &box);
        napi_set_element(Env(), box, 0, v);
        napi_create_reference(Env(), box, 1, &r.ref);
        r.boxed = true;
    }
    return r;
}

inline napi_value RefValue(const Ref &r)
{
    napi_value v = nullptr;
    if (!r.ref) return nullptr;
    napi_get_reference_value(Env(), r.ref, &v);
    if (v && r.boxed) {
        napi_value inner = nullptr;
        napi_get_element(Env(), v, 0, &inner);
        return inner;
    }
    return v;
}

template <class T> inline napi_value Raw(const T *p) { return reinterpret_cast<napi_value>(const_cast<T *>(p)); }

}  // namespace internal

/* ---- handles ------------------------------------------------------------------------------- */

template <class T> class Local {
public:
    Local() : v_(nullptr) {}
    template <class S> Local(Local<S> that) : v_(that.raw()) {}
    explicit Local(napi_value v) : v_(v) {}

    bool IsEmpty() const { return v_ == nullptr; }
    void Clear() { v_ = nullptr; }
    T *operator->() const { return reinterpret_cast<T *>(v_); }
    T *operator*() const { return reinterpret_cast<T *>(v_); }
    napi_value raw() const { return v_; }

    template <class S> bool operator==(const Local<S> &that) const
    {
        if (v_ == that.raw()) return true;
        if (!v_ || !that.raw()) return false;
        bool same = false;
        napi_strict_equals(internal::Env(), v_, that.raw(), &same);
        return same;
    }
    template <class S> bool operator!=(const Local<S> &that) const { return !(*this == that); }

    template <class S> static Local<T> Cast(Local<S> that) { return Local<T>(that.raw()); }
    template <class S> Local<S> As() const { return Local<S>(v_); }
    static Local<T> New(Isolate *, Local<T> that) { return that; }
    template <class M> static Local<T> New(Isolate *, const Persistent<T, M> &p);

private:
    napi_value v_;
};

template <class T> class MaybeLocal {
public:
    MaybeLocal() : local_() {}
    template <class S> MaybeLocal(Local<S> that) : local_(that) {}
    bool IsEmpty() const { return local_.IsEmpty(); }
    template <class S> bool ToLocal(Local<S> *out) const
    {
        *out = Local<S>(local_.raw());
        return !IsEmpty();
    }
    Local<T> ToLocalChecked() const
    {
        if (IsEmpty()) {
            std::fprintf(stderr, "FATAL ERROR: MaybeLocal::ToLocalChecked on an empty handle\n");
            std::abort();
        }
        return local_;
    }
    template <class S> Local<S> FromMaybe(Local<S> fallback) const { return IsEmpty() ? fallback : Local<S>(local_.raw()); }

private:
    Local<T> local_;
};

template <class T> class Maybe {
public:
    bool IsNothing() const { return !has_; }
    bool IsJust() const { return has_; }
    T ToChecked() const { return FromJust(); }
    void Check() const { FromJust(); }
    bool To(T *out) const
    {
        if (has_) *out = value_;
        return has_;
    }
    T FromJust() const
    {
        if (!has_) {
            std::fprintf(stderr, "FATAL ERROR: Maybe::FromJust on Nothing\n");
            std::abort();
        }
        return value_;
    }
    T FromMaybe(const T &fallback) const { return has_ ? value_ : fallback; }
    bool operator==(const Maybe &other) const { return has_ == other.has_ && (!has_ || value_ == other.value_); }
    bool operator!=(const Maybe &other) const { return !(*this == other); }

    Maybe() : has_(false), value_() {}
    explicit Maybe(const T &v) : has_(true), value_(v) {}

private:
    bool has_;
    T value_;
};
template <class T> inline Maybe<T> Just(const T &t) { return Maybe<T>(t); }
template <class T> inline Maybe<T> Nothing() { return Maybe<T>(); }
template <> class Maybe<void> {
public:
    bool IsNothing() const { return !has_; }
    bool IsJust() const { return has_; }
    Maybe() : has_(false) {}
    explicit Maybe(bool has) : has_(has) {}
    void Check() const {}
private:
    bool has_;
};
inline Maybe<void> JustVoid() { return Maybe<void>(true); }

/* ---- scopes -------------------------------------------------------------------------------- */

class HandleScope {
public:
    explicit HandleScope(Isolate *) { napi_open_handle_scope(internal::Env(), &scope_); }
    ~HandleScope() { napi_close_handle_scope(env_, scope_); }
    static int NumberOfHandles(Isolate *) { return 0; }
    HandleScope(const HandleScope &) = delete;
    HandleScope &operator=(const HandleScope &) = delete;

private:
    napi_env env_ = internal::Env();
    napi_handle_scope scope_;
};

class EscapableHandleScope {
public:
    explicit EscapableHandleScope(Isolate *) { napi_open_escapable_handle_scope(env_, &scope_); }
    ~EscapableHandleScope() { napi_close_escapable_handle_scope(env_, scope_); }
    static int NumberOfHandles(Isolate *) { return 0; }
    template <class T> Local<T> Escape(Local<T> value)
    {
        napi_value out = value.raw();
        if (out) napi_escape_handle(env_, scope_, out, &out);
        return Local<T>(out);
    }

private:
    napi_env env_ = internal::Env();
    napi_escapable_handle_scope scope_;
};

class SealHandleScope {
public:
    explicit SealHandleScope(Isolate *) {}
};

/* ---- enums and small types ----------------------------------------------------------------- */

enum PropertyAttribute { None = 0, ReadOnly = 1 << 0, DontEnum = 1 << 1, DontDelete = 1 << 2 };
enum AccessControl { DEFAULT = 0, ALL_CAN_READ = 1, ALL_CAN_WRITE = 2, PROHIBITS_OVERWRITING = 4 };
enum PropertyFilter {
    ALL_PROPERTIES = 0,
    ONLY_WRITABLE = 1,
    ONLY_ENUMERABLE = 2,
    ONLY_CONFIGURABLE = 4,
    SKIP_STRINGS = 8,
    SKIP_SYMBOLS = 16
};
enum class NewStringType { kNormal, kInternalized };
enum class KeyCollectionMode { kOwnOnly, kIncludePrototypes };
enum class IndexFilter { kIncludeIndices, kSkipIndices };
enum class KeyConversionMode { kConvertToString, kKeepNumbers };
enum class ConstructorBehavior { kThrow, kAllow };
enum class SideEffectType { kHasSideEffect, kHasNoSideEffect };
enum class WeakCallbackType { kParameter, kInternalFields, kFinalizer };
enum GCType { kGCTypeScavenge = 1, kGCTypeMarkSweepCompact = 2, kGCTypeAll = 15 };
enum GCCallbackFlags { kNoGCCallbackFlags = 0 };
enum class ExternalArrayType { kExternalInt8Array };

struct JitCodeEvent;
typedef void (*GCCallback)(Isolate *, GCType, GCCallbackFlags);
typedef void (*FatalErrorCallback)(const char *, const char *);
typedef void (*OOMErrorCallback)(const char *, bool);

/* ---- Isolate and Context ------------------------------------------------------------------- */

class HeapStatistics {
public:
    size_t total_heap_size() { return 0; }
    size_t total_heap_size_executable() { return 0; }
    size_t total_physical_size() { return 0; }
    size_t total_available_size() { return 0; }
    size_t used_heap_size() { return 0; }
    size_t heap_size_limit() { return 0; }
    size_t malloced_memory() { return 0; }
    size_t peak_malloced_memory() { return 0; }
    size_t does_zap_garbage() { return 0; }
    size_t number_of_native_contexts() { return 1; }
    size_t number_of_detached_contexts() { return 0; }
};
typedef void (*GCPrologueCallback)(GCType type, GCCallbackFlags flags);
typedef void (*GCEpilogueCallback)(GCType type, GCCallbackFlags flags);
typedef int *(*CounterLookupCallback)(const char *name);
typedef void *(*CreateHistogramCallback)(const char *name, int min, int max, size_t buckets);
typedef void (*AddHistogramSampleCallback)(void *histogram, int sample);

class Isolate {
public:
    typedef void (*GCCallback)(Isolate *, GCType, GCCallbackFlags);
    typedef void (*GCCallbackWithoutIsolate)(GCType, GCCallbackFlags);
    static Isolate *GetCurrent() { return reinterpret_cast<Isolate *>(internal::Env()); }
    static Isolate *TryGetCurrent() { return GetCurrent(); }
    napi_env env() const { return reinterpret_cast<napi_env>(const_cast<Isolate *>(this)); }

    class Scope {
    public:
        explicit Scope(Isolate *) {}
    };
    class DisallowJavascriptExecutionScope {
    public:
        enum OnFailure { CRASH_ON_FAILURE, THROW_ON_FAILURE };
        DisallowJavascriptExecutionScope(Isolate *, OnFailure) {}
    };
    class AllowJavascriptExecutionScope {
    public:
        explicit AllowJavascriptExecutionScope(Isolate *) {}
    };

    void Enter() {}
    void Exit() {}
    void Dispose() {}
    bool IsDead() { return false; }
    bool IsInUse() { return true; }
    inline Local<Value> ThrowException(Local<Value> exception);
    inline Local<Context> GetCurrentContext();
    Local<Context> GetEnteredContext();
    Local<Context> GetEnteredOrMicrotaskContext();
    int64_t AdjustAmountOfExternalAllocatedMemory(int64_t change)
    {
        int64_t total = 0;
        napi_adjust_external_memory(env(), change, &total);
        return total;
    }
    void SetData(uint32_t slot, void *data) { Slots()[slot < 16 ? slot : 0] = data; }
    void *GetData(uint32_t slot) { return Slots()[slot < 16 ? slot : 0]; }
    static uint32_t GetNumberOfDataSlots() { return 16; }
    void AddGCPrologueCallback(GCCallback, GCType = kGCTypeAll) {}
    void AddGCEpilogueCallback(GCCallback, GCType = kGCTypeAll) {}
    void RemoveGCPrologueCallback(GCCallback) {}
    void RemoveGCEpilogueCallback(GCCallback) {}
    void AddGCPrologueCallback(GCPrologueCallback, GCType = kGCTypeAll) {}
    void AddGCEpilogueCallback(GCEpilogueCallback, GCType = kGCTypeAll) {}
    void RemoveGCPrologueCallback(GCPrologueCallback) {}
    void RemoveGCEpilogueCallback(GCEpilogueCallback) {}
    void SetCounterFunction(CounterLookupCallback) {}
    void SetCreateHistogramFunction(CreateHistogramCallback) {}
    void SetAddHistogramSampleFunction(AddHistogramSampleCallback) {}
    bool IdleNotificationDeadline(double) { return true; }
    int ContextDisposedNotification(bool = true) { return 0; }
    void LowMemoryNotification() {}
    void RequestGarbageCollectionForTesting(int) {}
    void TerminateExecution() {}
    bool IsExecutionTerminating() { return false; }
    void CancelTerminateExecution() {}
    void SetFatalErrorHandler(FatalErrorCallback) {}
    void SetAbortOnUncaughtExceptionCallback(bool (*)(Isolate *)) {}
    void RunMicrotasks() {}
    void EnqueueMicrotask(Local<Function> function);
    void SetMicrotasksPolicy(int) {}
    void MemoryPressureNotification(int) {}
    void SetStackLimit(uintptr_t) {}
    void SetCaptureStackTraceForUncaughtExceptions(bool, int = 10, int = 0) {}
    void GetHeapStatistics(HeapStatistics *) {}

private:
    static void **Slots()
    {
        static void *slots[16];
        return slots;
    }
};

class Context {
public:
    class Scope {
    public:
        explicit Scope(Local<Context>) {}
    };
    class BackupIncumbentScope {
    public:
        explicit BackupIncumbentScope(Local<Context>) {}
    };
    static Local<Context> GetCurrent()
    {
        napi_value global;
        napi_get_global(internal::Env(), &global);
        return Local<Context>(global);
    }
    static Local<Context> New(Isolate *, ExtensionConfiguration * = nullptr, Local<ObjectTemplate> = Local<ObjectTemplate>(),
                              Local<Value> = Local<Value>()) { return GetCurrent(); }
    inline Local<Object> Global();
    Isolate *GetIsolate() { return Isolate::GetCurrent(); }
    void Enter() {}
    void Exit() {}
    void SetSecurityToken(Local<Value>) {}
    void UseDefaultSecurityToken() {}
    Local<Value> GetSecurityToken();
    void *GetAlignedPointerFromEmbedderData(int index) { return Slots()[index & 15]; }
    void SetAlignedPointerInEmbedderData(int index, void *value) { Slots()[index & 15] = value; }
    Local<Value> GetEmbedderData(int index);
    void SetEmbedderData(int, Local<Value>) {}
    inline MaybeLocal<Value> Get(Local<Value>);

private:
    static void **Slots()
    {
        static void *slots[16];
        return slots;
    }
};

/* ---- helpers ------------------------------------------------------------------------------- */

namespace internal {

inline napi_value Global()
{
    napi_value g;
    napi_get_global(Env(), &g);
    return g;
}

inline napi_value Str(const char *s, int len = -1)
{
    napi_value out;
    napi_create_string_utf8(Env(), s ? s : "", len < 0 ? NAPI_AUTO_LENGTH : static_cast<size_t>(len), &out);
    return out;
}

inline std::string ToStd(napi_value v)
{
    size_t len = 0;
    if (napi_get_value_string_utf8(Env(), v, nullptr, 0, &len) != napi_ok) return std::string();
    std::string out(len + 1, '\0');
    napi_get_value_string_utf8(Env(), v, &out[0], len + 1, &len);
    out.resize(len);
    return out;
}

inline napi_value PropGet(napi_value obj, const char *name)
{
    napi_value out = nullptr;
    napi_get_named_property(Env(), obj, name, &out);
    return out;
}

/* A call that can fail leaves the failure as a pending exception; the V8 API reports it as empty. */
/* `v` is taken by reference on purpose: callers write Result(napi_call(..., &out), out), and C++ does not
   order the evaluation of those two arguments, so a by-value `out` could be read before it is filled. */
template <class T> inline MaybeLocal<T> Result(napi_status status, const napi_value &v)
{
    return status == napi_ok && v ? MaybeLocal<T>(Local<T>(v)) : MaybeLocal<T>();
}

inline bool InstanceOfGlobal(napi_value v, const char *ctor)
{
    napi_value c = PropGet(Global(), ctor);
    bool r = false;
    if (c) napi_instanceof(Env(), v, c, &r);
    return r;
}

inline napi_value CallGlobalMethod(const char *object, const char *method, napi_value arg)
{
    napi_value o = PropGet(Global(), object);
    napi_value f = o ? PropGet(o, method) : nullptr;
    napi_value out = nullptr;
    if (f) napi_call_function(Env(), o, f, 1, &arg, &out);
    return out;
}

}  // namespace internal

/* ---- Value and its primitives -------------------------------------------------------------- */

class Data {};

class Value : public Data {
public:
#define FG_TYPE_IS(name, cond)                                                                         \
    bool name() const                                                                                  \
    {                                                                                                  \
        napi_valuetype t;                                                                              \
        napi_typeof(internal::Env(), internal::Raw(this), &t);                                         \
        return cond;                                                                                   \
    }
    FG_TYPE_IS(IsUndefined, t == napi_undefined)
    FG_TYPE_IS(IsNull, t == napi_null)
    FG_TYPE_IS(IsNullOrUndefined, t == napi_null || t == napi_undefined)
    FG_TYPE_IS(IsString, t == napi_string)
    FG_TYPE_IS(IsSymbol, t == napi_symbol)
    FG_TYPE_IS(IsName, t == napi_string || t == napi_symbol)
    FG_TYPE_IS(IsNumber, t == napi_number)
    FG_TYPE_IS(IsBigInt, t == napi_bigint)
    FG_TYPE_IS(IsBoolean, t == napi_boolean)
    FG_TYPE_IS(IsFunction, t == napi_function)
    FG_TYPE_IS(IsExternal, t == napi_external)
    FG_TYPE_IS(IsObject, t == napi_object || t == napi_function || t == napi_external)
    FG_TYPE_IS(IsCallable, t == napi_function)
#undef FG_TYPE_IS
    bool IsTrue() const
    {
        bool b = false;
        return IsBoolean() && napi_get_value_bool(internal::Env(), internal::Raw(this), &b) == napi_ok && b;
    }
    bool IsFalse() const
    {
        bool b = true;
        return IsBoolean() && napi_get_value_bool(internal::Env(), internal::Raw(this), &b) == napi_ok && !b;
    }
    bool IsArray() const
    {
        bool r = false;
        napi_is_array(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsDate() const
    {
        bool r = false;
        napi_is_date(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsPromise() const
    {
        bool r = false;
        napi_is_promise(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsArrayBuffer() const
    {
        bool r = false;
        napi_is_arraybuffer(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsArrayBufferView() const
    {
        return IsTypedArray() || IsDataView();
    }
    bool IsTypedArray() const
    {
        bool r = false;
        napi_is_typedarray(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsDataView() const
    {
        bool r = false;
        napi_is_dataview(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsNativeError() const
    {
        bool r = false;
        napi_is_error(internal::Env(), internal::Raw(this), &r);
        return r;
    }
    bool IsRegExp() const { return IsObject() && internal::InstanceOfGlobal(internal::Raw(this), "RegExp"); }
    bool IsMap() const { return IsObject() && internal::InstanceOfGlobal(internal::Raw(this), "Map"); }
    bool IsSet() const { return IsObject() && internal::InstanceOfGlobal(internal::Raw(this), "Set"); }
    bool IsWeakMap() const { return IsObject() && internal::InstanceOfGlobal(internal::Raw(this), "WeakMap"); }
    bool IsProxy() const { return false; }
    bool IsGeneratorFunction() const { return false; }
    bool IsAsyncFunction() const { return false; }
    bool IsArgumentsObject() const { return false; }
    bool IsBooleanObject() const { return false; }
    bool IsNumberObject() const { return false; }
    bool IsStringObject() const { return false; }
    bool IsSymbolObject() const { return false; }
    bool IsExternalString() const { return false; }
    bool IsInternalized() const { return false; }
    bool IsInt32() const
    {
        double d;
        if (!IsNumber() || napi_get_value_double(internal::Env(), internal::Raw(this), &d) != napi_ok) return false;
        return d == static_cast<double>(static_cast<int32_t>(d)) && !(d == 0 && std::signbit(d));
    }
    bool IsUint32() const
    {
        double d;
        if (!IsNumber() || napi_get_value_double(internal::Env(), internal::Raw(this), &d) != napi_ok) return false;
        return d >= 0 && d == static_cast<double>(static_cast<uint32_t>(d));
    }
#define FG_TYPED_IS(name, jsname) bool name() const { return IsTypedArray() && TypedKind() == jsname; }
    FG_TYPED_IS(IsInt8Array, napi_int8_array)
    FG_TYPED_IS(IsUint8Array, napi_uint8_array)
    FG_TYPED_IS(IsUint8ClampedArray, napi_uint8_clamped_array)
    FG_TYPED_IS(IsInt16Array, napi_int16_array)
    FG_TYPED_IS(IsUint16Array, napi_uint16_array)
    FG_TYPED_IS(IsInt32Array, napi_int32_array)
    FG_TYPED_IS(IsUint32Array, napi_uint32_array)
    FG_TYPED_IS(IsFloat32Array, napi_float32_array)
    FG_TYPED_IS(IsFloat64Array, napi_float64_array)
    FG_TYPED_IS(IsBigInt64Array, napi_bigint64_array)
    FG_TYPED_IS(IsBigUint64Array, napi_biguint64_array)
#undef FG_TYPED_IS

    /* conversions (Maybe / MaybeLocal forms are the current API; the bare forms are the deprecated
       ones that older addons still call) */
    MaybeLocal<String> ToString(Local<Context>) const;
    MaybeLocal<String> ToString(Isolate *) const { return ToString(Local<Context>()); }
    Local<String> ToString() const { return ToString(Local<Context>()).FromMaybe(Local<String>()); }
    MaybeLocal<String> ToDetailString(Local<Context> c) const { return ToString(c); }
    MaybeLocal<Object> ToObject(Local<Context>) const;
    Local<Object> ToObject(Isolate *) const;
    Local<Object> ToObject() const;
    MaybeLocal<Number> ToNumber(Local<Context>) const;
    MaybeLocal<Integer> ToInteger(Local<Context>) const;
    MaybeLocal<Int32> ToInt32(Local<Context>) const;
    MaybeLocal<Uint32> ToUint32(Local<Context>) const;
    Local<Boolean> ToBoolean(Isolate *) const;
    Local<Number> ToNumber(Isolate *) const;
    Local<Integer> ToInteger(Isolate *) const;
    Local<Int32> ToInt32(Isolate *) const;
    Local<Uint32> ToUint32(Isolate *) const;
    Local<Number> ToNumber() const;
    Local<Integer> ToInteger() const;
    Local<Int32> ToInt32() const;
    Local<Uint32> ToUint32() const;

    Maybe<double> NumberValue(Local<Context>) const
    {
        napi_value n;
        double d = 0;
        if (napi_coerce_to_number(internal::Env(), internal::Raw(this), &n) != napi_ok) return Nothing<double>();
        napi_get_value_double(internal::Env(), n, &d);
        return Just(d);
    }
    double NumberValue() const { return NumberValue(Local<Context>()).FromMaybe(0); }
    Maybe<int64_t> IntegerValue(Local<Context> c) const
    {
        double d;
        if (!NumberValue(c).To(&d)) return Nothing<int64_t>();
        if (d != d) return Just<int64_t>(0);
        if (d >= 9223372036854775807.0) return Just<int64_t>(INT64_MAX);
        if (d <= -9223372036854775808.0) return Just<int64_t>(INT64_MIN);
        return Just<int64_t>(static_cast<int64_t>(d));
    }
    int64_t IntegerValue() const { return IntegerValue(Local<Context>()).FromMaybe(0); }
    Maybe<int32_t> Int32Value(Local<Context> c) const
    {
        double d;
        if (!NumberValue(c).To(&d)) return Nothing<int32_t>();
        int32_t out = 0;
        napi_value n;
        napi_create_double(internal::Env(), d, &n);
        napi_get_value_int32(internal::Env(), n, &out);
        return Just(out);
    }
    int32_t Int32Value() const { return Int32Value(Local<Context>()).FromMaybe(0); }
    Maybe<uint32_t> Uint32Value(Local<Context> c) const
    {
        double d;
        if (!NumberValue(c).To(&d)) return Nothing<uint32_t>();
        uint32_t out = 0;
        napi_value n;
        napi_create_double(internal::Env(), d, &n);
        napi_get_value_uint32(internal::Env(), n, &out);
        return Just(out);
    }
    uint32_t Uint32Value() const { return Uint32Value(Local<Context>()).FromMaybe(0); }
    Maybe<bool> BooleanValue(Local<Context>) const { return Just(BooleanValue()); }
    bool BooleanValue(Isolate *) const { return BooleanValue(); }
    bool BooleanValue() const
    {
        napi_value b;
        bool out = false;
        if (napi_coerce_to_bool(internal::Env(), internal::Raw(this), &b) == napi_ok) napi_get_value_bool(internal::Env(), b, &out);
        return out;
    }
    Maybe<bool> Equals(Local<Context>, Local<Value> other) const
    {
        napi_value script, result;
        bool loose = false;
        napi_value args[2] = {internal::Raw(this), other.raw()};
        napi_value fn = jsEquals();
        if (napi_call_function(internal::Env(), internal::Global(), fn, 2, args, &result) != napi_ok) return Nothing<bool>();
        napi_get_value_bool(internal::Env(), result, &loose);
        (void) script;
        return Just(loose);
    }
    bool Equals(Local<Value> other) const { return Equals(Local<Context>(), other).FromMaybe(false); }
    bool StrictEquals(Local<Value> other) const
    {
        bool r = false;
        napi_strict_equals(internal::Env(), internal::Raw(this), other.raw(), &r);
        return r;
    }
    bool SameValue(Local<Value> other) const { return StrictEquals(other); }
    Maybe<bool> InstanceOf(Local<Context>, Local<Object> object) const
    {
        bool r = false;
        if (napi_instanceof(internal::Env(), internal::Raw(this), object.raw(), &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    MaybeLocal<Uint32> ToArrayIndex(Local<Context> c) const
    {
        napi_value n;
        double d;
        if (!IsNumber() && !IsString()) return MaybeLocal<Uint32>();
        if (napi_coerce_to_number(internal::Env(), internal::Raw(this), &n) != napi_ok) return MaybeLocal<Uint32>();
        napi_get_value_double(internal::Env(), n, &d);
        if (d < 0 || d != std::floor(d) || d >= 4294967295.0) return MaybeLocal<Uint32>();
        return ToUint32(c);
    }
    Maybe<int64_t> IntegerValueSafe() const { return IntegerValue(Local<Context>()); }
    template <class T> static Value *Cast(T *value) { return reinterpret_cast<Value *>(value); }

private:
    napi_typedarray_type TypedKind() const
    {
        napi_typedarray_type t = napi_uint8_array;
        napi_get_typedarray_info(internal::Env(), internal::Raw(this), &t, nullptr, nullptr, nullptr, nullptr);
        return t;
    }
    static napi_value jsEquals()
    {
        static napi_value cached = nullptr;
        napi_value script, fn;
        if (cached) return cached;
        napi_create_string_utf8(internal::Env(), "(function(a,b){return a==b})", NAPI_AUTO_LENGTH, &script);
        napi_run_script(internal::Env(), script, &fn);
        return fn;
    }
};

class Primitive : public Value {};
class Name : public Primitive {
public:
    int GetIdentityHash() { return 0; }
    template <class T> static Name *Cast(T *v) { return reinterpret_cast<Name *>(v); }
};

class Symbol : public Name {
public:
    static Local<Symbol> New(Isolate *, Local<String> description = Local<String>());
    static Local<Symbol> For(Isolate *, Local<String> name);
    static Local<Symbol> ForApi(Isolate *, Local<String> name) { return For(nullptr, name); }
    static Local<Symbol> GetIterator(Isolate *) { return WellKnown("iterator"); }
    static Local<Symbol> GetUnscopables(Isolate *) { return WellKnown("unscopables"); }
    static Local<Symbol> GetToPrimitive(Isolate *) { return WellKnown("toPrimitive"); }
    static Local<Symbol> GetToStringTag(Isolate *) { return WellKnown("toStringTag"); }
    static Local<Symbol> GetIsConcatSpreadable(Isolate *) { return WellKnown("isConcatSpreadable"); }
    Local<Value> Name() const;
    template <class T> static Symbol *Cast(T *v) { return reinterpret_cast<Symbol *>(v); }

private:
    static Local<Symbol> WellKnown(const char *name)
    {
        return Local<Symbol>(internal::PropGet(internal::PropGet(internal::Global(), "Symbol"), name));
    }
};

class Private : public Data {
public:
    static Local<Private> New(Isolate *, Local<String> name = Local<String>());
    static Local<Private> ForApi(Isolate *, Local<String> name);
    template <class T> static Private *Cast(T *v) { return reinterpret_cast<Private *>(v); }
};

class Number : public Primitive {
public:
    static Local<Number> New(Isolate *, double value)
    {
        napi_value v;
        napi_create_double(internal::Env(), value, &v);
        return Local<Number>(v);
    }
    double Value() const
    {
        double d = 0;
        napi_get_value_double(internal::Env(), internal::Raw(this), &d);
        return d;
    }
    template <class T> static Number *Cast(T *v) { return reinterpret_cast<Number *>(v); }
};

class Integer : public Number {
public:
    static Local<Integer> New(Isolate *, int32_t value)
    {
        napi_value v;
        napi_create_int32(internal::Env(), value, &v);
        return Local<Integer>(v);
    }
    static Local<Integer> NewFromUnsigned(Isolate *, uint32_t value)
    {
        napi_value v;
        napi_create_uint32(internal::Env(), value, &v);
        return Local<Integer>(v);
    }
    int64_t Value() const
    {
        int64_t i = 0;
        napi_get_value_int64(internal::Env(), internal::Raw(this), &i);
        return i;
    }
    template <class T> static Integer *Cast(T *v) { return reinterpret_cast<Integer *>(v); }
};

class Int32 : public Integer {
public:
    int32_t Value() const
    {
        int32_t i = 0;
        napi_get_value_int32(internal::Env(), internal::Raw(this), &i);
        return i;
    }
    template <class T> static Int32 *Cast(T *v) { return reinterpret_cast<Int32 *>(v); }
};

class Uint32 : public Integer {
public:
    uint32_t Value() const
    {
        uint32_t i = 0;
        napi_get_value_uint32(internal::Env(), internal::Raw(this), &i);
        return i;
    }
    template <class T> static Uint32 *Cast(T *v) { return reinterpret_cast<Uint32 *>(v); }
};

class BigInt : public Primitive {
public:
    static Local<BigInt> New(Isolate *, int64_t value)
    {
        napi_value v;
        napi_create_bigint_int64(internal::Env(), value, &v);
        return Local<BigInt>(v);
    }
    static Local<BigInt> NewFromUnsigned(Isolate *, uint64_t value)
    {
        napi_value v;
        napi_create_bigint_uint64(internal::Env(), value, &v);
        return Local<BigInt>(v);
    }
    int64_t Int64Value(bool *lossless = nullptr) const
    {
        int64_t i = 0;
        bool l = true;
        napi_get_value_bigint_int64(internal::Env(), internal::Raw(this), &i, &l);
        if (lossless) *lossless = l;
        return i;
    }
    uint64_t Uint64Value(bool *lossless = nullptr) const
    {
        uint64_t i = 0;
        bool l = true;
        napi_get_value_bigint_uint64(internal::Env(), internal::Raw(this), &i, &l);
        if (lossless) *lossless = l;
        return i;
    }
    template <class T> static BigInt *Cast(T *v) { return reinterpret_cast<BigInt *>(v); }
};

class Boolean : public Primitive {
public:
    static Local<Boolean> New(Isolate *, bool value)
    {
        napi_value v;
        napi_get_boolean(internal::Env(), value, &v);
        return Local<Boolean>(v);
    }
    bool Value() const
    {
        bool b = false;
        napi_get_value_bool(internal::Env(), internal::Raw(this), &b);
        return b;
    }
    template <class T> static Boolean *Cast(T *v) { return reinterpret_cast<Boolean *>(v); }
};

inline Local<Primitive> Undefined(Isolate *)
{
    napi_value v;
    napi_get_undefined(internal::Env(), &v);
    return Local<Primitive>(v);
}
inline Local<Primitive> Null(Isolate *)
{
    napi_value v;
    napi_get_null(internal::Env(), &v);
    return Local<Primitive>(v);
}
inline Local<Boolean> True(Isolate *i) { return Boolean::New(i, true); }
inline Local<Boolean> False(Isolate *i) { return Boolean::New(i, false); }

class String : public Name {
public:
    enum Encoding { UNKNOWN_ENCODING = 0x1, TWO_BYTE_ENCODING = 0x0, ONE_BYTE_ENCODING = 0x8 };
    enum NewStringType { kNormalString, kInternalizedString };
    enum WriteOptions {
        NO_OPTIONS = 0,
        HINT_MANY_WRITES_EXPECTED = 1,
        NO_NULL_TERMINATION = 2,
        PRESERVE_ONE_BYTE_NULL = 4,
        REPLACE_INVALID_UTF8 = 8
    };
    static const int kMaxLength = (1 << 29) - 24;

    static MaybeLocal<String> NewFromUtf8(Isolate *, const char *data, v8::NewStringType, int length = -1)
    {
        return MaybeLocal<String>(Local<String>(internal::Str(data, length)));
    }
    static Local<String> NewFromUtf8(Isolate *, const char *data, NewStringType = kNormalString, int length = -1)
    {
        return Local<String>(internal::Str(data, length));
    }
    static MaybeLocal<String> NewFromOneByte(Isolate *, const uint8_t *data, v8::NewStringType, int length = -1)
    {
        napi_value v;
        napi_create_string_latin1(internal::Env(), reinterpret_cast<const char *>(data),
                                  length < 0 ? NAPI_AUTO_LENGTH : static_cast<size_t>(length), &v);
        return MaybeLocal<String>(Local<String>(v));
    }
    static Local<String> NewFromOneByte(Isolate *i, const uint8_t *data, NewStringType = kNormalString, int length = -1)
    {
        return NewFromOneByte(i, data, v8::NewStringType::kNormal, length).ToLocalChecked();
    }
    static MaybeLocal<String> NewFromTwoByte(Isolate *, const uint16_t *data, v8::NewStringType, int length = -1)
    {
        napi_value v;
        napi_create_string_utf16(internal::Env(), reinterpret_cast<const char16_t *>(data),
                                 length < 0 ? NAPI_AUTO_LENGTH : static_cast<size_t>(length), &v);
        return MaybeLocal<String>(Local<String>(v));
    }
    static Local<String> NewFromTwoByte(Isolate *i, const uint16_t *data, NewStringType = kNormalString, int length = -1)
    {
        return NewFromTwoByte(i, data, v8::NewStringType::kNormal, length).ToLocalChecked();
    }
    static Local<String> Empty(Isolate *) { return Local<String>(internal::Str("", 0)); }
    static Local<String> Concat(Isolate *, Local<String> a, Local<String> b)
    {
        return Local<String>(internal::Str((internal::ToStd(a.raw()) + internal::ToStd(b.raw())).c_str()));
    }
    static Local<String> Concat(Local<String> a, Local<String> b) { return Concat(nullptr, a, b); }
    /* External strings copy their data: a JS string engine cannot alias native memory the way V8 can,
       so the resource is disposed of as soon as its contents have been copied. */
    class ExternalStringResourceBase {
    public:
        virtual ~ExternalStringResourceBase() {}
        virtual void Dispose() { delete this; }
    };
    class ExternalStringResource : public ExternalStringResourceBase {
    public:
        virtual const uint16_t *data() const = 0;
        virtual size_t length() const = 0;
    };
    class ExternalOneByteStringResource : public ExternalStringResourceBase {
    public:
        virtual const char *data() const = 0;
        virtual size_t length() const = 0;
    };
    const ExternalOneByteStringResource *GetExternalOneByteStringResource() const { return nullptr; }
    ExternalStringResourceBase *GetExternalStringResourceBase(int *encoding_out) const
    {
        if (encoding_out) *encoding_out = 0;
        return nullptr;
    }
    static MaybeLocal<String> NewExternalOneByte(Isolate *i, ExternalOneByteStringResource *resource)
    {
        MaybeLocal<String> out = NewFromOneByte(i, reinterpret_cast<const uint8_t *>(resource->data()), v8::NewStringType::kNormal,
                                                static_cast<int>(resource->length()));
        resource->Dispose();
        return out;
    }
    static MaybeLocal<String> NewExternalTwoByte(Isolate *i, ExternalStringResource *resource)
    {
        MaybeLocal<String> out = NewFromTwoByte(i, resource->data(), v8::NewStringType::kNormal, static_cast<int>(resource->length()));
        resource->Dispose();
        return out;
    }

    int Length() const
    {
        size_t len = 0;
        napi_get_value_string_utf16(internal::Env(), internal::Raw(this), nullptr, 0, &len);
        return static_cast<int>(len);
    }
    int Utf8Length(Isolate * = nullptr) const
    {
        size_t len = 0;
        napi_get_value_string_utf8(internal::Env(), internal::Raw(this), nullptr, 0, &len);
        return static_cast<int>(len);
    }
    int WriteUtf8(Isolate *, char *buffer, int length = -1, int *nchars_ref = nullptr, int options = NO_OPTIONS) const
    {
        std::string s = internal::ToStd(internal::Raw(this));
        size_t room = length < 0 ? s.size() + 1 : static_cast<size_t>(length);
        size_t n = s.size() < room ? s.size() : room;
        while (n > 0 && n < s.size() && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) n--;
        std::memcpy(buffer, s.data(), n);
        if (n < room && !(options & NO_NULL_TERMINATION)) buffer[n] = '\0';
        if (nchars_ref) *nchars_ref = static_cast<int>(n);
        return static_cast<int>(n);
    }
    int WriteUtf8(char *buffer, int length = -1, int *nchars_ref = nullptr, int options = NO_OPTIONS) const
    {
        return WriteUtf8(nullptr, buffer, length, nchars_ref, options);
    }
    int Write(Isolate *, uint16_t *buffer, int start = 0, int length = -1, int options = NO_OPTIONS) const
    {
        size_t total = 0;
        napi_get_value_string_utf16(internal::Env(), internal::Raw(this), nullptr, 0, &total);
        std::vector<char16_t> tmp(total + 1);
        napi_get_value_string_utf16(internal::Env(), internal::Raw(this), tmp.data(), total + 1, &total);
        int count = static_cast<int>(total) - start;
        if (count < 0) count = 0;
        if (length >= 0 && length < count) count = length;
        std::memcpy(buffer, tmp.data() + start, static_cast<size_t>(count) * 2);
        if (!(options & NO_NULL_TERMINATION) && (length < 0 || count < length)) buffer[count] = 0;
        return count;
    }
    int Write(uint16_t *buffer, int start = 0, int length = -1, int options = NO_OPTIONS) const
    {
        return Write(nullptr, buffer, start, length, options);
    }
    int WriteOneByte(Isolate *, uint8_t *buffer, int start = 0, int length = -1, int options = NO_OPTIONS) const
    {
        size_t total = 0;
        napi_get_value_string_latin1(internal::Env(), internal::Raw(this), nullptr, 0, &total);
        std::vector<char> tmp(total + 1);
        napi_get_value_string_latin1(internal::Env(), internal::Raw(this), tmp.data(), total + 1, &total);
        int count = static_cast<int>(total) - start;
        if (count < 0) count = 0;
        if (length >= 0 && length < count) count = length;
        std::memcpy(buffer, tmp.data() + start, static_cast<size_t>(count));
        if (!(options & NO_NULL_TERMINATION) && (length < 0 || count < length)) buffer[count] = 0;
        return count;
    }
    int WriteOneByte(uint8_t *buffer, int start = 0, int length = -1, int options = NO_OPTIONS) const
    {
        return WriteOneByte(nullptr, buffer, start, length, options);
    }
    bool IsOneByte() const
    {
        size_t total = 0;
        napi_get_value_string_utf16(internal::Env(), internal::Raw(this), nullptr, 0, &total);
        std::vector<char16_t> tmp(total + 1);
        napi_get_value_string_utf16(internal::Env(), internal::Raw(this), tmp.data(), total + 1, &total);
        for (size_t i = 0; i < total; i++) if (tmp[i] > 0xFF) return false;
        return true;
    }
    bool ContainsOnlyOneByte() const { return IsOneByte(); }
    bool IsExternal() const { return false; }
    bool IsExternalOneByte() const { return false; }
    bool IsExternalTwoByte() const { return false; }

    class Utf8Value {
    public:
        Utf8Value(Isolate *, Local<v8::Value> obj) { Init(obj); }
        explicit Utf8Value(Local<v8::Value> obj) { Init(obj); }
        char *operator*() { return const_cast<char *>(str_.c_str()); }
        const char *operator*() const { return str_.c_str(); }
        int length() const { return static_cast<int>(str_.size()); }
        Utf8Value(const Utf8Value &) = delete;
        Utf8Value &operator=(const Utf8Value &) = delete;

    private:
        void Init(Local<v8::Value> obj)
        {
            napi_value s = obj.raw();
            napi_valuetype t;
            if (!s) return;
            if (napi_typeof(internal::Env(), s, &t) == napi_ok && t != napi_string) {
                if (napi_coerce_to_string(internal::Env(), s, &s) != napi_ok) return;
            }
            str_ = internal::ToStd(s);
        }
        std::string str_;
    };

    class Value {
    public:
        Value(Isolate *, Local<v8::Value> obj) { Init(obj); }
        explicit Value(Local<v8::Value> obj) { Init(obj); }
        uint16_t *operator*() { return data_.data(); }
        const uint16_t *operator*() const { return data_.data(); }
        int length() const { return static_cast<int>(data_.size()) - 1; }
        Value(const Value &) = delete;
        Value &operator=(const Value &) = delete;

    private:
        void Init(Local<v8::Value> obj)
        {
            napi_value s = obj.raw();
            size_t len = 0;
            if (!s || napi_coerce_to_string(internal::Env(), s, &s) != napi_ok) {
                data_.assign(1, 0);
                return;
            }
            napi_get_value_string_utf16(internal::Env(), s, nullptr, 0, &len);
            std::vector<char16_t> tmp(len + 1);
            napi_get_value_string_utf16(internal::Env(), s, tmp.data(), len + 1, &len);
            data_.assign(reinterpret_cast<uint16_t *>(tmp.data()), reinterpret_cast<uint16_t *>(tmp.data()) + len);
            data_.push_back(0);
        }
        std::vector<uint16_t> data_;
    };

    template <class T> static String *Cast(T *v) { return reinterpret_cast<String *>(v); }
};

inline MaybeLocal<String> Value::ToString(Local<Context>) const
{
    napi_value s;
    return internal::Result<String>(napi_coerce_to_string(internal::Env(), internal::Raw(this), &s), s);
}
inline MaybeLocal<Object> Value::ToObject(Local<Context>) const
{
    napi_value o;
    return internal::Result<Object>(napi_coerce_to_object(internal::Env(), internal::Raw(this), &o), o);
}
inline Local<Object> Value::ToObject(Isolate *) const { return ToObject(Local<Context>()).FromMaybe(Local<Object>()); }
inline Local<Object> Value::ToObject() const { return ToObject(Local<Context>()).FromMaybe(Local<Object>()); }
inline MaybeLocal<Number> Value::ToNumber(Local<Context>) const
{
    napi_value n;
    return internal::Result<Number>(napi_coerce_to_number(internal::Env(), internal::Raw(this), &n), n);
}
inline MaybeLocal<Integer> Value::ToInteger(Local<Context> c) const
{
    int64_t i;
    if (!IntegerValue(c).To(&i)) return MaybeLocal<Integer>();
    napi_value n;
    napi_create_int64(internal::Env(), i, &n);
    return MaybeLocal<Integer>(Local<Integer>(n));
}
inline MaybeLocal<Int32> Value::ToInt32(Local<Context> c) const
{
    int32_t i;
    if (!Int32Value(c).To(&i)) return MaybeLocal<Int32>();
    napi_value n;
    napi_create_int32(internal::Env(), i, &n);
    return MaybeLocal<Int32>(Local<Int32>(n));
}
inline MaybeLocal<Uint32> Value::ToUint32(Local<Context> c) const
{
    uint32_t i;
    if (!Uint32Value(c).To(&i)) return MaybeLocal<Uint32>();
    napi_value n;
    napi_create_uint32(internal::Env(), i, &n);
    return MaybeLocal<Uint32>(Local<Uint32>(n));
}
inline Local<Boolean> Value::ToBoolean(Isolate *i) const { return Boolean::New(i, BooleanValue()); }
inline Local<Number> Value::ToNumber(Isolate *) const { return ToNumber(Local<Context>()).FromMaybe(Local<Number>()); }
inline Local<Integer> Value::ToInteger(Isolate *) const { return ToInteger(Local<Context>()).FromMaybe(Local<Integer>()); }
inline Local<Int32> Value::ToInt32(Isolate *) const { return ToInt32(Local<Context>()).FromMaybe(Local<Int32>()); }
inline Local<Uint32> Value::ToUint32(Isolate *) const { return ToUint32(Local<Context>()).FromMaybe(Local<Uint32>()); }
inline Local<Number> Value::ToNumber() const { return ToNumber(Local<Context>()).FromMaybe(Local<Number>()); }
inline Local<Integer> Value::ToInteger() const { return ToInteger(Local<Context>()).FromMaybe(Local<Integer>()); }
inline Local<Int32> Value::ToInt32() const { return ToInt32(Local<Context>()).FromMaybe(Local<Int32>()); }
inline Local<Uint32> Value::ToUint32() const { return ToUint32(Local<Context>()).FromMaybe(Local<Uint32>()); }

inline Local<Symbol> Symbol::New(Isolate *, Local<String> description)
{
    napi_value s;
    napi_create_symbol(internal::Env(), description.raw(), &s);
    return Local<Symbol>(s);
}
inline Local<Symbol> Symbol::For(Isolate *, Local<String> name)
{
    return Local<Symbol>(internal::CallGlobalMethod("Symbol", "for", name.raw()));
}
inline Local<Value> Symbol::Name() const { return Local<Value>(internal::PropGet(internal::Raw(this), "description")); }
inline Local<Private> Private::New(Isolate *, Local<String> name)
{
    napi_value s;
    napi_create_symbol(internal::Env(), name.raw(), &s);
    return Local<Private>(s);
}
inline Local<Private> Private::ForApi(Isolate *, Local<String> name)
{
    std::string key = "v8::Private::" + internal::ToStd(name.raw());
    return Local<Private>(internal::CallGlobalMethod("Symbol", "for", internal::Str(key.c_str())));
}

/* ---- callbacks and their info objects ------------------------------------------------------ */

template <class T> class ReturnValue {
public:
    explicit ReturnValue(napi_value *slot) : slot_(slot) {}
    template <class S> void Set(const Local<S> &handle) { *slot_ = handle.raw(); }
    template <class S, class M> void Set(const Persistent<S, M> &handle);
    void Set(bool value) { napi_get_boolean(internal::Env(), value, slot_); }
    void Set(double value) { napi_create_double(internal::Env(), value, slot_); }
    void Set(int32_t value) { napi_create_int32(internal::Env(), value, slot_); }
    void Set(uint32_t value) { napi_create_uint32(internal::Env(), value, slot_); }
    void SetNull() { napi_get_null(internal::Env(), slot_); }
    void SetUndefined() { napi_get_undefined(internal::Env(), slot_); }
    void SetEmptyString() { *slot_ = internal::Str("", 0); }
    Local<Value> Get() const { return Local<Value>(*slot_ ? *slot_ : internal::Undefined()); }
    Isolate *GetIsolate() const { return Isolate::GetCurrent(); }

private:
    napi_value *slot_;
};

typedef void (*FunctionCallback)(const FunctionCallbackInfo<Value> &info);
typedef void (*AccessorGetterCallback)(Local<String> property, const PropertyCallbackInfo<Value> &info);
typedef void (*AccessorNameGetterCallback)(Local<Name> property, const PropertyCallbackInfo<Value> &info);
typedef void (*AccessorSetterCallback)(Local<String> property, Local<Value> value, const PropertyCallbackInfo<void> &info);
typedef void (*AccessorNameSetterCallback)(Local<Name> property, Local<Value> value, const PropertyCallbackInfo<void> &info);

template <class T> class FunctionCallbackInfo {
public:
    FunctionCallbackInfo(napi_env env, napi_callback_info info, const internal::Ref &data)
    {
        size_t argc = 0;
        napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
        args_.resize(argc);
        if (argc) napi_get_cb_info(env, info, &argc, args_.data(), &this_, nullptr);
        else napi_get_cb_info(env, info, nullptr, nullptr, &this_, nullptr);
        napi_get_new_target(env, info, &new_target_);
        data_ = internal::RefValue(data);
    }
    int Length() const { return static_cast<int>(args_.size()); }
    Local<Value> operator[](int i) const
    {
        return Local<Value>(i >= 0 && i < Length() ? args_[static_cast<size_t>(i)] : internal::Undefined());
    }
    Local<Object> This() const { return Local<Object>(this_); }
    Local<Object> Holder() const { return Local<Object>(this_); }
    bool IsConstructCall() const { return new_target_ != nullptr; }
    Local<Value> NewTarget() const { return Local<Value>(new_target_ ? new_target_ : internal::Undefined()); }
    Local<Value> Data() const { return Local<Value>(data_ ? data_ : internal::Undefined()); }
    Isolate *GetIsolate() const { return Isolate::GetCurrent(); }
    ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(&rv_); }
    napi_value result() const { return rv_; }

private:
    std::vector<napi_value> args_;
    napi_value this_ = nullptr;
    napi_value new_target_ = nullptr;
    napi_value data_ = nullptr;
    mutable napi_value rv_ = nullptr;
};

template <class T> class PropertyCallbackInfo {
public:
    PropertyCallbackInfo(napi_value self, napi_value data, napi_value holder = nullptr) : this_(self), data_(data), holder_(holder) {}
    Isolate *GetIsolate() const { return Isolate::GetCurrent(); }
    Local<Value> Data() const { return Local<Value>(data_ ? data_ : internal::Undefined()); }
    Local<Object> This() const { return Local<Object>(this_); }
    Local<Object> Holder() const { return Local<Object>(holder_ ? holder_ : this_); }
    ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(&rv_); }
    bool ShouldThrowOnError() const { return false; }
    napi_value result() const { return rv_; }

private:
    napi_value this_;
    napi_value data_;
    napi_value holder_;
    mutable napi_value rv_ = nullptr;
};

/* ---- objects ------------------------------------------------------------------------------- */

namespace internal {

struct FnData {
    FunctionCallback cb;
    Ref data;
};

struct AccData {
    void *getter;
    void *setter;
    bool name_variant;
    Ref data;
    Ref name;
};

inline napi_value FnTramp(napi_env env, napi_callback_info cbinfo)
{
    EnvScope scope(env);
    FnData *d = nullptr;
    napi_get_cb_info(env, cbinfo, nullptr, nullptr, nullptr, reinterpret_cast<void **>(&d));
    FunctionCallbackInfo<Value> info(env, cbinfo, d->data);
    d->cb(info);
    return info.result();
}

inline napi_value AccGetTramp(napi_env env, napi_callback_info cbinfo)
{
    EnvScope scope(env);
    AccData *d = nullptr;
    napi_value self = nullptr;
    napi_get_cb_info(env, cbinfo, nullptr, nullptr, &self, reinterpret_cast<void **>(&d));
    PropertyCallbackInfo<Value> info(self, RefValue(d->data));
    napi_value name = RefValue(d->name);
    if (d->name_variant) reinterpret_cast<AccessorNameGetterCallback>(d->getter)(Local<Name>(name), info);
    else reinterpret_cast<AccessorGetterCallback>(d->getter)(Local<String>(name), info);
    return info.result();
}

inline napi_value AccSetTramp(napi_env env, napi_callback_info cbinfo)
{
    EnvScope scope(env);
    AccData *d = nullptr;
    napi_value self = nullptr;
    napi_value arg = nullptr;
    size_t argc = 1;
    napi_get_cb_info(env, cbinfo, &argc, &arg, &self, reinterpret_cast<void **>(&d));
    PropertyCallbackInfo<void> info(self, RefValue(d->data));
    napi_value name = RefValue(d->name);
    if (!arg) arg = Undefined();
    if (d->name_variant) reinterpret_cast<AccessorNameSetterCallback>(d->setter)(Local<Name>(name), Local<Value>(arg), info);
    else reinterpret_cast<AccessorSetterCallback>(d->setter)(Local<String>(name), Local<Value>(arg), info);
    return nullptr;
}

inline int NapiAttrs(int v8attrs, bool accessor)
{
    int a = napi_enumerable | napi_configurable;
    if (v8attrs & DontEnum) a &= ~napi_enumerable;
    if (v8attrs & DontDelete) a &= ~napi_configurable;
    if (!accessor && !(v8attrs & ReadOnly)) a |= napi_writable;
    return a;
}

inline napi_value NewFunction(FunctionCallback cb, napi_value data, const char *name = nullptr)
{
    FnData *d = new FnData{cb, KeepRef(data)};
    napi_value fn;
    napi_create_function(Env(), name, name ? NAPI_AUTO_LENGTH : 0, FnTramp, d, &fn);
    return fn;
}

inline bool DefineAccessor(napi_value obj, napi_value name, void *getter, void *setter, bool name_variant, napi_value data,
                           int attrs)
{
    AccData *d = new AccData{getter, setter, name_variant, KeepRef(data), KeepRef(name)};
    napi_property_descriptor desc = {};
    desc.name = name;
    desc.getter = getter ? AccGetTramp : nullptr;
    desc.setter = setter ? AccSetTramp : nullptr;
    desc.data = d;
    desc.attributes = static_cast<napi_property_attributes>(NapiAttrs(attrs, true));
    return napi_define_properties(Env(), obj, 1, &desc) == napi_ok;
}

inline napi_value InternalFields(napi_value obj, bool create, uint32_t count = 0)
{
    napi_value key = Str("__v8_internal_fields");
    bool has = false;
    napi_has_own_property(Env(), obj, key, &has);
    napi_value arr = nullptr;
    if (has) {
        napi_get_property(Env(), obj, key, &arr);
    } else if (create) {
        napi_create_array_with_length(Env(), count, &arr);
        napi_value undef = Undefined();
        for (uint32_t i = 0; i < count; i++) napi_set_element(Env(), arr, i, undef);
        napi_property_descriptor desc = {};
        desc.name = key;
        desc.value = arr;
        napi_define_properties(Env(), obj, 1, &desc);
    }
    return arr;
}

}  // namespace internal

class Object : public Value {
public:
    static Local<Object> New(Isolate *)
    {
        napi_value o;
        napi_create_object(internal::Env(), &o);
        return Local<Object>(o);
    }

    Maybe<bool> Set(Local<Context>, Local<Value> key, Local<Value> value)
    {
        if (napi_set_property(internal::Env(), internal::Raw(this), key.raw(), value.raw()) != napi_ok) return Nothing<bool>();
        return Just(true);
    }
    Maybe<bool> Set(Local<Context>, uint32_t index, Local<Value> value)
    {
        if (napi_set_element(internal::Env(), internal::Raw(this), index, value.raw()) != napi_ok) return Nothing<bool>();
        return Just(true);
    }
    bool Set(Local<Value> key, Local<Value> value) { return Set(Local<Context>(), key, value).FromMaybe(false); }
    bool Set(uint32_t index, Local<Value> value) { return Set(Local<Context>(), index, value).FromMaybe(false); }
    Maybe<bool> CreateDataProperty(Local<Context> c, Local<Name> key, Local<Value> value) { return Set(c, key, value); }
    Maybe<bool> CreateDataProperty(Local<Context> c, uint32_t index, Local<Value> value) { return Set(c, index, value); }
    MaybeLocal<Value> Get(Local<Context>, Local<Value> key)
    {
        napi_value v;
        return internal::Result<Value>(napi_get_property(internal::Env(), internal::Raw(this), key.raw(), &v), v);
    }
    MaybeLocal<Value> Get(Local<Context>, uint32_t index)
    {
        napi_value v;
        return internal::Result<Value>(napi_get_element(internal::Env(), internal::Raw(this), index, &v), v);
    }
    Local<Value> Get(Local<Value> key) { return Get(Local<Context>(), key).FromMaybe(Local<Value>()); }
    Local<Value> Get(uint32_t index) { return Get(Local<Context>(), index).FromMaybe(Local<Value>()); }
    Maybe<bool> Has(Local<Context>, Local<Value> key)
    {
        bool r = false;
        if (napi_has_property(internal::Env(), internal::Raw(this), key.raw(), &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    Maybe<bool> Has(Local<Context>, uint32_t index)
    {
        bool r = false;
        if (napi_has_element(internal::Env(), internal::Raw(this), index, &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    bool Has(Local<Value> key) { return Has(Local<Context>(), key).FromMaybe(false); }
    Maybe<bool> HasOwnProperty(Local<Context>, Local<Name> key)
    {
        bool r = false;
        if (napi_has_own_property(internal::Env(), internal::Raw(this), key.raw(), &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    Maybe<bool> HasRealNamedProperty(Local<Context> c, Local<Name> key) { return HasOwnProperty(c, key); }
    Maybe<bool> Delete(Local<Context>, Local<Value> key)
    {
        bool r = false;
        if (napi_delete_property(internal::Env(), internal::Raw(this), key.raw(), &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    Maybe<bool> Delete(Local<Context>, uint32_t index)
    {
        bool r = false;
        if (napi_delete_element(internal::Env(), internal::Raw(this), index, &r) != napi_ok) return Nothing<bool>();
        return Just(r);
    }
    bool Delete(Local<Value> key) { return Delete(Local<Context>(), key).FromMaybe(false); }
    MaybeLocal<Value> GetRealNamedProperty(Local<Context> c, Local<Name> key) { return Get(c, key); }
    MaybeLocal<Array> GetPropertyNames(Local<Context>);
    Local<Array> GetPropertyNames();
    /* V8's own default: enumerable, non-symbol properties only. An array's `length` is not one of them,
       and code that counts the result to size a list (erlpack does) is wrong by one if it is. */
    MaybeLocal<Array> GetOwnPropertyNames(Local<Context>, PropertyFilter filter = static_cast<PropertyFilter>(ONLY_ENUMERABLE | SKIP_SYMBOLS));
    Local<Array> GetOwnPropertyNames();
    Maybe<bool> DefineOwnProperty(Local<Context>, Local<Name> key, Local<Value> value, PropertyAttribute attributes = None)
    {
        napi_property_descriptor desc = {};
        desc.name = key.raw();
        desc.value = value.raw();
        desc.attributes = static_cast<napi_property_attributes>(internal::NapiAttrs(attributes, false));
        if (napi_define_properties(internal::Env(), internal::Raw(this), 1, &desc) != napi_ok) return Nothing<bool>();
        return Just(true);
    }
    Maybe<bool> SetAccessor(Local<Context>, Local<Name> name, AccessorNameGetterCallback getter,
                            AccessorNameSetterCallback setter = nullptr, Local<Value> data = Local<Value>(),
                            AccessControl = DEFAULT, PropertyAttribute attribute = None)
    {
        return Just(internal::DefineAccessor(internal::Raw(this), name.raw(), reinterpret_cast<void *>(getter),
                                             reinterpret_cast<void *>(setter), true, data.raw(), attribute));
    }
    Maybe<bool> SetAccessor(Local<Context>, Local<Name> name, AccessorGetterCallback getter,
                            AccessorSetterCallback setter = nullptr, Local<Value> data = Local<Value>(),
                            AccessControl = DEFAULT, PropertyAttribute attribute = None)
    {
        return Just(internal::DefineAccessor(internal::Raw(this), name.raw(), reinterpret_cast<void *>(getter),
                                             reinterpret_cast<void *>(setter), false, data.raw(), attribute));
    }
    Maybe<bool> SetNativeDataProperty(Local<Context> c, Local<Name> name, AccessorNameGetterCallback getter,
                                      AccessorNameSetterCallback setter = nullptr, Local<Value> data = Local<Value>(),
                                      PropertyAttribute attribute = None)
    {
        return SetAccessor(c, name, getter, setter, data, DEFAULT, attribute);
    }
    Local<Value> GetPrototype()
    {
        napi_value p;
        napi_get_prototype(internal::Env(), internal::Raw(this), &p);
        return Local<Value>(p);
    }
    Maybe<bool> SetPrototype(Local<Context>, Local<Value> prototype)
    {
        napi_value object = internal::PropGet(internal::Global(), "Object");
        napi_value fn = internal::PropGet(object, "setPrototypeOf");
        napi_value args[2] = {internal::Raw(this), prototype.raw()};
        napi_value out;
        if (napi_call_function(internal::Env(), object, fn, 2, args, &out) != napi_ok) return Nothing<bool>();
        return Just(true);
    }
    Local<String> GetConstructorName()
    {
        napi_value ctor = internal::PropGet(internal::Raw(this), "constructor");
        napi_value name = ctor ? internal::PropGet(ctor, "name") : nullptr;
        return Local<String>(name ? name : internal::Str("Object"));
    }
    MaybeLocal<String> ObjectProtoToString(Local<Context>)
    {
        napi_value proto = internal::PropGet(internal::PropGet(internal::Global(), "Object"), "prototype");
        napi_value fn = internal::PropGet(proto, "toString");
        napi_value out;
        return internal::Result<String>(napi_call_function(internal::Env(), internal::Raw(this), fn, 0, nullptr, &out), out);
    }
    Local<Context> CreationContext() { return Context::GetCurrent(); }
    Local<Object> Clone()
    {
        napi_value object = internal::PropGet(internal::Global(), "Object");
        napi_value fn = internal::PropGet(object, "assign");
        napi_value target;
        napi_create_object(internal::Env(), &target);
        napi_value args[2] = {target, internal::Raw(this)};
        napi_value out;
        napi_call_function(internal::Env(), object, fn, 2, args, &out);
        return Local<Object>(target);
    }
    bool IsCallable() { return IsFunction(); }
    Isolate *GetIsolate() { return Isolate::GetCurrent(); }

    int InternalFieldCount()
    {
        napi_value arr = internal::InternalFields(internal::Raw(this), false);
        uint32_t n = 0;
        if (arr) napi_get_array_length(internal::Env(), arr, &n);
        return static_cast<int>(n);
    }
    Local<Value> GetInternalField(int index)
    {
        napi_value arr = internal::InternalFields(internal::Raw(this), false), v = nullptr;
        if (arr) napi_get_element(internal::Env(), arr, static_cast<uint32_t>(index), &v);
        return Local<Value>(v ? v : internal::Undefined());
    }
    void SetInternalField(int index, Local<Value> value)
    {
        napi_value arr = internal::InternalFields(internal::Raw(this), true, static_cast<uint32_t>(index) + 1);
        napi_set_element(internal::Env(), arr, static_cast<uint32_t>(index), value.raw());
    }
    void *GetAlignedPointerFromInternalField(int index)
    {
        napi_value v = GetInternalField(index).raw();
        void *p = nullptr;
        napi_valuetype t;
        if (v && napi_typeof(internal::Env(), v, &t) == napi_ok && t == napi_external) napi_get_value_external(internal::Env(), v, &p);
        return p;
    }
    void SetAlignedPointerInInternalField(int index, void *value)
    {
        napi_value ext;
        napi_create_external(internal::Env(), value, nullptr, nullptr, &ext);
        SetInternalField(index, Local<Value>(ext));
    }

    Maybe<bool> HasPrivate(Local<Context> c, Local<Private> key) { return Has(c, Local<Value>(key.raw())); }
    MaybeLocal<Value> GetPrivate(Local<Context> c, Local<Private> key) { return Get(c, Local<Value>(key.raw())); }
    Maybe<bool> SetPrivate(Local<Context>, Local<Private> key, Local<Value> value)
    {
        napi_property_descriptor desc = {};
        desc.name = key.raw();
        desc.value = value.raw();
        desc.attributes = static_cast<napi_property_attributes>(napi_writable | napi_configurable);
        if (napi_define_properties(internal::Env(), internal::Raw(this), 1, &desc) != napi_ok) return Nothing<bool>();
        return Just(true);
    }
    Maybe<bool> DeletePrivate(Local<Context> c, Local<Private> key) { return Delete(c, Local<Value>(key.raw())); }

    Maybe<PropertyAttribute> GetPropertyAttributes(Local<Context>, Local<Value> key)
    {
        napi_value object = internal::PropGet(internal::Global(), "Object");
        napi_value fn = internal::PropGet(object, "getOwnPropertyDescriptor"), out = nullptr;
        napi_value args[2] = {internal::Raw(this), key.raw()};
        if (napi_call_function(internal::Env(), object, fn, 2, args, &out) != napi_ok || !out) return Nothing<PropertyAttribute>();
        int attrs = None;
        napi_valuetype t;
        napi_typeof(internal::Env(), out, &t);
        if (t != napi_object) return Just(static_cast<PropertyAttribute>(attrs));
        auto flag = [&](const char *name) {
            napi_value v = internal::PropGet(out, name);
            bool b = false;
            if (v) napi_get_value_bool(internal::Env(), v, &b);
            return b;
        };
        if (!flag("writable") && internal::PropGet(out, "value")) attrs |= ReadOnly;
        if (!flag("enumerable")) attrs |= DontEnum;
        if (!flag("configurable")) attrs |= DontDelete;
        return Just(static_cast<PropertyAttribute>(attrs));
    }
    Maybe<bool> HasRealIndexedProperty(Local<Context> c, uint32_t index) { return Has(c, index); }
    Maybe<bool> HasRealNamedCallbackProperty(Local<Context>, Local<Name>) { return Just(false); }
    MaybeLocal<Value> GetRealNamedPropertyInPrototypeChain(Local<Context> c, Local<Name> key)
    {
        Local<Value> proto = GetPrototype();
        if (proto.IsEmpty() || !proto->IsObject()) return MaybeLocal<Value>();
        return Local<Object>(proto.raw())->Get(c, key);
    }
    MaybeLocal<Value> CallAsConstructor(Local<Context>, int argc, Local<Value> argv[])
    {
        std::vector<napi_value> args(static_cast<size_t>(argc));
        for (int i = 0; i < argc; i++) args[static_cast<size_t>(i)] = argv[i].raw();
        napi_value out;
        return internal::Result<Value>(napi_new_instance(internal::Env(), internal::Raw(this), args.size(), args.data(), &out), out);
    }
    MaybeLocal<Value> CallAsFunction(Local<Context>, Local<Value> recv, int argc, Local<Value> argv[])
    {
        std::vector<napi_value> args(static_cast<size_t>(argc));
        for (int i = 0; i < argc; i++) args[static_cast<size_t>(i)] = argv[i].raw();
        napi_value out;
        return internal::Result<Value>(
            napi_call_function(internal::Env(), recv.raw(), internal::Raw(this), args.size(), args.data(), &out), out);
    }
    template <class T> static Object *Cast(T *v) { return reinterpret_cast<Object *>(v); }
};

class Array : public Object {
public:
    static Local<Array> New(Isolate *, int length = 0)
    {
        napi_value a;
        napi_create_array_with_length(internal::Env(), static_cast<size_t>(length < 0 ? 0 : length), &a);
        return Local<Array>(a);
    }
    static Local<Array> New(Isolate *i, Local<Value> *elements, size_t length)
    {
        Local<Array> a = New(i, static_cast<int>(length));
        for (size_t k = 0; k < length; k++) napi_set_element(internal::Env(), a.raw(), static_cast<uint32_t>(k), elements[k].raw());
        return a;
    }
    uint32_t Length() const
    {
        uint32_t n = 0;
        napi_get_array_length(internal::Env(), internal::Raw(this), &n);
        return n;
    }
    template <class T> static Array *Cast(T *v) { return reinterpret_cast<Array *>(v); }
};

inline MaybeLocal<Array> Object::GetPropertyNames(Local<Context>)
{
    napi_value a;
    return internal::Result<Array>(napi_get_property_names(internal::Env(), internal::Raw(this), &a), a);
}
inline Local<Array> Object::GetPropertyNames() { return GetPropertyNames(Local<Context>()).FromMaybe(Local<Array>()); }
inline MaybeLocal<Array> Object::GetOwnPropertyNames(Local<Context>, PropertyFilter filter)
{
    napi_value a;
    int napi_filter = (filter & SKIP_SYMBOLS) ? napi_key_skip_symbols : 0;
    if (filter & ONLY_ENUMERABLE) napi_filter |= napi_key_enumerable;
    if (filter & ONLY_WRITABLE) napi_filter |= napi_key_writable;
    if (filter & ONLY_CONFIGURABLE) napi_filter |= napi_key_configurable;
    if (filter & SKIP_STRINGS) napi_filter |= napi_key_skip_strings;
    return internal::Result<Array>(
        napi_get_all_property_names(internal::Env(), internal::Raw(this), napi_key_own_only,
                                    static_cast<napi_key_filter>(napi_filter), napi_key_numbers_to_strings, &a),
        a);
}
inline Local<Array> Object::GetOwnPropertyNames() { return GetOwnPropertyNames(Local<Context>()).FromMaybe(Local<Array>()); }

class External : public Value {
public:
    static Local<External> New(Isolate *, void *value)
    {
        napi_value v;
        napi_create_external(internal::Env(), value, nullptr, nullptr, &v);
        return Local<External>(v);
    }
    void *Value() const
    {
        void *p = nullptr;
        napi_get_value_external(internal::Env(), internal::Raw(this), &p);
        return p;
    }
    template <class T> static External *Cast(T *v) { return reinterpret_cast<External *>(v); }
};

class Function : public Object {
public:
    static MaybeLocal<Function> New(Local<Context>, FunctionCallback callback, Local<v8::Value> data = Local<v8::Value>(),
                                    int = 0, ConstructorBehavior = ConstructorBehavior::kAllow, SideEffectType = SideEffectType::kHasSideEffect)
    {
        return MaybeLocal<Function>(Local<Function>(internal::NewFunction(callback, data.raw())));
    }
    MaybeLocal<v8::Value> Call(Local<Context>, Local<v8::Value> recv, int argc, Local<v8::Value> argv[])
    {
        std::vector<napi_value> args(static_cast<size_t>(argc));
        for (int i = 0; i < argc; i++) args[static_cast<size_t>(i)] = argv[i].raw();
        napi_value out;
        return internal::Result<v8::Value>(
            napi_call_function(internal::Env(), recv.raw(), internal::Raw(this), args.size(), args.data(), &out), out);
    }
    Local<v8::Value> Call(Local<v8::Value> recv, int argc, Local<v8::Value> argv[])
    {
        return Call(Local<Context>(), recv, argc, argv).FromMaybe(Local<v8::Value>());
    }
    MaybeLocal<Object> NewInstance(Local<Context>, int argc, Local<v8::Value> argv[]) const
    {
        std::vector<napi_value> args(static_cast<size_t>(argc));
        for (int i = 0; i < argc; i++) args[static_cast<size_t>(i)] = argv[i].raw();
        napi_value out;
        return internal::Result<Object>(napi_new_instance(internal::Env(), internal::Raw(this), args.size(), args.data(), &out), out);
    }
    MaybeLocal<Object> NewInstance(Local<Context> c) const { return NewInstance(c, 0, nullptr); }
    Local<Object> NewInstance(int argc, Local<v8::Value> argv[]) const
    {
        return NewInstance(Local<Context>(), argc, argv).FromMaybe(Local<Object>());
    }
    Local<Object> NewInstance() const { return NewInstance(0, nullptr); }
    void SetName(Local<String> name)
    {
        napi_property_descriptor desc = {};
        desc.utf8name = "name";
        desc.value = name.raw();
        desc.attributes = napi_configurable;
        napi_define_properties(internal::Env(), internal::Raw(this), 1, &desc);
    }
    Local<v8::Value> GetName() const { return Local<v8::Value>(internal::PropGet(internal::Raw(this), "name")); }
    Local<v8::Value> GetDebugName() const { return GetName(); }
    int GetScriptLineNumber() const { return 0; }
    template <class T> static Function *Cast(T *v) { return reinterpret_cast<Function *>(v); }
};

class Date : public Object {
public:
    static MaybeLocal<v8::Value> New(Local<Context>, double time)
    {
        napi_value d;
        return internal::Result<v8::Value>(napi_create_date(internal::Env(), time, &d), d);
    }
    double ValueOf() const
    {
        double t = 0;
        napi_get_date_value(internal::Env(), internal::Raw(this), &t);
        return t;
    }
    template <class T> static Date *Cast(T *v) { return reinterpret_cast<Date *>(v); }
};

class Promise : public Object {
public:
    class Resolver : public Object {
    public:
        static MaybeLocal<Resolver> New(Local<Context>);
        Local<Promise> GetPromise();
        Maybe<bool> Resolve(Local<Context>, Local<v8::Value> value);
        Maybe<bool> Reject(Local<Context>, Local<v8::Value> value);
        template <class T> static Resolver *Cast(T *v) { return reinterpret_cast<Resolver *>(v); }
    };
    enum PromiseState { kPending, kFulfilled, kRejected };
    template <class T> static Promise *Cast(T *v) { return reinterpret_cast<Promise *>(v); }
};

namespace internal {
struct ResolverData {
    napi_deferred deferred;
    Ref promise;
};
inline const napi_type_tag &ResolverTag()
{
    static const napi_type_tag tag = {0x7f3a6e2d5c1b4a90ULL, 0xa1b2c3d4e5f60718ULL};
    return tag;
}
inline ResolverData *Resolver(const void *self)
{
    void *p = nullptr;
    napi_unwrap(Env(), Raw(static_cast<const Object *>(self)), &p);
    return static_cast<ResolverData *>(p);
}
}  // namespace internal

inline MaybeLocal<Promise::Resolver> Promise::Resolver::New(Local<Context>)
{
    napi_value handle, promise;
    internal::ResolverData *d = new internal::ResolverData();
    if (napi_create_promise(internal::Env(), &d->deferred, &promise) != napi_ok) {
        delete d;
        return MaybeLocal<Resolver>();
    }
    d->promise = internal::KeepRef(promise);
    napi_create_object(internal::Env(), &handle);
    napi_wrap(internal::Env(), handle, d, nullptr, nullptr, nullptr);
    return MaybeLocal<Resolver>(Local<Resolver>(handle));
}
inline Local<Promise> Promise::Resolver::GetPromise()
{
    return Local<Promise>(internal::RefValue(internal::Resolver(this)->promise));
}
inline Maybe<bool> Promise::Resolver::Resolve(Local<Context>, Local<v8::Value> value)
{
    if (napi_resolve_deferred(internal::Env(), internal::Resolver(this)->deferred, value.raw()) != napi_ok) return Nothing<bool>();
    return Just(true);
}
inline Maybe<bool> Promise::Resolver::Reject(Local<Context>, Local<v8::Value> value)
{
    if (napi_reject_deferred(internal::Env(), internal::Resolver(this)->deferred, value.raw()) != napi_ok) return Nothing<bool>();
    return Just(true);
}

/* Property interceptors. Node-API has no per-access hook, so an object whose template carries a handler
   is handed out wrapped in a JavaScript Proxy whose traps call these callbacks (see Proxied() below). A
   callback that sets no return value declines, and the access falls through to the ordinary property, as in V8. */
typedef void (*GenericNamedPropertyGetterCallback)(Local<Name> property, const PropertyCallbackInfo<Value> &info);
typedef void (*GenericNamedPropertySetterCallback)(Local<Name> property, Local<Value> value, const PropertyCallbackInfo<Value> &info);
typedef void (*GenericNamedPropertyQueryCallback)(Local<Name> property, const PropertyCallbackInfo<Integer> &info);
typedef void (*GenericNamedPropertyDeleterCallback)(Local<Name> property, const PropertyCallbackInfo<Boolean> &info);
typedef void (*GenericNamedPropertyEnumeratorCallback)(const PropertyCallbackInfo<Array> &info);
typedef void (*GenericNamedPropertyDescriptorCallback)(Local<Name> property, const PropertyCallbackInfo<Value> &info);
typedef void (*GenericNamedPropertyDefinerCallback)(Local<Name> property, const PropertyDescriptor &desc, const PropertyCallbackInfo<Value> &info);
typedef void (*IndexedPropertyGetterCallback)(uint32_t index, const PropertyCallbackInfo<Value> &info);
typedef void (*IndexedPropertySetterCallback)(uint32_t index, Local<Value> value, const PropertyCallbackInfo<Value> &info);
typedef void (*IndexedPropertyQueryCallback)(uint32_t index, const PropertyCallbackInfo<Integer> &info);
typedef void (*IndexedPropertyDeleterCallback)(uint32_t index, const PropertyCallbackInfo<Boolean> &info);
typedef void (*IndexedPropertyEnumeratorCallback)(const PropertyCallbackInfo<Array> &info);
typedef void (*IndexedPropertyDescriptorCallback)(uint32_t index, const PropertyCallbackInfo<Value> &info);
typedef void (*IndexedPropertyDefinerCallback)(uint32_t index, const PropertyDescriptor &desc, const PropertyCallbackInfo<Value> &info);

enum class PropertyHandlerFlags { kNone = 0, kAllCanRead = 1, kNonMasking = 2, kOnlyInterceptStrings = 4, kHasNoSideEffect = 8 };
inline PropertyHandlerFlags operator|(PropertyHandlerFlags a, PropertyHandlerFlags b)
{
    return static_cast<PropertyHandlerFlags>(static_cast<int>(a) | static_cast<int>(b));
}

/* One configuration type for both, holding the callbacks type-erased: which of the two it is decides how
   the trap calls them. */
struct PropertyHandlerConfigurationBase {
    void *getter = nullptr;
    void *setter = nullptr;
    void *query = nullptr;
    void *deleter = nullptr;
    void *enumerator = nullptr;
    Local<Value> data;
    internal::Ref dataRef; /* `data` outlives its handle scope only as a reference */
    PropertyHandlerFlags flags = PropertyHandlerFlags::kNone;
    bool indexed = false;
};
struct NamedPropertyHandlerConfiguration : PropertyHandlerConfigurationBase {
    NamedPropertyHandlerConfiguration(GenericNamedPropertyGetterCallback g, GenericNamedPropertySetterCallback s = nullptr,
                                      GenericNamedPropertyQueryCallback q = nullptr, GenericNamedPropertyDeleterCallback d = nullptr,
                                      GenericNamedPropertyEnumeratorCallback e = nullptr, Local<Value> data_ = Local<Value>(),
                                      PropertyHandlerFlags f = PropertyHandlerFlags::kNone)
    {
        getter = reinterpret_cast<void *>(g);
        setter = reinterpret_cast<void *>(s);
        query = reinterpret_cast<void *>(q);
        deleter = reinterpret_cast<void *>(d);
        enumerator = reinterpret_cast<void *>(e);
        data = data_;
        flags = f;
    }
    NamedPropertyHandlerConfiguration(GenericNamedPropertyGetterCallback g, GenericNamedPropertySetterCallback s,
                                      GenericNamedPropertyDescriptorCallback, GenericNamedPropertyDeleterCallback d,
                                      GenericNamedPropertyEnumeratorCallback e, GenericNamedPropertyDefinerCallback,
                                      Local<Value> data_ = Local<Value>(), PropertyHandlerFlags f = PropertyHandlerFlags::kNone)
        : NamedPropertyHandlerConfiguration(g, s, nullptr, d, e, data_, f) {}
};
struct IndexedPropertyHandlerConfiguration : PropertyHandlerConfigurationBase {
    IndexedPropertyHandlerConfiguration(IndexedPropertyGetterCallback g, IndexedPropertySetterCallback s = nullptr,
                                        IndexedPropertyQueryCallback q = nullptr, IndexedPropertyDeleterCallback d = nullptr,
                                        IndexedPropertyEnumeratorCallback e = nullptr, Local<Value> data_ = Local<Value>(),
                                        PropertyHandlerFlags f = PropertyHandlerFlags::kNone)
    {
        getter = reinterpret_cast<void *>(g);
        setter = reinterpret_cast<void *>(s);
        query = reinterpret_cast<void *>(q);
        deleter = reinterpret_cast<void *>(d);
        enumerator = reinterpret_cast<void *>(e);
        data = data_;
        flags = f;
        indexed = true;
    }
    IndexedPropertyHandlerConfiguration(IndexedPropertyGetterCallback g, IndexedPropertySetterCallback s,
                                        IndexedPropertyDescriptorCallback, IndexedPropertyDeleterCallback d,
                                        IndexedPropertyEnumeratorCallback e, IndexedPropertyDefinerCallback,
                                        Local<Value> data_ = Local<Value>(), PropertyHandlerFlags f = PropertyHandlerFlags::kNone)
        : IndexedPropertyHandlerConfiguration(g, s, nullptr, d, e, data_, f) {}
};

/* ---- templates ----------------------------------------------------------------------------- */

namespace internal {

struct TemplateData;
struct HandlerSet;

struct Prop {
    Ref name;
    int kind; /* 0 value, 1 template, 2 accessor */
    Ref value;
    Ref data;
    void *getter;
    void *setter;
    bool name_variant;
    int attrs;
};

struct TemplateData {
    bool is_function = false;
    FunctionCallback cb = nullptr;
    Ref data;
    std::string class_name;
    std::vector<Prop> props;
    TemplateData *proto = nullptr;
    TemplateData *instance = nullptr;
    TemplateData *parent = nullptr;
    int internal_fields = 0;
    Ref cached;
    struct HandlerSet *handlers = nullptr;
};

/* The interceptors of a template, and the Proxy handler built from them (once, on first use). */
struct HandlerSet {
    PropertyHandlerConfigurationBase named;
    PropertyHandlerConfigurationBase indexed;
    bool hasNamed = false;
    bool hasIndexed = false;
    Ref proxyHandler;
    Ref sentinel;
};

inline const napi_type_tag &TemplateTag()
{
    static const napi_type_tag tag = {0x2c9e4b7a1d3f5860ULL, 0x91a7c3e5b2d40f68ULL};
    return tag;
}

inline napi_value TemplateHandle(TemplateData *td)
{
    napi_value o;
    napi_create_object(Env(), &o);
    napi_type_tag_object(Env(), o, &TemplateTag());
    napi_wrap(Env(), o, td, nullptr, nullptr, nullptr);
    return o;
}

inline TemplateData *AsTemplate(napi_value v)
{
    bool is = false;
    napi_valuetype t;
    if (!v || napi_typeof(Env(), v, &t) != napi_ok || t != napi_object) return nullptr;
    if (napi_check_object_type_tag(Env(), v, &TemplateTag(), &is) != napi_ok || !is) return nullptr;
    void *p = nullptr;
    napi_unwrap(Env(), v, &p);
    return static_cast<TemplateData *>(p);
}

napi_value Instantiate(TemplateData *td);

/* ---- property interceptors, as a Proxy ------------------------------------------------------ */

inline bool CanonicalIndex(napi_value prop, uint32_t *out)
{
    napi_valuetype t;
    if (napi_typeof(Env(), prop, &t) != napi_ok || t != napi_string) return false;
    std::string text = ToStd(prop);
    if (text.empty() || text.size() > 10 || (text.size() > 1 && text[0] == '0')) return false;
    unsigned long long value = 0;
    for (char c : text) {
        if (c < '0' || c > '9') return false;
        value = value * 10 + static_cast<unsigned>(c - '0');
    }
    if (value >= 4294967295ULL) return false;
    *out = static_cast<uint32_t>(value);
    return true;
}

/* Called by the Proxy's traps: (kind, target, property, value, receiver, NOT). Returns what the callback
   produced, or NOT when it declined (set no return value), which sends the trap on to the plain object. */
inline napi_value HookTramp(napi_env env, napi_callback_info cbinfo)
{
    EnvScope scope(env);
    HandlerSet *hs = nullptr;
    size_t argc = 6;
    napi_value argv[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
    napi_get_cb_info(env, cbinfo, &argc, argv, nullptr, reinterpret_cast<void **>(&hs));
    int32_t kind = 0;
    napi_get_value_int32(env, argv[0], &kind);
    napi_value target = argv[1], prop = argv[2], value = argv[3], receiver = argv[4] ? argv[4] : argv[1], NOT = argv[5];

    if (kind == 4) {
        napi_value list = nullptr;
        uint32_t used = 0;
        const PropertyHandlerConfigurationBase *cfgs[2] = {hs->hasNamed ? &hs->named : nullptr, hs->hasIndexed ? &hs->indexed : nullptr};
        for (const PropertyHandlerConfigurationBase *cfg : cfgs) {
            if (!cfg || !cfg->enumerator) continue;
            PropertyCallbackInfo<Array> info(receiver, RefValue(cfg->dataRef), target);
            if (cfg->indexed) reinterpret_cast<IndexedPropertyEnumeratorCallback>(cfg->enumerator)(info);
            else reinterpret_cast<GenericNamedPropertyEnumeratorCallback>(cfg->enumerator)(info);
            napi_value got = info.result();
            uint32_t n = 0;
            if (!got || napi_get_array_length(env, got, &n) != napi_ok) continue;
            if (!list) napi_create_array_with_length(env, 0, &list);
            for (uint32_t i = 0; i < n; i++) {
                napi_value item;
                napi_get_element(env, got, i, &item);
                napi_set_element(env, list, used++, item);
            }
        }
        return list ? list : NOT;
    }

    uint32_t index = 0;
    const PropertyHandlerConfigurationBase *cfg = nullptr;
    if (hs->hasIndexed && CanonicalIndex(prop, &index)) {
        cfg = &hs->indexed;
    } else if (hs->hasNamed) {
        napi_valuetype t;
        napi_typeof(env, prop, &t);
        if (t == napi_string || !(static_cast<int>(hs->named.flags) & static_cast<int>(PropertyHandlerFlags::kOnlyInterceptStrings))) cfg = &hs->named;
    }
    if (!cfg) return NOT;
    napi_value data = RefValue(cfg->dataRef);

    switch (kind) {
    case 0: {
        if (!cfg->getter) return NOT;
        PropertyCallbackInfo<Value> info(receiver, data, target);
        if (cfg->indexed) reinterpret_cast<IndexedPropertyGetterCallback>(cfg->getter)(index, info);
        else reinterpret_cast<GenericNamedPropertyGetterCallback>(cfg->getter)(Local<Name>(prop), info);
        return info.result() ? info.result() : NOT;
    }
    case 1: {
        if (!cfg->setter) return NOT;
        PropertyCallbackInfo<Value> info(receiver, data, target);
        if (cfg->indexed) reinterpret_cast<IndexedPropertySetterCallback>(cfg->setter)(index, Local<Value>(value), info);
        else reinterpret_cast<GenericNamedPropertySetterCallback>(cfg->setter)(Local<Name>(prop), Local<Value>(value), info);
        return info.result() ? info.result() : NOT;
    }
    case 2: {
        if (!cfg->query) return NOT;
        PropertyCallbackInfo<Integer> info(receiver, data, target);
        if (cfg->indexed) reinterpret_cast<IndexedPropertyQueryCallback>(cfg->query)(index, info);
        else reinterpret_cast<GenericNamedPropertyQueryCallback>(cfg->query)(Local<Name>(prop), info);
        return info.result() ? info.result() : NOT;
    }
    case 3: {
        if (!cfg->deleter) return NOT;
        PropertyCallbackInfo<Boolean> info(receiver, data, target);
        if (cfg->indexed) reinterpret_cast<IndexedPropertyDeleterCallback>(cfg->deleter)(index, info);
        else reinterpret_cast<GenericNamedPropertyDeleterCallback>(cfg->deleter)(Local<Name>(prop), info);
        return info.result() ? info.result() : NOT;
    }
    }
    return NOT;
}

static const char kProxyHandlerSource[] =
    "(function(hook,NOT){return{"
    "get(t,p,r){const x=hook(0,t,p,undefined,r,NOT);return x===NOT?Reflect.get(t,p,r):x},"
    "set(t,p,v,r){const x=hook(1,t,p,v,r,NOT);return x===NOT?Reflect.set(t,p,v,r):true},"
    "has(t,p){const x=hook(2,t,p,undefined,t,NOT);return x===NOT?Reflect.has(t,p):true},"
    "deleteProperty(t,p){const x=hook(3,t,p,undefined,t,NOT);return x===NOT?Reflect.deleteProperty(t,p):!!x},"
    "ownKeys(t){const own=Reflect.ownKeys(t);const x=hook(4,t,undefined,undefined,t,NOT);if(x===NOT)return own;"
    "const seen=new Set(own);for(let k of Array.from(x)){if(typeof k==='number')k=String(k);"
    "if(!seen.has(k)){seen.add(k);own.push(k)}}return own},"
    "getOwnPropertyDescriptor(t,p){const d=Reflect.getOwnPropertyDescriptor(t,p);if(d)return d;"
    "const q=hook(2,t,p,undefined,t,NOT);const v=hook(0,t,p,undefined,t,NOT);"
    "if(q===NOT&&v===NOT)return undefined;const a=typeof q==='number'?q:0;"
    "return{value:v===NOT?undefined:v,writable:!(a&1),enumerable:!(a&2),configurable:true}}"
    "}})";

inline napi_value ProxyHandler(HandlerSet *hs)
{
    napi_value handler = RefValue(hs->proxyHandler);
    if (handler) return handler;
    napi_value sentinel, hook, factory, args[2];
    napi_create_symbol(Env(), nullptr, &sentinel);
    napi_create_function(Env(), "interceptor", NAPI_AUTO_LENGTH, HookTramp, hs, &hook);
    napi_run_script(Env(), Str(kProxyHandlerSource), &factory);
    args[0] = hook;
    args[1] = sentinel;
    napi_call_function(Env(), Global(), factory, 2, args, &handler);
    hs->proxyHandler = KeepRef(handler);
    hs->sentinel = KeepRef(sentinel);
    return handler;
}

/* The object a template with interceptors hands out: the plain object behind a Proxy. */
inline napi_value Proxied(napi_value target, HandlerSet *hs)
{
    napi_value ctor = PropGet(Global(), "Proxy"), args[2] = {target, ProxyHandler(hs)}, out = nullptr;
    if (!args[1] || napi_new_instance(Env(), ctor, 2, args, &out) != napi_ok || !out) return target;
    return out;
}

inline void ApplyProps(napi_value target, TemplateData *td)
{
    for (const Prop &p : td->props) {
        napi_value name = RefValue(p.name);
        if (p.kind == 2) {
            DefineAccessor(target, name, p.getter, p.setter, p.name_variant, RefValue(p.data), p.attrs);
            continue;
        }
        napi_value value = RefValue(p.value);
        if (p.kind == 1) {
            TemplateData *t = AsTemplate(value);
            value = t ? Instantiate(t) : nullptr;
        }
        napi_property_descriptor desc = {};
        desc.name = name;
        desc.value = value ? value : Undefined();
        desc.attributes = static_cast<napi_property_attributes>(NapiAttrs(p.attrs, false));
        napi_define_properties(Env(), target, 1, &desc);
    }
}

inline napi_value CtorTramp(napi_env env, napi_callback_info cbinfo)
{
    EnvScope scope(env);
    TemplateData *td = nullptr;
    napi_value self = nullptr;
    napi_get_cb_info(env, cbinfo, nullptr, nullptr, &self, reinterpret_cast<void **>(&td));
    if (td->instance) {
        if (td->instance->internal_fields > 0) InternalFields(self, true, static_cast<uint32_t>(td->instance->internal_fields));
        ApplyProps(self, td->instance);
    }
    napi_value target = nullptr;
    napi_get_new_target(env, cbinfo, &target);
    bool construct = target != nullptr;
    napi_value out = construct ? self : nullptr;
    if (td->cb) {
        FunctionCallbackInfo<Value> info(env, cbinfo, td->data);
        td->cb(info);
        napi_value rv = info.result();
        napi_valuetype t;
        /* Called as a function, the result is whatever the callback returned. Called with `new`, it is the
           new object unless the callback returned a different object, as in JavaScript itself. */
        if (!construct) out = rv;
        else if (rv && napi_typeof(env, rv, &t) == napi_ok && (t == napi_object || t == napi_function)) out = rv;
    }
    if (construct && out && td->instance && td->instance->handlers) out = Proxied(out, td->instance->handlers);
    return out;
}

inline napi_value Instantiate(TemplateData *td)
{
    if (td->cached.ref) {
        napi_value v = RefValue(td->cached);
        if (v) return v;
    }
    if (!td->is_function) {
        napi_value o;
        napi_create_object(Env(), &o);
        if (td->internal_fields > 0) InternalFields(o, true, static_cast<uint32_t>(td->internal_fields));
        ApplyProps(o, td);
        return td->handlers ? Proxied(o, td->handlers) : o;
    }
    napi_value ctor;
    const char *name = td->class_name.empty() ? "" : td->class_name.c_str();
    napi_define_class(Env(), name, NAPI_AUTO_LENGTH, CtorTramp, td, 0, nullptr, &ctor);
    td->cached = KeepRef(ctor);
    if (td->parent) {
        napi_value pctor = Instantiate(td->parent);
        napi_value object = PropGet(Global(), "Object");
        napi_value setproto = PropGet(object, "setPrototypeOf");
        napi_value proto = PropGet(ctor, "prototype"), pproto = PropGet(pctor, "prototype");
        napi_value a1[2] = {proto, pproto}, a2[2] = {ctor, pctor}, out;
        napi_call_function(Env(), object, setproto, 2, a1, &out);
        napi_call_function(Env(), object, setproto, 2, a2, &out);
    }
    if (td->proto) ApplyProps(PropGet(ctor, "prototype"), td->proto);
    ApplyProps(ctor, td);
    return ctor;
}

inline void AddProp(TemplateData *td, napi_value name, napi_value value, int attrs)
{
    Prop p = {};
    p.name = KeepRef(name);
    p.value = KeepRef(value);
    p.kind = AsTemplate(value) ? 1 : 0;
    p.attrs = attrs;
    td->props.push_back(p);
}

}  // namespace internal

class AccessorSignature : public Data {
public:
    static Local<AccessorSignature> New(Isolate *, Local<FunctionTemplate> = Local<FunctionTemplate>()) { return Local<AccessorSignature>(); }
};

class Template : public Data {
public:
    void Set(Local<Name> name, Local<Data> value, PropertyAttribute attributes = None)
    {
        internal::AddProp(internal::AsTemplate(internal::Raw(this)), name.raw(), value.raw(), attributes);
    }
    void Set(Isolate *, const char *name, Local<Data> value, PropertyAttribute attributes = None)
    {
        internal::AddProp(internal::AsTemplate(internal::Raw(this)), internal::Str(name), value.raw(), attributes);
    }
    void SetAccessorProperty(Local<Name> name, Local<FunctionTemplate> getter = Local<FunctionTemplate>(),
                             Local<FunctionTemplate> setter = Local<FunctionTemplate>(), PropertyAttribute = None,
                             AccessControl = DEFAULT);
    void SetNativeDataProperty(Local<String> name, AccessorGetterCallback getter, AccessorSetterCallback setter = nullptr,
                               Local<Value> data = Local<Value>(), PropertyAttribute attribute = None)
    {
        AddAccessor(name.raw(), reinterpret_cast<void *>(getter), reinterpret_cast<void *>(setter), false, data.raw(), attribute);
    }
    void SetNativeDataProperty(Local<Name> name, AccessorNameGetterCallback getter, AccessorNameSetterCallback setter = nullptr,
                               Local<Value> data = Local<Value>(), PropertyAttribute attribute = None)
    {
        AddAccessor(name.raw(), reinterpret_cast<void *>(getter), reinterpret_cast<void *>(setter), true, data.raw(), attribute);
    }

protected:
    void AddAccessor(napi_value name, void *getter, void *setter, bool name_variant, napi_value data, int attrs)
    {
        internal::Prop p = {};
        p.name = internal::KeepRef(name);
        p.kind = 2;
        p.data = internal::KeepRef(data);
        p.getter = getter;
        p.setter = setter;
        p.name_variant = name_variant;
        p.attrs = attrs;
        internal::AsTemplate(internal::Raw(this))->props.push_back(p);
    }
};

class ObjectTemplate : public Template {
public:
    static Local<ObjectTemplate> New(Isolate * = nullptr, Local<FunctionTemplate> = Local<FunctionTemplate>())
    {
        return Local<ObjectTemplate>(internal::TemplateHandle(new internal::TemplateData()));
    }
    MaybeLocal<Object> NewInstance(Local<Context>)
    {
        return MaybeLocal<Object>(Local<Object>(internal::Instantiate(internal::AsTemplate(internal::Raw(this)))));
    }
    Local<Object> NewInstance() { return NewInstance(Local<Context>()).ToLocalChecked(); }
    void SetAccessor(Local<String> name, AccessorGetterCallback getter, AccessorSetterCallback setter = nullptr,
                     Local<Value> data = Local<Value>(), AccessControl = DEFAULT, PropertyAttribute attribute = None)
    {
        AddAccessor(name.raw(), reinterpret_cast<void *>(getter), reinterpret_cast<void *>(setter), false, data.raw(), attribute);
    }
    void SetAccessor(Local<Name> name, AccessorNameGetterCallback getter, AccessorNameSetterCallback setter = nullptr,
                     Local<Value> data = Local<Value>(), AccessControl = DEFAULT, PropertyAttribute attribute = None)
    {
        AddAccessor(name.raw(), reinterpret_cast<void *>(getter), reinterpret_cast<void *>(setter), true, data.raw(), attribute);
    }
    void SetAccessor(Local<Name> name, AccessorNameGetterCallback getter, AccessorNameSetterCallback setter,
                     Local<Value> data, AccessControl, PropertyAttribute attribute, Local<AccessorSignature>)
    {
        AddAccessor(name.raw(), reinterpret_cast<void *>(getter), reinterpret_cast<void *>(setter), true, data.raw(), attribute);
    }
    void SetHandler(const NamedPropertyHandlerConfiguration &config)
    {
        internal::HandlerSet *hs = Handlers();
        hs->named = config;
        hs->named.dataRef = internal::KeepRef(config.data.raw());
        hs->hasNamed = true;
    }
    void SetHandler(const IndexedPropertyHandlerConfiguration &config)
    {
        internal::HandlerSet *hs = Handlers();
        hs->indexed = config;
        hs->indexed.dataRef = internal::KeepRef(config.data.raw());
        hs->hasIndexed = true;
    }
    void SetInternalFieldCount(int value) { internal::AsTemplate(internal::Raw(this))->internal_fields = value; }
private:
    internal::HandlerSet *Handlers()
    {
        internal::TemplateData *td = internal::AsTemplate(internal::Raw(this));
        if (!td->handlers) td->handlers = new internal::HandlerSet();
        return td->handlers;
    }
public:
    int InternalFieldCount() { return internal::AsTemplate(internal::Raw(this))->internal_fields; }
    void SetCallAsFunctionHandler(FunctionCallback, Local<Value> = Local<Value>()) {}
    void SetImmutableProto() {}
};

class Signature : public Data {
public:
    static Local<Signature> New(Isolate *, Local<FunctionTemplate> = Local<FunctionTemplate>()) { return Local<Signature>(); }
};

class FunctionTemplate : public Template {
public:
    static Local<FunctionTemplate> New(Isolate *, FunctionCallback callback = nullptr, Local<Value> data = Local<Value>(),
                                       Local<Signature> = Local<Signature>(), int = 0,
                                       ConstructorBehavior = ConstructorBehavior::kAllow,
                                       SideEffectType = SideEffectType::kHasSideEffect)
    {
        internal::TemplateData *td = new internal::TemplateData();
        td->is_function = true;
        td->cb = callback;
        td->data = internal::KeepRef(data.raw());
        return Local<FunctionTemplate>(internal::TemplateHandle(td));
    }
    MaybeLocal<Function> GetFunction(Local<Context>)
    {
        return MaybeLocal<Function>(Local<Function>(internal::Instantiate(internal::AsTemplate(internal::Raw(this)))));
    }
    Local<Function> GetFunction() { return GetFunction(Local<Context>()).ToLocalChecked(); }
    Local<ObjectTemplate> PrototypeTemplate()
    {
        internal::TemplateData *td = internal::AsTemplate(internal::Raw(this));
        if (!td->proto) td->proto = new internal::TemplateData();
        return Local<ObjectTemplate>(internal::TemplateHandle(td->proto));
    }
    Local<ObjectTemplate> InstanceTemplate()
    {
        internal::TemplateData *td = internal::AsTemplate(internal::Raw(this));
        if (!td->instance) td->instance = new internal::TemplateData();
        return Local<ObjectTemplate>(internal::TemplateHandle(td->instance));
    }
    void Inherit(Local<FunctionTemplate> parent) { internal::AsTemplate(internal::Raw(this))->parent = internal::AsTemplate(parent.raw()); }
    void SetClassName(Local<String> name) { internal::AsTemplate(internal::Raw(this))->class_name = internal::ToStd(name.raw()); }
    void SetCallHandler(FunctionCallback callback, Local<Value> data = Local<Value>())
    {
        internal::TemplateData *td = internal::AsTemplate(internal::Raw(this));
        td->cb = callback;
        td->data = internal::KeepRef(data.raw());
    }
    void SetLength(int) {}
    void ReadOnlyPrototype() {}
    void RemovePrototype() {}
    void SetAcceptAnyReceiver(bool) {}
    void SetHiddenPrototype(bool) {}
    void SetInterfaceName(Local<String>) {}
    bool HasInstance(Local<Value> object)
    {
        napi_value ctor = internal::Instantiate(internal::AsTemplate(internal::Raw(this)));
        bool r = false;
        napi_instanceof(internal::Env(), object.raw(), ctor, &r);
        return r;
    }
    template <class T> static FunctionTemplate *Cast(T *v) { return reinterpret_cast<FunctionTemplate *>(v); }
};

inline void Template::SetAccessorProperty(Local<Name> name, Local<FunctionTemplate> getter, Local<FunctionTemplate> setter,
                                          PropertyAttribute attribute, AccessControl)
{
    (void) name;
    (void) getter;
    (void) setter;
    (void) attribute;
}

inline Local<Context> Isolate::GetCurrentContext() { return Context::GetCurrent(); }
inline Local<Context> Isolate::GetEnteredContext() { return Context::GetCurrent(); }
inline Local<Context> Isolate::GetEnteredOrMicrotaskContext() { return Context::GetCurrent(); }
inline Local<Object> Context::Global() { return Local<Object>(internal::Global()); }
inline Local<Value> Isolate::ThrowException(Local<Value> exception)
{
    napi_throw(internal::Env(), exception.raw());
    return Local<Value>(internal::Undefined());
}
inline void Isolate::EnqueueMicrotask(Local<Function> function)
{
    napi_value script, queue, out;
    napi_create_string_utf8(internal::Env(), "(function(f){Promise.resolve().then(f)})", NAPI_AUTO_LENGTH, &script);
    napi_run_script(internal::Env(), script, &queue);
    napi_value arg = function.raw();
    napi_call_function(internal::Env(), internal::Global(), queue, 1, &arg, &out);
}
inline Local<Value> Context::GetEmbedderData(int) { return Local<Value>(internal::Undefined()); }
inline Local<Value> Context::GetSecurityToken() { return Local<Value>(internal::Undefined()); }

/* ---- persistent handles -------------------------------------------------------------------- */

template <class T> class NonCopyablePersistentTraits {
public:
    static const bool kResetInDestructor = false;
    template <class S, class M> static void Copy(const Persistent<S, M> &, Persistent<S, M> *) {}
};
template <class T> class CopyablePersistentTraits {
public:
    static const bool kResetInDestructor = true;
};

template <class T> class WeakCallbackInfo {
public:
    typedef void (*Callback)(const WeakCallbackInfo<T> &data);
    WeakCallbackInfo(Isolate *isolate, T *parameter) : isolate_(isolate), parameter_(parameter) {}
    Isolate *GetIsolate() const { return isolate_; }
    T *GetParameter() const { return parameter_; }
    void *GetInternalField(int) const { return nullptr; }
    void SetSecondPassCallback(void (*)(const WeakCallbackInfo<T> &)) const {}

private:
    Isolate *isolate_;
    T *parameter_;
};

namespace internal {
struct WeakState {
    bool active;
    std::function<void()> fire;
};
}  // namespace internal

template <class T> class PersistentBase {
public:
    bool IsEmpty() const { return ref_.ref == nullptr; }
    void Empty() { ref_ = internal::Ref(); }
    template <class S> bool operator==(const PersistentBase<S> &that) const { return ref_.ref == that.ref_.ref; }
    template <class S> bool operator==(const Local<S> &that) const
    {
        return !IsEmpty() && Local<T>(internal::RefValue(ref_)) == that;
    }
    template <class S> bool operator!=(const PersistentBase<S> &that) const { return !(*this == that); }
    Local<T> Get(Isolate *) const { return Local<T>(internal::RefValue(ref_)); }
    void Reset()
    {
        if (weak_) weak_->active = false;
        weak_ = nullptr;
        if (ref_.ref) napi_delete_reference(env_, ref_.ref);
        ref_ = internal::Ref();
    }
    template <class S> void Reset(Isolate *, const Local<S> &other)
    {
        Reset();
        if (other.IsEmpty()) return;
        env_ = internal::Env();
        ref_ = internal::KeepRef(other.raw());
    }
    template <class S, class M> void Reset(Isolate *i, const PersistentBase<S> &other) { Reset(i, other.Get(i)); }
    template <class P> void SetWeak(P *parameter, typename WeakCallbackInfo<P>::Callback callback, WeakCallbackType)
    {
        if (!ref_.ref || ref_.boxed) return;
        napi_value target = internal::RefValue(ref_);
        uint32_t count;
        napi_reference_unref(env_, ref_.ref, &count);
        internal::WeakState *state = new internal::WeakState();
        state->active = true;
        Isolate *isolate = Isolate::GetCurrent();
        state->fire = [parameter, callback, isolate]() {
            WeakCallbackInfo<P> info(isolate, parameter);
            callback(info);
        };
        weak_ = state;
        napi_add_finalizer(
            env_, target, state,
            [](napi_env env, void *data, void *) {
                internal::EnvScope scope(env);
                internal::WeakState *s = static_cast<internal::WeakState *>(data);
                if (s->active) s->fire();
                delete s;
            },
            nullptr, nullptr);
    }
    void SetWeak()
    {
        if (!ref_.ref || ref_.boxed) return;
        uint32_t count;
        napi_reference_unref(env_, ref_.ref, &count);
    }
    void ClearWeak()
    {
        if (!ref_.ref || ref_.boxed) return;
        uint32_t count;
        napi_reference_ref(env_, ref_.ref, &count);
    }
    void MarkIndependent() {}
    void MarkActive() {}
    void AnnotateStrongRetainer(const char *) {}
    void SetWrapperClassId(uint16_t) {}
    bool IsWeak() const { return false; }
    template <class S> static PersistentBase<T> &Cast(PersistentBase<S> &p) { return reinterpret_cast<PersistentBase<T> &>(p); }

    internal::Ref ref_;
    napi_env env_ = nullptr;
    internal::WeakState *weak_ = nullptr;
};

template <class T, class M> class Persistent : public PersistentBase<T> {
public:
    Persistent() {}
    template <class S> Persistent(Isolate *isolate, Local<S> that) { this->Reset(isolate, that); }
    template <class S, class M2> Persistent(Isolate *isolate, const Persistent<S, M2> &that) { this->Reset(isolate, that.Get(isolate)); }
    Persistent(const Persistent &that) { CopyFrom(that); }
    template <class S, class M2> Persistent(const Persistent<S, M2> &that) { CopyFrom(that); }
    Persistent &operator=(const Persistent &that)
    {
        if (this != &that) {
            this->Reset();
            CopyFrom(that);
        }
        return *this;
    }
    template <class S, class M2> Persistent &operator=(const Persistent<S, M2> &that)
    {
        this->Reset();
        CopyFrom(that);
        return *this;
    }
    ~Persistent()
    {
        if (M::kResetInDestructor) this->Reset();
    }
    template <class S> static Persistent<T, M> &Cast(Persistent<S, M> &p) { return reinterpret_cast<Persistent<T, M> &>(p); }
    template <class S> Persistent<S, M> &As() { return reinterpret_cast<Persistent<S, M> &>(*this); }

private:
    template <class P> void CopyFrom(const P &that)
    {
        if (that.IsEmpty()) return;
        this->env_ = that.env_;
        napi_value v = internal::RefValue(that.ref_);
        if (v) this->ref_ = internal::KeepRef(v);
    }
};

template <class T> class Global : public PersistentBase<T> {
public:
    Global() {}
    template <class S> Global(Isolate *isolate, Local<S> that) { this->Reset(isolate, that); }
    template <class S> Global(Isolate *isolate, const PersistentBase<S> &that) { this->Reset(isolate, that.Get(isolate)); }
    Global(Global &&other)
    {
        this->ref_ = other.ref_;
        this->env_ = other.env_;
        this->weak_ = other.weak_;
        other.ref_ = internal::Ref();
        other.weak_ = nullptr;
    }
    Global &operator=(Global &&other)
    {
        this->Reset();
        this->ref_ = other.ref_;
        this->env_ = other.env_;
        this->weak_ = other.weak_;
        other.ref_ = internal::Ref();
        other.weak_ = nullptr;
        return *this;
    }
    ~Global() { this->Reset(); }
    Global(const Global &) = delete;
    Global &operator=(const Global &) = delete;
};

template <class T> template <class M> Local<T> Local<T>::New(Isolate *, const Persistent<T, M> &p)
{
    return Local<T>(internal::RefValue(p.ref_));
}
template <class T> template <class S, class M> void ReturnValue<T>::Set(const Persistent<S, M> &handle)
{
    *slot_ = internal::RefValue(handle.ref_);
}

/* ---- exceptions ---------------------------------------------------------------------------- */

class Message {
public:
    Local<String> Get() const
    {
        napi_value m = internal::PropGet(internal::Raw(this), "message");
        return Local<String>(m ? m : internal::Str(""));
    }
    Local<String> GetSourceLine() const { return Local<String>(internal::Str("")); }
    MaybeLocal<String> GetSourceLine(Local<Context>) const { return MaybeLocal<String>(GetSourceLine()); }
    Maybe<int> GetEndColumn(Local<Context>) const { return Just(0); }
    Maybe<int> GetLineNumber(Local<Context>) const { return Just(0); }
    int GetLineNumber() const { return 0; }
    Maybe<int> GetStartColumn(Local<Context>) const { return Just(0); }
    int GetStartColumn() const { return 0; }
    int GetEndColumn() const { return 0; }
    Local<Value> GetScriptResourceName() const { return Local<Value>(internal::Str("")); }
    Local<StackTrace> GetStackTrace() const { return Local<StackTrace>(); }
};

class StackTrace {
public:
    int GetFrameCount() const { return 0; }
};

class Exception {
public:
    static Local<Value> Error(Local<String> message) { return Make("Error", message); }
    static Local<Value> TypeError(Local<String> message) { return Make("TypeError", message); }
    static Local<Value> RangeError(Local<String> message) { return Make("RangeError", message); }
    static Local<Value> ReferenceError(Local<String> message) { return Make("ReferenceError", message); }
    static Local<Value> SyntaxError(Local<String> message) { return Make("SyntaxError", message); }
    static Local<StackTrace> GetStackTrace(Local<Value>) { return Local<StackTrace>(); }
    static Local<Message> CreateMessage(Isolate *, Local<Value> exception) { return Local<Message>(exception.raw()); }

private:
    static Local<Value> Make(const char *kind, Local<String> message)
    {
        napi_value ctor = internal::PropGet(internal::Global(), kind), arg = message.raw(), out;
        napi_new_instance(internal::Env(), ctor, 1, &arg, &out);
        return Local<Value>(out);
    }
};

class TryCatch {
public:
    explicit TryCatch(Isolate *) : rethrow_(false), verbose_(false)
    {
        bool pending = false;
        napi_is_exception_pending(internal::Env(), &pending);
        if (pending) napi_get_and_clear_last_exception(internal::Env(), &outer_);
    }
    ~TryCatch()
    {
        bool pending = false;
        napi_is_exception_pending(internal::Env(), &pending);
        if (pending && !rethrow_) {
            napi_value drop;
            napi_get_and_clear_last_exception(internal::Env(), &drop);
        }
        if (outer_ && !rethrow_) napi_throw(internal::Env(), outer_);
    }
    bool HasCaught() const
    {
        bool pending = false;
        napi_is_exception_pending(internal::Env(), &pending);
        return pending || caught_ != nullptr;
    }
    bool CanContinue() const { return true; }
    bool HasTerminated() const { return false; }
    Local<Value> ReThrow()
    {
        Capture();
        rethrow_ = true;
        if (caught_) napi_throw(internal::Env(), caught_);
        return Local<Value>(internal::Undefined());
    }
    Local<Value> Exception() const
    {
        Capture();
        return Local<Value>(caught_ ? caught_ : internal::Undefined());
    }
    MaybeLocal<Value> StackTrace(Local<Context>) const
    {
        Capture();
        napi_value s = caught_ ? internal::PropGet(caught_, "stack") : nullptr;
        return s ? MaybeLocal<Value>(Local<Value>(s)) : MaybeLocal<Value>();
    }
    Local<v8::Message> Message() const
    {
        Capture();
        return Local<v8::Message>(caught_ ? caught_ : internal::Undefined());
    }
    void Reset()
    {
        bool pending = false;
        napi_is_exception_pending(internal::Env(), &pending);
        if (pending) {
            napi_value drop;
            napi_get_and_clear_last_exception(internal::Env(), &drop);
        }
        caught_ = nullptr;
    }
    void SetVerbose(bool value) { verbose_ = value; }
    void SetCaptureMessage(bool) {}
    TryCatch(const TryCatch &) = delete;
    TryCatch &operator=(const TryCatch &) = delete;

private:
    void Capture() const
    {
        bool pending = false;
        napi_is_exception_pending(internal::Env(), &pending);
        /* Taken out of the pending state, as V8 does for a TryCatch: while the exception is being
           looked at, further API calls (ToString on it, say) must still work. */
        if (pending) napi_get_and_clear_last_exception(internal::Env(), &caught_);
    }
    mutable napi_value caught_ = nullptr;
    napi_value outer_ = nullptr;
    bool rethrow_;
    bool verbose_;
};

/* ---- ArrayBuffer, typed arrays ------------------------------------------------------------- */

typedef void (*BackingStoreDeleterCallback)(void *data, size_t length, void *deleter_data);

class BackingStore {
public:
    void *Data() const { return data_; }
    size_t ByteLength() const { return length_; }
    bool IsShared() const { return false; }
    ~BackingStore()
    {
        if (deleter_) deleter_(data_, length_, deleter_data_);
    }
    void *data_ = nullptr;
    size_t length_ = 0;
    BackingStoreDeleterCallback deleter_ = nullptr;
    void *deleter_data_ = nullptr;
};

enum class ArrayBufferCreationMode { kInternalized, kExternalized };

class ArrayBuffer : public Object {
public:
    class Allocator {
    public:
        virtual ~Allocator() {}
        virtual void *Allocate(size_t length) = 0;
        virtual void *AllocateUninitialized(size_t length) = 0;
        virtual void Free(void *data, size_t length) = 0;
        static Allocator *NewDefaultAllocator();
    };
    class Contents {
    public:
        void *Data() const { return data_; }
        size_t ByteLength() const { return byte_length_; }
        void *AllocationBase() const { return data_; }
        size_t AllocationLength() const { return byte_length_; }
        void *data_ = nullptr;
        size_t byte_length_ = 0;
    };

    static Local<ArrayBuffer> New(Isolate *, size_t byte_length)
    {
        napi_value ab;
        void *data;
        napi_create_arraybuffer(internal::Env(), byte_length, &data, &ab);
        return Local<ArrayBuffer>(ab);
    }
    static Local<ArrayBuffer> New(Isolate *, void *data, size_t byte_length,
                                  ArrayBufferCreationMode mode = ArrayBufferCreationMode::kExternalized)
    {
        napi_value ab;
        napi_create_external_arraybuffer(
            internal::Env(), data, byte_length,
            mode == ArrayBufferCreationMode::kInternalized ? [](napi_env, void *d, void *) { std::free(d); }
                                                          : static_cast<napi_finalize>(nullptr),
            nullptr, &ab);
        return Local<ArrayBuffer>(ab);
    }
    static Local<ArrayBuffer> New(Isolate *, std::shared_ptr<BackingStore> store)
    {
        napi_value ab;
        std::shared_ptr<BackingStore> *keep = new std::shared_ptr<BackingStore>(store);
        napi_create_external_arraybuffer(
            internal::Env(), store->Data(), store->ByteLength(),
            [](napi_env, void *, void *hint) { delete static_cast<std::shared_ptr<BackingStore> *>(hint); }, keep, &ab);
        return Local<ArrayBuffer>(ab);
    }
    static std::unique_ptr<BackingStore> NewBackingStore(void *data, size_t byte_length, BackingStoreDeleterCallback deleter,
                                                         void *deleter_data)
    {
        std::unique_ptr<BackingStore> s(new BackingStore());
        s->data_ = data;
        s->length_ = byte_length;
        s->deleter_ = deleter;
        s->deleter_data_ = deleter_data;
        return s;
    }
    static std::unique_ptr<BackingStore> NewBackingStore(Isolate *, size_t byte_length)
    {
        return NewBackingStore(std::calloc(byte_length ? byte_length : 1, 1), byte_length,
                               [](void *d, size_t, void *) { std::free(d); }, nullptr);
    }
    size_t ByteLength() const
    {
        size_t len = 0;
        napi_get_arraybuffer_info(internal::Env(), internal::Raw(this), nullptr, &len);
        return len;
    }
    Contents GetContents()
    {
        Contents c;
        napi_get_arraybuffer_info(internal::Env(), internal::Raw(this), &c.data_, &c.byte_length_);
        return c;
    }
    Contents Externalize() { return GetContents(); }
    std::shared_ptr<BackingStore> GetBackingStore()
    {
        Contents c = GetContents();
        std::shared_ptr<BackingStore> s(new BackingStore());
        s->data_ = c.data_;
        s->length_ = c.byte_length_;
        return s;
    }
    bool IsExternal() const { return false; }
    bool IsDetachable() const { return true; }
    void Detach() { napi_detach_arraybuffer(internal::Env(), internal::Raw(this)); }
    void Neuter() { Detach(); }
    bool IsNeuterable() const { return true; }
    template <class T> static ArrayBuffer *Cast(T *v) { return reinterpret_cast<ArrayBuffer *>(v); }
};

class ArrayBufferView : public Object {
public:
    Local<ArrayBuffer> Buffer()
    {
        napi_value ab = nullptr;
        if (!GetInfo(nullptr, nullptr, nullptr, &ab, nullptr)) {
            napi_get_dataview_info(internal::Env(), internal::Raw(this), nullptr, nullptr, &ab, nullptr);
        }
        return Local<ArrayBuffer>(ab);
    }
    size_t ByteOffset()
    {
        size_t off = 0;
        if (!GetInfo(nullptr, nullptr, nullptr, nullptr, &off)) napi_get_dataview_info(internal::Env(), internal::Raw(this), nullptr, nullptr, nullptr, &off);
        return off;
    }
    size_t ByteLength()
    {
        napi_typedarray_type t;
        size_t len = 0;
        if (GetInfo(&t, &len, nullptr, nullptr, nullptr)) return len * ElementSize(t);
        napi_get_dataview_info(internal::Env(), internal::Raw(this), &len, nullptr, nullptr, nullptr);
        return len;
    }
    bool HasBuffer() const { return true; }
    size_t CopyContents(void *dest, size_t byte_length)
    {
        void *data = nullptr;
        size_t len = ByteLength();
        if (!GetInfo(nullptr, nullptr, &data, nullptr, nullptr)) napi_get_dataview_info(internal::Env(), internal::Raw(this), nullptr, &data, nullptr, nullptr);
        size_t n = len < byte_length ? len : byte_length;
        if (data && dest) std::memcpy(dest, data, n);
        return n;
    }
    void *DataPtr()
    {
        void *data = nullptr;
        if (!GetInfo(nullptr, nullptr, &data, nullptr, nullptr)) napi_get_dataview_info(internal::Env(), internal::Raw(this), nullptr, &data, nullptr, nullptr);
        return data;
    }
    template <class T> static ArrayBufferView *Cast(T *v) { return reinterpret_cast<ArrayBufferView *>(v); }

protected:
    bool GetInfo(napi_typedarray_type *type, size_t *length, void **data, napi_value *ab, size_t *offset)
    {
        return napi_get_typedarray_info(internal::Env(), internal::Raw(this), type, length, data, ab, offset) == napi_ok;
    }
    static size_t ElementSize(napi_typedarray_type t)
    {
        switch (t) {
        case napi_int8_array: case napi_uint8_array: case napi_uint8_clamped_array: return 1;
        case napi_int16_array: case napi_uint16_array: return 2;
        case napi_int32_array: case napi_uint32_array: case napi_float32_array: return 4;
        default: return 8;
        }
    }
};

class TypedArray : public ArrayBufferView {
public:
    size_t Length()
    {
        size_t len = 0;
        GetInfo(nullptr, &len, nullptr, nullptr, nullptr);
        return len;
    }
    template <class T> static TypedArray *Cast(T *v) { return reinterpret_cast<TypedArray *>(v); }
};

#define FG_TYPED_ARRAY(Name, kind)                                                                              \
    class Name : public TypedArray {                                                                            \
    public:                                                                                                     \
        static Local<Name> New(Local<ArrayBuffer> buffer, size_t byte_offset, size_t length)                    \
        {                                                                                                       \
            napi_value out;                                                                                     \
            napi_create_typedarray(internal::Env(), kind, length, buffer.raw(), byte_offset, &out);             \
            return Local<Name>(out);                                                                            \
        }                                                                                                       \
        template <class T> static Name *Cast(T *v) { return reinterpret_cast<Name *>(v); }                      \
    };
FG_TYPED_ARRAY(Int8Array, napi_int8_array)
FG_TYPED_ARRAY(Uint8Array, napi_uint8_array)
FG_TYPED_ARRAY(Uint8ClampedArray, napi_uint8_clamped_array)
FG_TYPED_ARRAY(Int16Array, napi_int16_array)
FG_TYPED_ARRAY(Uint16Array, napi_uint16_array)
FG_TYPED_ARRAY(Int32Array, napi_int32_array)
FG_TYPED_ARRAY(Uint32Array, napi_uint32_array)
FG_TYPED_ARRAY(Float32Array, napi_float32_array)
FG_TYPED_ARRAY(Float64Array, napi_float64_array)
FG_TYPED_ARRAY(BigInt64Array, napi_bigint64_array)
FG_TYPED_ARRAY(BigUint64Array, napi_biguint64_array)
#undef FG_TYPED_ARRAY

class DataView : public ArrayBufferView {
public:
    static Local<DataView> New(Local<ArrayBuffer> buffer, size_t byte_offset, size_t length)
    {
        napi_value out;
        napi_create_dataview(internal::Env(), length, buffer.raw(), byte_offset, &out);
        return Local<DataView>(out);
    }
};

/* ---- scripts and JSON ---------------------------------------------------------------------- */

class ScriptOrigin {
public:
    explicit ScriptOrigin(Local<Value> = Local<Value>(), Local<Integer> = Local<Integer>(), Local<Integer> = Local<Integer>(),
                          Local<Boolean> = Local<Boolean>(), Local<Integer> = Local<Integer>(), Local<Value> = Local<Value>(),
                          Local<Boolean> = Local<Boolean>(), Local<Boolean> = Local<Boolean>(), Local<Boolean> = Local<Boolean>()) {}
};

class UnboundScript {
public:
    Local<Script> BindToCurrentContext() { return Local<Script>(internal::Raw(this)); }
};
class Script {
public:
    static MaybeLocal<Script> Compile(Local<Context>, Local<String> source, ScriptOrigin * = nullptr)
    {
        return MaybeLocal<Script>(Local<Script>(source.raw()));
    }
    static Local<Script> Compile(Local<String> source, ScriptOrigin * = nullptr) { return Local<Script>(source.raw()); }
    MaybeLocal<Value> Run(Local<Context>)
    {
        napi_value out;
        return internal::Result<Value>(napi_run_script(internal::Env(), internal::Raw(this), &out), out);
    }
    Local<Value> Run() { return Run(Local<Context>()).FromMaybe(Local<Value>()); }
};

class JSON {
public:
    static MaybeLocal<Value> Parse(Local<Context>, Local<String> json_string)
    {
        napi_value out = internal::CallGlobalMethod("JSON", "parse", json_string.raw());
        return out ? MaybeLocal<Value>(Local<Value>(out)) : MaybeLocal<Value>();
    }
    static MaybeLocal<String> Stringify(Local<Context>, Local<Value> json_object, Local<String> = Local<String>())
    {
        napi_value out = internal::CallGlobalMethod("JSON", "stringify", json_object.raw());
        return out ? MaybeLocal<String>(Local<String>(out)) : MaybeLocal<String>();
    }
};

class V8 {
public:
    static bool Initialize() { return true; }
    static bool InitializeICU(const char * = nullptr) { return true; }
    static void InitializePlatform(void *) {}
    static void ShutdownPlatform() {}
    static bool Dispose() { return true; }
    static const char *GetVersion() { return V8_VERSION_STRING; }
    static void SetFlagsFromString(const char *, int = 0) {}
    static void SetFlagsFromCommandLine(int *, char **, bool) {}
    static void ToLocalEmpty() {}
};

class Locker {
public:
    explicit Locker(Isolate * = nullptr) {}
    static bool IsLocked(Isolate *) { return true; }
};
class Unlocker {
public:
    explicit Unlocker(Isolate *) {}
};


/* ---- wrappers, regular expressions, external strings, compilation --------------------------- */

class BooleanObject : public Object {
public:
    static Local<Value> New(Isolate *, bool value) { return Wrap("Boolean", Boolean::New(nullptr, value).raw()); }
    bool ValueOf() const { return internal::PropGet(internal::Raw(this), "valueOf") != nullptr && Value::IsTrue(); }
    static Local<Value> Wrap(const char *ctor, napi_value v)
    {
        napi_value c = internal::PropGet(internal::Global(), ctor), out = nullptr;
        napi_new_instance(internal::Env(), c, 1, &v, &out);
        return Local<Value>(out);
    }
    template <class T> static BooleanObject *Cast(T *v) { return reinterpret_cast<BooleanObject *>(v); }
};
class NumberObject : public Object {
public:
    static Local<Value> New(Isolate *, double value) { return BooleanObject::Wrap("Number", Number::New(nullptr, value).raw()); }
    double ValueOf() const
    {
        napi_value f = internal::PropGet(internal::Raw(this), "valueOf"), out = nullptr;
        double d = 0;
        if (f && napi_call_function(internal::Env(), internal::Raw(this), f, 0, nullptr, &out) == napi_ok) napi_get_value_double(internal::Env(), out, &d);
        return d;
    }
    template <class T> static NumberObject *Cast(T *v) { return reinterpret_cast<NumberObject *>(v); }
};
class StringObject : public Object {
public:
    static Local<Value> New(Isolate *, Local<String> value) { return BooleanObject::Wrap("String", value.raw()); }
    Local<String> ValueOf() const
    {
        napi_value f = internal::PropGet(internal::Raw(this), "valueOf"), out = nullptr;
        if (f) napi_call_function(internal::Env(), internal::Raw(this), f, 0, nullptr, &out);
        return Local<String>(out);
    }
    template <class T> static StringObject *Cast(T *v) { return reinterpret_cast<StringObject *>(v); }
};
class SymbolObject : public Object {
public:
    static Local<Value> New(Isolate *, Local<Symbol> value) { return Local<Value>(internal::CallGlobalMethod("Object", "call", value.raw())); }
};
class BigIntObject : public Object {
public:
    static Local<Value> New(Isolate *, int64_t value) { return BooleanObject::Wrap("Object", BigInt::New(nullptr, value).raw()); }
};

class RegExp : public Object {
public:
    enum Flags {
        kNone = 0, kGlobal = 1 << 0, kIgnoreCase = 1 << 1, kMultiline = 1 << 2, kSticky = 1 << 3, kUnicode = 1 << 4, kDotAll = 1 << 5
    };
    static MaybeLocal<RegExp> New(Local<Context>, Local<String> pattern, Flags flags)
    {
        std::string f;
        if (flags & kGlobal) f += 'g';
        if (flags & kIgnoreCase) f += 'i';
        if (flags & kMultiline) f += 'm';
        if (flags & kDotAll) f += 's';
        if (flags & kUnicode) f += 'u';
        if (flags & kSticky) f += 'y';
        napi_value ctor = internal::PropGet(internal::Global(), "RegExp"), args[2] = {pattern.raw(), internal::Str(f.c_str())}, out;
        return internal::Result<RegExp>(napi_new_instance(internal::Env(), ctor, 2, args, &out), out);
    }
    Local<String> GetSource() const { return Local<String>(internal::PropGet(internal::Raw(this), "source")); }
    Flags GetFlags() const
    {
        std::string f = internal::ToStd(internal::PropGet(internal::Raw(this), "flags"));
        int out = kNone;
        for (char c : f) {
            if (c == 'g') out |= kGlobal;
            if (c == 'i') out |= kIgnoreCase;
            if (c == 'm') out |= kMultiline;
            if (c == 's') out |= kDotAll;
            if (c == 'u') out |= kUnicode;
            if (c == 'y') out |= kSticky;
        }
        return static_cast<Flags>(out);
    }
    template <class T> static RegExp *Cast(T *v) { return reinterpret_cast<RegExp *>(v); }
};

class ScriptCompiler {
public:
    enum CompileOptions { kNoCompileOptions = 0, kConsumeCodeCache, kEagerCompile };
    class Source {
    public:
        Source(Local<String> source_string, const ScriptOrigin & = ScriptOrigin()) : source_(source_string) {}
        Local<String> source_;
    };
    static MaybeLocal<UnboundScript> CompileUnboundScript(Isolate *, Source *source, CompileOptions = kNoCompileOptions)
    {
        return MaybeLocal<UnboundScript>(Local<UnboundScript>(source->source_.raw()));
    }
    static MaybeLocal<Script> Compile(Local<Context>, Source *source, CompileOptions = kNoCompileOptions)
    {
        return MaybeLocal<Script>(Local<Script>(source->source_.raw()));
    }
};
inline Local<Script> UnboundScriptBind(Local<UnboundScript> u) { return Local<Script>(u.raw()); }


}  // namespace v8

/* Called by the ForgeGraal host before it runs an addon's registration function, so that the V8 layer
   knows which environment the addon is in. Real Node.js never calls it and does not need to. Its
   presence is also how the host recognises an addon built against this layer. */
extern "C" FG_EXPORT __attribute__((used)) inline void fg_v8_set_env(napi_env env) { v8::internal::Env() = env; }
#if defined(__GNUC__) && !defined(_WIN32)
#pragma GCC visibility pop
#endif
#endif  // FORGEGRAAL_V8_H_
