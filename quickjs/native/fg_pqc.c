/*
 * Post-quantum key types for the Graak native host: ML-KEM (FIPS 203) and ML-DSA (FIPS 204) from the PQ Code Package's
 * mlkem-native and mldsa-native, SLH-DSA (FIPS 205) from slhdsa-c. build.sh fetches the three at pinned commits. All of
 * them are portable C with no secret-dependent branches or table lookups, which is the reason they are here and not
 * the JavaScript in node-pqc.js: that stays as the fallback for a host built without them.
 *
 * The functions take the randomness from the caller (the JavaScript layer draws it from the host's generator), so
 * nothing here needs an entropy source.
 *
 *   pqcKemKeypair(bits, d||z)            -> ek || dk
 *   pqcKemEnc(bits, ek, m)               -> ct || ss
 *   pqcKemDec(bits, ct, dk)              -> ss
 *   pqcDsaKeypair(level, seed)           -> pk || sk
 *   pqcDsaSign(level, sk, msg, ctx, rnd) -> signature, or null
 *   pqcDsaVerify(level, pk, msg, ctx, sig) -> boolean
 *   pqcSlhKeypair(name, skSeed, skPrf, pkSeed) -> sk (4n bytes, the public key is its last 2n)
 *   pqcSlhSign(name, sk, msg, ctx, rnd)  -> signature
 *   pqcSlhVerify(name, pk, msg, ctx, sig) -> boolean
 */

#include "quickjs.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Both libraries clear their intermediate buffers through this (see the configuration headers). */
static void fg_pqc_zeroize(void *ptr, size_t len)
{
    volatile uint8_t *p = (volatile uint8_t *) ptr;
    while (len--) *p++ = 0;
}

/* ---- ML-KEM: 512, 768 and 1024 in one translation unit, the shared code with the first ---- */
#define MLK_CONFIG_FILE "fg_mlkem_config.h"
#define MLK_CONFIG_MULTILEVEL_WITH_SHARED
#define MLK_CONFIG_MONOBUILD_KEEP_SHARED_HEADERS
#define MLK_CONFIG_PARAMETER_SET 512
#include "mlkem_native.c"
#undef MLK_CONFIG_PARAMETER_SET
#undef MLK_CONFIG_MULTILEVEL_WITH_SHARED
#define MLK_CONFIG_MULTILEVEL_NO_SHARED
#define MLK_CONFIG_PARAMETER_SET 768
#include "mlkem_native.c"
#undef MLK_CONFIG_PARAMETER_SET
#undef MLK_CONFIG_MONOBUILD_KEEP_SHARED_HEADERS
#define MLK_CONFIG_PARAMETER_SET 1024
#include "mlkem_native.c"
#undef MLK_CONFIG_PARAMETER_SET

/* The API declarations for the three levels. */
#define MLK_CONFIG_PARAMETER_SET 512
#include <mlkem_native.h>
#undef MLK_CONFIG_PARAMETER_SET
#undef MLK_H
#define MLK_CONFIG_PARAMETER_SET 768
#include <mlkem_native.h>
#undef MLK_CONFIG_PARAMETER_SET
#undef MLK_H
#define MLK_CONFIG_PARAMETER_SET 1024
#include <mlkem_native.h>
#undef MLK_CONFIG_PARAMETER_SET
#undef MLK_H

/* ---- ML-DSA: 44, 65 and 87 ---- */
#define MLD_CONFIG_FILE "fg_mldsa_config.h"
#define MLD_CONFIG_MULTILEVEL_WITH_SHARED
#define MLD_CONFIG_MONOBUILD_KEEP_SHARED_HEADERS
#define MLD_CONFIG_PARAMETER_SET 44
#include "mldsa_native.c"
#undef MLD_CONFIG_PARAMETER_SET
#undef MLD_CONFIG_MULTILEVEL_WITH_SHARED
#define MLD_CONFIG_MULTILEVEL_NO_SHARED
#define MLD_CONFIG_PARAMETER_SET 65
#include "mldsa_native.c"
#undef MLD_CONFIG_PARAMETER_SET
#undef MLD_CONFIG_MONOBUILD_KEEP_SHARED_HEADERS
#define MLD_CONFIG_PARAMETER_SET 87
#include "mldsa_native.c"
#undef MLD_CONFIG_PARAMETER_SET

