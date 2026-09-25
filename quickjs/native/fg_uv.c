/*
 * The libuv subset the Windows hosts export to Node-API addons.
 *
 * Addons in the Holepunch family, and others that pair Node-API with libuv, import libuv's functions by name from the
 * program that loads them (node.exe on Node.js, the Graak host here). On Linux the host gets that through napi.c; on
 * Windows this file supplies it, written against Win32 calls Windows XP already has: no SRW locks, condition
 * variables, InitOnce, GetTickCount64 or GetThreadId, so the same source serves XP, Vista, 7 and 32-bit builds. Where
 * the real libuv header lays a type out around a newer API (uv_rwlock_t, uv_cond_t), the fallback fields libuv itself
 * keeps for that purpose are used instead.
 *
 * Provided:
 *   loop      uv_default_loop, uv_loop_init/close/alive, uv_run, uv_stop, uv_now, uv_update_time, uv_backend_timeout
 *   handles   uv_close, uv_ref/unref/has_ref, uv_is_active/closing, uv_walk, uv_handle_get_* and uv_req_get_* helpers
 *   timers    uv_timer_init/start/stop/again/set_repeat/get_repeat/get_due_in
 *   async     uv_async_init/send; uv_idle_*, uv_prepare_*, uv_check_*
 *   work      uv_queue_work, uv_cancel (a four-thread pool)
 *   fs        uv_fs_open/close/read/write/unlink/mkdir/rmdir/rename/stat/lstat/fstat/fsync/ftruncate/req_cleanup
 *   threads   uv_mutex_*, uv_rwlock_*, uv_cond_*, uv_sem_*, uv_thread_*, uv_key_*, uv_once
 *   system    uv_hrtime, uv_cwd, uv_chdir, uv_exepath, uv_os_* (pid, ppid, hostname, homedir, tmpdir, env, uname,
 *             passwd), uv_available_parallelism, uv_get_*_memory, uv_sleep, uv_gettimeofday, uv_clock_gettime
 *   errors    uv_strerror, uv_err_name (+_r), uv_translate_sys_error, uv_buf_init, uv_version
 *
 * Not provided: sockets, pipes, TTYs, processes, signals, fs events, uv_barrier, the rest of uv_fs_* and uv_os_*.
 * An addon that needs them fails to bind and Windows names the missing function.
 *
 * The host's JavaScript loop drives the default loop: napi.c calls fg_uv_drain() from its pump, which runs one
 * non-blocking iteration, and holds the pump alive while the default loop has anything referenced. Other loops
 * (uv_loop_init) are self-contained and run by the addon's own uv_run.
 */

#ifdef _WIN32

#define BUILDING_UV_SHARED 1
#include <uv.h>

#include <errno.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tlhelp32.h>

/* ---- state ------------------------------------------------------------------------------- */

#define FG_ACTIVE 0x1u
#define FG_CLOSING 0x2u
#define FG_REF 0x4u

#define POOL_THREADS 4

typedef struct fg_lp {
    CRITICAL_SECTION lock;
    HANDLE wake;
    uv_req_t *done_head, *done_tail;
    uv_handle_t *closing;
    unsigned nreqs;
    unsigned running;
    int kick;
    int is_default;
    int live;
} fg_lp;

#define LP(loop) ((fg_lp *) (loop)->internal_fields)

static void (*g_host_inc)(void);
static void (*g_host_dec)(void);

static volatile LONG g_init_state;
static CRITICAL_SECTION g_once_lock;
static CRITICAL_SECTION g_pool_lock;
static HANDLE g_pool_sem;
static uv_req_t *g_pool_head, *g_pool_tail;
static int g_pool_threads;
static DWORD g_self_tls;
static LARGE_INTEGER g_qpc_freq;

static uv_loop_t g_default_loop;
static int g_default_ready;

static void fg_init(void)
{
    if (InterlockedCompareExchange(&g_init_state, 1, 0) == 0) {
        InitializeCriticalSection(&g_once_lock);
        InitializeCriticalSection(&g_pool_lock);
        g_self_tls = TlsAlloc();
        if (!QueryPerformanceFrequency(&g_qpc_freq)) g_qpc_freq.QuadPart = 0;
        g_pool_sem = CreateSemaphoreW(NULL, 0, 0x7fffffff, NULL);
        MemoryBarrier();
        g_init_state = 2;
    } else {
        while (g_init_state != 2) Sleep(0);
    }
}

void fg_uv_host(void (*inc)(void), void (*dec)(void))
{
    g_host_inc = inc;
    g_host_dec = dec;
}

/* ---- strings and errors ------------------------------------------------------------------ */

static WCHAR *to_wide(const char *s)
{
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
    WCHAR *w;
    if (n <= 0) return NULL;
    w = malloc((size_t) n * sizeof(WCHAR));
    if (w) MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
    return w;
}

/* Converts a UTF-16 string into caller storage. Returns 0, or UV_ENOBUFS with *size set to the room needed. */
static int wide_to_buf(const WCHAR *w, char *buf, size_t *size)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n <= 0) return UV_EINVAL;
    if ((size_t) n > *size) {
        *size = (size_t) n;
        return UV_ENOBUFS;
    }
    WideCharToMultiByte(CP_UTF8, 0, w, -1, buf, n, NULL, NULL);
    *size = (size_t) n - 1;
    return 0;
}

int uv_translate_sys_error(int e)
{
    if (e <= 0) return e;
    switch (e) {
    case ERROR_NOACCESS:
    case WSAEACCES:
    case ERROR_ELEVATION_REQUIRED:
    case ERROR_ACCESS_DENIED:
    case ERROR_WRITE_PROTECT:
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION: return UV_EACCES;
    case ERROR_ADDRESS_ALREADY_ASSOCIATED:
    case WSAEADDRINUSE: return UV_EADDRINUSE;
    case ERROR_BUFFER_OVERFLOW: return UV_ENOBUFS;
    case ERROR_PIPE_BUSY:
    case ERROR_BUSY: return UV_EBUSY;
    case ERROR_OPERATION_ABORTED: return UV_ECANCELED;
    case ERROR_ALREADY_EXISTS:
    case ERROR_FILE_EXISTS: return UV_EEXIST;
    case ERROR_BAD_PATHNAME:
    case ERROR_INVALID_PARAMETER:
    case ERROR_INVALID_NAME: return UV_EINVAL;
    case ERROR_TOO_MANY_OPEN_FILES: return UV_EMFILE;
    case ERROR_BAD_NETPATH:
    case ERROR_BAD_NET_NAME:
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: return UV_ENOENT;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY: return UV_ENOMEM;
    case ERROR_DIRECTORY: return UV_ENOTDIR;
    case ERROR_DIR_NOT_EMPTY: return UV_ENOTEMPTY;
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL: return UV_ENOSPC;
    case ERROR_NOT_SAME_DEVICE: return UV_EXDEV;
    case ERROR_INVALID_HANDLE: return UV_EBADF;
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA: return UV_EPIPE;
    case ERROR_CALL_NOT_IMPLEMENTED: return UV_ENOSYS;
    case ERROR_PRIVILEGE_NOT_HELD: return UV_EPERM;
    default: return UV_UNKNOWN;
    }
}

static int errno_to_uv(int e)
{
    switch (e) {
    case 0: return 0;
    case ENOENT: return UV_ENOENT;
    case EACCES: return UV_EACCES;
    case EEXIST: return UV_EEXIST;
    case EBADF: return UV_EBADF;
    case EINVAL: return UV_EINVAL;
    case ENOTDIR: return UV_ENOTDIR;
    case EISDIR: return UV_EISDIR;
    case EMFILE: return UV_EMFILE;
    case ENOMEM: return UV_ENOMEM;
    case ENOSPC: return UV_ENOSPC;
    case EPERM: return UV_EPERM;
    case ENOTEMPTY: return UV_ENOTEMPTY;
    case EAGAIN: return UV_EAGAIN;
    case EXDEV: return UV_EXDEV;
    case EBUSY: return UV_EBUSY;
    default: return UV_EIO;
    }
}

