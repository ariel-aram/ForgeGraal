/*
 * Child processes with live pipes, for node:child_process spawn() and fork().
 *
 * The engine's os.exec() runs a child to completion, which cannot stream: stdout/stderr 'data' as it
 * arrives, stdin written while the child runs, kill(), and the IPC channel of fork() all need the parent
 * to keep running. This file spawns a child without waiting and gives the JavaScript layer non-blocking
 * pipes to poll, the same way native-modules.js polls sockets.
 *
 *   procSpawn(argv, { cwd, env, stdio: [m0, m1, m2], ipc, detached }) -> { proc, pid, stdio: [id|-1 x3], ipc: id|-1 }
 *                                                                        or a negative errno when the program cannot start
 *   procPoll(proc)                 -> undefined while running, else the exit code (or -signal)
 *   procKill(proc, signal)         -> true when the signal was delivered (signal 0 only probes)
 *   pipeRead(id, max)              -> ArrayBuffer, undefined when nothing is there yet, null at end of stream
 *   pipeWrite(id, buf, off, len)   -> bytes written (0 when the pipe is full), -1 when the reader is gone
 *   pipeClose(id, which)           -> 0 read half, 1 write half, 2 (default) both
 *   pipePoll(ids, ms)              -> the ids that can be read (data, end of stream or error), waiting at most ms
 *   channelOpen()                  -> the id of the IPC channel a forking parent left this process, or -1
 *
 * A stdio mode is "pipe", "inherit", "ignore" or a descriptor number.
 *
 * The IPC channel is a socketpair on POSIX (descriptor 3 in the child, NODE_CHANNEL_FD=3, exactly what Node
 * does, so a Graak parent and a Node child, or the other way round, can talk). Windows before 10 has no
 * AF_UNIX, so there it is two anonymous pipes whose handle numbers travel in NODE_CHANNEL_FD (parent to
 * child) and GRAAK_CHANNEL_OUT (child to parent). Nothing here needs more than Windows XP: CreatePipe,
 * CreateProcessW, PeekNamedPipe and TerminateProcess.
 */

#include "quickjs.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#define FG_NOH INVALID_HANDLE_VALUE
typedef HANDLE fg_h;
#else
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#define FG_NOH (-1)
typedef int fg_h;
#endif

#define FG_MAX_PIPES 512
#define FG_MAX_PROCS 256
#define FG_PIPE_CHUNK 65536

enum { FG_STDIO_PIPE = 0, FG_STDIO_INHERIT = 1, FG_STDIO_IGNORE = 2, FG_STDIO_FD = 3 };

typedef struct {
    int in_use;
    fg_h r, w; /* one descriptor may serve both halves (a socketpair); then r == w */
} fg_pipe;

typedef struct {
    int in_use, done, status, signal;
#ifdef _WIN32
    HANDLE h;
#else
    pid_t pid;
#endif
} fg_proc;

static fg_pipe fg_pipes[FG_MAX_PIPES];
static fg_proc fg_procs[FG_MAX_PROCS];
static unsigned char fg_chunk[FG_PIPE_CHUNK];

static int fg_pipe_alloc(fg_h r, fg_h w)
{
    int i;
    for (i = 0; i < FG_MAX_PIPES; i++) {
        if (!fg_pipes[i].in_use) {
            fg_pipes[i].in_use = 1;
            fg_pipes[i].r = r;
            fg_pipes[i].w = w;
            return i;
        }
    }
    return -1;
}

static int fg_proc_alloc(void)
{
    int i;
    for (i = 0; i < FG_MAX_PROCS; i++) {
        if (!fg_procs[i].in_use) {
            memset(&fg_procs[i], 0, sizeof(fg_procs[i]));
            fg_procs[i].in_use = 1;
            return i;
        }
    }
    return -1;
}

static void fg_close_h(fg_h h)
{
#ifdef _WIN32
    if (h != FG_NOH && h != NULL) CloseHandle(h);
#else
    if (h >= 0) close(h);
#endif
}

/* Closes one or both halves of a pipe entry; the entry is freed once nothing is left open. */
static void fg_pipe_close(int id, int which)
{
    fg_pipe *p;
    if (id < 0 || id >= FG_MAX_PIPES || !fg_pipes[id].in_use) return;
    p = &fg_pipes[id];
    if ((which == 0 || which == 2) && p->r != FG_NOH) {
        if (p->r == p->w) {
#ifndef _WIN32
            shutdown(p->r, SHUT_RD);
#endif
        } else {
            fg_close_h(p->r);
        }
        p->r = FG_NOH;
    }
    if ((which == 1 || which == 2) && p->w != FG_NOH) {
        if (p->r == p->w && p->r != FG_NOH) {
#ifndef _WIN32
            shutdown(p->w, SHUT_WR);
#endif
        } else {
            fg_close_h(p->w);
        }
        p->w = FG_NOH;
    }
    /* A socketpair descriptor is shared by both halves: it goes when both have been given up. */
    if (p->r == FG_NOH && p->w == FG_NOH) p->in_use = 0;
}

/* ----------------------------------------------------------------------------------------------------------- */