#define MLD_CONFIG_PARAMETER_SET 44
#include <mldsa_native.h>
#undef MLD_CONFIG_PARAMETER_SET
#undef MLD_H
#define MLD_CONFIG_PARAMETER_SET 65
#include <mldsa_native.h>
#undef MLD_CONFIG_PARAMETER_SET
#undef MLD_H
#define MLD_CONFIG_PARAMETER_SET 87
#include <mldsa_native.h>
#undef MLD_CONFIG_PARAMETER_SET
#undef MLD_H

#include "slh_dsa.h"

/* ---- glue ---- */

/* The bytes of an argument that must be a Uint8Array of exactly `want` bytes (or at least `want` when `min`). */
static uint8_t *fg_arg_bytes(JSContext *ctx, JSValueConst v, size_t want, int min, const char *what, size_t *len)
{
    size_t n;
    uint8_t *p = JS_GetUint8Array(ctx, &n, v);
    if (!p) return NULL;
    if ((!min && n != want) || (min && n < want)) {
        JS_ThrowRangeError(ctx, "%s must be %s%zu bytes", what, min ? "at least " : "", want);
        return NULL;
    }
    if (len) *len = n;
    return p;
}

static JSValue fg_result(JSContext *ctx, const uint8_t *data, size_t len)
{
    return JS_NewUint8ArrayCopy(ctx, data, len);
}

static int fg_kem_level(JSContext *ctx, JSValueConst v)
{
    int32_t bits;
    if (JS_ToInt32(ctx, &bits, v)) return -1;
    if (bits != 512 && bits != 768 && bits != 1024) {
        JS_ThrowRangeError(ctx, "ML-KEM parameter set must be 512, 768 or 1024");
        return -1;
    }
    return bits;
}

#define FG_KEM_SIZES(bits, ek, dk, ct)                                                                                 \
    do {                                                                                                               \
        (ek) = (bits) == 512 ? MLKEM512_PUBLICKEYBYTES : (bits) == 768 ? MLKEM768_PUBLICKEYBYTES : MLKEM1024_PUBLICKEYBYTES; \
        (dk) = (bits) == 512 ? MLKEM512_SECRETKEYBYTES : (bits) == 768 ? MLKEM768_SECRETKEYBYTES : MLKEM1024_SECRETKEYBYTES; \
        (ct) = (bits) == 512 ? MLKEM512_CIPHERTEXTBYTES : (bits) == 768 ? MLKEM768_CIPHERTEXTBYTES : MLKEM1024_CIPHERTEXTBYTES; \
    } while (0)

static JSValue fg_pqc_kem_keypair(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int bits, rc;
    size_t ekn, dkn, ctn;
    uint8_t *coins, *buf;
    JSValue result;
    if (argc < 2) return JS_ThrowTypeError(ctx, "pqcKemKeypair(bits, coins)");
    bits = fg_kem_level(ctx, argv[0]);
    if (bits < 0) return JS_EXCEPTION;
    coins = fg_arg_bytes(ctx, argv[1], 64, 0, "coins", NULL);
    if (!coins) return JS_EXCEPTION;
    FG_KEM_SIZES(bits, ekn, dkn, ctn);
    (void) ctn;
    buf = malloc(ekn + dkn);
    if (!buf) return JS_ThrowOutOfMemory(ctx);
    rc = bits == 512   ? mlkem512_keypair_derand(buf, buf + ekn, coins)
         : bits == 768 ? mlkem768_keypair_derand(buf, buf + ekn, coins)
                       : mlkem1024_keypair_derand(buf, buf + ekn, coins);
    result = rc == 0 ? fg_result(ctx, buf, ekn + dkn) : JS_ThrowInternalError(ctx, "ML-KEM key generation failed");
    memset(buf, 0, ekn + dkn);
    free(buf);
    return result;
}

