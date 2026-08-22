fn main() {
    // Android devices from Android 15 on can run with a 16 KB memory page size, and the loader
    // there refuses a library whose LOAD segments are aligned to the old 4 KB - which is what
    // rustc emits by default, so the device reports "This app isn't 16 KB-compatible" and names
    // this library. The alignment is a link-time decision, so it has to be asked for here.
    //
    // This goes through the build script rather than `.cargo/config.toml` on purpose: the Tauri
    // CLI sets `CARGO_TARGET_<triple>_RUSTFLAGS` when it drives the Android build, and that env
    // var replaces the config file's rustflags for that target wholesale - the flag would be
    // silently dropped. A build script's link args are additive and survive it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }

    tauri_build::build()
}