static int fg_str_array(JSContext *ctx, JSValueConst arr, char ***out, uint32_t *count_out)
{
    JSValue l = JS_GetPropertyStr(ctx, arr, "length");
    int64_t n = 0;
    uint32_t i;
    char **list;
    JS_ToInt64(ctx, &n, l);
    JS_FreeValue(ctx, l);
    list = calloc((size_t) n + 1, sizeof(char *));
    if (!list) return -1;
    for (i = 0; i < (uint32_t) n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, arr, i);
        const char *text = JS_ToCString(ctx, item);
        JS_FreeValue(ctx, item);
        if (!text) {
            while (i--) free(list[i]);
            free(list);
            return -1;
        }
        list[i] = strdup(text);
        JS_FreeCString(ctx, text);
    }
    *out = list;
    *count_out = (uint32_t) n;
    return 0;
}

static void fg_free_list(char **list, uint32_t n)
{
    uint32_t i;
    if (!list) return;
    for (i = 0; i < n; i++) free(list[i]);
    free(list);
}

/* KEY=VALUE strings from a plain object, or NULL when the option was not given. */
static char **fg_env_list(JSContext *ctx, JSValueConst obj, uint32_t *count_out)
{
    JSPropertyEnum *tab;
    uint32_t n, e, used = 0;
    char **list;
    if (!JS_IsObject(obj)) return NULL;
    if (JS_GetOwnPropertyNames(ctx, &tab, &n, obj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) return NULL;
    list = calloc((size_t) n + 1, sizeof(char *));
    for (e = 0; list && e < n; e++) {
        const char *key = JS_AtomToCString(ctx, tab[e].atom);
        JSValue val = JS_GetProperty(ctx, obj, tab[e].atom);
        const char *value = JS_IsUndefined(val) ? NULL : JS_ToCString(ctx, val);
        if (key && value) {
            size_t len = strlen(key) + strlen(value) + 2;
            char *entry = malloc(len);
            if (entry) {
                snprintf(entry, len, "%s=%s", key, value);
                list[used++] = entry;
            }
        }
        if (key) JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        JS_FreeValue(ctx, val);
    }
    js_free(ctx, tab);
    *count_out = used;
    return list;
}

static int fg_parse_stdio(JSContext *ctx, JSValueConst opt, int index, int *fd_out)
{
    JSValue list, v;
    int mode = FG_STDIO_PIPE;
    *fd_out = -1;
    if (!JS_IsObject(opt)) return mode;
    list = JS_GetPropertyStr(ctx, opt, "stdio");
    if (JS_IsObject(list)) {
        v = JS_GetPropertyUint32(ctx, list, (uint32_t) index);
        if (JS_IsString(v)) {
            const char *s = JS_ToCString(ctx, v);
            if (s && strcmp(s, "inherit") == 0) mode = FG_STDIO_INHERIT;
            else if (s && strcmp(s, "ignore") == 0) mode = FG_STDIO_IGNORE;
            if (s) JS_FreeCString(ctx, s);
        } else if (JS_IsNumber(v)) {
            int32_t n;
            if (JS_ToInt32(ctx, &n, v) == 0 && n >= 0) {
                mode = FG_STDIO_FD;
                *fd_out = n;
            }
        }
        JS_FreeValue(ctx, v);
    }
    JS_FreeValue(ctx, list);
    return mode;
}

static int fg_opt_bool(JSContext *ctx, JSValueConst opt, const char *name)
{
    int r = 0;
    JSValue v;
    if (!JS_IsObject(opt)) return 0;
    v = JS_GetPropertyStr(ctx, opt, name);
    if (!JS_IsUndefined(v)) r = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    return r;
}

static char *fg_opt_string(JSContext *ctx, JSValueConst opt, const char *name)
{
    char *r = NULL;
    JSValue v;
    if (!JS_IsObject(opt)) return NULL;
    v = JS_GetPropertyStr(ctx, opt, name);
    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        if (s) {
            r = strdup(s);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, v);
    return r;
}

static JSValue fg_spawn_result(JSContext *ctx, int proc, long pid, const int *ids, int ipc)
{
    JSValue out = JS_NewObject(ctx), arr = JS_NewArray(ctx);
    int i;
    for (i = 0; i < 3; i++) JS_SetPropertyUint32(ctx, arr, (uint32_t) i, JS_NewInt32(ctx, ids[i]));
    JS_SetPropertyStr(ctx, out, "proc", JS_NewInt32(ctx, proc));
    JS_SetPropertyStr(ctx, out, "pid", JS_NewInt32(ctx, (int32_t) pid));
    JS_SetPropertyStr(ctx, out, "stdio", arr);
    JS_SetPropertyStr(ctx, out, "ipc", JS_NewInt32(ctx, ipc));
    return out;
}

#ifndef _WIN32
/* ================================================================== POSIX ================================== */

static int fg_high_fd(int fd)
{
    int hi;
    if (fd < 0) return fd;
    hi = fcntl(fd, F_DUPFD_CLOEXEC, 10);
    if (hi >= 0) close(fd);
    return hi >= 0 ? hi : fd;
}

static void fg_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int fg_cloexec_pipe(int p[2])
{
    if (pipe(p) != 0) return -1;
    fcntl(p[0], F_SETFD, FD_CLOEXEC);
    fcntl(p[1], F_SETFD, FD_CLOEXEC);
    return 0;
}

static JSValue fg_proc_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    static int sigpipe_ignored;
    char **args = NULL, **env = NULL, **envp = NULL;
    uint32_t nargs = 0, nenv = 0, i, nenvp = 0;
    char *cwd = NULL;
    int mode[3], modefd[3], child_fd[4] = { -1, -1, -1, -1 }, parent_r[3] = { -1, -1, -1 }, parent_w = -1;
    int ipc, detached, ipc_parent = -1, ep[2] = { -1, -1 }, k, proc, ids[3] = { -1, -1, -1 }, ipc_id = -1;
    JSValueConst opt = argc > 1 ? argv[1] : JS_UNDEFINED;
    pid_t pid;
    int err = 0;
    JSValue result;

    if (argc < 1 || !JS_IsArray(argv[0])) return JS_ThrowTypeError(ctx, "procSpawn(argv, options) expects an array");
    if (fg_str_array(ctx, argv[0], &args, &nargs) != 0 || nargs == 0) {
        fg_free_list(args, nargs);
        return JS_ThrowTypeError(ctx, "procSpawn: empty command");
    }
    if (!sigpipe_ignored) {
        /* A write to a child that has gone must fail with EPIPE, not kill this process. */
        signal(SIGPIPE, SIG_IGN);
        sigpipe_ignored = 1;
    }
    cwd = fg_opt_string(ctx, opt, "cwd");
    ipc = fg_opt_bool(ctx, opt, "ipc");
    detached = fg_opt_bool(ctx, opt, "detached");
    for (k = 0; k < 3; k++) mode[k] = fg_parse_stdio(ctx, opt, k, &modefd[k]);
    if (JS_IsObject(opt)) {
        JSValue e = JS_GetPropertyStr(ctx, opt, "env");
        env = fg_env_list(ctx, e, &nenv);
        JS_FreeValue(ctx, e);
    }

    /* Descriptors: the child's end of each pipe goes to 0/1/2 (and 3 for the channel). Everything is moved
       above 10 first so that the dup2 calls in the child can never overwrite a source that is still needed. */
    for (k = 0; k < 3 && err == 0; k++) {
        if (mode[k] == FG_STDIO_PIPE) {
            int p[2];
            if (fg_cloexec_pipe(p) != 0) {
                err = errno;
                break;
            }
            p[0] = fg_high_fd(p[0]);
            p[1] = fg_high_fd(p[1]);
            if (k == 0) {
                child_fd[0] = p[0];
                parent_w = p[1];
            } else {
                child_fd[k] = p[1];
                parent_r[k] = p[0];
            }
        } else if (mode[k] == FG_STDIO_IGNORE) {
            int fd = open("/dev/null", O_RDWR | O_CLOEXEC);
            if (fd < 0) err = errno;
            else child_fd[k] = fg_high_fd(fd);
        } else if (mode[k] == FG_STDIO_FD) {
            child_fd[k] = modefd[k];
        }
    }
    if (err == 0 && ipc) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
            err = errno;
        } else {
            fcntl(sv[0], F_SETFD, FD_CLOEXEC);
            fcntl(sv[1], F_SETFD, FD_CLOEXEC);
            ipc_parent = fg_high_fd(sv[0]);
            child_fd[3] = fg_high_fd(sv[1]);
        }
    }
    if (err == 0 && fg_cloexec_pipe(ep) != 0) err = errno;

    /* The child's environment: the given one (or ours) plus the channel variables. */
    if (err == 0) {
        char **base = env ? env : environ;
        uint32_t nbase = nenv;
        if (!env) for (nbase = 0; base && base[nbase]; nbase++) {}
        envp = calloc((size_t) nbase + 3, sizeof(char *));
        if (!envp) err = ENOMEM;
        else {
            for (i = 0; i < nbase; i++) envp[nenvp++] = base[i];
            if (ipc) {
                envp[nenvp++] = "NODE_CHANNEL_FD=3";
                envp[nenvp++] = "NODE_CHANNEL_SERIALIZATION_MODE=json";
            }
            envp[nenvp] = NULL;
        }
    }

    pid = -1;
    if (err == 0) pid = fork();
    if (err == 0 && pid < 0) err = errno;
    if (err == 0 && pid == 0) {
        /* Child: only async-signal-safe calls from here to exec. */
        sigset_t none;
        long maxfd, fd;
        if (detached) setsid();
        signal(SIGPIPE, SIG_DFL);
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        for (k = 0; k < 4; k++) {
            if (child_fd[k] >= 0 && child_fd[k] != k) dup2(child_fd[k], k);
        }
        maxfd = sysconf(_SC_OPEN_MAX);
        if (maxfd < 0 || maxfd > 4096) maxfd = 4096;
        for (fd = 4; fd < maxfd; fd++) {
            int keep = fd == ep[1];
            for (k = 0; k < 3; k++) if (mode[k] == FG_STDIO_FD && modefd[k] == fd) keep = 1;
            if (!keep) close((int) fd);
        }
        if (cwd && chdir(cwd) != 0) goto child_fail;
        environ = envp;
        execvp(args[0], args);
    child_fail:
        err = errno;
        if (write(ep[1], &err, sizeof(err)) < 0) {}
        _exit(127);
    }

    /* Parent. */
    for (k = 0; k < 4; k++) {
        if (child_fd[k] >= 0 && !(k < 3 && mode[k] == FG_STDIO_FD)) close(child_fd[k]);
    }
    if (ep[1] >= 0) close(ep[1]);
    if (err == 0) {
        int got = 0;
        ssize_t n;
        do {
            n = read(ep[0], &got, sizeof(got));
        } while (n < 0 && errno == EINTR);
        if (n == (ssize_t) sizeof(got)) {
            int st;
            waitpid(pid, &st, 0);
            err = got;
        }
    }
    if (ep[0] >= 0) close(ep[0]);

    if (err == 0) {
        proc = fg_proc_alloc();
        if (proc < 0) {
            kill(pid, SIGKILL);
            waitpid(pid, NULL, 0);
            err = EMFILE;
        } else {
            fg_procs[proc].pid = pid;
        }
    }
    if (err == 0) {
        if (parent_w >= 0) {
            fg_nonblock(parent_w);
            ids[0] = fg_pipe_alloc(-1, parent_w);
        }
        for (k = 1; k < 3; k++) {
            if (parent_r[k] >= 0) {
                fg_nonblock(parent_r[k]);
                ids[k] = fg_pipe_alloc(parent_r[k], -1);
            }
        }
        if (ipc_parent >= 0) {
            fg_nonblock(ipc_parent);
            ipc_id = fg_pipe_alloc(ipc_parent, ipc_parent);
        }
        result = fg_spawn_result(ctx, proc, (long) pid, ids, ipc_id);
    } else {
        if (parent_w >= 0) close(parent_w);
        for (k = 1; k < 3; k++) if (parent_r[k] >= 0) close(parent_r[k]);
        if (ipc_parent >= 0) close(ipc_parent);
        result = JS_NewInt32(ctx, -err);
    }
    free(envp);
    fg_free_list(env, nenv);
    fg_free_list(args, nargs);
    free(cwd);
    return result;
}