static JSValue fg_pqc_kem_enc(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int bits, rc;
    size_t ekn, dkn, ctn;
    uint8_t *ek, *m, buf[1568 + 32];
    if (argc < 3) return JS_ThrowTypeError(ctx, "pqcKemEnc(bits, ek, m)");
    bits = fg_kem_level(ctx, argv[0]);
    if (bits < 0) return JS_EXCEPTION;
    FG_KEM_SIZES(bits, ekn, dkn, ctn);
    (void) dkn;
    ek = fg_arg_bytes(ctx, argv[1], ekn, 0, "encapsulation key", NULL);
    m = ek ? fg_arg_bytes(ctx, argv[2], 32, 0, "message", NULL) : NULL;
    if (!ek || !m) return JS_EXCEPTION;
    rc = bits == 512   ? mlkem512_enc_derand(buf, buf + ctn, ek, m)
         : bits == 768 ? mlkem768_enc_derand(buf, buf + ctn, ek, m)
                       : mlkem1024_enc_derand(buf, buf + ctn, ek, m);
    if (rc != 0) return JS_ThrowRangeError(ctx, "invalid encapsulation key");
    return fg_result(ctx, buf, ctn + 32);
}

static JSValue fg_pqc_kem_dec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int bits, rc;
    size_t ekn, dkn, ctn;
    uint8_t *ct, *dk, ss[32];
    if (argc < 3) return JS_ThrowTypeError(ctx, "pqcKemDec(bits, ciphertext, dk)");
    bits = fg_kem_level(ctx, argv[0]);
    if (bits < 0) return JS_EXCEPTION;
    FG_KEM_SIZES(bits, ekn, dkn, ctn);
    (void) ekn;
    ct = fg_arg_bytes(ctx, argv[1], ctn, 0, "ciphertext", NULL);
    dk = ct ? fg_arg_bytes(ctx, argv[2], dkn, 0, "decapsulation key", NULL) : NULL;
    if (!ct || !dk) return JS_EXCEPTION;
    rc = bits == 512 ? mlkem512_dec(ss, ct, dk) : bits == 768 ? mlkem768_dec(ss, ct, dk) : mlkem1024_dec(ss, ct, dk);
    if (rc != 0) return JS_ThrowRangeError(ctx, "invalid decapsulation key");
    {
        JSValue r = fg_result(ctx, ss, 32);
        memset(ss, 0, sizeof(ss));
        return r;
    }
}

static int fg_dsa_level(JSContext *ctx, JSValueConst v)
{
    int32_t level;
    if (JS_ToInt32(ctx, &level, v)) return -1;
    if (level != 44 && level != 65 && level != 87) {
        JS_ThrowRangeError(ctx, "ML-DSA parameter set must be 44, 65 or 87");
        return -1;
    }
    return level;
}

#define FG_DSA_SIZES(level, pk, sk, sig)                                                                               \
    do {                                                                                                               \
        (pk) = (level) == 44 ? MLDSA44_PUBLICKEYBYTES : (level) == 65 ? MLDSA65_PUBLICKEYBYTES : MLDSA87_PUBLICKEYBYTES; \
        (sk) = (level) == 44 ? MLDSA44_SECRETKEYBYTES : (level) == 65 ? MLDSA65_SECRETKEYBYTES : MLDSA87_SECRETKEYBYTES; \
        (sig) = (level) == 44 ? MLDSA44_BYTES : (level) == 65 ? MLDSA65_BYTES : MLDSA87_BYTES;                          \
    } while (0)