static int last_error_to_uv(void) { return uv_translate_sys_error((int) GetLastError()); }

const char *uv_err_name(int err)
{
    switch (err) {
#define XX(name, msg) case UV_##name: return #name;
    UV_ERRNO_MAP(XX)
#undef XX
    }
    return "Unknown system error";
}

const char *uv_strerror(int err)
{
    switch (err) {
#define XX(name, msg) case UV_##name: return msg;
    UV_ERRNO_MAP(XX)
#undef XX
    }
    return "Unknown system error";
}

char *uv_err_name_r(int err, char *buf, size_t buflen)
{
    if (buflen) snprintf(buf, buflen, "%s", uv_err_name(err));
    return buf;
}

char *uv_strerror_r(int err, char *buf, size_t buflen)
{
    if (buflen) snprintf(buf, buflen, "%s", uv_strerror(err));
    return buf;
}

uv_buf_t uv_buf_init(char *base, unsigned int len)
{
    uv_buf_t buf;
    buf.len = len;
    buf.base = base;
    return buf;
}

unsigned int uv_version(void) { return UV_VERSION_HEX; }

const char *uv_version_string(void) { return "1.48.0"; }

/* ---- time -------------------------------------------------------------------------------- */

uint64_t uv_hrtime(void)
{
    LARGE_INTEGER c;
    fg_init();
    if (g_qpc_freq.QuadPart && QueryPerformanceCounter(&c)) {
        uint64_t freq = (uint64_t) g_qpc_freq.QuadPart, v = (uint64_t) c.QuadPart;
        /* Split the multiplication so a long uptime cannot overflow 64 bits. */
        return (v / freq) * 1000000000ull + (v % freq) * 1000000000ull / freq;
    }
    return (uint64_t) GetTickCount() * 1000000ull;
}

void uv_sleep(unsigned int msec) { Sleep(msec); }

int uv_gettimeofday(uv_timeval64_t *tv)
{
    FILETIME ft;
    ULARGE_INTEGER u;
    uint64_t t;
    if (!tv) return UV_EINVAL;
    GetSystemTimeAsFileTime(&ft);
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    t = u.QuadPart - 116444736000000000ull;
    tv->tv_sec = (int64_t) (t / 10000000ull);
    tv->tv_usec = (int32_t) ((t % 10000000ull) / 10);
    return 0;
}

int uv_clock_gettime(uv_clock_id clock_id, uv_timespec64_t *ts)
{
    if (!ts) return UV_EINVAL;
    if (clock_id == UV_CLOCK_MONOTONIC) {
        uint64_t t = uv_hrtime();
        ts->tv_sec = (int64_t) (t / 1000000000ull);
        ts->tv_nsec = (int32_t) (t % 1000000000ull);
        return 0;
    } else if (clock_id == UV_CLOCK_REALTIME) {
        uv_timeval64_t tv;
        uv_gettimeofday(&tv);
        ts->tv_sec = tv.tv_sec;
        ts->tv_nsec = tv.tv_usec * 1000;
        return 0;
    }
    return UV_EINVAL;
}

/* ---- handle list ------------------------------------------------------------------------- */

static void q_init(struct uv__queue *q) { q->next = q; q->prev = q; }
static int q_empty(const struct uv__queue *q) { return q->next == q; }
static void q_insert_tail(struct uv__queue *h, struct uv__queue *q)
{
    q->next = h;
    q->prev = h->prev;
    q->prev->next = q;
    h->prev = q;
}
static void q_remove(struct uv__queue *q)
{
    q->prev->next = q->next;
    q->next->prev = q->prev;
    q->next = q->prev = q;
}

#define HANDLE_OF(q) ((uv_handle_t *) ((char *) (q) - offsetof(uv_handle_t, handle_queue)))

static void sync_live(uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    int alive;
    if (!st || !st->is_default || !g_host_inc) return;
    alive = loop->active_handles > 0 || st->nreqs > 0 || st->closing != NULL;
    if (alive && !st->live) {
        st->live = 1;
        g_host_inc();
    } else if (!alive && st->live) {
        st->live = 0;
        g_host_dec();
    }
}

/* ---- loop -------------------------------------------------------------------------------- */

static void update_time(uv_loop_t *loop) { loop->time = uv_hrtime() / 1000000ull; }

int uv_loop_init(uv_loop_t *loop)
{
    fg_lp *st;
    fg_init();
    memset(loop, 0, sizeof(*loop));
    st = calloc(1, sizeof(*st));
    if (!st) return UV_ENOMEM;
    InitializeCriticalSection(&st->lock);
    st->wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!st->wake) {
        free(st);
        return UV_ENOMEM;
    }
    q_init(&loop->handle_queue);
    loop->internal_fields = st;
    update_time(loop);
    return 0;
}

uv_loop_t *uv_default_loop(void)
{
    if (!g_default_ready) {
        if (uv_loop_init(&g_default_loop) != 0) return NULL;
        LP(&g_default_loop)->is_default = 1;
        g_default_ready = 1;
    }
    return &g_default_loop;
}

int uv_loop_close(uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    if (!q_empty(&loop->handle_queue) || st->nreqs || st->closing) return UV_EBUSY;
    CloseHandle(st->wake);
    DeleteCriticalSection(&st->lock);
    free(st);
    loop->internal_fields = NULL;
    if (loop == &g_default_loop) g_default_ready = 0;
    return 0;
}

int uv_loop_configure(uv_loop_t *loop, uv_loop_option option, ...)
{
    (void) loop;
    (void) option;
    return UV_ENOSYS;
}

int uv_loop_fork(uv_loop_t *loop) { (void) loop; return 0; }
size_t uv_loop_size(void) { return sizeof(uv_loop_t); }
void *uv_loop_get_data(const uv_loop_t *loop) { return loop->data; }
void uv_loop_set_data(uv_loop_t *loop, void *data) { loop->data = data; }
uint64_t uv_now(const uv_loop_t *loop) { return loop->time; }
void uv_update_time(uv_loop_t *loop) { update_time(loop); }
void uv_stop(uv_loop_t *loop) { loop->stop_flag = 1; }

int uv_loop_alive(const uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    return loop->active_handles > 0 || st->nreqs > 0 || st->closing != NULL;
}

static uv_timer_t *next_timer(uv_loop_t *loop)
{
    struct uv__queue *q;
    uv_timer_t *best = NULL;
    for (q = loop->handle_queue.next; q != &loop->handle_queue; q = q->next) {
        uv_handle_t *h = HANDLE_OF(q);
        uv_timer_t *t = (uv_timer_t *) h;
        if (h->type != UV_TIMER || !(h->flags & FG_ACTIVE) || (h->flags & FG_CLOSING)) continue;
        if (!best || t->timeout < best->timeout || (t->timeout == best->timeout && t->start_id < best->start_id)) best = t;
    }
    return best;
}

static void run_timers(uv_loop_t *loop)
{
    for (;;) {
        uv_timer_t *t = next_timer(loop);
        if (!t || t->timeout > loop->time) break;
        uv_timer_stop(t);
        uv_timer_again(t);
        t->timer_cb(t);
    }
}

/* idle, prepare and check are three lists of the same shape. */
static void run_watchers(uv_loop_t *loop, uv_handle_type type)
{
    struct uv__queue *q;
    for (q = loop->handle_queue.next; q != &loop->handle_queue; q = q->next) {
        uv_handle_t *h = HANDLE_OF(q);
        if (h->type != type || !(h->flags & FG_ACTIVE) || (h->flags & FG_CLOSING)) continue;
        if (type == UV_IDLE) ((uv_idle_t *) h)->idle_cb((uv_idle_t *) h);
        else if (type == UV_PREPARE) ((uv_prepare_t *) h)->prepare_cb((uv_prepare_t *) h);
        else ((uv_check_t *) h)->check_cb((uv_check_t *) h);
    }
}

