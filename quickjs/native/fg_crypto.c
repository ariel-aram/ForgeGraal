/*
 * The rest of the host's cryptography: Brotli, asymmetric keys (generate, inspect, RSA encrypt/decrypt, PSS), ECDH,
 * primes and X.509 inspection. `node:crypto`, `node:zlib` and `node:tls` are built on these in JavaScript
 * (quickjs/runtime/node-crypto2.js, native-modules.js).
 *
 * Keys cross the boundary as PEM strings or DER byte arrays and are parsed per call, like the existing pkSign: no
 * pointer ever reaches JavaScript. Errors carry the mbedTLS message and are given Node's codes by the caller.
 */

#define MBEDTLS_ALLOW_PRIVATE_ACCESS

#include "quickjs.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <brotli/decode.h>
#include <brotli/encode.h>

#include "mbedtls/bignum.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecp.h"
#include "mbedtls/error.h"
#include "mbedtls/md.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/rsa.h"
#include "mbedtls/x509_crt.h"

extern mbedtls_ctr_drbg_context fg_drbg;
extern int fg_rng_init(void);
extern const char graak_ca_bundle[];

/* ------------------------------------------------------------------ helpers */

static JSValue fg_c_throw(JSContext *ctx, const char *code, const char *what, int mbed)
{
    char buf[160];
    char message[320];
    JSValue err = JS_NewError(ctx);
    if (mbed) {
        mbedtls_strerror(mbed, buf, sizeof(buf));
        snprintf(message, sizeof(message), "%s: %s", what, buf);
        JS_SetPropertyStr(ctx, err, "mbedtls", JS_NewInt32(ctx, mbed));
    } else {
        snprintf(message, sizeof(message), "%s", what);
    }
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message));
    JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, code));
    return JS_Throw(ctx, err);
}

static mbedtls_md_type_t fg_c_md(const char *name)
{
    if (!strcmp(name, "sha1")) return MBEDTLS_MD_SHA1;
    if (!strcmp(name, "sha224")) return MBEDTLS_MD_SHA224;
    if (!strcmp(name, "sha256")) return MBEDTLS_MD_SHA256;
    if (!strcmp(name, "sha384")) return MBEDTLS_MD_SHA384;
    if (!strcmp(name, "sha512")) return MBEDTLS_MD_SHA512;
    if (!strcmp(name, "md5")) return MBEDTLS_MD_MD5;
    return MBEDTLS_MD_NONE;
}

/* Bytes of an argument that is a string (PEM: the terminating NUL is counted, as mbedTLS wants) or a Uint8Array
   (DER). The string form is freed by fg_c_release. */
typedef struct {
    const unsigned char *p;
    size_t len;
    const char *str;
    JSContext *ctx;
} fg_c_input;

static int fg_c_input_get(JSContext *ctx, JSValueConst v, fg_c_input *in)
{
    memset(in, 0, sizeof(*in));
    in->ctx = ctx;
    if (JS_IsString(v)) {
        size_t n = 0;
        in->str = JS_ToCStringLen(ctx, &n, v);
        if (!in->str) return -1;
        in->p = (const unsigned char *) in->str;
        in->len = n + 1;
        return 0;
    }
    {
        size_t n = 0;
        uint8_t *b = JS_GetUint8Array(ctx, &n, v);
        if (!b) return -1;
        in->p = b;
        in->len = n;
    }
    return 0;
}

static void fg_c_release(fg_c_input *in)
{
    if (in->str) JS_FreeCString(in->ctx, in->str);
}

/* A key of any kind: private, public, or the public key of a certificate. */
typedef struct {
    mbedtls_pk_context own;
    mbedtls_x509_crt crt;
    mbedtls_pk_context *pk;
    int is_private;
} fg_c_key;

static void fg_c_key_free(fg_c_key *k)
{
    mbedtls_pk_free(&k->own);
    mbedtls_x509_crt_free(&k->crt);
}

static int fg_c_key_load(fg_c_key *k, const unsigned char *p, size_t len, const char *pass, int want_private)
{
    int ret;
    memset(k, 0, sizeof(*k));
    mbedtls_pk_init(&k->own);
    mbedtls_x509_crt_init(&k->crt);
    fg_rng_init();
    ret = mbedtls_pk_parse_key(&k->own, p, len, (const unsigned char *) pass, pass ? strlen(pass) : 0,
                               mbedtls_ctr_drbg_random, &fg_drbg);
    if (ret == 0) {
        k->pk = &k->own;
        k->is_private = 1;
        return 0;
    }
    if (want_private) return ret;
    mbedtls_pk_free(&k->own);
    mbedtls_pk_init(&k->own);
    ret = mbedtls_pk_parse_public_key(&k->own, p, len);
    if (ret == 0) {
        k->pk = &k->own;
        return 0;
    }
    mbedtls_pk_free(&k->own);
    mbedtls_pk_init(&k->own);
    ret = mbedtls_x509_crt_parse(&k->crt, p, len);
    if (ret == 0) {
        k->pk = &k->crt.pk;
        return 0;
    }
    return ret;
}

static JSValue fg_c_bytes(JSContext *ctx, const unsigned char *p, size_t n)
{
    return JS_NewUint8ArrayCopy(ctx, p, n);
}

static JSValue fg_c_mpi(JSContext *ctx, const mbedtls_mpi *m)
{
    size_t n = mbedtls_mpi_size(m);
    unsigned char *buf = malloc(n ? n : 1);
    JSValue v;
    if (!buf) return JS_ThrowOutOfMemory(ctx);
    mbedtls_mpi_write_binary(m, buf, n);
    v = fg_c_bytes(ctx, buf, n);
    free(buf);
    return v;
}

/* ------------------------------------------------------------------ Brotli */

