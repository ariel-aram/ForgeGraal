//! Filesystem, timers and process primitives.
//!
//! These are not here because they are hard — they are here so that the JavaScript layer has one
//! thing to target. Running on the standalone engine it can reach `qjs:os` and `qjs:std`, but this
//! host embeds the engine directly and those modules are not present, so without an equivalent
//! surface `node-compat.js` would need two implementations of everything. Instead both backends
//! expose the same shape and the JavaScript picks whichever it finds.
//!
//! Timers matter most: quickjs has no event loop of its own, and an embedder that does not provide
//! `setTimeout` leaves every library that schedules work — which is all of them — unable to run.

use rquickjs::{function::Func, Ctx, Function, Object, Result as JsResult, Value};

/// Raises a native error as a JavaScript exception, so a failed file operation is catchable
/// rather than fatal.
fn throw<T>(ctx: &Ctx<'_>, result: Result<T, String>) -> JsResult<T> {
    result.map_err(|message| {
        ctx.throw(Value::from_string(
            rquickjs::String::from_str(ctx.clone(), &message).unwrap(),
        ))
    })
}
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// Pending timers, so that `clearTimeout` can cancel one before it fires.
#[derive(Clone, Default)]
pub struct Timers {
    cancelled: Arc<Mutex<HashMap<u32, ()>>>,
    next_id: Arc<AtomicU32>,
}

impl Timers {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU32::new(1)),
        }
    }

    fn take_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn cancel(&self, id: u32) {
        self.cancelled.lock().unwrap().insert(id, ());
    }

    fn is_cancelled(&self, id: u32) -> bool {
        self.cancelled.lock().unwrap().remove(&id).is_some()
    }
}

