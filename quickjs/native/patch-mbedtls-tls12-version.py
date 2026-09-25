#!/usr/bin/env python3
"""Makes mbedTLS's TLS 1.2 server answer a client that does not offer TLS 1.2 with a protocol_version alert.

A ClientHello that lists only TLS 1.3 in its supported_versions extension still carries legacy_version 1.2, and the
stock 1.2-only server goes on to look for a cipher suite, fails, and sends handshake_failure. OpenSSL, and therefore
Node.js, sends protocol_version; a client (or a person reading the error) can then tell what went wrong.
"""
import pathlib
import sys

target = pathlib.Path(sys.argv[1])
source = target.read_text()
MARK = "GRAAK_TLS12_VERSION_ALERT"
if MARK in source:
    sys.exit(0)

OLD = """            default:
                MBEDTLS_SSL_DEBUG_MSG(3, ("unknown extension found: %u (ignoring)",
                                          ext_id));
        }

        ext_len -= 4 + ext_size;
        ext += 4 + ext_size;
    }

#if defined(MBEDTLS_KEY_EXCHANGE_WITH_CERT_ENABLED)"""

NEW = """            case MBEDTLS_TLS_EXT_SUPPORTED_VERSIONS: {
                /* GRAAK_TLS12_VERSION_ALERT: a client that does not list TLS 1.2 cannot be served by this server. */
                size_t list_len = ext_size >= 1 ? ext[4] : 0;
                if (ext_size >= 1 && list_len + 1 == ext_size && (list_len % 2) == 0) {
                    size_t v;
                    int offers_tls12 = 0;
                    for (v = 0; v < list_len; v += 2) {
                        if (ext[5 + v] == 3 && ext[6 + v] == 3) {
                            offers_tls12 = 1;
                        }
                    }
                    if (!offers_tls12) {
                        mbedtls_ssl_send_alert_message(ssl, MBEDTLS_SSL_ALERT_LEVEL_FATAL,
                                                       MBEDTLS_SSL_ALERT_MSG_PROTOCOL_VERSION);
                        return MBEDTLS_ERR_SSL_BAD_PROTOCOL_VERSION;
                    }
                }
                break;
            }

            default:
                MBEDTLS_SSL_DEBUG_MSG(3, ("unknown extension found: %u (ignoring)",
                                          ext_id));
        }

        ext_len -= 4 + ext_size;
        ext += 4 + ext_size;
    }

#if defined(MBEDTLS_KEY_EXCHANGE_WITH_CERT_ENABLED)"""

if OLD not in source:
    sys.exit("patch-mbedtls-tls12-version: the expected code was not found in " + str(target))
target.write_text(source.replace(OLD, NEW, 1))
