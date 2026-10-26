//! Registers the GitHub GraphQL schema for `#[cynic::schema("github")]`.
//!
//! The schema is the public GitHub GraphQL schema (fetched with
//! `curl -L https://docs.github.com/public/fpt/schema.docs.graphql`), checked
//! in at `schema/github.graphql` since it is only published as a file, not an
//! endpoint we can introspect at build time.

fn main() {
    println!("cargo:rerun-if-changed=schema/github.graphql");
    cynic_codegen::register_schema("github")
        .from_sdl_file("schema/github.graphql")
        .expect("register GitHub GraphQL schema");
}
