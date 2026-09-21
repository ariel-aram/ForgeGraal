#ifndef GRAAK_NODE_OBJECT_WRAP_H_
#define GRAAK_NODE_OBJECT_WRAP_H_

#include "node.h"
#include <cassert>
#if defined(__GNUC__) && !defined(_WIN32)
/* Header-only and private to the addon: were these symbols exported, a host that really is V8 (Node.js)
   would bind the addon's calls to its own implementation of the same name instead of this one. */
#pragma GCC visibility push(hidden)
#endif


namespace node {

class ObjectWrap {
public:
    ObjectWrap() { refs_ = 0; }
    virtual ~ObjectWrap()
    {
        if (persistent().IsEmpty()) return;
        persistent().ClearWeak();
        persistent().Reset();
    }

    template <class T> static inline T *Unwrap(v8::Local<v8::Object> handle)
    {
        assert(!handle.IsEmpty());
        assert(handle->InternalFieldCount() > 0);
        void *ptr = handle->GetAlignedPointerFromInternalField(0);
        ObjectWrap *wrap = static_cast<ObjectWrap *>(ptr);
        return static_cast<T *>(wrap);
    }

    inline v8::Local<v8::Object> handle() { return handle(v8::Isolate::GetCurrent()); }
    inline v8::Local<v8::Object> handle(v8::Isolate *isolate) { return v8::Local<v8::Object>::New(isolate, handle_); }
    inline v8::Persistent<v8::Object> &persistent() { return handle_; }

protected:
    inline void Wrap(v8::Local<v8::Object> handle)
    {
        assert(persistent().IsEmpty());
        assert(handle->InternalFieldCount() > 0);
        handle->SetAlignedPointerInInternalField(0, this);
        persistent().Reset(v8::Isolate::GetCurrent(), handle);
        MakeWeak();
    }
    inline void MakeWeak()
    {
        persistent().SetWeak(this, WeakCallback, v8::WeakCallbackType::kParameter);
        persistent().MarkIndependent();
    }
    virtual void Ref()
    {
        assert(!persistent().IsEmpty());
        persistent().ClearWeak();
        refs_++;
    }
    virtual void Unref()
    {
        assert(!persistent().IsEmpty());
        assert(!persistent().IsWeak());
        assert(refs_ > 0);
        if (--refs_ == 0) MakeWeak();
    }

    int refs_;

private:
    static void WeakCallback(const v8::WeakCallbackInfo<ObjectWrap> &data)
    {
        ObjectWrap *wrap = data.GetParameter();
        assert(wrap->refs_ == 0);
        wrap->handle_.Reset();
        delete wrap;
    }
    v8::Persistent<v8::Object> handle_;
};

}  // namespace node



#if defined(__GNUC__) && !defined(_WIN32)
#pragma GCC visibility pop
#endif
#endif