static int fg_proc_reap(fg_proc *p)
{
    int st = 0;
    pid_t r;
    if (p->done) return 1;
    do {
        r = waitpid(p->pid, &st, WNOHANG);
    } while (r < 0 && errno == EINTR);
    if (r == 0) return 0;
    p->done = 1;
    if (r < 0) p->status = 0;
    else if (WIFSIGNALED(st)) p->status = -WTERMSIG(st);
    else p->status = WEXITSTATUS(st);
    return 1;
}

static JSValue fg_proc_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, sig = SIGTERM;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &sig, argv[1]);
    if (id < 0 || id >= FG_MAX_PROCS || !fg_procs[id].in_use || fg_procs[id].done) return JS_FALSE;
    return JS_NewBool(ctx, kill(fg_procs[id].pid, sig) == 0);
}

static JSValue fg_pipe_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, max = FG_PIPE_CHUNK;
    ssize_t n;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &max, argv[1]);
    if (max <= 0 || max > FG_PIPE_CHUNK) max = FG_PIPE_CHUNK;
    if (id < 0 || id >= FG_MAX_PIPES || !fg_pipes[id].in_use || fg_pipes[id].r < 0) return JS_NULL;
    do {
        n = read(fg_pipes[id].r, fg_chunk, (size_t) max);
    } while (n < 0 && errno == EINTR);
    if (n > 0) return JS_NewArrayBufferCopy(ctx, fg_chunk, (size_t) n);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return JS_UNDEFINED;
    return JS_NULL;
}