/* brotliCompress(bytes, quality, lgwin, mode) */
static JSValue fg_brotli_compress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, outlen;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    int32_t quality = 11, lgwin = 22, mode = 0;
    uint8_t *out;
    JSValue v;

    if (!in) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &quality, argv[1]);
    if (argc > 2) JS_ToInt32(ctx, &lgwin, argv[2]);
    if (argc > 3) JS_ToInt32(ctx, &mode, argv[3]);
    cap = BrotliEncoderMaxCompressedSize(n);
    if (cap == 0) cap = n + 1024;
    out = malloc(cap);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    outlen = cap;
    if (!BrotliEncoderCompress(quality, lgwin, (BrotliEncoderMode) mode, n, in, &outlen, out)) {
        free(out);
        return fg_c_throw(ctx, "ERR_BROTLI_COMPRESSION_FAILED", "Compression failed", 0);
    }
    v = fg_c_bytes(ctx, out, outlen);
    free(out);
    return v;
}

/* brotliDecompress(bytes, maxOutputLength) */
static JSValue fg_brotli_decompress(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0, cap, used = 0;
    uint8_t *in = JS_GetUint8Array(ctx, &n, argv[0]);
    double max_out = 0;
    BrotliDecoderState *st;
    BrotliDecoderResult r;
    const uint8_t *next_in;
    size_t avail_in;
    uint8_t *out;
    JSValue v;

    if (!in) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1])) JS_ToFloat64(ctx, &max_out, argv[1]);
    st = BrotliDecoderCreateInstance(NULL, NULL, NULL);
    if (!st) return JS_ThrowOutOfMemory(ctx);
    cap = n * 4 + 4096;
    out = malloc(cap);
    if (!out) {
        BrotliDecoderDestroyInstance(st);
        return JS_ThrowOutOfMemory(ctx);
    }
    next_in = in;
    avail_in = n;
    for (;;) {
        size_t avail_out = cap - used;
        uint8_t *next_out = out + used;
        r = BrotliDecoderDecompressStream(st, &avail_in, &next_in, &avail_out, &next_out, NULL);
        used = cap - avail_out;
        if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
            uint8_t *bigger;
            if (max_out > 0 && (double) used >= max_out) {
                free(out);
                BrotliDecoderDestroyInstance(st);
                return fg_c_throw(ctx, "ERR_BUFFER_TOO_LARGE", "Cannot create a Buffer larger than the maxOutputLength", 0);
            }
            cap *= 2;
            bigger = realloc(out, cap);
            if (!bigger) {
                free(out);
                BrotliDecoderDestroyInstance(st);
                return JS_ThrowOutOfMemory(ctx);
            }
            out = bigger;
            continue;
        }
        break;
    }
    if (r != BROTLI_DECODER_RESULT_SUCCESS) {
        BrotliDecoderErrorCode code = BrotliDecoderGetErrorCode(st);
        char name[96];
        JSValue err = JS_NewError(ctx);
        const char *what = r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT ? "unexpected end of file" : "Decompression failed";
        snprintf(name, sizeof(name), "ERR_%s", BrotliDecoderErrorString(code));
        if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) snprintf(name, sizeof(name), "%s", "Z_BUF_ERROR");
        JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, what));
        JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, name));
        JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT ? -5 : (int) code));
        free(out);
        BrotliDecoderDestroyInstance(st);
        return JS_Throw(ctx, err);
    }
    BrotliDecoderDestroyInstance(st);
    v = fg_c_bytes(ctx, out, used);
    free(out);
    return v;
}

/* ------------------------------------------------------------------ X.509 */

static void fg_c_set_time(JSContext *ctx, JSValueConst obj, const char *name, const mbedtls_x509_time *t)
{
    char buf[40];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", t->year, t->mon, t->day, t->hour, t->min, t->sec);
    JS_SetPropertyStr(ctx, obj, name, JS_NewString(ctx, buf));
}

static JSValue fg_c_dn(JSContext *ctx, const mbedtls_x509_name *name)
{
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (; name; name = name->next) {
        const char *short_name = NULL;
        char oidbuf[64];
        JSValue pair = JS_NewArray(ctx);
        if (mbedtls_oid_get_attr_short_name(&name->oid, &short_name) != 0 || !short_name) {
            if (mbedtls_oid_get_numeric_string(oidbuf, sizeof(oidbuf), &name->oid) < 0) oidbuf[0] = 0;
            short_name = oidbuf;
        }
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, short_name));
        JS_SetPropertyUint32(ctx, pair, 1, JS_NewStringLen(ctx, (const char *) name->val.p, name->val.len));
        JS_SetPropertyUint32(ctx, arr, i++, pair);
    }
    return arr;
}

static const char *fg_c_curve_name(mbedtls_ecp_group_id id)
{
    const mbedtls_ecp_curve_info *info = mbedtls_ecp_curve_info_from_grp_id(id);
    return info ? info->name : "unknown";
}

static void fg_c_describe_pk(JSContext *ctx, JSValueConst obj, mbedtls_pk_context *pk)
{
    mbedtls_pk_type_t t = mbedtls_pk_get_type(pk);
    JS_SetPropertyStr(ctx, obj, "bits", JS_NewInt32(ctx, (int) mbedtls_pk_get_bitlen(pk)));
    if (t == MBEDTLS_PK_RSA || t == MBEDTLS_PK_RSASSA_PSS) {
        mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*pk);
        mbedtls_mpi n, e;
        mbedtls_mpi_init(&n);
        mbedtls_mpi_init(&e);
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, t == MBEDTLS_PK_RSA ? "rsa" : "rsa-pss"));
        if (mbedtls_rsa_export(rsa, &n, NULL, NULL, NULL, &e) == 0) {
            JS_SetPropertyStr(ctx, obj, "modulus", fg_c_mpi(ctx, &n));
            JS_SetPropertyStr(ctx, obj, "exponent", fg_c_mpi(ctx, &e));
        }
        mbedtls_mpi_free(&n);
        mbedtls_mpi_free(&e);
    } else if (t == MBEDTLS_PK_ECKEY || t == MBEDTLS_PK_ECKEY_DH || t == MBEDTLS_PK_ECDSA) {
        mbedtls_ecp_keypair *ec = mbedtls_pk_ec(*pk);
        unsigned char pub[133];
        size_t plen = 0;
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, "ec"));
        JS_SetPropertyStr(ctx, obj, "curve", JS_NewString(ctx, fg_c_curve_name(ec->grp.id)));
        if (mbedtls_ecp_point_write_binary(&ec->grp, &ec->Q, MBEDTLS_ECP_PF_UNCOMPRESSED, &plen, pub, sizeof(pub)) == 0) {
            JS_SetPropertyStr(ctx, obj, "point", fg_c_bytes(ctx, pub, plen));
        }
    } else {
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, mbedtls_pk_get_name(pk)));
    }
}