static int has_active(uv_loop_t *loop, uv_handle_type type)
{
    struct uv__queue *q;
    for (q = loop->handle_queue.next; q != &loop->handle_queue; q = q->next) {
        uv_handle_t *h = HANDLE_OF(q);
        if (h->type == type && (h->flags & FG_ACTIVE) && !(h->flags & FG_CLOSING)) return 1;
    }
    return 0;
}

/* Delivers asyncs that were sent and requests the pool finished. */
static void run_pending(uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    struct uv__queue *q;
    uv_req_t *req;
    EnterCriticalSection(&st->lock);
    st->kick = 0;
    LeaveCriticalSection(&st->lock);
    for (q = loop->handle_queue.next; q != &loop->handle_queue; q = q->next) {
        uv_handle_t *h = HANDLE_OF(q);
        uv_async_t *a = (uv_async_t *) h;
        int sent;
        if (h->type != UV_ASYNC || (h->flags & FG_CLOSING)) continue;
        EnterCriticalSection(&st->lock);
        sent = a->async_sent;
        a->async_sent = 0;
        LeaveCriticalSection(&st->lock);
        if (sent && a->async_cb) a->async_cb(a);
    }
    for (;;) {
        EnterCriticalSection(&st->lock);
        req = st->done_head;
        if (req) {
            st->done_head = req->next_req;
            if (!st->done_head) st->done_tail = NULL;
        }
        LeaveCriticalSection(&st->lock);
        if (!req) break;
        st->nreqs--;
        if (req->type == UV_WORK) {
            uv_work_t *w = (uv_work_t *) req;
            if (w->after_work_cb) w->after_work_cb(w, req->reserved[0] ? UV_ECANCELED : 0);
        } else if (req->type == UV_FS) {
            uv_fs_t *f = (uv_fs_t *) req;
            if (req->reserved[0]) f->result = UV_ECANCELED;
            if (f->cb) f->cb(f);
        }
    }
}

static void run_closing(uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    while (st->closing) {
        uv_handle_t *h = st->closing;
        st->closing = h->endgame_next;
        q_remove(&h->handle_queue);
        if (h->close_cb) h->close_cb(h);
    }
}

int uv_backend_timeout(const uv_loop_t *cloop)
{
    uv_loop_t *loop = (uv_loop_t *) cloop;
    fg_lp *st = LP(loop);
    uv_timer_t *t;
    if (loop->stop_flag || !uv_loop_alive(loop)) return 0;
    if (st->closing || st->kick || has_active(loop, UV_IDLE)) return 0;
    t = next_timer(loop);
    if (t) return t->timeout > loop->time ? (int) (t->timeout - loop->time) : 0;
    return -1;
}

int uv_backend_fd(const uv_loop_t *loop) { (void) loop; return -1; }

int uv_run(uv_loop_t *loop, uv_run_mode mode)
{
    fg_lp *st = LP(loop);
    int r = uv_loop_alive(loop);
    st->running++;
    if (!r) update_time(loop);
    while (r && !loop->stop_flag) {
        int timeout;
        update_time(loop);
        run_timers(loop);
        run_pending(loop);
        run_watchers(loop, UV_IDLE);
        run_watchers(loop, UV_PREPARE);
        timeout = mode == UV_RUN_NOWAIT ? 0 : uv_backend_timeout(loop);
        if (timeout != 0) WaitForSingleObject(st->wake, timeout < 0 ? INFINITE : (DWORD) timeout);
        update_time(loop);
        run_pending(loop);
        run_watchers(loop, UV_CHECK);
        run_closing(loop);
        if (mode == UV_RUN_ONCE) {
            update_time(loop);
            run_timers(loop);
        }
        r = uv_loop_alive(loop);
        if (mode == UV_RUN_ONCE || mode == UV_RUN_NOWAIT) break;
    }
    loop->stop_flag = 0;
    st->running--;
    sync_live(loop);
    return r;
}

/* Called by the host's pump: one non-blocking turn of the default loop. Returns the number of things it did. */
int fg_uv_drain(void)
{
    fg_lp *st;
    if (!g_default_ready) return 0;
    st = LP(&g_default_loop);
    if (st->running) return 0;
    if (!uv_loop_alive(&g_default_loop) && !st->live) return 0;
    uv_run(&g_default_loop, UV_RUN_NOWAIT);
    return 0;
}

/* ---- handles and requests ---------------------------------------------------------------- */

size_t uv_handle_size(uv_handle_type type)
{
    switch (type) {
#define XX(uc, lc) case UV_##uc: return sizeof(uv_##lc##_t);
    UV_HANDLE_TYPE_MAP(XX)
#undef XX
    default: return (size_t) -1;
    }
}

size_t uv_req_size(uv_req_type type)
{
    switch (type) {
#define XX(uc, lc) case UV_##uc: return sizeof(uv_##lc##_t);
    UV_REQ_TYPE_MAP(XX)
#undef XX
    default: return (size_t) -1;
    }
}

const char *uv_handle_type_name(uv_handle_type type)
{
    switch (type) {
#define XX(uc, lc) case UV_##uc: return #lc;
    UV_HANDLE_TYPE_MAP(XX)
#undef XX
    default: return NULL;
    }
}

const char *uv_req_type_name(uv_req_type type)
{
    switch (type) {
#define XX(uc, lc) case UV_##uc: return #lc;
    UV_REQ_TYPE_MAP(XX)
#undef XX
    default: return NULL;
    }
}

uv_handle_type uv_handle_get_type(const uv_handle_t *h) { return h->type; }
void *uv_handle_get_data(const uv_handle_t *h) { return h->data; }
uv_loop_t *uv_handle_get_loop(const uv_handle_t *h) { return h->loop; }
void uv_handle_set_data(uv_handle_t *h, void *data) { h->data = data; }
void *uv_req_get_data(const uv_req_t *r) { return r->data; }
void uv_req_set_data(uv_req_t *r, void *data) { r->data = data; }
uv_req_type uv_req_get_type(const uv_req_t *r) { return r->type; }

static void handle_init(uv_loop_t *loop, uv_handle_t *h, uv_handle_type type)
{
    h->loop = loop;
    h->type = type;
    h->close_cb = NULL;
    h->flags = FG_REF;
    h->endgame_next = NULL;
    q_insert_tail(&loop->handle_queue, &h->handle_queue);
}

static void handle_start(uv_handle_t *h)
{
    if (h->flags & FG_ACTIVE) return;
    h->flags |= FG_ACTIVE;
    if (h->flags & FG_REF) h->loop->active_handles++;
    sync_live(h->loop);
}

static void handle_stop(uv_handle_t *h)
{
    if (!(h->flags & FG_ACTIVE)) return;
    h->flags &= ~FG_ACTIVE;
    if (h->flags & FG_REF) h->loop->active_handles--;
    sync_live(h->loop);
}

int uv_is_active(const uv_handle_t *h) { return (h->flags & FG_ACTIVE) && !(h->flags & FG_CLOSING); }
int uv_is_closing(const uv_handle_t *h) { return (h->flags & FG_CLOSING) != 0; }
int uv_has_ref(const uv_handle_t *h) { return (h->flags & FG_REF) != 0; }

void uv_ref(uv_handle_t *h)
{
    if (h->flags & FG_REF) return;
    h->flags |= FG_REF;
    if (h->flags & FG_ACTIVE) h->loop->active_handles++;
    sync_live(h->loop);
}

void uv_unref(uv_handle_t *h)
{
    if (!(h->flags & FG_REF)) return;
    h->flags &= ~FG_REF;
    if (h->flags & FG_ACTIVE) h->loop->active_handles--;
    sync_live(h->loop);
}

void uv_close(uv_handle_t *h, uv_close_cb cb)
{
    fg_lp *st = LP(h->loop);
    if (h->flags & FG_CLOSING) return;
    handle_stop(h);
    h->flags |= FG_CLOSING;
    h->close_cb = cb;
    h->endgame_next = st->closing;
    st->closing = h;
    sync_live(h->loop);
}

