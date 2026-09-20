// A raw V8 addon: no NAN, only the v8:: and node:: APIs, exactly as one written for Node 12 would be.
#include <node.h>
#include <node_buffer.h>
#include <node_object_wrap.h>
#include <string>
using namespace v8;

static void Add(const FunctionCallbackInfo<Value> &args)
{
    Isolate *isolate = args.GetIsolate();
    Local<Context> ctx = isolate->GetCurrentContext();
    if (args.Length() < 2 || !args[0]->IsNumber() || !args[1]->IsNumber()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8(isolate, "Wrong arguments", NewStringType::kNormal).ToLocalChecked()));
        return;
    }
    double v = args[0]->NumberValue(ctx).FromJust() + args[1]->NumberValue(ctx).FromJust();
    args.GetReturnValue().Set(Number::New(isolate, v));
}

static void Hello(const FunctionCallbackInfo<Value> &args)
{
    Isolate *isolate = args.GetIsolate();
    String::Utf8Value name(isolate, args[0]);
    std::string out = std::string("hello, ") + *name;
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, out.c_str(), NewStringType::kNormal).ToLocalChecked());
}

static void MakeObj(const FunctionCallbackInfo<Value> &args)
{
    Isolate *isolate = args.GetIsolate();
    Local<Context> ctx = isolate->GetCurrentContext();
    Local<Object> o = Object::New(isolate);
    o->Set(ctx, String::NewFromUtf8(isolate, "answer", NewStringType::kNormal).ToLocalChecked(), Integer::New(isolate, 42)).FromJust();
    Local<Array> arr = Array::New(isolate, 2);
    arr->Set(ctx, 0, Integer::New(isolate, 7)).FromJust();
    arr->Set(ctx, 1, Integer::New(isolate, 8)).FromJust();
    o->Set(ctx, String::NewFromUtf8(isolate, "list", NewStringType::kNormal).ToLocalChecked(), arr).FromJust();
    args.GetReturnValue().Set(o);
}

static void CallBack(const FunctionCallbackInfo<Value> &args)
{
    Isolate *isolate = args.GetIsolate();
    Local<Context> ctx = isolate->GetCurrentContext();
    Local<Function> cb = Local<Function>::Cast(args[0]);
    Local<Value> argv[1] = {Number::New(isolate, 20)};
    Local<Value> r;
    if (cb->Call(ctx, ctx->Global(), 1, argv).ToLocal(&r)) args.GetReturnValue().Set(r);
}

static void Catches(const FunctionCallbackInfo<Value> &args)
{
    Isolate *isolate = args.GetIsolate();
    Local<Context> ctx = isolate->GetCurrentContext();
    TryCatch tc(isolate);
    Local<Function> cb = Local<Function>::Cast(args[0]);
    MaybeLocal<Value> r = cb->Call(ctx, ctx->Global(), 0, nullptr);
    if (tc.HasCaught()) {
        String::Utf8Value msg(isolate, tc.Exception()->ToString(ctx).ToLocalChecked());
        std::string out = std::string("caught: ") + *msg;
        args.GetReturnValue().Set(String::NewFromUtf8(isolate, out.c_str(), NewStringType::kNormal).ToLocalChecked());
        return;
    }
    args.GetReturnValue().Set(r.ToLocalChecked());
}

static void BufSum(const FunctionCallbackInfo<Value> &args)
{
    unsigned char *data = reinterpret_cast<unsigned char *>(node::Buffer::Data(args[0]));
    size_t len = node::Buffer::Length(args[0]);
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) sum += data[i];
    args.GetReturnValue().Set(Integer::NewFromUnsigned(args.GetIsolate(), sum));
}

static void MakeBuf(const FunctionCallbackInfo<Value> &args)
{
    Local<Object> b = node::Buffer::Copy(args.GetIsolate(), "\x01\x02\x03\x04", 4).ToLocalChecked();
    args.GetReturnValue().Set(b);
}