/* x509Info(pemOrDer) -> the fields Node's certificate objects expose. */
static JSValue fg_x509_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input in;
    mbedtls_x509_crt crt;
    JSValue o, arr, ku;
    const mbedtls_x509_sequence *seq;
    uint32_t i;
    int ret;
    char buf[128];

    if (fg_c_input_get(ctx, argv[0], &in)) return JS_EXCEPTION;
    mbedtls_x509_crt_init(&crt);
    ret = mbedtls_x509_crt_parse(&crt, in.p, in.len);
    fg_c_release(&in);
    if (ret != 0) {
        mbedtls_x509_crt_free(&crt);
        return fg_c_throw(ctx, "ERR_OSSL_PEM_NO_START_LINE", "Certificate", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "version", JS_NewInt32(ctx, crt.version));
    {
        char hex[2 * 32 + 1];
        size_t j, n = crt.serial.len > 32 ? 32 : crt.serial.len;
        for (j = 0; j < n; j++) snprintf(hex + 2 * j, 3, "%02X", crt.serial.p[j]);
        hex[2 * n] = 0;
        JS_SetPropertyStr(ctx, o, "serial", JS_NewString(ctx, hex));
    }
    JS_SetPropertyStr(ctx, o, "subject", fg_c_dn(ctx, &crt.subject));
    JS_SetPropertyStr(ctx, o, "issuer", fg_c_dn(ctx, &crt.issuer));
    fg_c_set_time(ctx, o, "validFrom", &crt.valid_from);
    fg_c_set_time(ctx, o, "validTo", &crt.valid_to);
    JS_SetPropertyStr(ctx, o, "raw", fg_c_bytes(ctx, crt.raw.p, crt.raw.len));
    JS_SetPropertyStr(ctx, o, "ca", JS_NewBool(ctx, crt.ext_types & MBEDTLS_X509_EXT_BASIC_CONSTRAINTS ? crt.ca_istrue : 0));
    if (mbedtls_oid_get_numeric_string(buf, sizeof(buf), &crt.sig_oid) > 0) {
        JS_SetPropertyStr(ctx, o, "signatureOid", JS_NewString(ctx, buf));
    }
    /* Subject alternative names: [[kind, value], ...] */
    arr = JS_NewArray(ctx);
    i = 0;
    for (seq = &crt.subject_alt_names; seq && seq->buf.p; seq = seq->next) {
        int tag = seq->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
        JSValue pair = JS_NewArray(ctx);
        const char *kind = NULL;
        JSValue value = JS_UNDEFINED;
        if (tag == 2) kind = "DNS";
        else if (tag == 1) kind = "email";
        else if (tag == 6) kind = "URI";
        else if (tag == 7) kind = "IP Address";
        if (!kind) {
            JS_FreeValue(ctx, pair);
            continue;
        }
        if (tag == 7) {
            char ip[64];
            size_t j, pos = 0;
            if (seq->buf.len == 4) {
                snprintf(ip, sizeof(ip), "%u.%u.%u.%u", seq->buf.p[0], seq->buf.p[1], seq->buf.p[2], seq->buf.p[3]);
            } else {
                for (j = 0; j + 1 < seq->buf.len && pos + 6 < sizeof(ip); j += 2) {
                    pos += (size_t) snprintf(ip + pos, sizeof(ip) - pos, "%s%X", j ? ":" : "",
                                             (seq->buf.p[j] << 8) | seq->buf.p[j + 1]);
                }
                ip[pos] = 0;
            }
            value = JS_NewString(ctx, ip);
        } else {
            value = JS_NewStringLen(ctx, (const char *) seq->buf.p, seq->buf.len);
        }
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, kind));
        JS_SetPropertyUint32(ctx, pair, 1, value);
        JS_SetPropertyUint32(ctx, arr, i++, pair);
    }
    JS_SetPropertyStr(ctx, o, "altNames", arr);
    /* Extended key usage as dotted OIDs. */
    ku = JS_NewArray(ctx);
    i = 0;
    for (seq = &crt.ext_key_usage; seq && seq->buf.p; seq = seq->next) {
        if (mbedtls_oid_get_numeric_string(buf, sizeof(buf), &seq->buf) > 0) {
            JS_SetPropertyUint32(ctx, ku, i++, JS_NewString(ctx, buf));
        }
    }
    JS_SetPropertyStr(ctx, o, "extKeyUsage", ku);
    fg_c_describe_pk(ctx, o, &crt.pk);
    {
        unsigned char spki[2048];
        int n = mbedtls_pk_write_pubkey_der(&crt.pk, spki, sizeof(spki));
        if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, spki + sizeof(spki) - n, (size_t) n));
    }
    mbedtls_x509_crt_free(&crt);
    return o;
}

