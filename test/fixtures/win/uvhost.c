/* Stands in for the Graak host: it links fg_uv.c (which exports the libuv subset), loads an addon that imports
   libuv from it, and drives the default loop the way the host's pump does, until nothing is left alive. */
#include <stdio.h>
#include <windows.h>

void fg_uv_host(void (*inc)(void), void (*dec)(void));
int fg_uv_drain(void);

static int g_live;
static void live_inc(void) { g_live++; }
static void live_dec(void) { g_live--; }

int main(int argc, char **argv)
{
    HMODULE lib;
    int (*start)(void);
    int (*finish)(void);
    int i, r;
    setvbuf(stdout, NULL, _IONBF, 0);
    fg_uv_host(live_inc, live_dec);
    lib = LoadLibraryExA(argc > 1 ? argv[1] : "uvaddon.dll", NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!lib) {
        printf("load failed: %lu\n", (unsigned long) GetLastError());
        return 1;
    }
    start = (int (*)(void)) GetProcAddress(lib, "addon_start");
    finish = (int (*)(void)) GetProcAddress(lib, "addon_finish");
    if (!start || !finish) {
        printf("missing exports\n");
        return 2;
    }
    r = start();
    for (i = 0; i < 1500 && g_live > 0; i++) {
        fg_uv_drain();
        Sleep(2);
    }
    printf("pump: live=%d after %d turns\n", g_live, i);
    r |= finish();
    printf(r ? "FAILED\n" : "ALL OK\n");
    return r;
}
