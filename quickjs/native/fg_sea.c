/*
 * Single-file executables for the ForgeGraal native host.
 *
 * `forgegraal compile --strategy sea` appends the application (the compatibility layer plus the program and its
 * node_modules) to a copy of this executable, followed by a fixed-size trailer that says where it starts. On
 * launch the host looks at its own file: when the trailer is there it unpacks the payload beside itself (or into
 * the temp directory when that is read-only), and runs the program from there with the arguments it was given.
 * Nothing is installed and no other file is needed, so the executable can simply be copied to a device.
 *
 * Payload layout, written by src/compiler/SeaPayload.ts:
 *
 *     u32 count, then per entry:
 *     u16 pathLength, path (UTF-8, forward slashes), u32 mode, u32 rawSize, u32 storedSize, u8 method
 *     (0 = stored, 1 = raw deflate), storedSize bytes of data
 *
 * Trailer (88 bytes, the last thing in the file):
 *
 *     "FGSEA\0\0\1", u64 payloadOffset, u64 payloadLength, 64 hex characters (the payload's SHA-256)
 *
 * The entry named ".forgegraal" holds the path of the program's entry file. Extraction is skipped when the marker
 * file from the last run carries the same SHA-256, so start-up after the first is a couple of stat calls.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "miniz.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define FG_SEA_TRAILER 88
#define FG_SEA_MAGIC "FGSEA\0\0\1"

static uint64_t fg_le64(const unsigned char *p)
{
    uint64_t v = 0;
    int i;
    for (i = 7; i >= 0; i--) {
        v = (v << 8) | p[i];
    }
    return v;
}

static uint32_t fg_le32(const unsigned char *p)
{
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

static int fg_self_path(char *out, size_t cap, const char *argv0)
{
#ifdef _WIN32
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD) cap);
    (void) argv0;
    return n > 0 && n < cap ? 0 : -1;
#else
    ssize_t n = readlink("/proc/self/exe", out, cap - 1);
    if (n > 0) {
        out[n] = '\0';
        return 0;
    }
    if (argv0 && strlen(argv0) < cap) {
        strcpy(out, argv0);
        return 0;
    }
    return -1;
#endif
}

static int fg_make_dir(const char *path)
{
#ifdef _WIN32
    if (CreateDirectoryA(path, NULL)) {
        return 0;
    }
    return GetLastError() == ERROR_ALREADY_EXISTS ? 0 : -1;
#else
    if (mkdir(path, 0755) == 0) {
        return 0;
    }
    return errno == EEXIST ? 0 : -1;
#endif
}

/* mkdir -p for everything above the last separator of `file`. */
static int fg_make_parents(char *file)
{
    char *p;
    for (p = file + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            /* A Windows drive ("C:") is not a directory to create. */
            if (!(p - file == 2 && file[1] == ':') && fg_make_dir(file) != 0) {
                *p = '/';
                return -1;
            }
            *p = '/';
        }
    }
    return 0;
}

/* Entries come from our own build, but a hand-edited file must still not write outside the directory. */
static int fg_safe_path(const char *path, size_t len)
{
    size_t i;
    if (len == 0 || path[0] == '/' || (len > 1 && path[1] == ':')) {
        return 0;
    }
    for (i = 0; i < len; i++) {
        if (path[i] == '\\' || path[i] == '\0') {
            return 0;
        }
        if (path[i] == '.' && path[i + 1] == '.' && (i == 0 || path[i - 1] == '/') && (i + 2 >= len || path[i + 2] == '/')) {
            return 0;
        }
    }
    return 1;
}

static int fg_write_file(const char *path, const unsigned char *data, size_t len, uint32_t mode)
{
    FILE *f = fopen(path, "wb");
    if (!f) {
        return -1;
    }
    if (len && fwrite(data, 1, len, f) != len) {
        fclose(f);
        return -1;
    }
    if (fclose(f) != 0) {
        return -1;
    }
#ifndef _WIN32
    if (mode & 0111) {
        chmod(path, (mode_t) (mode & 0777));
    }
#else
    (void) mode;
#endif
    return 0;
}