/* x509CheckIssued(certDer, issuerDer) -> whether issuer's key signed cert (time is ignored). */
static JSValue fg_x509_check_issued(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input a, b;
    mbedtls_x509_crt child, parent;
    int ret, ok;

    if (fg_c_input_get(ctx, argv[0], &a)) return JS_EXCEPTION;
    if (fg_c_input_get(ctx, argv[1], &b)) {
        fg_c_release(&a);
        return JS_EXCEPTION;
    }
    mbedtls_x509_crt_init(&child);
    mbedtls_x509_crt_init(&parent);
    ret = mbedtls_x509_crt_parse(&child, a.p, a.len);
    if (ret == 0) ret = mbedtls_x509_crt_parse(&parent, b.p, b.len);
    fg_c_release(&a);
    fg_c_release(&b);
    if (ret != 0) {
        mbedtls_x509_crt_free(&child);
        mbedtls_x509_crt_free(&parent);
        return fg_c_throw(ctx, "ERR_OSSL_PEM_NO_START_LINE", "Certificate", ret);
    }
    /* The issuer's name matches and its key made the signature; validity dates are not looked at. */
    ok = child.issuer_raw.len == parent.subject_raw.len && memcmp(child.issuer_raw.p, parent.subject_raw.p, parent.subject_raw.len) == 0;
    if (ok) {
        const mbedtls_md_info_t *info = mbedtls_md_info_from_type(child.sig_md);
        unsigned char hash[64];
        ok = info && mbedtls_md(info, child.tbs.p, child.tbs.len, hash) == 0 &&
             mbedtls_pk_verify_ext(child.sig_pk, child.sig_opts, &parent.pk, child.sig_md, hash, mbedtls_md_get_size(info),
                                   child.sig.p, child.sig.len) == 0;
    }
    mbedtls_x509_crt_free(&child);
    mbedtls_x509_crt_free(&parent);
    return JS_NewBool(ctx, ok);
}

/* keyMatchesCert(certPem, keyPem, passphrase) */
static JSValue fg_key_matches_cert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input a, b;
    const char *pass = NULL;
    fg_c_key pub, priv;
    int ret, ok = 0;

    if (fg_c_input_get(ctx, argv[0], &a)) return JS_EXCEPTION;
    if (fg_c_input_get(ctx, argv[1], &b)) {
        fg_c_release(&a);
        return JS_EXCEPTION;
    }
    if (argc > 2 && JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    ret = fg_c_key_load(&pub, a.p, a.len, NULL, 0);
    if (ret == 0) {
        ret = fg_c_key_load(&priv, b.p, b.len, pass, 1);
        if (ret == 0) {
            ok = mbedtls_pk_check_pair(pub.pk, priv.pk, mbedtls_ctr_drbg_random, &fg_drbg) == 0;
            fg_c_key_free(&priv);
        }
        fg_c_key_free(&pub);
    }
    fg_c_release(&a);
    fg_c_release(&b);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "key", ret);
    return JS_NewBool(ctx, ok);
}

/* ------------------------------------------------------------------ keys */

/* keyInfo(pemOrDer, passphrase, wantPrivate) -> { private, type, bits, ..., spki, pkcs (private DER) } */
static JSValue fg_key_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    fg_c_input in;
    fg_c_key k;
    const char *pass = NULL;
    int want_private = argc > 2 && JS_ToBool(ctx, argv[2]);
    int ret;
    JSValue o;
    unsigned char der[8192];
    int n;

    if (fg_c_input_get(ctx, argv[0], &in)) return JS_EXCEPTION;
    if (argc > 1 && JS_IsString(argv[1])) pass = JS_ToCString(ctx, argv[1]);
    ret = fg_c_key_load(&k, in.p, in.len, pass, want_private);
    fg_c_release(&in);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) {
        const char *code = ret == MBEDTLS_ERR_PK_PASSWORD_REQUIRED ? "ERR_MISSING_PASSPHRASE"
                           : ret == MBEDTLS_ERR_PK_PASSWORD_MISMATCH ? "ERR_OSSL_BAD_DECRYPT"
                                                                      : "ERR_OSSL_UNSUPPORTED";
        return fg_c_throw(ctx, code, "error:1E08010C:DECODER routines::unsupported", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "private", JS_NewBool(ctx, k.is_private));
    fg_c_describe_pk(ctx, o, k.pk);
    n = mbedtls_pk_write_pubkey_der(k.pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    if (k.is_private) {
        n = mbedtls_pk_write_key_der(k.pk, der, sizeof(der));
        if (n > 0) JS_SetPropertyStr(ctx, o, "pkcs", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    }
    fg_c_key_free(&k);
    return o;
}

/* generateKey("rsa", bits, exponent) or ("ec", curveName) -> { pkcs (private DER: PKCS#1 / SEC1), spki } */
static int fg_c_curve_id(const char *name, mbedtls_ecp_group_id *id)
{
    static const struct { const char *alias; const char *canonical; } aliases[] = {
        {"prime256v1", "secp256r1"}, {"P-256", "secp256r1"}, {"P-384", "secp384r1"}, {"P-521", "secp521r1"},
        {"prime192v1", "secp192r1"}, {"X25519", "x25519"},   {"x25519", "x25519"},
    };
    const mbedtls_ecp_curve_info *info;
    size_t i;
    for (i = 0; i < sizeof(aliases) / sizeof(aliases[0]); i++) {
        if (!strcmp(name, aliases[i].alias)) {
            name = aliases[i].canonical;
            break;
        }
    }
    info = mbedtls_ecp_curve_info_from_name(name);
    if (!info) return -1;
    *id = info->grp_id;
    return 0;
}

static JSValue fg_generate_key(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *kind = JS_ToCString(ctx, argv[0]);
    mbedtls_pk_context pk;
    unsigned char der[8192];
    int ret = 0, n;
    JSValue o;

    if (!kind) return JS_EXCEPTION;
    fg_rng_init();
    mbedtls_pk_init(&pk);
    if (!strcmp(kind, "rsa")) {
        int32_t bits = 2048, exponent = 65537;
        if (argc > 1) JS_ToInt32(ctx, &bits, argv[1]);
        if (argc > 2 && !JS_IsUndefined(argv[2])) JS_ToInt32(ctx, &exponent, argv[2]);
        ret = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA));
        if (ret == 0) ret = mbedtls_rsa_gen_key(mbedtls_pk_rsa(pk), mbedtls_ctr_drbg_random, &fg_drbg, (unsigned) bits, exponent);
    } else if (!strcmp(kind, "ec")) {
        const char *curve = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;
        mbedtls_ecp_group_id gid;
        if (!curve || fg_c_curve_id(curve, &gid) != 0 || gid == MBEDTLS_ECP_DP_CURVE25519 || gid == MBEDTLS_ECP_DP_CURVE448) {
            if (curve) JS_FreeCString(ctx, curve);
            JS_FreeCString(ctx, kind);
            mbedtls_pk_free(&pk);
            return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
        }
        JS_FreeCString(ctx, curve);
        ret = mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY));
        if (ret == 0) ret = mbedtls_ecp_gen_key(gid, mbedtls_pk_ec(pk), mbedtls_ctr_drbg_random, &fg_drbg);
    } else {
        JS_FreeCString(ctx, kind);
        mbedtls_pk_free(&pk);
        return fg_c_throw(ctx, "ERR_INVALID_ARG_VALUE", "unsupported key type", 0);
    }
    JS_FreeCString(ctx, kind);
    if (ret != 0) {
        mbedtls_pk_free(&pk);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "key generation", ret);
    }
    o = JS_NewObject(ctx);
    n = mbedtls_pk_write_key_der(&pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "pkcs", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    n = mbedtls_pk_write_pubkey_der(&pk, der, sizeof(der));
    if (n > 0) JS_SetPropertyStr(ctx, o, "spki", fg_c_bytes(ctx, der + sizeof(der) - n, (size_t) n));
    mbedtls_pk_free(&pk);
    return o;
}