static JSValue fg_pqc_dsa_keypair(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int level, rc;
    size_t pkn, skn, sgn;
    uint8_t *seed, *buf;
    JSValue result;
    if (argc < 2) return JS_ThrowTypeError(ctx, "pqcDsaKeypair(level, seed)");
    level = fg_dsa_level(ctx, argv[0]);
    if (level < 0) return JS_EXCEPTION;
    seed = fg_arg_bytes(ctx, argv[1], 32, 0, "seed", NULL);
    if (!seed) return JS_EXCEPTION;
    FG_DSA_SIZES(level, pkn, skn, sgn);
    (void) sgn;
    buf = malloc(pkn + skn);
    if (!buf) return JS_ThrowOutOfMemory(ctx);
    rc = level == 44   ? mldsa44_keypair_internal(buf, buf + pkn, seed)
         : level == 65 ? mldsa65_keypair_internal(buf, buf + pkn, seed)
                       : mldsa87_keypair_internal(buf, buf + pkn, seed);
    result = rc == 0 ? fg_result(ctx, buf, pkn + skn) : JS_ThrowInternalError(ctx, "ML-DSA key generation failed");
    memset(buf, 0, pkn + skn);
    free(buf);
    return result;
}

/* FIPS 204 pure signing formats M' = 0x00 || len(ctx) || ctx || M; mldsa-native takes M' as `pre` (the part before M). */
static JSValue fg_pqc_dsa_sign(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int level, rc;
    size_t pkn, skn, sgn, mn, cn;
    uint8_t *sk, *msg, *cx, *rnd, pre[2 + 255], *sig;
    JSValue result;
    if (argc < 5) return JS_ThrowTypeError(ctx, "pqcDsaSign(level, sk, message, context, rnd)");
    level = fg_dsa_level(ctx, argv[0]);
    if (level < 0) return JS_EXCEPTION;
    FG_DSA_SIZES(level, pkn, skn, sgn);
    (void) pkn;
    sk = fg_arg_bytes(ctx, argv[1], skn, 0, "secret key", NULL);
    msg = sk ? JS_GetUint8Array(ctx, &mn, argv[2]) : NULL;
    cx = msg ? JS_GetUint8Array(ctx, &cn, argv[3]) : NULL;
    rnd = cx ? fg_arg_bytes(ctx, argv[4], 32, 0, "rnd", NULL) : NULL;
    if (!sk || !msg || !cx || !rnd) return JS_EXCEPTION;
    if (cn > 255) return JS_ThrowRangeError(ctx, "context is at most 255 bytes");
    pre[0] = 0;
    pre[1] = (uint8_t) cn;
    memcpy(pre + 2, cx, cn);
    sig = malloc(sgn);
    if (!sig) return JS_ThrowOutOfMemory(ctx);
    rc = level == 44   ? mldsa44_signature_internal(sig, msg, mn, pre, 2 + cn, rnd, sk, 0)
         : level == 65 ? mldsa65_signature_internal(sig, msg, mn, pre, 2 + cn, rnd, sk, 0)
                       : mldsa87_signature_internal(sig, msg, mn, pre, 2 + cn, rnd, sk, 0);
    result = rc == 0 ? fg_result(ctx, sig, sgn) : JS_NULL;
    free(sig);
    return result;
}