pub fn install<'js>(ctx: &Ctx<'js>, timers: Timers) -> JsResult<()> {
    let native: Object = ctx.globals().get("__forgegraal_native")?;

    /* ---- timers ---- */

    {
        let timers = timers.clone();
        let set_timeout = move |ctx: Ctx<'js>, callback: Function<'js>, delay: Option<f64>| -> u32 {
            let id = timers.take_id();
            let timers = timers.clone();
            let delay = delay.unwrap_or(0.0).max(0.0);
            // spawn_local keeps the callback on the JavaScript thread; the engine is not
            // thread-safe and a timer that fired on a worker thread would corrupt it.
            ctx.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs_f64(delay / 1000.0)).await;
                if timers.is_cancelled(id) {
                    return;
                }
                let _ = callback.call::<(), ()>(());
            });
            id
        };
        ctx.globals().set("setTimeout", Func::from(set_timeout.clone()))?;
        native.set("setTimeout", Func::from(set_timeout))?;
    }

    {
        let timers = timers.clone();
        let set_interval = move |ctx: Ctx<'js>, callback: Function<'js>, delay: Option<f64>| -> u32 {
            let id = timers.take_id();
            let timers = timers.clone();
            let delay = delay.unwrap_or(0.0).max(1.0);
            ctx.spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs_f64(delay / 1000.0)).await;
                    if timers.is_cancelled(id) {
                        return;
                    }
                    if callback.call::<(), ()>(()).is_err() {
                        return;
                    }
                }
            });
            id
        };
        ctx.globals().set("setInterval", Func::from(set_interval))?;
    }

    {
        let timers = timers.clone();
        let clear = move |id: u32| timers.cancel(id);
        ctx.globals().set("clearTimeout", Func::from(clear.clone()))?;
        ctx.globals().set("clearInterval", Func::from(clear))?;
    }

    /* ---- filesystem ---- */

    native.set(
        "readFile",
        Func::from(|ctx: Ctx<'js>, path: String| -> JsResult<rquickjs::TypedArray<'js, u8>> {
            let bytes = throw(&ctx, std::fs::read(&path).map_err(|e| format!("{path}: {e}")))?;
            rquickjs::TypedArray::new(ctx.clone(), bytes)
        }),
    )?;
    native.set(
        "writeFile",
        Func::from(|ctx: Ctx<'js>, path: String, data: rquickjs::TypedArray<'js, u8>| -> JsResult<()> {
            let bytes = data.as_bytes().map(<[u8]>::to_vec).unwrap_or_default();
            throw(&ctx, std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}")))
        }),
    )?;
    native.set(
        "exists",
        Func::from(|path: String| std::path::Path::new(&path).exists()),
    )?;
    native.set(
        "stat",
        Func::from(|ctx: Ctx<'js>, path: String| -> JsResult<Object<'js>> {
            let meta = throw(&ctx, std::fs::metadata(&path).map_err(|e| format!("{path}: {e}")))?;
            let out = Object::new(ctx.clone())?;
            out.set("size", meta.len() as f64).ok();
            out.set("isDirectory", meta.is_dir()).ok();
            out.set("isFile", meta.is_file()).ok();
            out.set(
                "mtimeMs",
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0),
            )
            .ok();
            Ok(out)
        }),
    )?;
    native.set(
        "readdir",
        Func::from(|ctx: Ctx<'js>, path: String| -> JsResult<Vec<String>> {
            let entries = throw(&ctx, std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}")))?;
            Ok(entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect())
        }),
    )?;
    native.set(
        "mkdir",
        Func::from(|ctx: Ctx<'js>, path: String, recursive: bool| -> JsResult<()> {
            let result = if recursive {
                std::fs::create_dir_all(&path)
            } else {
                std::fs::create_dir(&path)
            };
            throw(&ctx, result.map_err(|e| format!("{path}: {e}")))
        }),
    )?;
    native.set(
        "remove",
        Func::from(|ctx: Ctx<'js>, path: String| -> JsResult<()> {
            let path_ref = std::path::Path::new(&path);
            let result = if path_ref.is_dir() {
                std::fs::remove_dir_all(path_ref)
            } else {
                std::fs::remove_file(path_ref)
            };
            throw(&ctx, result.map_err(|e| format!("{path}: {e}")))
        }),
    )?;
    native.set(
        "rename",
        Func::from(|ctx: Ctx<'js>, from: String, to: String| -> JsResult<()> {
            throw(&ctx, std::fs::rename(&from, &to).map_err(|e| format!("{from}: {e}")))
        }),
    )?;
    native.set(
        "realpath",
        Func::from(|ctx: Ctx<'js>, path: String| -> JsResult<String> {
            throw(&ctx, std::fs::canonicalize(&path)
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| format!("{path}: {e}")))
        }),
    )?;

    /* ---- text ---- */

    // UTF-8 conversion belongs on this side: Rust's String is already UTF-8, so encoding is a
    // copy, and decoding gets correct replacement of invalid sequences for free rather than
    // reimplementing the scanner in JavaScript.
    native.set(
        "encodeUtf8",
        Func::from(|ctx: Ctx<'js>, text: String| -> JsResult<rquickjs::TypedArray<'js, u8>> {
            rquickjs::TypedArray::new(ctx.clone(), text.into_bytes())
        }),
    )?;
    native.set(
        "decodeUtf8",
        Func::from(|data: rquickjs::TypedArray<'js, u8>| {
            let bytes = data.as_bytes().map(<[u8]>::to_vec).unwrap_or_default();
            String::from_utf8_lossy(&bytes).into_owned()
        }),
    )?;

    /* ---- process ---- */

    native.set("cwd", Func::from(|| std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()))?;
    native.set("exePath", Func::from(|| std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()))?;
    native.set("pid", Func::from(|| std::process::id()))?;
    // Wrapped in a block so the closure's type is (), not the never type that
    // std::process::exit returns, which rquickjs cannot convert into a JavaScript value.
    native.set(
        "exit",
        Func::from(|code: Option<i32>| -> () {
            let code = code.unwrap_or(0);
            std::process::exit(code)
        }),
    )?;
    native.set(
        "env",
        Func::from(|ctx: Ctx<'js>| -> JsResult<Object<'js>> {
            let out = Object::new(ctx)?;
            for (key, value) in std::env::vars() {
                out.set(key, value)?;
            }
            Ok(out)
        }),
    )?;
    native.set(
        "argv",
        Func::from(|| std::env::args().collect::<Vec<String>>()),
    )?;
    native.set(
        "now",
        Func::from(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0)
        }),
    )?;
    native.set(
        "tmpdir",
        Func::from(|| std::env::temp_dir().to_string_lossy().to_string()),
    )?;

    Ok(())
}