// A wrapped native class, through FunctionTemplate + ObjectWrap: the pattern every V8 addon has.
class Counter : public node::ObjectWrap {
public:
    static void Init(Local<Object> exports)
    {
        Isolate *isolate = exports->GetIsolate();
        Local<Context> ctx = isolate->GetCurrentContext();
        Local<FunctionTemplate> tpl = FunctionTemplate::New(isolate, New);
        tpl->SetClassName(String::NewFromUtf8(isolate, "Counter", NewStringType::kNormal).ToLocalChecked());
        tpl->InstanceTemplate()->SetInternalFieldCount(1);
        NODE_SET_PROTOTYPE_METHOD(tpl, "inc", Inc);
        tpl->InstanceTemplate()->SetAccessor(String::NewFromUtf8(isolate, "value", NewStringType::kNormal).ToLocalChecked(), GetValue);
        constructor.Reset(isolate, tpl->GetFunction(ctx).ToLocalChecked());
        exports->Set(ctx, String::NewFromUtf8(isolate, "Counter", NewStringType::kNormal).ToLocalChecked(), tpl->GetFunction(ctx).ToLocalChecked()).FromJust();
    }
    static int freed;
    ~Counter() { freed++; }

private:
    explicit Counter(double v) : value_(v) {}
    static void New(const FunctionCallbackInfo<Value> &args)
    {
        Isolate *isolate = args.GetIsolate();
        Local<Context> ctx = isolate->GetCurrentContext();
        if (!args.IsConstructCall()) {
            isolate->ThrowException(Exception::TypeError(String::NewFromUtf8(isolate, "use new", NewStringType::kNormal).ToLocalChecked()));
            return;
        }
        double v = args[0]->IsUndefined() ? 0 : args[0]->NumberValue(ctx).FromMaybe(0);
        Counter *c = new Counter(v);
        c->Wrap(args.This());
        args.GetReturnValue().Set(args.This());
    }
    static void Inc(const FunctionCallbackInfo<Value> &args)
    {
        Counter *c = ObjectWrap::Unwrap<Counter>(args.Holder());
        c->value_ += 1;
        args.GetReturnValue().Set(Number::New(args.GetIsolate(), c->value_));
    }
    static void GetValue(Local<String>, const PropertyCallbackInfo<Value> &info)
    {
        Counter *c = ObjectWrap::Unwrap<Counter>(info.Holder());
        info.GetReturnValue().Set(Number::New(info.GetIsolate(), c->value_));
    }
    static Persistent<Function> constructor;
    double value_;
};
Persistent<Function> Counter::constructor;
int Counter::freed = 0;

static void Freed(const FunctionCallbackInfo<Value> &args) { args.GetReturnValue().Set(Integer::New(args.GetIsolate(), Counter::freed)); }

static void Persist(const FunctionCallbackInfo<Value> &args)
{
    static Persistent<Value> keep;
    Isolate *isolate = args.GetIsolate();
    if (args.Length() > 0) keep.Reset(isolate, args[0]);
    args.GetReturnValue().Set(Local<Value>::New(isolate, keep));
}

static void TypeName(const FunctionCallbackInfo<Value> &args)
{
    Local<Value> v = args[0];
    const char *n = v->IsUndefined() ? "undefined" : v->IsNull() ? "null" : v->IsBoolean() ? "boolean" : v->IsNumber() ? "number"
                  : v->IsString() ? "string" : v->IsSymbol() ? "symbol" : v->IsFunction() ? "function" : v->IsArray() ? "array"
                  : v->IsBigInt() ? "bigint" : v->IsObject() ? "object" : "?";
    args.GetReturnValue().Set(String::NewFromUtf8(args.GetIsolate(), n, NewStringType::kNormal).ToLocalChecked());
}

static void Init(Local<Object> exports)
{
    NODE_SET_METHOD(exports, "add", Add);
    NODE_SET_METHOD(exports, "hello", Hello);
    NODE_SET_METHOD(exports, "makeObject", MakeObj);
    NODE_SET_METHOD(exports, "callBack", CallBack);
    NODE_SET_METHOD(exports, "catches", Catches);
    NODE_SET_METHOD(exports, "bufSum", BufSum);
    NODE_SET_METHOD(exports, "makeBuf", MakeBuf);
    NODE_SET_METHOD(exports, "freed", Freed);
    NODE_SET_METHOD(exports, "persist", Persist);
    NODE_SET_METHOD(exports, "typeName", TypeName);
    Counter::Init(exports);
}

NODE_MODULE(raw_v8, Init)