static JSValue fg_pipe_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, off = 0, len = 0;
    size_t size;
    uint8_t *buf;
    ssize_t n;
    if (argc < 4 || JS_ToInt32(ctx, &id, argv[0]) || JS_ToInt32(ctx, &off, argv[2]) || JS_ToInt32(ctx, &len, argv[3])) {
        return JS_ThrowTypeError(ctx, "pipeWrite(id, buffer, offset, length)");
    }
    buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf) return JS_EXCEPTION;
    if (off < 0 || len < 0 || (size_t) off + (size_t) len > size) return JS_ThrowRangeError(ctx, "pipeWrite: out of range");
    if (id < 0 || id >= FG_MAX_PIPES || !fg_pipes[id].in_use || fg_pipes[id].w < 0) return JS_NewInt32(ctx, -1);
    if (len == 0) return JS_NewInt32(ctx, 0);
    do {
        n = write(fg_pipes[id].w, buf + off, (size_t) len);
    } while (n < 0 && errno == EINTR);
    if (n >= 0) return JS_NewInt32(ctx, (int32_t) n);
    if (errno == EAGAIN || errno == EWOULDBLOCK) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, -1);
}

static JSValue fg_pipe_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    JSValue out = JS_NewArray(ctx);
    uint32_t n = 0, i, used = 0, found = 0;
    int32_t ms = 0, r;
    struct pollfd *fds;
    int32_t *owner;
    if (argc > 0 && JS_IsArray(argv[0])) {
        JSValue l = JS_GetPropertyStr(ctx, argv[0], "length");
        JS_ToUint32(ctx, &n, l);
        JS_FreeValue(ctx, l);
    }
    if (argc > 1) JS_ToInt32(ctx, &ms, argv[1]);
    fds = calloc((size_t) n + 1, sizeof(struct pollfd));
    owner = calloc((size_t) n + 1, sizeof(int32_t));
    if (!fds || !owner) {
        free(fds);
        free(owner);
        JS_FreeValue(ctx, out);
        return JS_ThrowOutOfMemory(ctx);
    }
    for (i = 0; i < n; i++) {
        int32_t id;
        JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
        JS_ToInt32(ctx, &id, v);
        JS_FreeValue(ctx, v);
        if (id >= 0 && id < FG_MAX_PIPES && fg_pipes[id].in_use && fg_pipes[id].r >= 0) {
            fds[used].fd = fg_pipes[id].r;
            fds[used].events = POLLIN;
            owner[used++] = id;
        }
    }
    do {
        r = poll(fds, used, ms);
    } while (r < 0 && errno == EINTR);
    if (r > 0) {
        for (i = 0; i < used; i++) {
            if (fds[i].revents) JS_SetPropertyUint32(ctx, out, found++, JS_NewInt32(ctx, owner[i]));
        }
    }
    free(fds);
    free(owner);
    return out;
}

