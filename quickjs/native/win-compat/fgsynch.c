/*
 * WaitOnAddress / WakeByAddressSingle / WakeByAddressAll for Windows Vista and 7.
 *
 * These three arrived with Windows 8 and live in api-ms-win-core-synch-l1-2-0.dll, an API-set DLL that
 * does not exist on Windows 7. Rust's standard library (so every Rust Node-API addon: @napi-rs/canvas,
 * davey, mediaplex, ...) and current libvips import them, which is why such an addon fails to load
 * there with "The specified module could not be found". ForgeGraal redirects the import to this DLL
 * (see src/compiler/Win7Compat.ts), which provides the same three functions on Vista's primitives.
 *
 * Waiters hash into a fixed set of buckets, each a critical section plus a condition variable. A wake
 * wakes the whole bucket: a waiter that was not the target sees its value unchanged and waits again in
 * the caller's loop, which is exactly the contract WaitOnAddress documents (it may return spuriously).
 */
#include <windows.h>
#include <string.h>

#define FG_BUCKETS 64

typedef struct {
    CRITICAL_SECTION lock;
    CONDITION_VARIABLE cv;
} fg_bucket;

static fg_bucket fg_buckets[FG_BUCKETS];
static INIT_ONCE fg_once = INIT_ONCE_STATIC_INIT;

static BOOL CALLBACK fg_init(PINIT_ONCE once, PVOID param, PVOID *ctx)
{
    int i;
    for (i = 0; i < FG_BUCKETS; i++) {
        InitializeCriticalSection(&fg_buckets[i].lock);
        InitializeConditionVariable(&fg_buckets[i].cv);
    }
    return TRUE;
}

static fg_bucket *fg_bucket_for(const volatile VOID *address)
{
    InitOnceExecuteOnce(&fg_once, fg_init, NULL, NULL);
    return &fg_buckets[(((ULONG_PTR) address) >> 3) % FG_BUCKETS];
}

__declspec(dllexport) BOOL WINAPI WaitOnAddress(volatile VOID *Address, PVOID CompareAddress, SIZE_T AddressSize,
                                                DWORD dwMilliseconds)
{
    fg_bucket *bucket;
    BOOL ok = TRUE;

    if (!Address || !CompareAddress || (AddressSize != 1 && AddressSize != 2 && AddressSize != 4 && AddressSize != 8)) {
        SetLastError(ERROR_INVALID_PARAMETER);
        return FALSE;
    }
    bucket = fg_bucket_for(Address);
    EnterCriticalSection(&bucket->lock);
    /* Only wait while the value is still the undesired one; a wake between the caller's check and here
       is covered because wakers take the same lock. */
    if (memcmp((const void *) Address, CompareAddress, AddressSize) == 0) {
        ok = SleepConditionVariableCS(&bucket->cv, &bucket->lock, dwMilliseconds);
    }
    LeaveCriticalSection(&bucket->lock);
    if (!ok) SetLastError(ERROR_TIMEOUT);
    return ok;
}

__declspec(dllexport) VOID WINAPI WakeByAddressSingle(PVOID Address)
{
    fg_bucket *bucket = fg_bucket_for(Address);
    EnterCriticalSection(&bucket->lock);
    WakeAllConditionVariable(&bucket->cv);
    LeaveCriticalSection(&bucket->lock);
}

__declspec(dllexport) VOID WINAPI WakeByAddressAll(PVOID Address)
{
    fg_bucket *bucket = fg_bucket_for(Address);
    EnterCriticalSection(&bucket->lock);
    WakeAllConditionVariable(&bucket->cv);
    LeaveCriticalSection(&bucket->lock);
}
