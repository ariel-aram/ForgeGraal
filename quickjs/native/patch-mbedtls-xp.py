#!/usr/bin/env python3
"""Switches mbedTLS's Windows entropy source from BCryptGenRandom to CryptGenRandom.

BCryptGenRandom lives in bcrypt.dll, which arrived with Windows Vista. CryptGenRandom is the
CryptoAPI equivalent in advapi32 and has been present since Windows 95 OSR2, so it is what an
XP-capable build has to use. Both are the OS CSPRNG; this is not a downgrade in randomness
quality, only in API vintage.
"""
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
source = target.read_text()

OLD = """    while (len != 0) {
        unsigned long ulong_bytes =
            (len > ULONG_MAX) ? ULONG_MAX : (unsigned long) len;

        if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, output, ulong_bytes,
                                            BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        }

        *olen += ulong_bytes;
        len -= ulong_bytes;
    }

    return 0;"""

NEW = """#if defined(QJS_WINXP_COMPAT)
    /* CryptoAPI rather than CNG: bcrypt.dll is Windows Vista and later, while CryptGenRandom
       has existed since Windows 95 OSR2. Both draw from the OS CSPRNG. */
    {
        HCRYPTPROV provider = 0;
        if (!CryptAcquireContext(&provider, NULL, NULL, PROV_RSA_FULL,
                                 CRYPT_VERIFYCONTEXT | CRYPT_SILENT)) {
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        }
        if (!CryptGenRandom(provider, (DWORD) len, output)) {
            CryptReleaseContext(provider, 0);
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        }
        CryptReleaseContext(provider, 0);
        *olen = len;
    }

    return 0;
#else
    while (len != 0) {
        unsigned long ulong_bytes =
            (len > ULONG_MAX) ? ULONG_MAX : (unsigned long) len;

        if (!BCRYPT_SUCCESS(BCryptGenRandom(NULL, output, ulong_bytes,
                                            BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
            return MBEDTLS_ERR_ENTROPY_SOURCE_FAILED;
        }

        *olen += ulong_bytes;
        len -= ulong_bytes;
    }

    return 0;
#endif"""

if "QJS_WINXP_COMPAT" in source:
    print("already patched")
    sys.exit(0)
if OLD not in source:
    print(f"error: entropy anchor not found in {target}", file=sys.stderr)
    sys.exit(1)

source = source.replace(OLD, NEW, 1)
# wincrypt.h declares CryptAcquireContext/CryptGenRandom; bcrypt.h alone does not.
source = source.replace('#include <bcrypt.h>', '#include <bcrypt.h>\n#include <wincrypt.h>', 1)
target.write_text(source)
print(f"patched {target} to use CryptGenRandom under QJS_WINXP_COMPAT")
