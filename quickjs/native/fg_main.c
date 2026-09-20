/*
 * Entry point for the C build of the ForgeGraal runtime.
 *
 * Deliberately small: it starts the engine, installs the native layer, runs a script and drains
 * the job queue. Everything else lives in JavaScript, exactly as with the Rust host, so the two
 * backends stay interchangeable rather than drifting apart.
 */

#include "quickjs-libc.h"
#include "quickjs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void forgegraal_native_init(JSContext *ctx);
void forgegraal_napi_shutdown(void);

static char *read_file(const char *path, size_t *len_out)
{
    FILE *file = fopen(path, "rb");
    long size;
    char *buffer;

    if (!file) {
        return NULL;
    }
    fseek(file, 0, SEEK_END);
    size = ftell(file);
    fseek(file, 0, SEEK_SET);
    if (size < 0) {
        fclose(file);
        return NULL;
    }
    buffer = malloc((size_t) size + 1);
    if (!buffer) {
        fclose(file);
        return NULL;
    }
    if (fread(buffer, 1, (size_t) size, file) != (size_t) size) {
        free(buffer);
        fclose(file);
        return NULL;
    }
    fclose(file);
    buffer[size] = '\0';
    *len_out = (size_t) size;
    return buffer;
}

int main(int argc, char **argv)
{
    JSRuntime *rt;
    JSContext *ctx;
    char *source;
    size_t len;
    JSValue result;
    int status = 0;

    if (argc < 2) {
        fprintf(stderr, "usage: %s <script.js> [args...]\n\n", argv[0]);
        fprintf(stderr, "Runs a script on quickjs-ng with native sockets, TLS, crypto and compression.\n");
        return 2;
    }

#ifdef _WIN32
    /* The engine resolves a module's relative imports by splitting its name on '/'. A Windows launcher
       naturally passes backslashes, under which `./node-web.js` next to `C:\\app\\node-compat.js` is never
       found, so the script path is given forward slashes, which Windows accepts everywhere. */
    {
        char *c;
        for (c = argv[1]; *c; c++) {
            if (*c == '\\') *c = '/';
        }
    }
#endif

    rt = JS_NewRuntime();
    if (!rt) {
        fprintf(stderr, "forgegraal: could not create the JavaScript runtime\n");
        return 1;
    }
    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        fprintf(stderr, "forgegraal: could not create the JavaScript context\n");
        return 1;
    }

    /* The engine's own std/os modules supply timers, files and the module loader; the native
       layer adds what they lack. Together they match what the Rust host provides. */
    js_std_init_handlers(rt);
    /* An unhandled rejection is an error in the program, not something to ignore: report it and fail. */
    JS_SetHostPromiseRejectionTracker(rt, js_std_promise_rejection_tracker, NULL);
    JS_SetModuleLoaderFunc(rt, NULL, js_module_loader, NULL);
    js_init_module_std(ctx, "qjs:std");
    js_init_module_os(ctx, "qjs:os");
    js_std_add_helpers(ctx, argc - 1, argv + 1);

    forgegraal_native_init(ctx);

    source = read_file(argv[1], &len);
    if (!source) {
        fprintf(stderr, "forgegraal: cannot read '%s'\n", argv[1]);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        return 1;
    }

    /* Evaluated as a module so that top-level await works, which the socket API needs. */
    result = JS_Eval(ctx, source, len, argv[1], JS_EVAL_TYPE_MODULE);
    free(source);

    if (JS_IsException(result)) {
        js_std_dump_error(ctx);
        status = 1;
        JS_FreeValue(ctx, result);
    } else {
        /* Pending promises and timers still need to run before the process ends. */
        js_std_loop(ctx);

        /* A module with top-level await evaluates to a promise, and an error thrown by the script
           rejects it. Without this check the process would exit 0 having silently failed. */
        if (JS_PromiseState(ctx, result) == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, result);
            JS_Throw(ctx, reason);
            js_std_dump_error(ctx);
            status = 1;
        }
        JS_FreeValue(ctx, result);
    }

    /* Addons get their cleanup hooks while the engine is still alive to be called into. */
    forgegraal_napi_shutdown();

    js_std_free_handlers(rt);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return status;
}