static JSValue fg_pqc_dsa_verify(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int level, rc;
    size_t pkn, skn, sgn, mn, cn;
    uint8_t *pk, *msg, *cx, *sig, pre[2 + 255];
    if (argc < 5) return JS_ThrowTypeError(ctx, "pqcDsaVerify(level, pk, message, context, signature)");
    level = fg_dsa_level(ctx, argv[0]);
    if (level < 0) return JS_EXCEPTION;
    FG_DSA_SIZES(level, pkn, skn, sgn);
    (void) skn;
    pk = fg_arg_bytes(ctx, argv[1], pkn, 0, "public key", NULL);
    msg = pk ? JS_GetUint8Array(ctx, &mn, argv[2]) : NULL;
    cx = msg ? JS_GetUint8Array(ctx, &cn, argv[3]) : NULL;
    sig = cx ? JS_GetUint8Array(ctx, &pkn, argv[4]) : NULL;
    if (!pk || !msg || !cx || !sig) return JS_EXCEPTION;
    if (cn > 255 || pkn != sgn) return JS_FALSE;
    pre[0] = 0;
    pre[1] = (uint8_t) cn;
    memcpy(pre + 2, cx, cn);
    pk = JS_GetUint8Array(ctx, &skn, argv[1]);
    rc = level == 44   ? mldsa44_verify_internal(sig, msg, mn, pre, 2 + cn, pk, 0)
         : level == 65 ? mldsa65_verify_internal(sig, msg, mn, pre, 2 + cn, pk, 0)
                       : mldsa87_verify_internal(sig, msg, mn, pre, 2 + cn, pk, 0);
    return JS_NewBool(ctx, rc == 0);
}

static const slh_param_t *fg_slh_params(JSContext *ctx, JSValueConst v)
{
    static const struct {
        const char *name;
        const slh_param_t *prm;
    } table[] = {
        {"slh-dsa-sha2-128s", &slh_dsa_sha2_128s},   {"slh-dsa-sha2-128f", &slh_dsa_sha2_128f},
        {"slh-dsa-sha2-192s", &slh_dsa_sha2_192s},   {"slh-dsa-sha2-192f", &slh_dsa_sha2_192f},
        {"slh-dsa-sha2-256s", &slh_dsa_sha2_256s},   {"slh-dsa-sha2-256f", &slh_dsa_sha2_256f},
        {"slh-dsa-shake-128s", &slh_dsa_shake_128s}, {"slh-dsa-shake-128f", &slh_dsa_shake_128f},
        {"slh-dsa-shake-192s", &slh_dsa_shake_192s}, {"slh-dsa-shake-192f", &slh_dsa_shake_192f},
        {"slh-dsa-shake-256s", &slh_dsa_shake_256s}, {"slh-dsa-shake-256f", &slh_dsa_shake_256f},
    };
    const char *name = JS_ToCString(ctx, v);
    size_t i;
    if (!name) return NULL;
    for (i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
        if (strcmp(name, table[i].name) == 0) {
            JS_FreeCString(ctx, name);
            return table[i].prm;
        }
    }
    JS_FreeCString(ctx, name);
    JS_ThrowRangeError(ctx, "unknown SLH-DSA parameter set");
    return NULL;
}

static JSValue fg_pqc_slh_keypair(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const slh_param_t *prm;
    size_t skn, pkn, n;
    uint8_t *a, *b, *c, *sk, pk[64];
    JSValue result;
    if (argc < 4) return JS_ThrowTypeError(ctx, "pqcSlhKeypair(name, skSeed, skPrf, pkSeed)");
    prm = fg_slh_params(ctx, argv[0]);
    if (!prm) return JS_EXCEPTION;
    skn = slh_sk_sz(prm);
    pkn = slh_pk_sz(prm);
    n = pkn / 2;
    a = fg_arg_bytes(ctx, argv[1], n, 0, "skSeed", NULL);
    b = a ? fg_arg_bytes(ctx, argv[2], n, 0, "skPrf", NULL) : NULL;
    c = b ? fg_arg_bytes(ctx, argv[3], n, 0, "pkSeed", NULL) : NULL;
    if (!a || !b || !c) return JS_EXCEPTION;
    sk = malloc(skn);
    if (!sk) return JS_ThrowOutOfMemory(ctx);
    if (slh_keygen_internal(sk, pk, a, b, c, prm) != 0) {
        free(sk);
        return JS_ThrowInternalError(ctx, "SLH-DSA key generation failed");
    }
    result = fg_result(ctx, sk, skn);
    memset(sk, 0, skn);
    free(sk);
    return result;
}

