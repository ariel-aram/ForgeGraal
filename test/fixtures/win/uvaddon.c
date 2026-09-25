/* An addon that calls libuv directly, the way Holepunch-style Node-API addons do. */
#define USING_UV_SHARED 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>
#include <windows.h>

#define EXPORT __declspec(dllexport)

static int g_fail;
static void check(int ok, const char *what)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) g_fail++;
}

/* timers: a repeating one that stops itself after three ticks, and a one-shot */
static uv_timer_t g_rep, g_one, g_keep;
static int g_ticks, g_one_fired, g_order[2], g_norder;
static void on_close(uv_handle_t *h) { (void) h; }
static void rep_cb(uv_timer_t *t)
{
    if (++g_ticks == 3) {
        g_order[g_norder++] = 2;
        uv_timer_stop(t);
        uv_close((uv_handle_t *) t, on_close);
    }
}
static void one_cb(uv_timer_t *t)
{
    g_one_fired++;
    g_order[g_norder++] = 1;
    uv_close((uv_handle_t *) t, on_close);
}
static void keep_cb(uv_timer_t *t) { (void) t; }

/* async woken from another thread */
static uv_async_t g_async;
static int g_async_calls;
static DWORD g_main_thread;
static DWORD g_async_cb_thread;
static uv_thread_t g_sender;
static void sender(void *arg) { uv_async_send((uv_async_t *) arg); }
static void async_cb(uv_async_t *a)
{
    g_async_calls++;
    g_async_cb_thread = GetCurrentThreadId();
    uv_close((uv_handle_t *) a, on_close);
}

/* thread pool work */
static uv_work_t g_work;
static DWORD g_work_thread, g_after_thread;
static int g_after_status = -1;
static void work_cb(uv_work_t *w)
{
    (void) w;
    g_work_thread = GetCurrentThreadId();
    Sleep(10);
}
static void after_cb(uv_work_t *w, int status)
{
    (void) w;
    g_after_thread = GetCurrentThreadId();
    g_after_status = status;
}

/* fs: async open -> write -> close chain */
static uv_fs_t g_fs;
static char g_path[MAX_PATH];
static char g_wdata[] = "hello from uv_fs";
static int g_chain_done;
static void fs_close_cb(uv_fs_t *r)
{
    g_chain_done = r->result == 0;
    uv_fs_req_cleanup(r);
}
static void fs_write_cb(uv_fs_t *r)
{
    ssize_t n = r->result;
    uv_file f = (uv_file) (intptr_t) r->data;
    uv_fs_req_cleanup(r);
    if (n != (ssize_t) strlen(g_wdata)) return;
    uv_fs_close(uv_default_loop(), &g_fs, f, fs_close_cb);
}
static void fs_open_cb(uv_fs_t *r)
{
    uv_file f = (uv_file) r->result;
    uv_buf_t b = uv_buf_init(g_wdata, (unsigned) strlen(g_wdata));
    uv_fs_req_cleanup(r);
    if (f < 0) return;
    g_fs.data = (void *) (intptr_t) f;
    uv_fs_write(uv_default_loop(), &g_fs, f, &b, 1, -1, fs_write_cb);
}

/* locks and threads */
static uv_mutex_t g_mutex;
static uv_cond_t g_cond;
static uv_sem_t g_sem;
static uv_rwlock_t g_rw;
static uv_key_t g_key;
static uv_once_t g_once = UV_ONCE_INIT;
static int g_once_runs, g_ready, g_counter;
static void once_cb(void) { g_once_runs++; }
static void worker(void *arg)
{
    int i;
    uv_once(&g_once, once_cb);
    uv_key_set(&g_key, arg);
    for (i = 0; i < 1000; i++) {
        uv_mutex_lock(&g_mutex);
        g_counter++;
        uv_mutex_unlock(&g_mutex);
    }
    uv_rwlock_rdlock(&g_rw);
    uv_rwlock_rdunlock(&g_rw);
    uv_mutex_lock(&g_mutex);
    g_ready = 1;
    uv_cond_signal(&g_cond);
    uv_mutex_unlock(&g_mutex);
    uv_sem_post(&g_sem);
}

