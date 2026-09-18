//! ForgeGraal's native runtime host.
//!
//! quickjs-ng implements the JavaScript language completely on platforms Node.js abandoned — the
//! measured conformance is 10/10 on syntax and builtins on a 32-bit build, where the newest Node
//! that runs on Windows 7 scores 5/10. What it has no answer for is the host surface, and the part
//! that actually blocks a Discord bot is sockets: `qjs:os` exposes none, so `net`, `tls`, `http`
//! and everything above them are unreachable from JavaScript no matter how much is written there.
//!
//! This binary is that missing half. It embeds the engine, runs a tokio reactor beside it, and
//! hands JavaScript the capabilities that genuinely require native code: TCP, TLS, hashing, HMAC,
//! secure randomness and compression. Everything expressible in JavaScript stays in JavaScript,
//! in `quickjs/runtime/node-compat.js`.
//!
//! Rust rather than C for this layer because it is the part that parses bytes off a network. The
//! cost is a platform floor: Rust's standard library for 32-bit Windows imports `ProcessPrng`
//! (Windows 10), `GetSystemTimePreciseAsFileTime` (Windows 8) and the `api-ms-win-core-synch`
//! API set (Windows 7), so this host cannot serve Windows XP or Vista. Those remain on the C
//! engine path.

mod crypto;
mod host;
mod net;

use rquickjs::{
    async_with,
    function::Func,
    AsyncContext, AsyncRuntime, CatchResultExt, Ctx, Module, Object, Result as JsResult,
    TypedArray, Value,
};
use std::path::{Path, PathBuf};

/// Turns a `Result<T, String>` from the native side into a JavaScript exception, so a failure
/// reaches the bot as a normal catchable error rather than killing the process.
fn to_js<T>(ctx: &Ctx<'_>, result: Result<T, String>) -> JsResult<T> {
    result.map_err(|message| {
        let error = ctx.throw(Value::from_string(
            rquickjs::String::from_str(ctx.clone(), &message).unwrap(),
        ));
        error
    })
}

fn bytes_of(value: &TypedArray<'_, u8>) -> Vec<u8> {
    value.as_bytes().map(|b| b.to_vec()).unwrap_or_default()
}

fn to_typed_array<'js>(ctx: &Ctx<'js>, data: Vec<u8>) -> JsResult<TypedArray<'js, u8>> {
    TypedArray::new(ctx.clone(), data)
}

/// Installs `globalThis.__forgegraal_native`, the single object the JavaScript layer builds
/// `net`, `tls`, `crypto` and `zlib` on top of.
fn install_native<'js>(ctx: &Ctx<'js>, sockets: net::Sockets) -> JsResult<()> {
    let native = Object::new(ctx.clone())?;

    {
        let sockets = sockets.clone();
        native.set(
            "connect",
            Func::from(rquickjs::function::Async(
                move |ctx: Ctx<'js>, host: String, port: u16, tls: bool| {
                    let sockets = sockets.clone();
                    async move { to_js(&ctx, sockets.connect(host, port, tls).await) }
                },
            )),
        )?;
    }
    {
        let sockets = sockets.clone();
        native.set(
            "read",
            Func::from(rquickjs::function::Async(move |ctx: Ctx<'js>, id: u32| {
                let sockets = sockets.clone();
                async move {
                    let data = to_js(&ctx, sockets.read(id).await)?;
                    to_typed_array(&ctx, data)
                }
            })),
        )?;
    }
    {
        let sockets = sockets.clone();
        native.set(
            "write",
            Func::from(rquickjs::function::Async(
                move |ctx: Ctx<'js>, id: u32, data: TypedArray<'js, u8>| {
                    let sockets = sockets.clone();
                    let bytes = bytes_of(&data);
                    async move { to_js(&ctx, sockets.write(id, bytes).await) }
                },
            )),
        )?;
    }
    {
        let sockets = sockets.clone();
        native.set(
            "close",
            Func::from(rquickjs::function::Async(move |ctx: Ctx<'js>, id: u32| {
                let sockets = sockets.clone();
                async move { to_js(&ctx, sockets.close(id).await) }
            })),
        )?;
    }

    native.set(
        "hash",
        Func::from(|ctx: Ctx<'js>, algorithm: String, data: TypedArray<'js, u8>| {
            let out = to_js(&ctx, crypto::hash(&algorithm, &bytes_of(&data)))?;
            to_typed_array(&ctx, out)
        }),
    )?;
    native.set(
        "hmac",
        Func::from(
            |ctx: Ctx<'js>, algorithm: String, key: TypedArray<'js, u8>, data: TypedArray<'js, u8>| {
                let out = to_js(&ctx, crypto::hmac(&algorithm, &bytes_of(&key), &bytes_of(&data)))?;
                to_typed_array(&ctx, out)
            },
        ),
    )?;
    native.set(
        "randomBytes",
        Func::from(|ctx: Ctx<'js>, len: usize| to_typed_array(&ctx, crypto::random_bytes(len))),
    )?;
    native.set(
        "inflate",
        Func::from(|ctx: Ctx<'js>, data: TypedArray<'js, u8>, raw: bool| {
            let out = to_js(&ctx, crypto::inflate(&bytes_of(&data), raw))?;
            to_typed_array(&ctx, out)
        }),
    )?;
    native.set(
        "deflate",
        Func::from(|ctx: Ctx<'js>, data: TypedArray<'js, u8>, raw: bool| {
            let out = to_js(&ctx, crypto::deflate(&bytes_of(&data), raw))?;
            to_typed_array(&ctx, out)
        }),
    )?;
    native.set(
        "gunzip",
        Func::from(|ctx: Ctx<'js>, data: TypedArray<'js, u8>| {
            let out = to_js(&ctx, crypto::gunzip(&bytes_of(&data)))?;
            to_typed_array(&ctx, out)
        }),
    )?;

    native.set("platform", std::env::consts::OS)?;
    native.set("arch", std::env::consts::ARCH)?;

    ctx.globals().set("__forgegraal_native", native)?;
    Ok(())
}