/* rsaCrypt(op, key, passphrase, data, padding, hash, label)
   op: 0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt, 3 publicDecrypt. padding: 1 PKCS#1 v1.5, 4 OAEP. */
static JSValue fg_rsa_crypt(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t op = 0, padding = 4;
    fg_c_input key;
    fg_c_key k;
    const char *pass = NULL, *hash = NULL;
    size_t dlen = 0, llen = 0, olen = 0;
    uint8_t *data;
    const unsigned char *label = NULL;
    unsigned char *out;
    mbedtls_rsa_context *rsa;
    int ret;
    JSValue v;

    JS_ToInt32(ctx, &op, argv[0]);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    if (JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    data = JS_GetUint8Array(ctx, &dlen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5 && JS_IsString(argv[5])) hash = JS_ToCString(ctx, argv[5]);
    if (argc > 6 && !JS_IsUndefined(argv[6]) && !JS_IsNull(argv[6])) label = JS_GetUint8Array(ctx, &llen, argv[6]);
    if (!data) {
        fg_c_release(&key);
        if (pass) JS_FreeCString(ctx, pass);
        if (hash) JS_FreeCString(ctx, hash);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, pass, op == 1 || op == 2);
    fg_c_release(&key);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) {
        if (hash) JS_FreeCString(ctx, hash);
        return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "key", ret);
    }
    if (mbedtls_pk_get_type(k.pk) != MBEDTLS_PK_RSA) {
        fg_c_key_free(&k);
        if (hash) JS_FreeCString(ctx, hash);
        return fg_c_throw(ctx, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "not an RSA key", 0);
    }
    rsa = mbedtls_pk_rsa(*k.pk);
    {
        mbedtls_md_type_t md = hash ? fg_c_md(hash) : MBEDTLS_MD_SHA1;
        if (md == MBEDTLS_MD_NONE) md = MBEDTLS_MD_SHA1;
        if (padding == 4) {
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
        } else {
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE);
        }
    }
    if (hash) JS_FreeCString(ctx, hash);
    olen = mbedtls_rsa_get_len(rsa);
    out = malloc(olen ? olen : 1);
    if (!out) {
        fg_c_key_free(&k);
        return JS_ThrowOutOfMemory(ctx);
    }
    if (op == 0) {
        ret = padding == 4 ? mbedtls_rsa_rsaes_oaep_encrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, label, llen, dlen, data, out)
                           : mbedtls_rsa_rsaes_pkcs1_v15_encrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, dlen, data, out);
    } else if (op == 1) {
        size_t got = 0;
        ret = padding == 4 ? mbedtls_rsa_rsaes_oaep_decrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, label, llen, &got, data, out, olen)
                           : mbedtls_rsa_rsaes_pkcs1_v15_decrypt(rsa, mbedtls_ctr_drbg_random, &fg_drbg, &got, data, out, olen);
        if (ret == 0) olen = got;
    } else if (op == 2) {
        ret = mbedtls_rsa_pkcs1_sign(rsa, mbedtls_ctr_drbg_random, &fg_drbg, MBEDTLS_MD_NONE, dlen, data, out);
    } else {
        size_t got = 0;
        /* publicDecrypt: raw public operation, then strip the type 1 padding. */
        unsigned char *raw = malloc(olen);
        if (!raw || dlen != olen) {
            free(raw);
            ret = MBEDTLS_ERR_RSA_BAD_INPUT_DATA;
        } else {
            ret = mbedtls_rsa_public(rsa, data, raw);
            if (ret == 0) {
                size_t i = 2;
                if (raw[0] != 0 || raw[1] != 1) {
                    ret = MBEDTLS_ERR_RSA_INVALID_PADDING;
                } else {
                    while (i < olen && raw[i] == 0xff) i++;
                    if (i >= olen || raw[i] != 0) {
                        ret = MBEDTLS_ERR_RSA_INVALID_PADDING;
                    } else {
                        got = olen - i - 1;
                        memcpy(out, raw + i + 1, got);
                        olen = got;
                    }
                }
            }
            free(raw);
        }
    }
    fg_c_key_free(&k);
    if (ret != 0) {
        free(out);
        return fg_c_throw(ctx, op == 1 || op == 3 ? "ERR_OSSL_RSA_OAEP_DECODING_ERROR" : "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
                          op == 1 || op == 3 ? "error:02000079:rsa routines::oaep decoding error" : "RSA operation", ret);
    }
    v = fg_c_bytes(ctx, out, olen);
    free(out);
    return v;
}