static int g_idle_runs;
static uv_idle_t g_idle;
static void idle_cb(uv_idle_t *h)
{
    if (++g_idle_runs == 2) uv_close((uv_handle_t *) h, on_close);
}

static void own_loop_timer(uv_timer_t *t)
{
    (*(int *) t->data)++;
    uv_close((uv_handle_t *) t, on_close);
}

static void basics(void)
{
    char buf[512];
    size_t n;
    uv_loop_t *loop = uv_default_loop();
    uv_fs_t req;
    uv_buf_t b;
    uv_file f;
    uint64_t t0, t1;

    check(loop == uv_default_loop() && uv_loop_alive(loop) == 0, "default loop is stable and idle");
    check(strcmp(uv_err_name(UV_ENOENT), "ENOENT") == 0 && strstr(uv_strerror(UV_ENOENT), "no such file"),
          "err_name and strerror");
    check(uv_handle_size(UV_TIMER) == sizeof(uv_timer_t) && strcmp(uv_handle_type_name(UV_ASYNC), "async") == 0,
          "handle_size and type_name");
    check(uv_req_size(UV_WORK) == sizeof(uv_work_t) && strcmp(uv_req_type_name(UV_FS), "fs") == 0,
          "req_size and type_name");

    t0 = uv_hrtime();
    Sleep(15);
    t1 = uv_hrtime();
    check(t1 - t0 >= 10000000ull && t1 - t0 < 2000000000ull, "hrtime advances in nanoseconds");

    n = sizeof(buf);
    check(uv_cwd(buf, &n) == 0 && n == strlen(buf) && n > 1, "uv_cwd");
    n = 2;
    check(uv_cwd(buf, &n) == UV_ENOBUFS && n > 2, "uv_cwd reports the size it needs");
    n = sizeof(buf);
    check(uv_os_homedir(buf, &n) == 0 && n > 0, "uv_os_homedir");
    n = sizeof(buf);
    check(uv_os_tmpdir(buf, &n) == 0 && n > 0, "uv_os_tmpdir");
    n = sizeof(buf);
    check(uv_os_gethostname(buf, &n) == 0 && n > 0, "uv_os_gethostname");
    check(uv_os_getpid() == (uv_pid_t) GetCurrentProcessId(), "uv_os_getpid");
    check(uv_os_setenv("GRAAK_UV_TEST", "value \xc3\xa9") == 0, "uv_os_setenv");
    n = sizeof(buf);
    check(uv_os_getenv("GRAAK_UV_TEST", buf, &n) == 0 && strcmp(buf, "value \xc3\xa9") == 0, "uv_os_getenv");
    check(uv_os_unsetenv("GRAAK_UV_TEST") == 0, "uv_os_unsetenv");
    n = sizeof(buf);
    check(uv_os_getenv("GRAAK_UV_TEST", buf, &n) == UV_ENOENT, "unset variable is ENOENT");
    {
        uv_utsname_t u;
        uv_passwd_t pw;
        check(uv_os_uname(&u) == 0 && strcmp(u.sysname, "Windows_NT") == 0, "uv_os_uname");
        check(uv_os_get_passwd(&pw) == 0 && pw.username && pw.homedir, "uv_os_get_passwd");
        uv_os_free_passwd(&pw);
    }
    check(uv_available_parallelism() >= 1, "uv_available_parallelism");

    /* synchronous fs */
    snprintf(g_path, sizeof(g_path), "uvtest-%lu.txt", (unsigned long) GetCurrentProcessId());
    check(uv_fs_open(loop, &req, g_path, UV_FS_O_WRONLY | UV_FS_O_CREAT | UV_FS_O_TRUNC, 0644, NULL) >= 0,
          "fs_open (sync, create)");
    f = (uv_file) req.result;
    uv_fs_req_cleanup(&req);
    b = uv_buf_init("0123456789", 10);
    check(uv_fs_write(loop, &req, f, &b, 1, -1, NULL) == 10, "fs_write (sync)");
    uv_fs_req_cleanup(&req);
    check(uv_fs_fstat(loop, &req, f, NULL) == 0 && req.statbuf.st_size == 10, "fs_fstat size");
    uv_fs_req_cleanup(&req);
    check(uv_fs_close(loop, &req, f, NULL) == 0, "fs_close (sync)");
    uv_fs_req_cleanup(&req);
    check(uv_fs_open(loop, &req, g_path, UV_FS_O_RDONLY, 0, NULL) >= 0, "fs_open (sync, read)");
    f = (uv_file) req.result;
    uv_fs_req_cleanup(&req);
    memset(buf, 0, sizeof(buf));
    b = uv_buf_init(buf, 4);
    check(uv_fs_read(loop, &req, f, &b, 1, 3, NULL) == 4 && memcmp(buf, "3456", 4) == 0, "fs_read at an offset");
    uv_fs_req_cleanup(&req);
    uv_fs_close(loop, &req, f, NULL);
    uv_fs_req_cleanup(&req);
    check(uv_fs_stat(loop, &req, g_path, NULL) == 0 && req.statbuf.st_size == 10 && (req.statbuf.st_mode & 0100000),
          "fs_stat");
    uv_fs_req_cleanup(&req);
    check(uv_fs_unlink(loop, &req, g_path, NULL) == 0, "fs_unlink");
    uv_fs_req_cleanup(&req);
    check(uv_fs_stat(loop, &req, g_path, NULL) == UV_ENOENT, "missing file is ENOENT");
    uv_fs_req_cleanup(&req);
    check(uv_fs_mkdir(loop, &req, "uvdir.tmp", 0755, NULL) == 0, "fs_mkdir");
    uv_fs_req_cleanup(&req);
    check(uv_fs_mkdir(loop, &req, "uvdir.tmp", 0755, NULL) == UV_EEXIST, "fs_mkdir twice is EEXIST");
    uv_fs_req_cleanup(&req);
    check(uv_fs_rmdir(loop, &req, "uvdir.tmp", NULL) == 0, "fs_rmdir");
    uv_fs_req_cleanup(&req);
}

