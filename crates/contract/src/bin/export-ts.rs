//! Writes `ui/src/gen/contract.ts`. Run from the workspace root:
//! `cargo run -p theodore-contract --bin export-ts`.

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| "ui/src/gen/contract.ts".into());
    if let Some(dir) = std::path::Path::new(&out).parent() {
        std::fs::create_dir_all(dir).expect("create output dir");
    }
    let ts = specta_typescript::Typescript::default()
        .export(&theodore_contract::types(), specta_serde::Format)
        .expect("export TS");
    // Specta leaves trailing spaces after `|`; the pre-commit hook rejects them.
    let mut clean: String = ts.lines().map(|l| format!("{}\n", l.trim_end())).collect();
    while clean.ends_with("\n\n") {
        clean.pop();
    }
    std::fs::write(&out, clean).expect("write TS");
    println!("wrote {out}");
}