void uv_walk(uv_loop_t *loop, uv_walk_cb cb, void *arg)
{
    struct uv__queue *q = loop->handle_queue.next;
    while (q != &loop->handle_queue) {
        uv_handle_t *h = HANDLE_OF(q);
        q = q->next;
        if (!(h->flags & FG_CLOSING)) cb(h, arg);
    }
}

/* ---- timers ------------------------------------------------------------------------------ */

int uv_timer_init(uv_loop_t *loop, uv_timer_t *t)
{
    handle_init(loop, (uv_handle_t *) t, UV_TIMER);
    t->timer_cb = NULL;
    t->timeout = 0;
    t->repeat = 0;
    t->start_id = 0;
    return 0;
}

int uv_timer_start(uv_timer_t *t, uv_timer_cb cb, uint64_t timeout, uint64_t repeat)
{
    uv_loop_t *loop = t->loop;
    if ((t->flags & FG_CLOSING) || !cb) return UV_EINVAL;
    if (t->flags & FG_ACTIVE) uv_timer_stop(t);
    t->timer_cb = cb;
    t->timeout = loop->time + timeout;
    if (t->timeout < timeout) t->timeout = (uint64_t) -1;
    t->repeat = repeat;
    t->start_id = ++loop->timer_counter;
    handle_start((uv_handle_t *) t);
    return 0;
}

int uv_timer_stop(uv_timer_t *t)
{
    handle_stop((uv_handle_t *) t);
    return 0;
}

int uv_timer_again(uv_timer_t *t)
{
    if (!t->timer_cb) return UV_EINVAL;
    if (t->repeat) {
        uv_timer_stop(t);
        uv_timer_start(t, t->timer_cb, t->repeat, t->repeat);
    }
    return 0;
}

void uv_timer_set_repeat(uv_timer_t *t, uint64_t repeat) { t->repeat = repeat; }
uint64_t uv_timer_get_repeat(const uv_timer_t *t) { return t->repeat; }

uint64_t uv_timer_get_due_in(const uv_timer_t *t)
{
    if (!(t->flags & FG_ACTIVE)) return 0;
    return t->timeout > t->loop->time ? t->timeout - t->loop->time : 0;
}

/* ---- async, idle, prepare, check --------------------------------------------------------- */

int uv_async_init(uv_loop_t *loop, uv_async_t *a, uv_async_cb cb)
{
    handle_init(loop, (uv_handle_t *) a, UV_ASYNC);
    a->async_cb = cb;
    a->async_sent = 0;
    a->async_req.type = UV_REQ;
    handle_start((uv_handle_t *) a);
    return 0;
}

int uv_async_send(uv_async_t *a)
{
    fg_lp *st;
    if (a->flags & FG_CLOSING) return UV_EINVAL;
    st = LP(a->loop);
    EnterCriticalSection(&st->lock);
    a->async_sent = 1;
    st->kick = 1;
    LeaveCriticalSection(&st->lock);
    SetEvent(st->wake);
    return 0;
}

int uv_idle_init(uv_loop_t *loop, uv_idle_t *h)
{
    handle_init(loop, (uv_handle_t *) h, UV_IDLE);
    h->idle_cb = NULL;
    return 0;
}
int uv_idle_start(uv_idle_t *h, uv_idle_cb cb)
{
    if (h->flags & FG_ACTIVE) return 0;
    h->idle_cb = cb;
    handle_start((uv_handle_t *) h);
    return 0;
}
int uv_idle_stop(uv_idle_t *h) { handle_stop((uv_handle_t *) h); return 0; }

int uv_prepare_init(uv_loop_t *loop, uv_prepare_t *h)
{
    handle_init(loop, (uv_handle_t *) h, UV_PREPARE);
    h->prepare_cb = NULL;
    return 0;
}
int uv_prepare_start(uv_prepare_t *h, uv_prepare_cb cb)
{
    if (h->flags & FG_ACTIVE) return 0;
    h->prepare_cb = cb;
    handle_start((uv_handle_t *) h);
    return 0;
}
int uv_prepare_stop(uv_prepare_t *h) { handle_stop((uv_handle_t *) h); return 0; }

int uv_check_init(uv_loop_t *loop, uv_check_t *h)
{
    handle_init(loop, (uv_handle_t *) h, UV_CHECK);
    h->check_cb = NULL;
    return 0;
}
int uv_check_start(uv_check_t *h, uv_check_cb cb)
{
    if (h->flags & FG_ACTIVE) return 0;
    h->check_cb = cb;
    handle_start((uv_handle_t *) h);
    return 0;
}
int uv_check_stop(uv_check_t *h) { handle_stop((uv_handle_t *) h); return 0; }

/* ---- thread pool: uv_queue_work and asynchronous uv_fs_* --------------------------------- */

static void fs_execute(uv_fs_t *req);

static void req_done(uv_req_t *req, uv_loop_t *loop)
{
    fg_lp *st = LP(loop);
    EnterCriticalSection(&st->lock);
    req->next_req = NULL;
    if (st->done_tail) st->done_tail->next_req = req; else st->done_head = req;
    st->done_tail = req;
    st->kick = 1;
    LeaveCriticalSection(&st->lock);
    SetEvent(st->wake);
}

static DWORD WINAPI pool_main(LPVOID arg)
{
    (void) arg;
    for (;;) {
        uv_req_t *req;
        WaitForSingleObject(g_pool_sem, INFINITE);
        EnterCriticalSection(&g_pool_lock);
        req = g_pool_head;
        if (req) {
            g_pool_head = req->next_req;
            if (!g_pool_head) g_pool_tail = NULL;
        }
        LeaveCriticalSection(&g_pool_lock);
        if (!req) continue;
        if (req->type == UV_WORK) {
            uv_work_t *w = (uv_work_t *) req;
            w->work_cb(w);
            req_done(req, w->loop);
        } else {
            uv_fs_t *f = (uv_fs_t *) req;
            fs_execute(f);
            req_done(req, f->loop);
        }
    }
    return 0;
}

static int pool_submit(uv_req_t *req)
{
    fg_init();
    EnterCriticalSection(&g_pool_lock);
    if (g_pool_threads < POOL_THREADS) {
        HANDLE t = CreateThread(NULL, 0, pool_main, NULL, 0, NULL);
        if (t) {
            CloseHandle(t);
            g_pool_threads++;
        } else if (g_pool_threads == 0) {
            LeaveCriticalSection(&g_pool_lock);
            return UV_ENOMEM;
        }
    }
    req->next_req = NULL;
    if (g_pool_tail) g_pool_tail->next_req = req; else g_pool_head = req;
    g_pool_tail = req;
    LeaveCriticalSection(&g_pool_lock);
    ReleaseSemaphore(g_pool_sem, 1, NULL);
    return 0;
}

int uv_queue_work(uv_loop_t *loop, uv_work_t *req, uv_work_cb work_cb, uv_after_work_cb after_work_cb)
{
    int r;
    if (!work_cb) return UV_EINVAL;
    req->type = UV_WORK;
    req->loop = loop;
    req->work_cb = work_cb;
    req->after_work_cb = after_work_cb;
    req->reserved[0] = NULL;
    LP(loop)->nreqs++;
    r = pool_submit((uv_req_t *) req);
    if (r) {
        LP(loop)->nreqs--;
        return r;
    }
    sync_live(loop);
    return 0;
}

int uv_cancel(uv_req_t *req)
{
    uv_req_t *p, *prev = NULL;
    uv_loop_t *loop;
    if (req->type != UV_WORK && req->type != UV_FS) return UV_EINVAL;
    loop = req->type == UV_WORK ? ((uv_work_t *) req)->loop : ((uv_fs_t *) req)->loop;
    EnterCriticalSection(&g_pool_lock);
    for (p = g_pool_head; p && p != req; prev = p, p = p->next_req) {}
    if (p) {
        if (prev) prev->next_req = p->next_req; else g_pool_head = p->next_req;
        if (g_pool_tail == p) g_pool_tail = prev;
        req->reserved[0] = (void *) 1;
    }
    LeaveCriticalSection(&g_pool_lock);
    if (!p) return UV_EBUSY;
    /* The semaphore was already counted for this request; the worker that takes it finds the queue shorter and
       simply goes back to waiting. */
    req_done(req, loop);
    return 0;
}