static int fg_read_marker(const char *path, char *out, size_t cap)
{
    FILE *f = fopen(path, "rb");
    size_t n;
    if (!f) {
        return -1;
    }
    n = fread(out, 1, cap - 1, f);
    fclose(f);
    out[n] = '\0';
    return 0;
}

/* Unpacks `payload` under `dir`. Returns 0 on success and copies the entry-file path to `entry`. */
static int fg_extract(const unsigned char *payload, size_t len, const char *dir, char *entry, size_t entry_cap)
{
    size_t pos = 4;
    uint32_t count, i;
    char full[4096];

    if (len < 4) {
        return -1;
    }
    count = fg_le32(payload);
    entry[0] = '\0';
    for (i = 0; i < count; i++) {
        size_t plen, stored, raw;
        uint32_t mode;
        unsigned method;
        const char *rel;
        const unsigned char *data;

        if (pos + 2 > len) {
            return -1;
        }
        plen = (size_t) payload[pos] | ((size_t) payload[pos + 1] << 8);
        pos += 2;
        if (pos + plen + 13 > len || !fg_safe_path((const char *) payload + pos, plen)) {
            return -1;
        }
        rel = (const char *) payload + pos;
        pos += plen;
        mode = fg_le32(payload + pos);
        raw = fg_le32(payload + pos + 4);
        stored = fg_le32(payload + pos + 8);
        method = payload[pos + 12];
        pos += 13;
        if (pos + stored > len) {
            return -1;
        }
        data = payload + pos;
        pos += stored;

        if (plen == 11 && memcmp(rel, ".forgegraal", 11) == 0) {
            if (raw + 1 > entry_cap) {
                return -1;
            }
            memcpy(entry, data, raw);
            entry[raw] = '\0';
            continue;
        }
        if (strlen(dir) + 1 + plen + 1 > sizeof(full)) {
            return -1;
        }
        snprintf(full, sizeof(full), "%s/%.*s", dir, (int) plen, rel);
        if (fg_make_parents(full) != 0) {
            return -1;
        }
        if (method == 0) {
            if (fg_write_file(full, data, raw, mode) != 0) {
                return -1;
            }
        } else {
            size_t out_len = 0;
            void *out = raw ? tinfl_decompress_mem_to_heap(data, stored, &out_len, 0) : NULL;
            int rc;
            if (raw && (!out || out_len != raw)) {
                mz_free(out);
                return -1;
            }
            rc = fg_write_file(full, (const unsigned char *) out, raw, mode);
            mz_free(out);
            if (rc != 0) {
                return -1;
            }
        }
    }
    return 0;
}

/*
 * If this executable carries a payload, unpacks it and rewrites argv so the host runs the program:
 * {exe, <dir>/runtime/node-compat.js, <dir>/<entry>, original arguments...}. Returns 1 when it did, 0 when this is
 * a plain host, and -1 (after printing why) when the payload is there but cannot be unpacked.
 */
