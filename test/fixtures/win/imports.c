/* A DLL whose imports are exactly the Windows 8+/10 ones Windows 7 lacks (see Win7Compat.ts). */
#include <windows.h>
#include <synchapi.h>
#include <sysinfoapi.h>
#include <bcrypt.h>

__declspec(dllexport) int fixture(volatile LONG *flag)
{
    FILETIME ft;
    LONG undesired = 0;
    UCHAR bytes[8];
    GetSystemTimePreciseAsFileTime(&ft);
    WaitOnAddress(flag, &undesired, sizeof(undesired), 1);
    WakeByAddressAll((PVOID) flag);
    return (int) ft.dwLowDateTime + (int) bytes[0];
}