static JSValue fg_channel_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *text = getenv("NODE_CHANNEL_FD");
    char *end;
    long fd;
    int id;
    if (!text || !*text) return JS_NewInt32(ctx, -1);
    fd = strtol(text, &end, 10);
    if (*end || fd < 3 || fcntl((int) fd, F_GETFD) < 0) return JS_NewInt32(ctx, -1);
    fcntl((int) fd, F_SETFD, FD_CLOEXEC);
    fg_nonblock((int) fd);
    id = fg_pipe_alloc((int) fd, (int) fd);
    return JS_NewInt32(ctx, id);
}

#else
/* ================================================================== Windows ================================ */

static wchar_t *fg_wide(const char *s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    wchar_t *w = malloc((size_t) (n > 0 ? n : 1) * sizeof(wchar_t));
    if (w) {
        if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
        else w[0] = 0;
    }
    return w;
}

/* Appends one argument, quoted the way CommandLineToArgvW reads it back. */
static void fg_quote(wchar_t **out, size_t *len, size_t *cap, const wchar_t *arg)
{
    size_t need = wcslen(arg) * 2 + 4 + *len + 1, i, backslashes = 0;
    int quote = arg[0] == 0 || wcspbrk(arg, L" \t\n\v\"") != NULL;
    if (need > *cap) {
        *cap = need * 2;
        *out = realloc(*out, *cap * sizeof(wchar_t));
    }
    if (*len) (*out)[(*len)++] = L' ';
    if (quote) (*out)[(*len)++] = L'"';
    for (i = 0; arg[i]; i++) {
        if (arg[i] == L'\\') {
            backslashes++;
            continue;
        }
        if (arg[i] == L'"') {
            while (backslashes--) (*out)[(*len)++] = L'\\';
            (*out)[(*len)++] = L'\\';
        } else {
            while (backslashes--) (*out)[(*len)++] = L'\\';
        }
        backslashes = 0;
        (*out)[(*len)++] = arg[i];
    }
    while (backslashes--) (*out)[(*len)++] = L'\\';
    if (quote) (*out)[(*len)++] = L'"';
    (*out)[*len] = 0;
}

/* An anonymous pipe. `child_read` says which end the child gets; the parent's end is not inheritable
   and, when it is the write end, non-blocking so that a full pipe never stalls the event loop. */
static int fg_make_pipe(int child_read, HANDLE *parent_end, HANDLE *child_end)
{
    SECURITY_ATTRIBUTES sa;
    HANDLE r, w;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&r, &w, &sa, FG_PIPE_CHUNK)) return -1;
    *child_end = child_read ? r : w;
    *parent_end = child_read ? w : r;
    SetHandleInformation(*parent_end, HANDLE_FLAG_INHERIT, 0);
    if (child_read) {
        DWORD nowait = PIPE_NOWAIT;
        SetNamedPipeHandleState(*parent_end, &nowait, NULL, NULL);
    }
    return 0;
}

static int fg_win_errno(DWORD e)
{
    switch (e) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_DRIVE:
        return ENOENT;
    case ERROR_ACCESS_DENIED:
        return EACCES;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
        return ENOMEM;
    default:
        return EINVAL;
    }
}