/* ---- fs ---------------------------------------------------------------------------------- */

uv_fs_type uv_fs_get_type(const uv_fs_t *r) { return r->fs_type; }
ssize_t uv_fs_get_result(const uv_fs_t *r) { return r->result; }
int uv_fs_get_system_error(const uv_fs_t *r) { return (int) r->sys_errno_; }
void *uv_fs_get_ptr(const uv_fs_t *r) { return r->ptr; }
const char *uv_fs_get_path(const uv_fs_t *r) { return r->path; }
uv_stat_t *uv_fs_get_statbuf(uv_fs_t *r) { return &r->statbuf; }

#define FS_OWN_PATH 0x1
#define FS_OWN_NEWPATH 0x2
#define FS_OWN_BUFS 0x4

static void ft_to_ts(const FILETIME *ft, uv_timespec_t *ts)
{
    ULARGE_INTEGER u;
    uint64_t t;
    u.LowPart = ft->dwLowDateTime;
    u.HighPart = ft->dwHighDateTime;
    t = u.QuadPart >= 116444736000000000ull ? u.QuadPart - 116444736000000000ull : 0;
    ts->tv_sec = (long) (t / 10000000ull);
    ts->tv_nsec = (long) ((t % 10000000ull) * 100);
}

static void fill_stat(uv_stat_t *s, DWORD attrs, const FILETIME *c, const FILETIME *a, const FILETIME *m, uint64_t size,
                      uint64_t nlink, uint64_t ino, uint64_t dev)
{
    memset(s, 0, sizeof(*s));
    s->st_dev = dev;
    s->st_ino = ino;
    s->st_nlink = nlink ? nlink : 1;
    s->st_size = size;
    s->st_blksize = 4096;
    s->st_blocks = (size + 511) / 512;
    if (attrs & FILE_ATTRIBUTE_DIRECTORY) s->st_mode = 0040000 | 0777;
    else s->st_mode = 0100000 | ((attrs & FILE_ATTRIBUTE_READONLY) ? 0444 : 0666);
    ft_to_ts(a, &s->st_atim);
    ft_to_ts(m, &s->st_mtim);
    ft_to_ts(c, &s->st_ctim);
    s->st_birthtim = s->st_ctim;
}

static void fs_execute(uv_fs_t *req)
{
    ssize_t r = 0;
    WCHAR *path = NULL;
    if (req->flags & FS_OWN_PATH) {
        path = to_wide(req->path);
        if (!path) {
            req->result = UV_ENOMEM;
            return;
        }
    }
    switch (req->fs_type) {
    case UV_FS_OPEN: {
        int fd = _wopen(path, req->fs.info.file_flags | _O_BINARY, req->fs.info.mode);
        r = fd < 0 ? errno_to_uv(errno) : fd;
        break;
    }
    case UV_FS_CLOSE:
        r = _close(req->file.fd) < 0 ? errno_to_uv(errno) : 0;
        break;
    case UV_FS_READ:
    case UV_FS_WRITE: {
        HANDLE h = (HANDLE) _get_osfhandle(req->file.fd);
        unsigned i;
        int64_t off = req->fs.info.offset;
        if (h == INVALID_HANDLE_VALUE) {
            r = UV_EBADF;
            break;
        }
        for (i = 0; i < req->fs.info.nbufs && r >= 0; i++) {
            uv_buf_t *b = &req->fs.info.bufs[i];
            DWORD done = 0;
            OVERLAPPED ov;
            OVERLAPPED *pov = NULL;
            BOOL ok;
            if (off >= 0) {
                memset(&ov, 0, sizeof(ov));
                ov.Offset = (DWORD) (off & 0xffffffff);
                ov.OffsetHigh = (DWORD) ((uint64_t) off >> 32);
                pov = &ov;
            }
            ok = req->fs_type == UV_FS_READ ? ReadFile(h, b->base, (DWORD) b->len, &done, pov)
                                            : WriteFile(h, b->base, (DWORD) b->len, &done, pov);
            if (!ok && GetLastError() != ERROR_HANDLE_EOF) {
                r = last_error_to_uv();
                break;
            }
            r += done;
            if (off >= 0) off += done;
            if (done < b->len) break;
        }
        break;
    }
    case UV_FS_UNLINK:
        r = DeleteFileW(path) ? 0 : last_error_to_uv();
        break;
    case UV_FS_MKDIR:
        r = CreateDirectoryW(path, NULL) ? 0 : last_error_to_uv();
        break;
    case UV_FS_RMDIR:
        r = RemoveDirectoryW(path) ? 0 : last_error_to_uv();
        break;
    case UV_FS_RENAME:
        r = MoveFileExW(path, req->fs.info.new_pathw, MOVEFILE_REPLACE_EXISTING) ? 0 : last_error_to_uv();
        break;
    case UV_FS_STAT:
    case UV_FS_LSTAT: {
        WIN32_FILE_ATTRIBUTE_DATA d;
        if (!GetFileAttributesExW(path, GetFileExInfoStandard, &d)) {
            r = last_error_to_uv();
            break;
        }
        fill_stat(&req->statbuf, d.dwFileAttributes, &d.ftCreationTime, &d.ftLastAccessTime, &d.ftLastWriteTime,
                  ((uint64_t) d.nFileSizeHigh << 32) | d.nFileSizeLow, 1, 0, 0);
        req->ptr = &req->statbuf;
        break;
    }
    case UV_FS_FSTAT: {
        BY_HANDLE_FILE_INFORMATION i;
        HANDLE h = (HANDLE) _get_osfhandle(req->file.fd);
        if (h == INVALID_HANDLE_VALUE) {
            r = UV_EBADF;
            break;
        }
        if (!GetFileInformationByHandle(h, &i)) {
            r = last_error_to_uv();
            break;
        }
        fill_stat(&req->statbuf, i.dwFileAttributes, &i.ftCreationTime, &i.ftLastAccessTime, &i.ftLastWriteTime,
                  ((uint64_t) i.nFileSizeHigh << 32) | i.nFileSizeLow, i.nNumberOfLinks,
                  ((uint64_t) i.nFileIndexHigh << 32) | i.nFileIndexLow, i.dwVolumeSerialNumber);
        req->ptr = &req->statbuf;
        break;
    }
    case UV_FS_FSYNC:
    case UV_FS_FDATASYNC: {
        HANDLE h = (HANDLE) _get_osfhandle(req->file.fd);
        r = h != INVALID_HANDLE_VALUE && FlushFileBuffers(h) ? 0 : (h == INVALID_HANDLE_VALUE ? UV_EBADF : last_error_to_uv());
        break;
    }
    case UV_FS_FTRUNCATE: {
        HANDLE h = (HANDLE) _get_osfhandle(req->file.fd);
        LARGE_INTEGER to;
        to.QuadPart = req->fs.info.offset;
        if (h == INVALID_HANDLE_VALUE) r = UV_EBADF;
        else r = SetFilePointerEx(h, to, NULL, FILE_BEGIN) && SetEndOfFile(h) ? 0 : last_error_to_uv();
        break;
    }
    default: r = UV_ENOSYS;
    }
    free(path);
    req->result = r;
}

static int fs_submit(uv_loop_t *loop, uv_fs_t *req, uv_fs_type type, uv_fs_cb cb)
{
    req->type = UV_FS;
    req->reserved[0] = NULL;
    req->fs_type = type;
    req->loop = loop;
    req->cb = cb;
    req->result = 0;
    req->ptr = NULL;
    if (!cb) {
        fs_execute(req);
        return (int) req->result;
    }
    LP(loop)->nreqs++;
    {
        int r = pool_submit((uv_req_t *) req);
        if (r) {
            LP(loop)->nreqs--;
            return r;
        }
    }
    sync_live(loop);
    return 0;
}