/// Minimal console, so a script that logs works before any JavaScript layer is loaded.
fn install_console(ctx: &Ctx<'_>) -> JsResult<()> {
    let console = Object::new(ctx.clone())?;
    console.set(
        "log",
        Func::from(|args: rquickjs::function::Rest<Value<'_>>| {
            let line = args
                .iter()
                .map(format_value)
                .collect::<Vec<_>>()
                .join(" ");
            println!("{line}");
        }),
    )?;
    console.set(
        "error",
        Func::from(|args: rquickjs::function::Rest<Value<'_>>| {
            let line = args.iter().map(format_value).collect::<Vec<_>>().join(" ");
            eprintln!("{line}");
        }),
    )?;
    ctx.globals().set("console", console)?;
    Ok(())
}

fn format_value(value: &Value<'_>) -> String {
    if let Some(s) = value.as_string() {
        return s.to_string().unwrap_or_default();
    }
    if value.is_undefined() {
        return "undefined".into();
    }
    if value.is_null() {
        return "null".into();
    }
    // Objects and arrays go through JSON so output is readable without reimplementing inspect.
    value
        .ctx()
        .json_stringify(value.clone())
        .ok()
        .flatten()
        .and_then(|s| s.to_string().ok())
        .unwrap_or_else(|| format!("{value:?}"))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: forgegraal-runtime <script.js> [args...]");
        eprintln!();
        eprintln!("Runs a script on quickjs-ng with native sockets, TLS, crypto and compression.");
        std::process::exit(2);
    }

    let entry = PathBuf::from(&args[1]);
    if !entry.exists() {
        eprintln!("forgegraal-runtime: '{}' does not exist", entry.display());
        std::process::exit(1);
    }

    let runtime = AsyncRuntime::new().expect("failed to create the JavaScript runtime");

    // Without a resolver and loader the engine cannot follow an `import` to a file at all.
    // Resolution is rooted at the entry's own directory so a script's relative imports work the
    // way they would under node.
    let entry_dir = entry.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    runtime
        .set_loader(
            rquickjs::loader::FileResolver::default()
                .with_path(entry_dir.to_string_lossy().as_ref())
                .with_path(".")
                .with_pattern("{}")
                .with_pattern("{}.js")
                .with_pattern("{}.mjs"),
            rquickjs::loader::ScriptLoader::default()
                .with_extension("js")
                .with_extension("mjs"),
        )
        .await;
    let context = AsyncContext::full(&runtime)
        .await
        .expect("failed to create the JavaScript context");
    let sockets = net::Sockets::new();

    let failed = async_with!(context => |ctx| {
        let install = install_console(&ctx)
            .and_then(|_| install_native(&ctx, sockets))
            .and_then(|_| host::install(&ctx, host::Timers::new()));
        if let Err(err) = install {
            eprintln!("forgegraal-runtime: could not install the native layer: {err}");
            return true;
        }

        let source = match std::fs::read_to_string(&entry) {
            Ok(source) => source,
            Err(err) => {
                eprintln!("forgegraal-runtime: cannot read '{}': {err}", entry.display());
                return true;
            }
        };

        // Evaluated as a module so that top-level await works, which the socket API needs.
        let name = entry.to_string_lossy().to_string();
        match Module::evaluate(ctx.clone(), name, source).catch(&ctx) {
            Ok(promise) => {
                if let Err(err) = promise.into_future::<()>().await.catch(&ctx) {
                    eprintln!("{err}");
                    return true;
                }
                false
            }
            Err(err) => {
                eprintln!("{err}");
                true
            }
        }
    })
    .await;

    // Let anything still queued (timers, pending socket work) finish before exiting.
    runtime.idle().await;

    if failed {
        std::process::exit(1);
    }
}

#[allow(dead_code)]
fn entry_dir(entry: &Path) -> PathBuf {
    entry.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))
}