/* pkSignEx(hash, key, passphrase, data, padding, saltLen): padding 0 PKCS#1 v1.5 / ECDSA (DER), 1 PSS. */
static JSValue fg_pk_sign_ex(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *hash = JS_ToCString(ctx, argv[0]);
    const char *pass = NULL;
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, siglen = 0;
    uint8_t *data;
    unsigned char digest[64], sig[MBEDTLS_PK_SIGNATURE_MAX_SIZE];
    int32_t padding = 0, salt = -1;
    mbedtls_md_type_t md;
    int ret;

    if (!hash) return JS_EXCEPTION;
    md = fg_c_md(hash);
    JS_FreeCString(ctx, hash);
    if (md == MBEDTLS_MD_NONE) return fg_c_throw(ctx, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest", 0);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    if (JS_IsString(argv[2])) pass = JS_ToCString(ctx, argv[2]);
    data = JS_GetUint8Array(ctx, &dlen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5) JS_ToInt32(ctx, &salt, argv[5]);
    if (!data) {
        fg_c_release(&key);
        if (pass) JS_FreeCString(ctx, pass);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, pass, 1);
    fg_c_release(&key);
    if (pass) JS_FreeCString(ctx, pass);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "private key", ret);
    ret = mbedtls_md(mbedtls_md_info_from_type(md), data, dlen, digest);
    if (ret == 0) {
        size_t hlen = mbedtls_md_get_size(mbedtls_md_info_from_type(md));
        if (padding == 1 && mbedtls_pk_get_type(k.pk) == MBEDTLS_PK_RSA) {
            mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*k.pk);
            size_t klen = mbedtls_rsa_get_len(rsa);
            int use_salt = salt;
            if (salt == -1) use_salt = (int) hlen;                 /* RSA_PSS_SALTLEN_DIGEST */
            else if (salt < 0) use_salt = (int) (klen - hlen - 2); /* RSA_PSS_SALTLEN_MAX_SIGN */
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
            ret = mbedtls_rsa_rsassa_pss_sign_ext(rsa, mbedtls_ctr_drbg_random, &fg_drbg, md, (unsigned) hlen, digest,
                                                  use_salt, sig);
            siglen = klen;
        } else {
            ret = mbedtls_pk_sign(k.pk, md, digest, hlen, sig, sizeof(sig), &siglen, mbedtls_ctr_drbg_random, &fg_drbg);
        }
    }
    fg_c_key_free(&k);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", "sign", ret);
    return fg_c_bytes(ctx, sig, siglen);
}

/* pkVerifyEx(hash, key, data, signature, padding, saltLen) */
static JSValue fg_pk_verify_ex(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *hash = JS_ToCString(ctx, argv[0]);
    fg_c_input key;
    fg_c_key k;
    size_t dlen = 0, slen = 0;
    uint8_t *data, *sig;
    unsigned char digest[64];
    int32_t padding = 0, salt = -1;
    mbedtls_md_type_t md;
    int ret, ok = 0;

    if (!hash) return JS_EXCEPTION;
    md = fg_c_md(hash);
    JS_FreeCString(ctx, hash);
    if (md == MBEDTLS_MD_NONE) return fg_c_throw(ctx, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest", 0);
    if (fg_c_input_get(ctx, argv[1], &key)) return JS_EXCEPTION;
    data = JS_GetUint8Array(ctx, &dlen, argv[2]);
    sig = JS_GetUint8Array(ctx, &slen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &padding, argv[4]);
    if (argc > 5) JS_ToInt32(ctx, &salt, argv[5]);
    if (!data || !sig) {
        fg_c_release(&key);
        return JS_EXCEPTION;
    }
    ret = fg_c_key_load(&k, key.p, key.len, NULL, 0);
    fg_c_release(&key);
    if (ret != 0) return fg_c_throw(ctx, "ERR_OSSL_UNSUPPORTED", "public key", ret);
    if (mbedtls_md(mbedtls_md_info_from_type(md), data, dlen, digest) == 0) {
        size_t hlen = mbedtls_md_get_size(mbedtls_md_info_from_type(md));
        if (padding == 1 && mbedtls_pk_get_type(k.pk) == MBEDTLS_PK_RSA) {
            mbedtls_rsa_context *rsa = mbedtls_pk_rsa(*k.pk);
            size_t klen = mbedtls_rsa_get_len(rsa);
            int use_salt = salt;
            if (salt == -1) use_salt = (int) hlen;
            else if (salt < 0) use_salt = MBEDTLS_RSA_SALT_LEN_ANY;
            (void) klen;
            mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md);
            ok = mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, (unsigned) hlen, digest, md, use_salt, sig) == 0;
        } else {
            ok = mbedtls_pk_verify(k.pk, md, digest, hlen, sig, slen) == 0;
        }
    }
    fg_c_key_free(&k);
    return JS_NewBool(ctx, ok);
}

/* ------------------------------------------------------------------ ECDH */

static int fg_c_ec_grp(const char *name, mbedtls_ecp_group *grp)
{
    mbedtls_ecp_group_id id;
    if (fg_c_curve_id(name, &id) != 0) return -1;
    return mbedtls_ecp_group_load(grp, id);
}