static void fs_prepare(uv_fs_t *req)
{
    req->flags = 0;
    req->path = NULL;
    req->fs.info.new_pathw = NULL;
    req->fs.info.bufs = NULL;
    req->fs.info.nbufs = 0;
    req->fs.info.offset = -1;
}

static int fs_set_path(uv_fs_t *req, const char *path)
{
    char *copy;
    if (!path) return UV_EINVAL;
    copy = _strdup(path);
    if (!copy) return UV_ENOMEM;
    req->path = copy;
    req->flags |= FS_OWN_PATH;
    return 0;
}

static int fs_path_op(uv_loop_t *loop, uv_fs_t *req, uv_fs_type type, const char *path, uv_fs_cb cb)
{
    int r;
    fs_prepare(req);
    r = fs_set_path(req, path);
    if (r) return r;
    return fs_submit(loop, req, type, cb);
}

int uv_fs_open(uv_loop_t *loop, uv_fs_t *req, const char *path, int flags, int mode, uv_fs_cb cb)
{
    int r;
    fs_prepare(req);
    r = fs_set_path(req, path);
    if (r) return r;
    req->fs.info.file_flags = flags;
    req->fs.info.mode = mode;
    return fs_submit(loop, req, UV_FS_OPEN, cb);
}

int uv_fs_close(uv_loop_t *loop, uv_fs_t *req, uv_file file, uv_fs_cb cb)
{
    fs_prepare(req);
    req->file.fd = file;
    return fs_submit(loop, req, UV_FS_CLOSE, cb);
}

static int fs_transfer(uv_loop_t *loop, uv_fs_t *req, uv_fs_type type, uv_file file, const uv_buf_t bufs[],
                       unsigned int nbufs, int64_t offset, uv_fs_cb cb)
{
    fs_prepare(req);
    if (!bufs || !nbufs) return UV_EINVAL;
    req->file.fd = file;
    req->fs.info.nbufs = nbufs;
    req->fs.info.offset = offset;
    if (nbufs > ARRAYSIZE(req->fs.info.bufsml)) {
        req->fs.info.bufs = malloc(sizeof(uv_buf_t) * nbufs);
        if (!req->fs.info.bufs) return UV_ENOMEM;
        req->flags |= FS_OWN_BUFS;
    } else {
        req->fs.info.bufs = req->fs.info.bufsml;
    }
    memcpy(req->fs.info.bufs, bufs, sizeof(uv_buf_t) * nbufs);
    return fs_submit(loop, req, type, cb);
}

int uv_fs_read(uv_loop_t *loop, uv_fs_t *req, uv_file file, const uv_buf_t bufs[], unsigned int nbufs, int64_t offset,
               uv_fs_cb cb)
{
    return fs_transfer(loop, req, UV_FS_READ, file, bufs, nbufs, offset, cb);
}

int uv_fs_write(uv_loop_t *loop, uv_fs_t *req, uv_file file, const uv_buf_t bufs[], unsigned int nbufs, int64_t offset,
                uv_fs_cb cb)
{
    return fs_transfer(loop, req, UV_FS_WRITE, file, bufs, nbufs, offset, cb);
}

int uv_fs_unlink(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    return fs_path_op(loop, req, UV_FS_UNLINK, path, cb);
}

int uv_fs_mkdir(uv_loop_t *loop, uv_fs_t *req, const char *path, int mode, uv_fs_cb cb)
{
    (void) mode;
    return fs_path_op(loop, req, UV_FS_MKDIR, path, cb);
}

int uv_fs_rmdir(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    return fs_path_op(loop, req, UV_FS_RMDIR, path, cb);
}

int uv_fs_stat(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    return fs_path_op(loop, req, UV_FS_STAT, path, cb);
}

int uv_fs_lstat(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    return fs_path_op(loop, req, UV_FS_LSTAT, path, cb);
}

int uv_fs_rename(uv_loop_t *loop, uv_fs_t *req, const char *path, const char *new_path, uv_fs_cb cb)
{
    int r;
    fs_prepare(req);
    r = fs_set_path(req, path);
    if (r) return r;
    if (!new_path) return UV_EINVAL;
    req->fs.info.new_pathw = to_wide(new_path);
    if (!req->fs.info.new_pathw) return UV_ENOMEM;
    req->flags |= FS_OWN_NEWPATH;
    return fs_submit(loop, req, UV_FS_RENAME, cb);
}

int uv_fs_fstat(uv_loop_t *loop, uv_fs_t *req, uv_file file, uv_fs_cb cb)
{
    fs_prepare(req);
    req->file.fd = file;
    return fs_submit(loop, req, UV_FS_FSTAT, cb);
}

int uv_fs_fsync(uv_loop_t *loop, uv_fs_t *req, uv_file file, uv_fs_cb cb)
{
    fs_prepare(req);
    req->file.fd = file;
    return fs_submit(loop, req, UV_FS_FSYNC, cb);
}

int uv_fs_ftruncate(uv_loop_t *loop, uv_fs_t *req, uv_file file, int64_t offset, uv_fs_cb cb)
{
    fs_prepare(req);
    req->file.fd = file;
    req->fs.info.offset = offset;
    return fs_submit(loop, req, UV_FS_FTRUNCATE, cb);
}

void uv_fs_req_cleanup(uv_fs_t *req)
{
    if (req->flags & FS_OWN_PATH) free((void *) req->path);
    if (req->flags & FS_OWN_NEWPATH) free(req->fs.info.new_pathw);
    if (req->flags & FS_OWN_BUFS) free(req->fs.info.bufs);
    req->flags = 0;
    req->path = NULL;
    req->fs.info.new_pathw = NULL;
    req->fs.info.bufs = NULL;
}

/* ---- threads and synchronisation --------------------------------------------------------- */

int uv_mutex_init(uv_mutex_t *m) { InitializeCriticalSection(m); return 0; }
int uv_mutex_init_recursive(uv_mutex_t *m) { InitializeCriticalSection(m); return 0; }
void uv_mutex_destroy(uv_mutex_t *m) { DeleteCriticalSection(m); }
void uv_mutex_lock(uv_mutex_t *m) { EnterCriticalSection(m); }
int uv_mutex_trylock(uv_mutex_t *m) { return TryEnterCriticalSection(m) ? 0 : UV_EBUSY; }
void uv_mutex_unlock(uv_mutex_t *m) { LeaveCriticalSection(m); }

/* A reader/writer lock over a critical section and a semaphore, the layout libuv's own pre-Vista fallback used. */
typedef struct {
    LONG readers;
    CRITICAL_SECTION readers_lock;
    HANDLE write_sem;
} fg_rwlock;

int uv_rwlock_init(uv_rwlock_t *rw)
{
    fg_rwlock *l = (fg_rwlock *) rw;
    l->write_sem = CreateSemaphoreW(NULL, 1, 1, NULL);
    if (!l->write_sem) return UV_ENOMEM;
    l->readers = 0;
    InitializeCriticalSection(&l->readers_lock);
    return 0;
}

void uv_rwlock_destroy(uv_rwlock_t *rw)
{
    fg_rwlock *l = (fg_rwlock *) rw;
    DeleteCriticalSection(&l->readers_lock);
    CloseHandle(l->write_sem);
}

void uv_rwlock_rdlock(uv_rwlock_t *rw)
{
    fg_rwlock *l = (fg_rwlock *) rw;
    EnterCriticalSection(&l->readers_lock);
    if (++l->readers == 1) WaitForSingleObject(l->write_sem, INFINITE);
    LeaveCriticalSection(&l->readers_lock);
}

int uv_rwlock_tryrdlock(uv_rwlock_t *rw)
{
    fg_rwlock *l = (fg_rwlock *) rw;
    int r = 0;
    if (!TryEnterCriticalSection(&l->readers_lock)) return UV_EBUSY;
    if (l->readers == 0) {
        if (WaitForSingleObject(l->write_sem, 0) == WAIT_OBJECT_0) l->readers = 1;
        else r = UV_EBUSY;
    } else {
        l->readers++;
    }
    LeaveCriticalSection(&l->readers_lock);
    return r;
}

