fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // tauri-build は通常の bin にだけ manifest を付ける。MockRuntime を使う
        // 統合テストにも Common Controls v6 が必要（TaskDialogIndirect 等）。
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/windows.manifest");
        println!("cargo:rerun-if-changed=tests/windows.manifest");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