static JSValue fg_pqc_slh_sign(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const slh_param_t *prm;
    size_t skn, sgn, mn, cn;
    uint8_t *sk, *msg, *cx, *rnd, *sig;
    size_t got;
    JSValue result;
    if (argc < 5) return JS_ThrowTypeError(ctx, "pqcSlhSign(name, sk, message, context, rnd)");
    prm = fg_slh_params(ctx, argv[0]);
    if (!prm) return JS_EXCEPTION;
    skn = slh_sk_sz(prm);
    sgn = slh_sig_sz(prm);
    sk = fg_arg_bytes(ctx, argv[1], skn, 0, "secret key", NULL);
    msg = sk ? JS_GetUint8Array(ctx, &mn, argv[2]) : NULL;
    cx = msg ? JS_GetUint8Array(ctx, &cn, argv[3]) : NULL;
    rnd = cx ? fg_arg_bytes(ctx, argv[4], skn / 4, 0, "rnd", NULL) : NULL;
    if (!sk || !msg || !cx || !rnd) return JS_EXCEPTION;
    if (cn > 255) return JS_ThrowRangeError(ctx, "context is at most 255 bytes");
    sig = malloc(sgn);
    if (!sig) return JS_ThrowOutOfMemory(ctx);
    got = slh_sign(sig, msg, mn, cx, cn, sk, rnd, prm);
    result = got == sgn ? fg_result(ctx, sig, sgn) : JS_NULL;
    free(sig);
    return result;
}

static JSValue fg_pqc_slh_verify(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const slh_param_t *prm;
    size_t pkn, mn, cn, sn;
    uint8_t *pk, *msg, *cx, *sig;
    if (argc < 5) return JS_ThrowTypeError(ctx, "pqcSlhVerify(name, pk, message, context, signature)");
    prm = fg_slh_params(ctx, argv[0]);
    if (!prm) return JS_EXCEPTION;
    pkn = slh_pk_sz(prm);
    pk = fg_arg_bytes(ctx, argv[1], pkn, 0, "public key", NULL);
    msg = pk ? JS_GetUint8Array(ctx, &mn, argv[2]) : NULL;
    cx = msg ? JS_GetUint8Array(ctx, &cn, argv[3]) : NULL;
    sig = cx ? JS_GetUint8Array(ctx, &sn, argv[4]) : NULL;
    if (!pk || !msg || !cx || !sig) return JS_EXCEPTION;
    if (cn > 255 || sn != slh_sig_sz(prm)) return JS_FALSE;
    return JS_NewBool(ctx, slh_verify(msg, mn, sig, sn, cx, cn, pk, prm) == 1);
}

const JSCFunctionListEntry graak_pqc_funcs[] = {
    JS_CFUNC_DEF("pqcKemKeypair", 2, fg_pqc_kem_keypair),
    JS_CFUNC_DEF("pqcKemEnc", 3, fg_pqc_kem_enc),
    JS_CFUNC_DEF("pqcKemDec", 3, fg_pqc_kem_dec),
    JS_CFUNC_DEF("pqcDsaKeypair", 2, fg_pqc_dsa_keypair),
    JS_CFUNC_DEF("pqcDsaSign", 5, fg_pqc_dsa_sign),
    JS_CFUNC_DEF("pqcDsaVerify", 5, fg_pqc_dsa_verify),
    JS_CFUNC_DEF("pqcSlhKeypair", 4, fg_pqc_slh_keypair),
    JS_CFUNC_DEF("pqcSlhSign", 5, fg_pqc_slh_sign),
    JS_CFUNC_DEF("pqcSlhVerify", 5, fg_pqc_slh_verify),
};
const size_t graak_pqc_funcs_count = sizeof(graak_pqc_funcs) / sizeof(graak_pqc_funcs[0]);
