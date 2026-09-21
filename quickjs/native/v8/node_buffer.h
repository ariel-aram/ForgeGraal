#ifndef GRAAK_NODE_BUFFER_H_
#define GRAAK_NODE_BUFFER_H_

#include "node.h"
#if defined(__GNUC__) && !defined(_WIN32)
/* Header-only and private to the addon: were these symbols exported, a host that really is V8 (Node.js)
   would bind the addon's calls to its own implementation of the same name instead of this one. */
#pragma GCC visibility push(hidden)
#endif


namespace node {
namespace Buffer {

static const size_t kMaxLength = 0x7fffffff;
typedef void (*FreeCallback)(char *data, void *hint);

namespace internal {
inline napi_value Wrap(napi_value arraybuffer, size_t length)
{
    napi_value buffer_ctor = v8::internal::PropGet(v8::internal::Global(), "Buffer"), from = nullptr, out = nullptr;
    from = v8::internal::PropGet(buffer_ctor, "from");
    napi_value args[3] = {arraybuffer, nullptr, nullptr};
    napi_create_int32(v8::internal::Env(), 0, &args[1]);
    napi_create_int64(v8::internal::Env(), static_cast<int64_t>(length), &args[2]);
    napi_call_function(v8::internal::Env(), buffer_ctor, from, 3, args, &out);
    return out;
}
}  // namespace internal

inline bool HasInstance(v8::Local<v8::Value> val) { return val->IsArrayBufferView(); }
inline bool HasInstance(v8::Local<v8::Object> obj) { return obj->IsArrayBufferView(); }

inline char *Data(v8::Local<v8::Value> val)
{
    return static_cast<char *>(v8::Local<v8::ArrayBufferView>(val.raw())->DataPtr());
}
inline char *Data(v8::Local<v8::Object> obj) { return Data(v8::Local<v8::Value>(obj.raw())); }
inline size_t Length(v8::Local<v8::Value> val) { return v8::Local<v8::ArrayBufferView>(val.raw())->ByteLength(); }
inline size_t Length(v8::Local<v8::Object> obj) { return Length(v8::Local<v8::Value>(obj.raw())); }

inline v8::MaybeLocal<v8::Object> New(v8::Isolate *, size_t length)
{
    napi_value buf, ab;
    void *data;
    if (napi_create_arraybuffer(v8::internal::Env(), length, &data, &ab) != napi_ok) return v8::MaybeLocal<v8::Object>();
    buf = internal::Wrap(ab, length);
    return buf ? v8::MaybeLocal<v8::Object>(v8::Local<v8::Object>(buf)) : v8::MaybeLocal<v8::Object>();
}
inline v8::MaybeLocal<v8::Object> New(v8::Isolate *isolate, char *data, size_t length, FreeCallback callback, void *hint)
{
    struct Hint { FreeCallback cb; void *hint; };
    napi_value ab;
    Hint *h = new Hint{callback, hint};
    if (napi_create_external_arraybuffer(
            v8::internal::Env(), data, length,
            [](napi_env, void *d, void *hh) {
                Hint *x = static_cast<Hint *>(hh);
                if (x->cb) x->cb(static_cast<char *>(d), x->hint);
                delete x;
            },
            h, &ab) != napi_ok) {
        delete h;
        return v8::MaybeLocal<v8::Object>();
    }
    (void) isolate;
    napi_value buf = internal::Wrap(ab, length);
    return buf ? v8::MaybeLocal<v8::Object>(v8::Local<v8::Object>(buf)) : v8::MaybeLocal<v8::Object>();
}
inline v8::MaybeLocal<v8::Object> New(v8::Isolate *isolate, char *data, size_t length)
{
    return New(isolate, data, length, [](char *d, void *) { std::free(d); }, nullptr);
}
inline v8::MaybeLocal<v8::Object> Copy(v8::Isolate *isolate, const char *data, size_t length)
{
    v8::Local<v8::Object> out;
    if (!New(isolate, length).ToLocal(&out)) return v8::MaybeLocal<v8::Object>();
    std::memcpy(Data(out), data, length);
    return v8::MaybeLocal<v8::Object>(out);
}
inline v8::MaybeLocal<v8::Object> Use(v8::Isolate *isolate, char *data, size_t length) { return New(isolate, data, length); }

}  // namespace Buffer

inline v8::Local<v8::Value> Encode(v8::Isolate *isolate, const char *buf, size_t len, encoding enc = BINARY)
{
    switch (enc) {
    case UTF8: return v8::String::NewFromUtf8(isolate, buf, v8::NewStringType::kNormal, static_cast<int>(len)).ToLocalChecked();
    case UCS2: return v8::String::NewFromTwoByte(isolate, reinterpret_cast<const uint16_t *>(buf), v8::NewStringType::kNormal, static_cast<int>(len / 2)).ToLocalChecked();
    case BUFFER: return Buffer::Copy(isolate, buf, len).ToLocalChecked();
    case HEX: {
        static const char digits[] = "0123456789abcdef";
        std::string out(len * 2, '0');
        for (size_t i = 0; i < len; i++) {
            out[2 * i] = digits[(static_cast<unsigned char>(buf[i]) >> 4) & 15];
            out[2 * i + 1] = digits[static_cast<unsigned char>(buf[i]) & 15];
        }
        return v8::String::NewFromUtf8(isolate, out.c_str(), v8::NewStringType::kNormal, static_cast<int>(out.size())).ToLocalChecked();
    }
    default: return v8::String::NewFromOneByte(isolate, reinterpret_cast<const uint8_t *>(buf), v8::NewStringType::kNormal, static_cast<int>(len)).ToLocalChecked();
    }
}
inline v8::Local<v8::Value> Encode(v8::Isolate *isolate, const uint16_t *buf, size_t len)
{
    return v8::String::NewFromTwoByte(isolate, buf, v8::NewStringType::kNormal, static_cast<int>(len)).ToLocalChecked();
}

inline ssize_t DecodeBytes(v8::Isolate *isolate, v8::Local<v8::Value> val, encoding enc = BINARY)
{
    if (val->IsArrayBufferView()) return static_cast<ssize_t>(Buffer::Length(val));
    v8::Local<v8::String> s = val->ToString(v8::Local<v8::Context>()).ToLocalChecked();
    if (enc == UCS2) return s->Length() * 2;
    if (enc == HEX) return s->Length() / 2;
    if (enc == UTF8) return s->Utf8Length(isolate);
    return s->Length();
}
inline ssize_t DecodeWrite(v8::Isolate *isolate, char *buf, size_t buflen, v8::Local<v8::Value> val, encoding enc = BINARY)
{
    if (val->IsArrayBufferView()) {
        size_t n = Buffer::Length(val) < buflen ? Buffer::Length(val) : buflen;
        std::memcpy(buf, Buffer::Data(val), n);
        return static_cast<ssize_t>(n);
    }
    v8::Local<v8::String> s = val->ToString(v8::Local<v8::Context>()).ToLocalChecked();
    switch (enc) {
    case UTF8: return s->WriteUtf8(isolate, buf, static_cast<int>(buflen), nullptr, v8::String::NO_NULL_TERMINATION);
    case UCS2: return s->Write(isolate, reinterpret_cast<uint16_t *>(buf), 0, static_cast<int>(buflen / 2), v8::String::NO_NULL_TERMINATION) * 2;
    case HEX: {
        std::string in = v8::internal::ToStd(s.raw());
        size_t n = 0;
        for (size_t i = 0; i + 1 < in.size() && n < buflen; i += 2, n++) buf[n] = static_cast<char>(std::strtol(in.substr(i, 2).c_str(), nullptr, 16));
        return static_cast<ssize_t>(n);
    }
    default: return s->WriteOneByte(isolate, reinterpret_cast<uint8_t *>(buf), 0, static_cast<int>(buflen), v8::String::NO_NULL_TERMINATION);
    }
}

}  // namespace node



#if defined(__GNUC__) && !defined(_WIN32)
#pragma GCC visibility pop
#endif
#endif
