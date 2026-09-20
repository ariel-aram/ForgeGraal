// Property interceptors: an object whose reads, writes, `in`, delete and enumeration are answered by C++.
// Written against the V8 API as an addon would (no NAN), backed here by a std::map.
#include <node.h>
#include <map>
#include <string>
using namespace v8;

typedef std::map<std::string, std::string> Store;

static Store *StoreOf(const PropertyCallbackInfo<Value> &info)
{
    return static_cast<Store *>(info.Holder()->GetAlignedPointerFromInternalField(0));
}
template <class T> static Store *StoreOfT(const PropertyCallbackInfo<T> &info)
{
    return static_cast<Store *>(info.Holder()->GetAlignedPointerFromInternalField(0));
}
static bool Declined(const std::string &key) { return !key.empty() && key[0] == '_'; }

static void Get(Local<Name> property, const PropertyCallbackInfo<Value> &info)
{
    Isolate *isolate = info.GetIsolate();
    String::Utf8Value key(isolate, property);
    Store *store = StoreOf(info);
    auto it = store->find(*key);
    if (Declined(*key) || it == store->end()) return;
    info.GetReturnValue().Set(String::NewFromUtf8(isolate, it->second.c_str(), NewStringType::kNormal).ToLocalChecked());
}

static void Set(Local<Name> property, Local<Value> value, const PropertyCallbackInfo<Value> &info)
{
    Isolate *isolate = info.GetIsolate();
    String::Utf8Value key(isolate, property);
    if (Declined(*key)) return;  // a plain property, as if there were no interceptor
    String::Utf8Value text(isolate, value);
    (*StoreOf(info))[*key] = *text;
    info.GetReturnValue().Set(value);
}

static void Query(Local<Name> property, const PropertyCallbackInfo<Integer> &info)
{
    String::Utf8Value key(info.GetIsolate(), property);
    Store *store = StoreOfT(info);
    if (store->count(*key)) info.GetReturnValue().Set(Integer::New(info.GetIsolate(), 0));
}

static void Delete(Local<Name> property, const PropertyCallbackInfo<Boolean> &info)
{
    String::Utf8Value key(info.GetIsolate(), property);
    Store *store = StoreOfT(info);
    if (store->erase(*key)) info.GetReturnValue().Set(Boolean::New(info.GetIsolate(), true));
}

static void Enumerate(const PropertyCallbackInfo<Array> &info)
{
    Isolate *isolate = info.GetIsolate();
    Store *store = StoreOfT(info);
    Local<Array> keys = Array::New(isolate, static_cast<int>(store->size()));
    uint32_t i = 0;
    for (auto &entry : *store) {
        keys->Set(isolate->GetCurrentContext(), i++, String::NewFromUtf8(isolate, entry.first.c_str(), NewStringType::kNormal).ToLocalChecked()).FromJust();
    }
    info.GetReturnValue().Set(keys);
}

static void IndexGet(uint32_t index, const PropertyCallbackInfo<Value> &info)
{
    if (index < 10) info.GetReturnValue().Set(Integer::NewFromUnsigned(info.GetIsolate(), index * index));
}

static void New(const FunctionCallbackInfo<Value> &args)
{
    args.This()->SetAlignedPointerInInternalField(0, new Store());
    args.GetReturnValue().Set(args.This());
}

static void Size(const FunctionCallbackInfo<Value> &args)
{
    Store *store = static_cast<Store *>(args.Holder()->GetAlignedPointerFromInternalField(0));
    args.GetReturnValue().Set(Integer::NewFromUnsigned(args.GetIsolate(), static_cast<uint32_t>(store->size())));
}

static void Init(Local<Object> exports)
{
    Isolate *isolate = exports->GetIsolate();
    Local<Context> ctx = isolate->GetCurrentContext();
    Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New);
    tpl->SetClassName(String::NewFromUtf8(isolate, "Dict", NewStringType::kNormal).ToLocalChecked());
    tpl->InstanceTemplate()->SetInternalFieldCount(1);
    tpl->InstanceTemplate()->SetHandler(NamedPropertyHandlerConfiguration(Get, Set, Query, Delete, Enumerate));
    tpl->InstanceTemplate()->SetHandler(IndexedPropertyHandlerConfiguration(IndexGet));
    NODE_SET_PROTOTYPE_METHOD(tpl, "size", Size);
    exports->Set(ctx, String::NewFromUtf8(isolate, "Dict", NewStringType::kNormal).ToLocalChecked(), tpl->GetFunction(ctx).ToLocalChecked()).FromJust();
}

NODE_MODULE(interceptors, Init)