static void sync_prims(void)
{
    uv_thread_t th[3];
    int i;
    int own_fired = 0;
    uv_loop_t own;
    uv_timer_t ot;
    uv_thread_t self, again;
    uv_mutex_init(&g_mutex);
    uv_cond_init(&g_cond);
    uv_sem_init(&g_sem, 0);
    uv_rwlock_init(&g_rw);
    uv_key_create(&g_key);
    check(uv_rwlock_trywrlock(&g_rw) == 0 && uv_rwlock_tryrdlock(&g_rw) == UV_EBUSY, "rwlock writer excludes readers");
    uv_rwlock_wrunlock(&g_rw);
    check(uv_rwlock_tryrdlock(&g_rw) == 0 && uv_rwlock_tryrdlock(&g_rw) == 0 && uv_rwlock_trywrlock(&g_rw) == UV_EBUSY,
          "rwlock readers share, exclude a writer");
    uv_rwlock_rdunlock(&g_rw);
    uv_rwlock_rdunlock(&g_rw);
    for (i = 0; i < 3; i++) check(uv_thread_create(&th[i], worker, (void *) (intptr_t) (i + 1)) == 0, "uv_thread_create");
    uv_mutex_lock(&g_mutex);
    while (!g_ready) uv_cond_wait(&g_cond, &g_mutex);
    uv_mutex_unlock(&g_mutex);
    check(g_ready == 1, "cond wait woken by signal");
    for (i = 0; i < 3; i++) check(uv_thread_join(&th[i]) == 0, "uv_thread_join");
    check(g_counter == 3000, "mutex protects a counter across threads");
    check(g_once_runs == 1, "uv_once runs once");
    check(uv_key_get(&g_key) == NULL, "thread-local key is per thread");
    for (i = 0; i < 3; i++) uv_sem_wait(&g_sem);
    check(uv_sem_trywait(&g_sem) == UV_EAGAIN, "semaphore counted three posts");
    uv_mutex_lock(&g_mutex);
    check(uv_cond_timedwait(&g_cond, &g_mutex, 20000000ull) == UV_ETIMEDOUT, "cond timedwait times out");
    uv_mutex_unlock(&g_mutex);
    self = uv_thread_self();
    again = uv_thread_self();
    check(uv_thread_equal(&self, &again), "uv_thread_self is stable");

    /* a loop of the addon's own, run by the addon */
    check(uv_loop_init(&own) == 0, "uv_loop_init");
    uv_timer_init(&own, &ot);
    ot.data = &own_fired;
    uv_timer_start(&ot, own_loop_timer, 20, 0);
    check(uv_run(&own, UV_RUN_DEFAULT) == 0 && own_fired == 1, "uv_run on a private loop blocks until its timer fires");
    check(uv_loop_close(&own) == 0, "uv_loop_close");
}