void uv_rwlock_rdunlock(uv_rwlock_t *rw)
{
    fg_rwlock *l = (fg_rwlock *) rw;
    EnterCriticalSection(&l->readers_lock);
    if (--l->readers == 0) ReleaseSemaphore(l->write_sem, 1, NULL);
    LeaveCriticalSection(&l->readers_lock);
}

void uv_rwlock_wrlock(uv_rwlock_t *rw) { WaitForSingleObject(((fg_rwlock *) rw)->write_sem, INFINITE); }

int uv_rwlock_trywrlock(uv_rwlock_t *rw)
{
    return WaitForSingleObject(((fg_rwlock *) rw)->write_sem, 0) == WAIT_OBJECT_0 ? 0 : UV_EBUSY;
}

void uv_rwlock_wrunlock(uv_rwlock_t *rw) { ReleaseSemaphore(((fg_rwlock *) rw)->write_sem, 1, NULL); }

/* Condition variable from two events (signal wakes one waiter, broadcast wakes all): the fields libuv keeps in
   uv_cond_t for systems without CONDITION_VARIABLE. */
int uv_cond_init(uv_cond_t *c)
{
    c->unused_.waiters_count = 0;
    InitializeCriticalSection(&c->unused_.waiters_count_lock);
    c->unused_.signal_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    c->unused_.broadcast_event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!c->unused_.signal_event || !c->unused_.broadcast_event) return UV_ENOMEM;
    return 0;
}

void uv_cond_destroy(uv_cond_t *c)
{
    CloseHandle(c->unused_.signal_event);
    CloseHandle(c->unused_.broadcast_event);
    DeleteCriticalSection(&c->unused_.waiters_count_lock);
}

void uv_cond_signal(uv_cond_t *c)
{
    int waiters;
    EnterCriticalSection(&c->unused_.waiters_count_lock);
    waiters = c->unused_.waiters_count > 0;
    LeaveCriticalSection(&c->unused_.waiters_count_lock);
    if (waiters) SetEvent(c->unused_.signal_event);
}

void uv_cond_broadcast(uv_cond_t *c)
{
    int waiters;
    EnterCriticalSection(&c->unused_.waiters_count_lock);
    waiters = c->unused_.waiters_count > 0;
    LeaveCriticalSection(&c->unused_.waiters_count_lock);
    if (waiters) SetEvent(c->unused_.broadcast_event);
}

static int cond_wait(uv_cond_t *c, uv_mutex_t *m, DWORD ms)
{
    HANDLE events[2];
    DWORD r;
    int last;
    events[0] = c->unused_.signal_event;
    events[1] = c->unused_.broadcast_event;
    EnterCriticalSection(&c->unused_.waiters_count_lock);
    c->unused_.waiters_count++;
    LeaveCriticalSection(&c->unused_.waiters_count_lock);
    LeaveCriticalSection(m);
    r = WaitForMultipleObjects(2, events, FALSE, ms);
    EnterCriticalSection(&c->unused_.waiters_count_lock);
    c->unused_.waiters_count--;
    last = r == WAIT_OBJECT_0 + 1 && c->unused_.waiters_count == 0;
    LeaveCriticalSection(&c->unused_.waiters_count_lock);
    if (last) ResetEvent(c->unused_.broadcast_event);
    EnterCriticalSection(m);
    return r == WAIT_OBJECT_0 || r == WAIT_OBJECT_0 + 1 ? 0 : (r == WAIT_TIMEOUT ? UV_ETIMEDOUT : UV_EINVAL);
}

void uv_cond_wait(uv_cond_t *c, uv_mutex_t *m) { cond_wait(c, m, INFINITE); }

int uv_cond_timedwait(uv_cond_t *c, uv_mutex_t *m, uint64_t timeout)
{
    uint64_t ms = timeout / 1000000ull;
    return cond_wait(c, m, ms >= INFINITE ? INFINITE - 1 : (DWORD) ms);
}

int uv_sem_init(uv_sem_t *s, unsigned int value)
{
    *s = CreateSemaphoreW(NULL, (LONG) value, 0x7fffffff, NULL);
    return *s ? 0 : last_error_to_uv();
}
void uv_sem_destroy(uv_sem_t *s) { CloseHandle(*s); }
void uv_sem_post(uv_sem_t *s) { ReleaseSemaphore(*s, 1, NULL); }
void uv_sem_wait(uv_sem_t *s) { WaitForSingleObject(*s, INFINITE); }
int uv_sem_trywait(uv_sem_t *s) { return WaitForSingleObject(*s, 0) == WAIT_OBJECT_0 ? 0 : UV_EAGAIN; }

void uv_once(uv_once_t *guard, void (*callback)(void))
{
    fg_init();
    if (guard->ran) return;
    /* The critical section is recursive, so a callback that reaches another uv_once does not deadlock itself. */
    EnterCriticalSection(&g_once_lock);
    if (!guard->ran) {
        callback();
        guard->ran = 1;
    }
    LeaveCriticalSection(&g_once_lock);
}

typedef struct {
    uv_thread_cb entry;
    void *arg;
    HANDLE self;
} fg_thread_pack;

static DWORD WINAPI thread_main(LPVOID p)
{
    fg_thread_pack pack = *(fg_thread_pack *) p;
    free(p);
    TlsSetValue(g_self_tls, pack.self);
    pack.entry(pack.arg);
    return 0;
}

int uv_thread_create_ex(uv_thread_t *tid, const uv_thread_options_t *params, uv_thread_cb entry, void *arg)
{
    fg_thread_pack *pack;
    HANDLE h;
    size_t stack = 0;
    fg_init();
    if (params && (params->flags & UV_THREAD_HAS_STACK_SIZE)) stack = params->stack_size;
    pack = malloc(sizeof(*pack));
    if (!pack) return UV_ENOMEM;
    pack->entry = entry;
    pack->arg = arg;
    pack->self = NULL;
    /* Created suspended so the thread can be told its own handle before it runs, which is what uv_thread_self and
       uv_thread_equal compare, and which GetThreadId (Vista and later) would otherwise be needed for. */
    h = CreateThread(NULL, stack, thread_main, pack, CREATE_SUSPENDED, NULL);
    if (!h) {
        free(pack);
        return UV_EAGAIN;
    }
    pack->self = h;
    *tid = h;
    ResumeThread(h);
    return 0;
}

int uv_thread_create(uv_thread_t *tid, uv_thread_cb entry, void *arg)
{
    return uv_thread_create_ex(tid, NULL, entry, arg);
}

uv_thread_t uv_thread_self(void)
{
    HANDLE h;
    fg_init();
    h = (HANDLE) TlsGetValue(g_self_tls);
    if (!h) {
        if (!DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &h, 0, FALSE,
                             DUPLICATE_SAME_ACCESS))
            return NULL;
        TlsSetValue(g_self_tls, h);
    }
    return h;
}

int uv_thread_join(uv_thread_t *tid)
{
    if (WaitForSingleObject(*tid, INFINITE) != WAIT_OBJECT_0) return last_error_to_uv();
    CloseHandle(*tid);
    *tid = NULL;
    return 0;
}

int uv_thread_equal(const uv_thread_t *a, const uv_thread_t *b) { return *a == *b; }

int uv_key_create(uv_key_t *key)
{
    key->tls_index = TlsAlloc();
    return key->tls_index == TLS_OUT_OF_INDEXES ? UV_ENOMEM : 0;
}
void uv_key_delete(uv_key_t *key) { TlsFree(key->tls_index); }
void *uv_key_get(uv_key_t *key) { return TlsGetValue(key->tls_index); }
void uv_key_set(uv_key_t *key, void *value) { TlsSetValue(key->tls_index, value); }

/* ---- operating system -------------------------------------------------------------------- */