/* ecdhGenerate(curve, privateBytes?) -> { priv, pub } (uncompressed point; the raw key for x25519) */
static JSValue fg_ecdh_generate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_mpi d;
    mbedtls_ecp_point q;
    unsigned char priv[80], pub[133];
    size_t plen = 0, publen = 0;
    int ret;
    JSValue o;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_ecp_point_init(&q);
    fg_rng_init();
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        size_t n = 0;
        uint8_t *given = JS_GetUint8Array(ctx, &n, argv[1]);
        if (!given) {
            ret = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
        } else if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
            ret = mbedtls_mpi_read_binary_le(&d, given, n);
            if (ret == 0) ret = mbedtls_ecp_check_privkey(&grp, &d);
        } else {
            ret = mbedtls_mpi_read_binary(&d, given, n);
            if (ret == 0) ret = mbedtls_ecp_check_privkey(&grp, &d);
        }
        if (ret == 0) ret = mbedtls_ecp_mul(&grp, &q, &d, &grp.G, mbedtls_ctr_drbg_random, &fg_drbg);
    } else {
        ret = mbedtls_ecdh_gen_public(&grp, &d, &q, mbedtls_ctr_drbg_random, &fg_drbg);
    }
    if (ret == 0) {
        plen = (grp.nbits + 7) / 8;
        if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
            ret = mbedtls_mpi_write_binary_le(&d, priv, plen);
        } else {
            ret = mbedtls_mpi_write_binary(&d, priv, plen);
        }
    }
    if (ret == 0) ret = mbedtls_ecp_point_write_binary(&grp, &q, MBEDTLS_ECP_PF_UNCOMPRESSED, &publen, pub, sizeof(pub));
    if (ret != 0) {
        mbedtls_ecp_group_free(&grp);
        mbedtls_mpi_free(&d);
        mbedtls_ecp_point_free(&q);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "ECDH key", ret);
    }
    o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "priv", fg_c_bytes(ctx, priv, plen));
    JS_SetPropertyStr(ctx, o, "pub", fg_c_bytes(ctx, pub, publen));
    mbedtls_ecp_group_free(&grp);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&q);
    return o;
}

/* ecdhCompute(curve, priv, peerPub) -> shared secret */
static JSValue fg_ecdh_compute(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_mpi d, z;
    mbedtls_ecp_point q;
    size_t pn = 0, qn = 0, zlen;
    uint8_t *priv, *peer;
    unsigned char out[80];
    int ret, stage = 0;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&z);
    mbedtls_ecp_point_init(&q);
    fg_rng_init();
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    priv = JS_GetUint8Array(ctx, &pn, argv[1]);
    peer = JS_GetUint8Array(ctx, &qn, argv[2]);
    if (!priv || !peer) {
        mbedtls_ecp_group_free(&grp);
        return JS_EXCEPTION;
    }
    if (mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY) {
        ret = mbedtls_mpi_read_binary_le(&d, priv, pn);
    } else {
        ret = mbedtls_mpi_read_binary(&d, priv, pn);
    }
    if (ret == 0) {
        ret = mbedtls_ecp_point_read_binary(&grp, &q, peer, qn);
        if (ret != 0) stage = 1;
    }
    if (ret == 0 && qn == 1) {
        ret = MBEDTLS_ERR_ECP_INVALID_KEY;
        stage = 1;
    }
    if (ret == 0) ret = mbedtls_ecp_check_pubkey(&grp, &q);
    if (ret == 0) ret = mbedtls_ecdh_compute_shared(&grp, &z, &q, &d, mbedtls_ctr_drbg_random, &fg_drbg);
    zlen = (grp.nbits + 7) / 8;
    if (ret == 0) {
        ret = mbedtls_ecp_get_type(&grp) == MBEDTLS_ECP_TYPE_MONTGOMERY ? mbedtls_mpi_write_binary_le(&z, out, zlen)
                                                                        : mbedtls_mpi_write_binary(&z, out, zlen);
    }
    mbedtls_ecp_group_free(&grp);
    mbedtls_mpi_free(&d);
    mbedtls_mpi_free(&z);
    mbedtls_ecp_point_free(&q);
    if (ret != 0) {
        if (stage == 1) return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "Failed to compute ECDH key", 0);
        return fg_c_throw(ctx, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve", 0);
    }
    return fg_c_bytes(ctx, out, zlen);
}

/* ecdhConvert(curve, point, format): 0 compressed, 1 uncompressed. Also validates the point. */
static JSValue fg_ecdh_convert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *curve = JS_ToCString(ctx, argv[0]);
    mbedtls_ecp_group grp;
    mbedtls_ecp_point q;
    size_t n = 0, outn = 0;
    uint8_t *pt;
    int32_t fmt = 1;
    unsigned char out[133];
    int ret;

    if (!curve) return JS_EXCEPTION;
    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&q);
    if (fg_c_ec_grp(curve, &grp) != 0) {
        JS_FreeCString(ctx, curve);
        mbedtls_ecp_group_free(&grp);
        return fg_c_throw(ctx, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name", 0);
    }
    JS_FreeCString(ctx, curve);
    pt = JS_GetUint8Array(ctx, &n, argv[1]);
    if (!pt) {
        mbedtls_ecp_group_free(&grp);
        return JS_EXCEPTION;
    }
    if (argc > 2) JS_ToInt32(ctx, &fmt, argv[2]);
    ret = mbedtls_ecp_point_read_binary(&grp, &q, pt, n);
    if (ret == 0) ret = mbedtls_ecp_check_pubkey(&grp, &q);
    if (ret == 0) {
        ret = mbedtls_ecp_point_write_binary(&grp, &q, fmt ? MBEDTLS_ECP_PF_UNCOMPRESSED : MBEDTLS_ECP_PF_COMPRESSED, &outn,
                                             out, sizeof(out));
    }
    mbedtls_ecp_group_free(&grp);
    mbedtls_ecp_point_free(&q);
    if (ret != 0) return fg_c_throw(ctx, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve", ret);
    return fg_c_bytes(ctx, out, outn);
}

/* ------------------------------------------------------------------ primes */

/* genPrime(bits, safe) -> big-endian bytes */
static JSValue fg_gen_prime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t bits = 0, safe = 0;
    mbedtls_mpi p;
    int ret;
    JSValue v;

    JS_ToInt32(ctx, &bits, argv[0]);
    if (argc > 1) safe = JS_ToBool(ctx, argv[1]);
    if (bits < 3 || bits > 16384) return fg_c_throw(ctx, "ERR_OUT_OF_RANGE", "The value of \"size\" is out of range.", 0);
    fg_rng_init();
    mbedtls_mpi_init(&p);
    ret = mbedtls_mpi_gen_prime(&p, (size_t) bits, safe ? MBEDTLS_MPI_GEN_PRIME_FLAG_DH : 0, mbedtls_ctr_drbg_random, &fg_drbg);
    if (ret != 0) {
        mbedtls_mpi_free(&p);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "prime generation", ret);
    }
    v = fg_c_mpi(ctx, &p);
    mbedtls_mpi_free(&p);
    return v;
}