static JSValue fg_proc_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    char **args = NULL, **env = NULL;
    uint32_t nargs = 0, nenv = 0, i;
    wchar_t *cmd = NULL, *cwdw = NULL, *envblock = NULL;
    char *cwd;
    size_t len = 0, cap = 0;
    int mode[3], modefd[3], k, ipc, detached, err = 0, ids[3] = { -1, -1, -1 }, ipc_id = -1, proc;
    HANDLE child_h[3] = { NULL, NULL, NULL }, own_child[3] = { NULL, NULL, NULL };
    HANDLE parent_r[3] = { FG_NOH, FG_NOH, FG_NOH }, parent_w = FG_NOH;
    HANDLE ipc_parent_r = FG_NOH, ipc_parent_w = FG_NOH, ipc_child_r = NULL, ipc_child_w = NULL;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    JSValueConst opt = argc > 1 ? argv[1] : JS_UNDEFINED;
    JSValue result;
    char chan_in[40], chan_out[40];
    DWORD flags = CREATE_UNICODE_ENVIRONMENT;

    if (argc < 1 || !JS_IsArray(argv[0])) return JS_ThrowTypeError(ctx, "procSpawn(argv, options) expects an array");
    if (fg_str_array(ctx, argv[0], &args, &nargs) != 0 || nargs == 0) {
        fg_free_list(args, nargs);
        return JS_ThrowTypeError(ctx, "procSpawn: empty command");
    }
    cwd = fg_opt_string(ctx, opt, "cwd");
    ipc = fg_opt_bool(ctx, opt, "ipc");
    detached = fg_opt_bool(ctx, opt, "detached");
    for (k = 0; k < 3; k++) mode[k] = fg_parse_stdio(ctx, opt, k, &modefd[k]);
    if (JS_IsObject(opt)) {
        JSValue e = JS_GetPropertyStr(ctx, opt, "env");
        env = fg_env_list(ctx, e, &nenv);
        JS_FreeValue(ctx, e);
    }
    for (i = 0; i < nargs; i++) {
        wchar_t *w = fg_wide(args[i]);
        fg_quote(&cmd, &len, &cap, w);
        free(w);
    }

    for (k = 0; k < 3 && err == 0; k++) {
        if (mode[k] == FG_STDIO_PIPE) {
            HANDLE parent_end, child_end;
            if (fg_make_pipe(k == 0, &parent_end, &child_end) != 0) {
                err = ENOMEM;
                break;
            }
            child_h[k] = own_child[k] = child_end;
            if (k == 0) parent_w = parent_end;
            else parent_r[k] = parent_end;
        } else if (mode[k] == FG_STDIO_IGNORE) {
            SECURITY_ATTRIBUTES sa;
            sa.nLength = sizeof(sa);
            sa.lpSecurityDescriptor = NULL;
            sa.bInheritHandle = TRUE;
            child_h[k] = own_child[k] = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa,
                                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (child_h[k] == INVALID_HANDLE_VALUE) err = fg_win_errno(GetLastError());
        } else if (mode[k] == FG_STDIO_FD) {
            child_h[k] = (HANDLE) _get_osfhandle(modefd[k]);
            SetHandleInformation(child_h[k], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        } else {
            child_h[k] = GetStdHandle(k == 0 ? STD_INPUT_HANDLE : k == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
            if (child_h[k] != NULL && child_h[k] != INVALID_HANDLE_VALUE) {
                SetHandleInformation(child_h[k], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            }
        }
    }
    if (err == 0 && ipc) {
        HANDLE pe1, ce1, pe2, ce2;
        if (fg_make_pipe(1, &pe1, &ce1) != 0 || fg_make_pipe(0, &pe2, &ce2) != 0) {
            err = ENOMEM;
        } else {
            ipc_parent_w = pe1;
            ipc_child_r = ce1;
            ipc_parent_r = pe2;
            ipc_child_w = ce2;
            snprintf(chan_in, sizeof(chan_in), "NODE_CHANNEL_FD=%lu", (unsigned long) (ULONG_PTR) ce1);
            snprintf(chan_out, sizeof(chan_out), "GRAAK_CHANNEL_OUT=%lu", (unsigned long) (ULONG_PTR) ce2);
        }
    }

    /* The environment block: the given one plus the channel variables. When none was given, ours is copied. */
    if (err == 0 && (env || ipc)) {
        size_t total = 4, pos = 0;
        wchar_t *cur = NULL;
        uint32_t extra = ipc ? 3 : 0;
        if (!env) cur = GetEnvironmentStringsW();
        for (i = 0; i < nenv; i++) total += strlen(env[i]) + 1;
        if (cur) {
            wchar_t *p = cur;
            while (*p) p += wcslen(p) + 1;
            total += (size_t) (p - cur) + 1;
        }
        total += extra * 48 + 8;
        envblock = malloc(total * sizeof(wchar_t));
        if (!envblock) {
            err = ENOMEM;
        } else {
            for (i = 0; i < nenv; i++) {
                wchar_t *w = fg_wide(env[i]);
                wcscpy(envblock + pos, w);
                pos += wcslen(w) + 1;
                free(w);
            }
            if (cur) {
                wchar_t *p = cur;
                while (*p) {
                    size_t l = wcslen(p) + 1;
                    memcpy(envblock + pos, p, l * sizeof(wchar_t));
                    pos += l;
                    p += l;
                }
            }
            if (ipc) {
                const char *extras[3];
                int x;
                extras[0] = chan_in;
                extras[1] = chan_out;
                extras[2] = "NODE_CHANNEL_SERIALIZATION_MODE=json";
                for (x = 0; x < 3; x++) {
                    wchar_t *w = fg_wide(extras[x]);
                    wcscpy(envblock + pos, w);
                    pos += wcslen(w) + 1;
                    free(w);
                }
            }
            envblock[pos++] = 0;
            envblock[pos] = 0;
        }
        if (cur) FreeEnvironmentStringsW(cur);
    }
    if (cwd) cwdw = fg_wide(cwd);
    if (detached) flags |= DETACHED_PROCESS;

    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = child_h[0];
    si.hStdOutput = child_h[1];
    si.hStdError = child_h[2];
    memset(&pi, 0, sizeof(pi));
    proc = -1;
    if (err == 0) {
        if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, flags, envblock, cwdw, &si, &pi)) {
            err = fg_win_errno(GetLastError());
        } else {
            CloseHandle(pi.hThread);
            proc = fg_proc_alloc();
            if (proc < 0) {
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hProcess);
                err = EMFILE;
            } else {
                fg_procs[proc].h = pi.hProcess;
            }
        }
    }
    for (k = 0; k < 3; k++) if (own_child[k]) CloseHandle(own_child[k]);
    if (ipc_child_r) CloseHandle(ipc_child_r);
    if (ipc_child_w) CloseHandle(ipc_child_w);

    if (err == 0) {
        if (parent_w != FG_NOH) ids[0] = fg_pipe_alloc(FG_NOH, parent_w);
        for (k = 1; k < 3; k++) if (parent_r[k] != FG_NOH) ids[k] = fg_pipe_alloc(parent_r[k], FG_NOH);
        if (ipc_parent_r != FG_NOH) ipc_id = fg_pipe_alloc(ipc_parent_r, ipc_parent_w);
        result = fg_spawn_result(ctx, proc, (long) pi.dwProcessId, ids, ipc_id);
    } else {
        fg_close_h(parent_w);
        for (k = 1; k < 3; k++) fg_close_h(parent_r[k]);
        fg_close_h(ipc_parent_r);
        fg_close_h(ipc_parent_w);
        result = JS_NewInt32(ctx, -err);
    }
    free(cmd);
    free(cwdw);
    free(envblock);
    free(cwd);
    fg_free_list(env, nenv);
    fg_free_list(args, nargs);
    return result;
}