int uv_cwd(char *buffer, size_t *size)
{
    WCHAR tmp[MAX_PATH * 2];
    DWORD n;
    if (!buffer || !size) return UV_EINVAL;
    n = GetCurrentDirectoryW((DWORD) (sizeof(tmp) / sizeof(tmp[0])), tmp);
    if (n == 0) return last_error_to_uv();
    if (n >= sizeof(tmp) / sizeof(tmp[0])) return UV_ENOBUFS;
    /* Drop a trailing separator except on a drive root, as libuv does. */
    if (n > 3 && tmp[n - 1] == L'\\') tmp[n - 1] = 0;
    return wide_to_buf(tmp, buffer, size);
}

int uv_chdir(const char *dir)
{
    WCHAR *w = to_wide(dir);
    BOOL ok;
    if (!w) return UV_ENOMEM;
    ok = SetCurrentDirectoryW(w);
    free(w);
    return ok ? 0 : last_error_to_uv();
}

int uv_exepath(char *buffer, size_t *size)
{
    WCHAR tmp[MAX_PATH * 2];
    DWORD n;
    if (!buffer || !size || !*size) return UV_EINVAL;
    n = GetModuleFileNameW(NULL, tmp, (DWORD) (sizeof(tmp) / sizeof(tmp[0])));
    if (n == 0) return last_error_to_uv();
    return wide_to_buf(tmp, buffer, size);
}

uv_pid_t uv_os_getpid(void) { return (uv_pid_t) GetCurrentProcessId(); }

uv_pid_t uv_os_getppid(void)
{
    DWORD self = GetCurrentProcessId();
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W pe;
    uv_pid_t parent = -1;
    if (snap == INVALID_HANDLE_VALUE) return -1;
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == self) {
                parent = (uv_pid_t) pe.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return parent;
}

int uv_os_gethostname(char *buffer, size_t *size)
{
    WCHAR name[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD n = MAX_COMPUTERNAME_LENGTH + 1;
    if (!buffer || !size) return UV_EINVAL;
    if (!GetComputerNameW(name, &n)) return last_error_to_uv();
    return wide_to_buf(name, buffer, size);
}

int uv_os_getenv(const char *name, char *buffer, size_t *size)
{
    WCHAR *wn, *val;
    DWORD n;
    int r;
    if (!name || !buffer || !size || !*size) return UV_EINVAL;
    wn = to_wide(name);
    if (!wn) return UV_ENOMEM;
    n = GetEnvironmentVariableW(wn, NULL, 0);
    if (n == 0) {
        free(wn);
        return GetLastError() == ERROR_ENVVAR_NOT_FOUND ? UV_ENOENT : last_error_to_uv();
    }
    val = malloc((size_t) n * sizeof(WCHAR));
    if (!val) {
        free(wn);
        return UV_ENOMEM;
    }
    GetEnvironmentVariableW(wn, val, n);
    r = wide_to_buf(val, buffer, size);
    free(wn);
    free(val);
    return r;
}

int uv_os_setenv(const char *name, const char *value)
{
    WCHAR *wn, *wv;
    BOOL ok;
    if (!name || !value) return UV_EINVAL;
    wn = to_wide(name);
    wv = to_wide(value);
    if (!wn || !wv) {
        free(wn);
        free(wv);
        return UV_ENOMEM;
    }
    ok = SetEnvironmentVariableW(wn, wv);
    free(wn);
    free(wv);
    return ok ? 0 : last_error_to_uv();
}

int uv_os_unsetenv(const char *name)
{
    WCHAR *wn;
    BOOL ok;
    if (!name) return UV_EINVAL;
    wn = to_wide(name);
    if (!wn) return UV_ENOMEM;
    ok = SetEnvironmentVariableW(wn, NULL);
    free(wn);
    return ok ? 0 : last_error_to_uv();
}

int uv_os_homedir(char *buffer, size_t *size)
{
    int r;
    if (!buffer || !size || !*size) return UV_EINVAL;
    r = uv_os_getenv("USERPROFILE", buffer, size);
    if (r != UV_ENOENT) return r;
    {
        WCHAR dir[MAX_PATH];
        DWORD n = MAX_PATH;
        HANDLE token;
        typedef BOOL(WINAPI * profile_fn)(HANDLE, LPWSTR, LPDWORD);
        HMODULE lib = LoadLibraryW(L"userenv.dll");
        profile_fn fn = lib ? (profile_fn) GetProcAddress(lib, "GetUserProfileDirectoryW") : NULL;
        r = UV_ENOENT;
        if (fn && OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
            if (fn(token, dir, &n)) r = wide_to_buf(dir, buffer, size);
            CloseHandle(token);
        }
        if (lib) FreeLibrary(lib);
    }
    return r;
}

int uv_os_tmpdir(char *buffer, size_t *size)
{
    WCHAR tmp[MAX_PATH + 2];
    DWORD n;
    if (!buffer || !size || !*size) return UV_EINVAL;
    n = GetTempPathW(MAX_PATH + 1, tmp);
    if (n == 0) return last_error_to_uv();
    if (n > MAX_PATH) return UV_ENOBUFS;
    if (n > 3 && tmp[n - 1] == L'\\' && tmp[n - 2] != L':') tmp[n - 1] = 0;
    return wide_to_buf(tmp, buffer, size);
}

int uv_os_uname(uv_utsname_t *buffer)
{
    OSVERSIONINFOW v;
    SYSTEM_INFO si;
    if (!buffer) return UV_EINVAL;
    memset(&v, 0, sizeof(v));
    v.dwOSVersionInfoSize = sizeof(v);
    GetVersionExW(&v);
    GetNativeSystemInfo(&si);
    snprintf(buffer->sysname, sizeof(buffer->sysname), "Windows_NT");
    snprintf(buffer->release, sizeof(buffer->release), "%u.%u.%u", (unsigned) v.dwMajorVersion,
             (unsigned) v.dwMinorVersion, (unsigned) v.dwBuildNumber);
    snprintf(buffer->version, sizeof(buffer->version), "Windows NT %u.%u Build %u", (unsigned) v.dwMajorVersion,
             (unsigned) v.dwMinorVersion, (unsigned) v.dwBuildNumber);
    snprintf(buffer->machine, sizeof(buffer->machine), "%s",
             si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x86_64"
             : si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM  ? "arm"
                                                                        : "i386");
    return 0;
}

int uv_os_get_passwd(uv_passwd_t *pwd)
{
    WCHAR user[256];
    DWORD n = 256;
    char home[MAX_PATH * 3];
    size_t hsize = sizeof(home), usize = 0;
    char *mem;
    int r;
    if (!pwd) return UV_EINVAL;
    if (!GetUserNameW(user, &n)) return last_error_to_uv();
    r = uv_os_homedir(home, &hsize);
    if (r) return r;
    usize = (size_t) WideCharToMultiByte(CP_UTF8, 0, user, -1, NULL, 0, NULL, NULL);
    mem = malloc(usize + hsize + 1);
    if (!mem) return UV_ENOMEM;
    WideCharToMultiByte(CP_UTF8, 0, user, -1, mem, (int) usize, NULL, NULL);
    memcpy(mem + usize, home, hsize + 1);
    pwd->username = mem;
    pwd->homedir = mem + usize;
    pwd->shell = NULL;
    pwd->uid = (unsigned long) -1;
    pwd->gid = (unsigned long) -1;
    return 0;
}

void uv_os_free_passwd(uv_passwd_t *pwd)
{
    if (!pwd) return;
    free(pwd->username);
    pwd->username = NULL;
    pwd->homedir = NULL;
}

unsigned int uv_available_parallelism(void)
{
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return si.dwNumberOfProcessors ? si.dwNumberOfProcessors : 1;
}

uint64_t uv_get_total_memory(void)
{
    MEMORYSTATUSEX m;
    m.dwLength = sizeof(m);
    return GlobalMemoryStatusEx(&m) ? m.ullTotalPhys : 0;
}

uint64_t uv_get_free_memory(void)
{
    MEMORYSTATUSEX m;
    m.dwLength = sizeof(m);
    return GlobalMemoryStatusEx(&m) ? m.ullAvailPhys : 0;
}

#endif /* _WIN32 */
