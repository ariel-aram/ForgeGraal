/*
 * ProcessPrng for Windows 7.
 *
 * bcryptprimitives.dll exists on Windows 7 but does not export ProcessPrng, which arrived with Windows 10
 * and is what Rust's standard library uses to seed randomness. ForgeGraal redirects the import to this
 * DLL (see src/compiler/Win7Compat.ts). RtlGenRandom (exported as SystemFunction036 by advapi32) has
 * been the system CSPRNG since Windows XP and is what ProcessPrng wraps.
 */
#include <windows.h>

typedef BOOLEAN(WINAPI *rtlgenrandom_fn)(PVOID buffer, ULONG length);

__declspec(dllexport) BOOL WINAPI ProcessPrng(PBYTE pbData, SIZE_T cbData)
{
    static rtlgenrandom_fn generate;
    if (!generate) {
        HMODULE advapi = LoadLibraryA("advapi32.dll");
        if (advapi) generate = (rtlgenrandom_fn) GetProcAddress(advapi, "SystemFunction036");
    }
    if (!generate) return FALSE;
    while (cbData) {
        ULONG chunk = cbData > 0x10000000 ? 0x10000000 : (ULONG) cbData;
        if (!generate(pbData, chunk)) return FALSE;
        pbData += chunk;
        cbData -= chunk;
    }
    return TRUE;
}