int fg_sea_prepare(int *argc, char ***argv)
{
    char self[4096];
    unsigned char trailer[FG_SEA_TRAILER];
    FILE *f;
    long size;
    uint64_t offset, length;
    unsigned char *payload;
    char sha[65];
    char dir[4096];
    char marker[4200];
    char have[80];
    char entry[1024];
    char **nargv;
    int extracted = 0, i;

    if (fg_self_path(self, sizeof(self), (*argv)[0]) != 0) {
        return 0;
    }
    f = fopen(self, "rb");
    if (!f) {
        return 0;
    }
    if (fseek(f, 0, SEEK_END) != 0 || (size = ftell(f)) < FG_SEA_TRAILER || fseek(f, size - FG_SEA_TRAILER, SEEK_SET) != 0 ||
        fread(trailer, 1, FG_SEA_TRAILER, f) != FG_SEA_TRAILER || memcmp(trailer, FG_SEA_MAGIC, 8) != 0) {
        fclose(f);
        return 0;
    }
    offset = fg_le64(trailer + 8);
    length = fg_le64(trailer + 16);
    if (offset + length + FG_SEA_TRAILER != (uint64_t) size) {
        fclose(f);
        fprintf(stderr, "forgegraal: the embedded application is damaged\n");
        return -1;
    }
    memcpy(sha, trailer + 24, 64);
    sha[64] = '\0';

    /* Beside the executable when that is writable, otherwise in the temp directory. */
    snprintf(dir, sizeof(dir), "%s.forgegraal", self);
    for (i = 0; dir[i]; i++) {
        if (dir[i] == '\\') dir[i] = '/';
    }
    snprintf(marker, sizeof(marker), "%s/.sea", dir);
    /* Writable? Probed with a scratch file, never the marker: writing that would erase the record of what is unpacked. */
    {
        char probe[4200];
        snprintf(probe, sizeof(probe), "%s/.probe", dir);
        if (fg_make_dir(dir) != 0 || fg_write_file(probe, (const unsigned char *) "", 0, 0) != 0) {
            probe[0] = '\0';
        }
        if (!probe[0]) {
            dir[0] = '\0';
        }
    }
    if (!dir[0]) {
        const char *tmp = getenv("TMPDIR");
        if (!tmp) tmp = getenv("TEMP");
        if (!tmp) tmp = getenv("TMP");
        if (!tmp) tmp = "/tmp";
        snprintf(dir, sizeof(dir), "%s/forgegraal-%.16s", tmp, sha);
        for (i = 0; dir[i]; i++) {
            if (dir[i] == '\\') dir[i] = '/';
        }
        snprintf(marker, sizeof(marker), "%s/.sea", dir);
        if (fg_make_dir(dir) != 0) {
            fclose(f);
            fprintf(stderr, "forgegraal: cannot create a directory to unpack into (%s)\n", dir);
            return -1;
        }
    }

    if (fg_read_marker(marker, have, sizeof(have)) != 0 || strncmp(have, sha, 64) != 0) {
        payload = (unsigned char *) malloc((size_t) length ? (size_t) length : 1);
        if (!payload || fseek(f, (long) offset, SEEK_SET) != 0 || fread(payload, 1, (size_t) length, f) != (size_t) length) {
            free(payload);
            fclose(f);
            fprintf(stderr, "forgegraal: cannot read the embedded application\n");
            return -1;
        }
        if (fg_extract(payload, (size_t) length, dir, entry, sizeof(entry)) != 0) {
            free(payload);
            fclose(f);
            fprintf(stderr, "forgegraal: cannot unpack the embedded application into %s\n", dir);
            return -1;
        }
        free(payload);
        /* The entry path is stored beside the marker so a later run can start without reading the payload. */
        {
            char entry_file[4200];
            snprintf(entry_file, sizeof(entry_file), "%s/.entry", dir);
            fg_write_file(entry_file, (const unsigned char *) entry, strlen(entry), 0);
        }
        fg_write_file(marker, (const unsigned char *) sha, 64, 0);
        extracted = 1;
    }
    fclose(f);
    if (!extracted) {
        char entry_file[4200];
        snprintf(entry_file, sizeof(entry_file), "%s/.entry", dir);
        if (fg_read_marker(entry_file, entry, sizeof(entry)) != 0 || !entry[0]) {
            fprintf(stderr, "forgegraal: the unpacked application in %s is incomplete; delete it and start again\n", dir);
            return -1;
        }
    }

    nargv = (char **) malloc(sizeof(char *) * ((size_t) *argc + 3));
    if (!nargv) {
        return -1;
    }
    nargv[0] = (*argv)[0];
    {
        size_t n = strlen(dir) + 40, m = strlen(dir) + strlen(entry) + 4;
        nargv[1] = (char *) malloc(n);
        nargv[2] = (char *) malloc(m);
        if (!nargv[1] || !nargv[2]) {
            return -1;
        }
        snprintf(nargv[1], n, "%s/runtime/node-compat.js", dir);
        snprintf(nargv[2], m, "%s/%s", dir, entry);
    }
    for (i = 1; i < *argc; i++) {
        nargv[i + 2] = (*argv)[i];
    }
    nargv[*argc + 2] = NULL;
    *argv = nargv;
    *argc += 2;
    return 1;
}
