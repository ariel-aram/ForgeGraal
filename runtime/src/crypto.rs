//! Hashing, HMAC, randomness and compression.
//!
//! These are the other things the JavaScript layer cannot supply honestly. A hash implemented in
//! JavaScript would be correct but slow; randomness implemented in JavaScript would not be
//! random at all, and a bot that thinks it has entropy when it does not is a security bug rather
//! than a performance one. So they come from audited Rust crates, and anything not implemented
//! returns an error naming the algorithm instead of falling back to something weaker.

use hmac::{Hmac, Mac};
use md5::Md5;
use rand::RngCore;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::io::{Read, Write};

/// Hashes with the named algorithm. Names match Node's `crypto.createHash` spelling.
pub fn hash(algorithm: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(match algorithm.to_ascii_lowercase().as_str() {
        "sha1" => Sha1::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        "md5" => Md5::digest(data).to_vec(),
        other => {
            return Err(format!(
                "hash algorithm '{other}' is not available in this runtime (sha1, sha256, sha512 and md5 are). \
                 Substituting a different algorithm would silently produce values that do not verify."
            ))
        }
    })
}

pub fn hmac(algorithm: &str, key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    // Written out per algorithm rather than generically: the digest crates' trait bounds for a
    // generic HMAC helper are considerably more noise than three lines each.
    macro_rules! run {
        ($ty:ty) => {{
            let mut mac = <Hmac<$ty> as Mac>::new_from_slice(key)
                .expect("HMAC accepts a key of any length");
            mac.update(data);
            mac.finalize().into_bytes().to_vec()
        }};
    }

    Ok(match algorithm.to_ascii_lowercase().as_str() {
        "sha1" => run!(Sha1),
        "sha256" => run!(Sha256),
        "sha512" => run!(Sha512),
        other => {
            return Err(format!(
                "HMAC algorithm '{other}' is not available in this runtime (sha1, sha256 and sha512 are)."
            ))
        }
    })
}

/// Cryptographically secure bytes from the OS. Never a pseudo-random fallback: a caller asking
/// for random bytes is usually generating a nonce or a key.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut out);
    out
}

pub fn inflate(data: &[u8], raw: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    if raw {
        flate2::read::DeflateDecoder::new(data)
            .read_to_end(&mut out)
            .map_err(|e| format!("inflate failed: {e}"))?;
    } else {
        flate2::read::ZlibDecoder::new(data)
            .read_to_end(&mut out)
            .map_err(|e| format!("inflate failed: {e}"))?;
    }
    Ok(out)
}

pub fn deflate(data: &[u8], raw: bool) -> Result<Vec<u8>, String> {
    let level = flate2::Compression::default();
    if raw {
        let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), level);
        encoder.write_all(data).map_err(|e| format!("deflate failed: {e}"))?;
        encoder.finish().map_err(|e| format!("deflate failed: {e}"))
    } else {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), level);
        encoder.write_all(data).map_err(|e| format!("deflate failed: {e}"))?;
        encoder.finish().map_err(|e| format!("deflate failed: {e}"))
    }
}

pub fn gunzip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| format!("gunzip failed: {e}"))?;
    Ok(out)
}