EXPORT int addon_start(void)
{
    uv_loop_t *loop;
    g_main_thread = GetCurrentThreadId();
    basics();
    sync_prims();
    loop = uv_default_loop();
    uv_timer_init(loop, &g_rep);
    uv_timer_init(loop, &g_one);
    uv_timer_start(&g_rep, rep_cb, 10, 10);
    uv_timer_start(&g_one, one_cb, 15, 0);
    uv_async_init(loop, &g_async, async_cb);
    uv_thread_create(&g_sender, sender, &g_async);
    uv_queue_work(loop, &g_work, work_cb, after_cb);
    uv_idle_init(loop, &g_idle);
    uv_idle_start(&g_idle, idle_cb);
    check(uv_is_active((uv_handle_t *) &g_rep) && uv_has_ref((uv_handle_t *) &g_rep), "timer is active and referenced");
    check(uv_handle_get_loop((uv_handle_t *) &g_rep) == loop && uv_handle_get_type((uv_handle_t *) &g_rep) == UV_TIMER,
          "handle getters");
    /* an unreferenced timer far in the future must not keep the loop, or the host, alive */
    uv_timer_init(loop, &g_keep);
    uv_unref((uv_handle_t *) &g_keep);
    uv_timer_start(&g_keep, keep_cb, 100000, 0);
    check(!uv_has_ref((uv_handle_t *) &g_keep), "uv_unref");
    snprintf(g_path, sizeof(g_path), "uvchain-%lu.txt", (unsigned long) GetCurrentProcessId());
    uv_fs_open(loop, &g_fs, g_path, UV_FS_O_WRONLY | UV_FS_O_CREAT | UV_FS_O_TRUNC, 0644, fs_open_cb);
    return g_fail;
}

EXPORT int addon_finish(void)
{
    uv_fs_t req;
    char buf[64] = {0};
    uv_buf_t b = uv_buf_init(buf, sizeof(buf) - 1);
    uv_file f;
    check(g_ticks == 3, "repeating timer ticked three times");
    check(g_one_fired == 1 && g_order[0] == 1 && g_order[1] == 2, "timers fired in due order");
    check(g_async_calls == 1 && g_async_cb_thread == g_main_thread, "uv_async_send from a thread runs on the loop thread");
    uv_thread_join(&g_sender);
    check(g_work_thread && g_work_thread != g_main_thread && g_after_thread == g_main_thread && g_after_status == 0,
          "uv_queue_work runs off-thread, completes on the loop thread");
    check(g_idle_runs == 2, "idle handle ran until closed");
    check(g_chain_done, "async fs open/write/close chain completed");
    if (uv_fs_open(uv_default_loop(), &req, g_path, UV_FS_O_RDONLY, 0, NULL) >= 0) {
        f = (uv_file) req.result;
        uv_fs_req_cleanup(&req);
        uv_fs_read(uv_default_loop(), &req, f, &b, 1, 0, NULL);
        check(strcmp(buf, g_wdata) == 0, "file written by the async chain reads back");
        uv_fs_req_cleanup(&req);
        uv_fs_close(uv_default_loop(), &req, f, NULL);
        uv_fs_req_cleanup(&req);
    } else {
        check(0, "reopen chain file");
    }
    uv_fs_unlink(uv_default_loop(), &req, g_path, NULL);
    uv_fs_req_cleanup(&req);
    return g_fail;
}