static int fg_proc_reap(fg_proc *p)
{
    DWORD code = 0;
    if (p->done) return 1;
    if (WaitForSingleObject(p->h, 0) != WAIT_OBJECT_0) return 0;
    GetExitCodeProcess(p->h, &code);
    p->done = 1;
    /* TerminateProcess is the only kill Windows has; like libuv, report it as the signal that was asked for. */
    p->status = p->signal ? -p->signal : (int) code;
    CloseHandle(p->h);
    p->h = NULL;
    return 1;
}

static JSValue fg_proc_kill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, sig = 15;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &sig, argv[1]);
    if (id < 0 || id >= FG_MAX_PROCS || !fg_procs[id].in_use || fg_procs[id].done) return JS_FALSE;
    if (sig == 0) return JS_NewBool(ctx, WaitForSingleObject(fg_procs[id].h, 0) == WAIT_TIMEOUT);
    if (!TerminateProcess(fg_procs[id].h, 1)) return JS_FALSE;
    fg_procs[id].signal = sig;
    return JS_TRUE;
}

/* 1 when the pipe has data to read or has ended, 0 when it is only empty. */
static int fg_pipe_ready(fg_h h, DWORD *avail)
{
    *avail = 0;
    if (!PeekNamedPipe(h, NULL, 0, NULL, avail, NULL)) return 1;
    return *avail > 0;
}

static JSValue fg_pipe_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, max = FG_PIPE_CHUNK;
    DWORD avail, got = 0;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &max, argv[1]);
    if (max <= 0 || max > FG_PIPE_CHUNK) max = FG_PIPE_CHUNK;
    if (id < 0 || id >= FG_MAX_PIPES || !fg_pipes[id].in_use || fg_pipes[id].r == FG_NOH) return JS_NULL;
    if (!PeekNamedPipe(fg_pipes[id].r, NULL, 0, NULL, &avail, NULL)) return JS_NULL; /* broken pipe: the writer is gone */
    if (avail == 0) return JS_UNDEFINED;
    if (avail > (DWORD) max) avail = (DWORD) max;
    if (!ReadFile(fg_pipes[id].r, fg_chunk, avail, &got, NULL) || got == 0) return JS_NULL;
    return JS_NewArrayBufferCopy(ctx, fg_chunk, got);
}

