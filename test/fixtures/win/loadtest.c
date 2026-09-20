/* Loads a DLL by name and calls its `fixture` export: what a host does with an addon. */
#include <stdio.h>
#include <windows.h>

int main(int argc, char **argv)
{
    HMODULE lib = LoadLibraryExA(argc > 1 ? argv[1] : "imports.dll", NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    int (*fixture)(volatile LONG *);
    volatile LONG flag = 0;
    if (!lib) {
        printf("load failed: %lu\n", (unsigned long) GetLastError());
        return 1;
    }
    fixture = (int (*)(volatile LONG *)) GetProcAddress(lib, "fixture");
    if (!fixture) {
        printf("no fixture export\n");
        return 2;
    }
    fixture(&flag);
    printf("ok\n");
    return 0;
}