/* isPrime(bytes, rounds) */
static JSValue fg_is_prime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n = 0;
    uint8_t *b = JS_GetUint8Array(ctx, &n, argv[0]);
    int32_t rounds = 0;
    mbedtls_mpi p;
    int ret;

    if (!b) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &rounds, argv[1]);
    if (rounds <= 0 || rounds > 250) rounds = 40;
    fg_rng_init();
    mbedtls_mpi_init(&p);
    ret = mbedtls_mpi_read_binary(&p, b, n);
    if (ret == 0) ret = mbedtls_mpi_is_prime_ext(&p, rounds, mbedtls_ctr_drbg_random, &fg_drbg);
    mbedtls_mpi_free(&p);
    return JS_NewBool(ctx, ret == 0);
}

/* modPow(base, exp, mod) -> big-endian bytes of base^exp mod mod (Diffie-Hellman) */
static JSValue fg_mod_pow(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t bn = 0, en = 0, mn = 0;
    uint8_t *b = JS_GetUint8Array(ctx, &bn, argv[0]);
    uint8_t *e = JS_GetUint8Array(ctx, &en, argv[1]);
    uint8_t *m = JS_GetUint8Array(ctx, &mn, argv[2]);
    mbedtls_mpi base, exp, mod, res;
    int ret;
    JSValue v;

    if (!b || !e || !m) return JS_EXCEPTION;
    mbedtls_mpi_init(&base);
    mbedtls_mpi_init(&exp);
    mbedtls_mpi_init(&mod);
    mbedtls_mpi_init(&res);
    ret = mbedtls_mpi_read_binary(&base, b, bn);
    if (ret == 0) ret = mbedtls_mpi_read_binary(&exp, e, en);
    if (ret == 0) ret = mbedtls_mpi_read_binary(&mod, m, mn);
    if (ret == 0 && mbedtls_mpi_cmp_int(&mod, 1) <= 0) ret = MBEDTLS_ERR_MPI_BAD_INPUT_DATA;
    if (ret == 0) ret = mbedtls_mpi_exp_mod(&res, &base, &exp, &mod, NULL);
    if (ret != 0) {
        mbedtls_mpi_free(&base);
        mbedtls_mpi_free(&exp);
        mbedtls_mpi_free(&mod);
        mbedtls_mpi_free(&res);
        return fg_c_throw(ctx, "ERR_CRYPTO_OPERATION_FAILED", "modular exponentiation", ret);
    }
    v = fg_c_mpi(ctx, &res);
    mbedtls_mpi_free(&base);
    mbedtls_mpi_free(&exp);
    mbedtls_mpi_free(&mod);
    mbedtls_mpi_free(&res);
    return v;
}

/* caBundle() -> the compiled-in trust store as PEM */
static JSValue fg_ca_bundle(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, graak_ca_bundle);
}

const JSCFunctionListEntry graak_crypto_funcs[] = {
    JS_CFUNC_DEF("brotliCompress", 4, fg_brotli_compress),
    JS_CFUNC_DEF("brotliDecompress", 2, fg_brotli_decompress),
    JS_CFUNC_DEF("x509Info", 1, fg_x509_info),
    JS_CFUNC_DEF("x509CheckIssued", 2, fg_x509_check_issued),
    JS_CFUNC_DEF("keyMatchesCert", 3, fg_key_matches_cert),
    JS_CFUNC_DEF("keyInfo", 3, fg_key_info),
    JS_CFUNC_DEF("generateKey", 3, fg_generate_key),
    JS_CFUNC_DEF("rsaCrypt", 7, fg_rsa_crypt),
    JS_CFUNC_DEF("pkSignEx", 6, fg_pk_sign_ex),
    JS_CFUNC_DEF("pkVerifyEx", 6, fg_pk_verify_ex),
    JS_CFUNC_DEF("ecdhGenerate", 2, fg_ecdh_generate),
    JS_CFUNC_DEF("ecdhCompute", 3, fg_ecdh_compute),
    JS_CFUNC_DEF("ecdhConvert", 3, fg_ecdh_convert),
    JS_CFUNC_DEF("genPrime", 2, fg_gen_prime),
    JS_CFUNC_DEF("isPrime", 2, fg_is_prime),
    JS_CFUNC_DEF("modPow", 3, fg_mod_pow),
    JS_CFUNC_DEF("caBundle", 0, fg_ca_bundle),
};
const size_t graak_crypto_funcs_count = sizeof(graak_crypto_funcs) / sizeof(graak_crypto_funcs[0]);