static JSValue fg_pipe_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, off = 0, len = 0;
    size_t size;
    uint8_t *buf;
    DWORD n = 0;
    if (argc < 4 || JS_ToInt32(ctx, &id, argv[0]) || JS_ToInt32(ctx, &off, argv[2]) || JS_ToInt32(ctx, &len, argv[3])) {
        return JS_ThrowTypeError(ctx, "pipeWrite(id, buffer, offset, length)");
    }
    buf = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (!buf) return JS_EXCEPTION;
    if (off < 0 || len < 0 || (size_t) off + (size_t) len > size) return JS_ThrowRangeError(ctx, "pipeWrite: out of range");
    if (id < 0 || id >= FG_MAX_PIPES || !fg_pipes[id].in_use || fg_pipes[id].w == FG_NOH) return JS_NewInt32(ctx, -1);
    if (len == 0) return JS_NewInt32(ctx, 0);
    /* A non-blocking write larger than the pipe can take at once is refused outright, so hand it over in pieces the pipe can hold. */
    if (len > FG_PIPE_CHUNK / 4) len = FG_PIPE_CHUNK / 4;
    if (!WriteFile(fg_pipes[id].w, buf + off, (DWORD) len, &n, NULL)) {
        DWORD e = GetLastError();
        return JS_NewInt32(ctx, (e == ERROR_NO_DATA || e == ERROR_BROKEN_PIPE || e == ERROR_PIPE_NOT_CONNECTED) ? -1 : 0);
    }
    return JS_NewInt32(ctx, (int32_t) n);
}

static JSValue fg_pipe_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    JSValue out = JS_NewArray(ctx);
    uint32_t n = 0, i, found = 0;
    int32_t ms = 0;
    DWORD start = GetTickCount();
    if (argc > 0 && JS_IsArray(argv[0])) {
        JSValue l = JS_GetPropertyStr(ctx, argv[0], "length");
        JS_ToUint32(ctx, &n, l);
        JS_FreeValue(ctx, l);
    }
    if (argc > 1) JS_ToInt32(ctx, &ms, argv[1]);
    for (;;) {
        for (i = 0; i < n; i++) {
            int32_t id;
            DWORD avail;
            JSValue v = JS_GetPropertyUint32(ctx, argv[0], i);
            JS_ToInt32(ctx, &id, v);
            JS_FreeValue(ctx, v);
            if (id >= 0 && id < FG_MAX_PIPES && fg_pipes[id].in_use && fg_pipes[id].r != FG_NOH &&
                fg_pipe_ready(fg_pipes[id].r, &avail)) {
                JS_SetPropertyUint32(ctx, out, found++, JS_NewInt32(ctx, id));
            }
        }
        if (found || (int32_t) (GetTickCount() - start) >= ms) break;
        Sleep(1);
    }
    return out;
}

static JSValue fg_channel_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *in = getenv("NODE_CHANNEL_FD"), *out = getenv("GRAAK_CHANNEL_OUT");
    HANDLE r, w;
    DWORD nowait = PIPE_NOWAIT, flags;
    if (!in || !*in) return JS_NewInt32(ctx, -1);
    r = (HANDLE) (ULONG_PTR) strtoul(in, NULL, 10);
    w = out && *out ? (HANDLE) (ULONG_PTR) strtoul(out, NULL, 10) : r;
    if (!GetHandleInformation(r, &flags) || !GetHandleInformation(w, &flags)) return JS_NewInt32(ctx, -1);
    SetHandleInformation(r, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(w, HANDLE_FLAG_INHERIT, 0);
    SetNamedPipeHandleState(w, &nowait, NULL, NULL);
    return JS_NewInt32(ctx, fg_pipe_alloc(r, w));
}
#endif

/* ================================================================== shared ================================ */

static JSValue fg_proc_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (id < 0 || id >= FG_MAX_PROCS || !fg_procs[id].in_use) return JS_NewInt32(ctx, 0);
    if (!fg_proc_reap(&fg_procs[id])) return JS_UNDEFINED;
    return JS_NewInt32(ctx, fg_procs[id].status);
}

static JSValue fg_proc_release(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (id >= 0 && id < FG_MAX_PROCS && fg_procs[id].in_use && fg_procs[id].done) fg_procs[id].in_use = 0;
    return JS_UNDEFINED;
}

static JSValue fg_pipe_close_js(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, which = 2;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &which, argv[1]);
    fg_pipe_close(id, which);
    return JS_UNDEFINED;
}

const JSCFunctionListEntry graak_proc_funcs[] = {
    JS_CFUNC_DEF("procSpawn", 2, fg_proc_spawn),
    JS_CFUNC_DEF("procPoll", 1, fg_proc_poll),
    JS_CFUNC_DEF("procKill", 2, fg_proc_kill),
    JS_CFUNC_DEF("procRelease", 1, fg_proc_release),
    JS_CFUNC_DEF("pipeRead", 2, fg_pipe_read),
    JS_CFUNC_DEF("pipeWrite", 4, fg_pipe_write),
    JS_CFUNC_DEF("pipeClose", 2, fg_pipe_close_js),
    JS_CFUNC_DEF("pipePoll", 2, fg_pipe_poll),
    JS_CFUNC_DEF("channelOpen", 0, fg_channel_open),
};
const size_t graak_proc_funcs_count = sizeof(graak_proc_funcs) / sizeof(graak_proc_funcs[0]);
