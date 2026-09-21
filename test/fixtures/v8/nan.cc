// A NAN addon, written the way NAN's own documentation shows: Nan::New, NAN_METHOD, Nan::ObjectWrap,
// Nan::AsyncWorker, Nan::Callback, Nan::Persistent. Built against Graak's V8 layer, nothing else.
#include <nan.h>
#include <string>

using namespace Nan;
using v8::Local;
using v8::Value;
using v8::Object;

NAN_METHOD(Add)
{
    if (info.Length() < 2 || !info[0]->IsNumber() || !info[1]->IsNumber()) return ThrowTypeError("Wrong arguments");
    double a = To<double>(info[0]).FromJust();
    double b = To<double>(info[1]).FromJust();
    info.GetReturnValue().Set(New<v8::Number>(a + b));
}

NAN_METHOD(Hello)
{
    Utf8String name(info[0]);
    std::string out = std::string("hello, ") + *name;
    info.GetReturnValue().Set(New(out).ToLocalChecked());
}

NAN_METHOD(MakeObject)
{
    Local<Object> o = New<Object>();
    Set(o, New("answer").ToLocalChecked(), New<v8::Int32>(42));
    Local<v8::Array> list = New<v8::Array>(2);
    Set(list, 0, New<v8::Int32>(7));
    Set(list, 1, New<v8::Int32>(8));
    Set(o, New("list").ToLocalChecked(), list);
    info.GetReturnValue().Set(o);
}

NAN_METHOD(CallBack)
{
    Callback cb(To<v8::Function>(info[0]).ToLocalChecked());
    Local<Value> argv[] = {New<v8::Number>(20)};
    info.GetReturnValue().Set(Call(cb, 1, argv).ToLocalChecked());
}

NAN_METHOD(BufSum)
{
    unsigned char *data = reinterpret_cast<unsigned char *>(node::Buffer::Data(info[0]));
    size_t len = node::Buffer::Length(info[0]);
    uint32_t sum = 0;
    for (size_t i = 0; i < len; i++) sum += data[i];
    info.GetReturnValue().Set(New<v8::Uint32>(sum));
}

NAN_METHOD(MakeBuf)
{
    info.GetReturnValue().Set(CopyBuffer("\x01\x02\x03\x04", 4).ToLocalChecked());
}

NAN_METHOD(Throws) { ThrowError("the addon threw"); }

// ---- an ObjectWrap class --------------------------------------------------------------------
class Counter : public ObjectWrap {
public:
    static NAN_MODULE_INIT(Init)
    {
        Local<v8::FunctionTemplate> tpl = New<v8::FunctionTemplate>(CtorNew);
        tpl->SetClassName(New("Counter").ToLocalChecked());
        tpl->InstanceTemplate()->SetInternalFieldCount(1);
        SetPrototypeMethod(tpl, "inc", Inc);
        SetAccessor(tpl->InstanceTemplate(), New("value").ToLocalChecked(), GetValue);
        constructor().Reset(GetFunction(tpl).ToLocalChecked());
        Set(target, New("Counter").ToLocalChecked(), GetFunction(tpl).ToLocalChecked());
    }

private:
    explicit Counter(double v = 0) : value_(v) {}
    static NAN_METHOD(CtorNew)
    {
        if (!info.IsConstructCall()) return ThrowError("use new");
        double v = info[0]->IsUndefined() ? 0 : To<double>(info[0]).FromJust();
        Counter *c = new Counter(v);
        c->Wrap(info.This());
        info.GetReturnValue().Set(info.This());
    }
    static NAN_METHOD(Inc)
    {
        Counter *c = ObjectWrap::Unwrap<Counter>(info.Holder());
        c->value_ += 1;
        info.GetReturnValue().Set(c->value_);
    }
    static NAN_GETTER(GetValue)
    {
        Counter *c = ObjectWrap::Unwrap<Counter>(info.Holder());
        info.GetReturnValue().Set(c->value_);
    }
    static inline Persistent<v8::Function> &constructor()
    {
        static Persistent<v8::Function> my_constructor;
        return my_constructor;
    }
    double value_;
};

// ---- an AsyncWorker: real work on another thread, result back through a callback ------------
class DoubleWorker : public AsyncWorker {
public:
    DoubleWorker(Callback *callback, double input) : AsyncWorker(callback), input_(input), output_(0) {}
    void Execute() override { output_ = input_ * 2; }
    void HandleOKCallback() override
    {
        HandleScope scope;
        Local<Value> argv[] = {Null(), New<v8::Number>(output_)};
        callback->Call(2, argv, async_resource);
    }

private:
    double input_, output_;
};

NAN_METHOD(AsyncDouble)
{
    Callback *cb = new Callback(To<v8::Function>(info[1]).ToLocalChecked());
    AsyncQueueWorker(new DoubleWorker(cb, To<double>(info[0]).FromJust()));
}

NAN_MODULE_INIT(InitAll)
{
    Set(target, New("add").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(Add)).ToLocalChecked());
    Set(target, New("hello").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(Hello)).ToLocalChecked());
    Set(target, New("makeObject").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(MakeObject)).ToLocalChecked());
    Set(target, New("callBack").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(CallBack)).ToLocalChecked());
    Set(target, New("bufSum").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(BufSum)).ToLocalChecked());
    Set(target, New("makeBuf").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(MakeBuf)).ToLocalChecked());
    Set(target, New("throws").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(Throws)).ToLocalChecked());
    Set(target, New("asyncDouble").ToLocalChecked(), GetFunction(New<v8::FunctionTemplate>(AsyncDouble)).ToLocalChecked());
    Counter::Init(target);
}

NODE_MODULE(nan_fixture, InitAll)
