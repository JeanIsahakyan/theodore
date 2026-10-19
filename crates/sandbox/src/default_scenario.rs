//! The default scenario (`theodore sandbox init`): two hosted repos, a
//! local folder, and PRs covering every screen — every inbox reason, big
//! and small diffs, renames, lockfiles and generated code, images,
//! markdown, a conflict, a draft, failing/pending checks, approvals,
//! changes requested, a stack of three, merged and closed PRs, open /
//! resolved / outdated threads with a suggestion and reactions, and a
//! timeline of pushes, comments, review requests and a merge by a
//! teammate. Written out as plain `scenario.json` + `assets/`, so it can be
//! edited by hand.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use theodore_domain::CheckStatus;

use crate::error::{SandboxError, SandboxResult};
use crate::scenario::*;

const VIEWER: &str = "sam";

fn t(path: &str, text: impl Into<String>) -> FileSpec {
    FileSpec::text(path, text)
}

fn asset(path: &str, asset: &str) -> FileSpec {
    FileSpec {
        path: path.into(),
        asset: Some(asset.into()),
        ..FileSpec::default()
    }
}

fn rename(from: &str, to: &str, text: impl Into<String>) -> FileSpec {
    FileSpec {
        path: to.into(),
        rename_from: Some(from.into()),
        text: Some(text.into()),
        ..FileSpec::default()
    }
}

fn commit(message: &str, author: &str, ago: &str, files: Vec<FileSpec>) -> CommitSpec {
    CommitSpec {
        message: message.into(),
        author: author.into(),
        ago: Some(ago.into()),
        files,
    }
}

fn branch(name: &str, from: Option<&str>, commits: Vec<CommitSpec>) -> BranchSpec {
    BranchSpec {
        name: name.into(),
        from: from.map(str::to_string),
        commits,
    }
}

fn requested(user: &str) -> ReviewerSpec {
    ReviewerSpec {
        user: Some(user.into()),
        team: None,
        state: ReviewerStateSpec::Requested,
        ago: None,
        body: String::new(),
    }
}

fn reviewed(user: &str, state: ReviewerStateSpec, ago: &str, body: &str) -> ReviewerSpec {
    ReviewerSpec {
        user: Some(user.into()),
        team: None,
        state,
        ago: Some(ago.into()),
        body: body.into(),
    }
}

fn check(name: &str, status: CheckStatus) -> CheckSpec {
    CheckSpec {
        name: name.into(),
        status,
        duration_ms: None,
        url: None,
        after: None,
        then: None,
    }
}

fn green() -> Vec<CheckSpec> {
    vec![
        check("ci/build", CheckStatus::Pass),
        check("ci/test", CheckStatus::Pass),
        check("lint", CheckStatus::Pass),
    ]
}

fn comment(author: &str, ago: &str, body: &str) -> CommentSpec {
    CommentSpec {
        author: author.into(),
        body: body.into(),
        ago: Some(ago.into()),
        reactions: BTreeMap::new(),
    }
}

fn thread(path: &str, line: u32, comments: Vec<CommentSpec>) -> ThreadSpec {
    ThreadSpec {
        path: path.into(),
        line,
        side: SideSpec::New,
        start_line: None,
        resolved: false,
        outdated: false,
        comments,
    }
}

#[allow(clippy::too_many_arguments)]
fn pr(
    repo: &str,
    number: u64,
    title: &str,
    author: &str,
    head: &str,
    base: Option<&str>,
    state: PrStateSpec,
    body: &str,
) -> PrSpec {
    PrSpec {
        repo: repo.into(),
        number,
        title: title.into(),
        body: body.into(),
        author: author.into(),
        head: head.into(),
        base: base.map(str::to_string),
        state,
        created_ago: None,
        updated_ago: None,
        labels: Vec::new(),
        assignees: Vec::new(),
        reviewers: Vec::new(),
        checks: green(),
        threads: Vec::new(),
        required_approvals: None,
    }
}

fn event(id: &str, at: Option<&str>, action: Action) -> EventSpec {
    EventSpec {
        id: id.into(),
        at: at.map(str::to_string),
        label: None,
        action,
    }
}

// ── avatars and images ─────────────────────────────────────────────────

fn avatar(initials: &str, color: &str) -> String {
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>\
         <circle cx='32' cy='32' r='32' fill='{color}'/>\
         <text x='32' y='41' font-family='Helvetica,Arial' font-size='26' \
         text-anchor='middle' fill='white'>{initials}</text></svg>"
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

/// A small RGB PNG (stored deflate blocks, no compression dependency).
pub fn png(w: u32, h: u32, px: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(((w * 3 + 1) * h) as usize);
    for y in 0..h {
        raw.push(0);
        for x in 0..w {
            raw.extend_from_slice(&px(x, y));
        }
    }
    let mut z = vec![0x78, 0x01];
    let chunks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, c) in chunks.iter().enumerate() {
        z.push(u8::from(i + 1 == chunks.len()));
        let len = c.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(c);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

fn assets() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (
            "assets/placeholder-v1.png",
            png(96, 64, |x, y| {
                if (x / 12 + y / 12) % 2 == 0 {
                    [0xD1, 0xD5, 0xDB]
                } else {
                    [0xF3, 0xF4, 0xF6]
                }
            }),
        ),
        (
            "assets/placeholder-v2.png",
            png(96, 64, |x, y| {
                let r = (x * 255 / 95) as u8;
                let b = (y * 255 / 63) as u8;
                [r / 2 + 60, 0x70, b / 2 + 120]
            }),
        ),
        (
            "assets/badge.png",
            png(48, 48, |x, y| {
                let (dx, dy) = (x as i32 - 24, y as i32 - 24);
                if dx * dx + dy * dy < 22 * 22 {
                    [0x16, 0xA3, 0x4A]
                } else {
                    [0xFF, 0xFF, 0xFF]
                }
            }),
        ),
    ]
}

// ── storefront (TypeScript) ────────────────────────────────────────────

const COMPONENTS: [&str; 20] = [
    "Button",
    "Card",
    "Header",
    "Footer",
    "Modal",
    "ProductTile",
    "PriceTag",
    "CartIcon",
    "SearchBox",
    "Badge",
    "Avatar",
    "Tabs",
    "Toast",
    "Spinner",
    "Rating",
    "Pagination",
    "Breadcrumbs",
    "Drawer",
    "Tooltip",
    "Select",
];
const PAGES: [&str; 8] = [
    "Home", "Product", "Cart", "Checkout", "Orders", "Search", "Account", "Wishlist",
];
const STYLES: [&str; 5] = ["base", "layout", "buttons", "cards", "forms"];
const HOOKS: [&str; 5] = ["useCart", "useSearch", "useOrders", "useToast", "useMedia"];
const ROOT_CONFIGS: [&str; 14] = [
    "babel.config.js",
    "jest.config.js",
    "postcss.config.js",
    "tailwind.config.js",
    "vite.config.ts",
    "vitest.config.ts",
    "playwright.config.ts",
    "eslint.config.js",
    "prettier.config.js",
    "commitlint.config.js",
    "lint-staged.config.js",
    "stylelint.config.js",
    "svgo.config.js",
    "storybook.config.ts",
];

fn kebab(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('-');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn component(name: &str, tokens: bool) -> String {
    let (import, color, bg, radius) = if tokens {
        (
            "import { tokens } from '../styles/tokens';\n",
            "tokens.text",
            "tokens.surface",
            "tokens.radius",
        )
    } else {
        ("", "'#1f2937'", "'#ffffff'", "6")
    };
    let k = kebab(name);
    format!(
        "import React from 'react';\n{import}\n\
export interface {name}Props {{\n  label?: string;\n  children?: React.ReactNode;\n}}\n\n\
export function {name}({{ label, children }}: {name}Props) {{\n\
  const style = {{\n    color: {color},\n    background: {bg},\n    borderRadius: {radius},\n    padding: '8px 12px',\n  }};\n\
  return (\n    <div className=\"{k}\" style={{style}} aria-label={{label}}>\n      {{children}}\n    </div>\n  );\n}}\n"
    )
}

fn page(name: &str, tokens: bool) -> String {
    let (import, gap) = if tokens {
        (
            "import { tokens } from '../styles/tokens';\n",
            "tokens.space(4)",
        )
    } else {
        ("", "'16px'")
    };
    format!(
        "import React from 'react';\nimport {{ Header }} from '../components/Header';\nimport {{ Footer }} from '../components/Footer';\n{import}\n\
export default function {name}Page() {{\n  return (\n    <main style={{{{ display: 'grid', gap: {gap} }}}}>\n      <Header />\n      <h1>{name}</h1>\n      <Footer />\n    </main>\n  );\n}}\n"
    )
}

fn style(name: &str, tokens: bool) -> String {
    let (fg, bg) = if tokens {
        ("var(--color-text)", "var(--color-surface)")
    } else {
        ("#1f2937", "#ffffff")
    };
    format!(
        ".{name} {{\n  color: {fg};\n  background: {bg};\n  margin: 0;\n}}\n\n.{name}--muted {{\n  opacity: 0.7;\n}}\n"
    )
}

fn hook(name: &str, tokens: bool) -> String {
    let delay = if tokens { "tokens.motion.fast" } else { "150" };
    let import = if tokens {
        "import { tokens } from '../styles/tokens';\n"
    } else {
        ""
    };
    format!(
        "import {{ useEffect, useState }} from 'react';\n{import}\n\
export function {name}<T>(load: () => Promise<T>) {{\n  const [value, setValue] = useState<T | null>(null);\n\
  useEffect(() => {{\n    const id = setTimeout(() => load().then(setValue), {delay});\n    return () => clearTimeout(id);\n  }}, [load]);\n  return value;\n}}\n"
    )
}

fn root_config(name: &str, year: u32) -> String {
    format!(
        "// Copyright (c) {year} Acme Inc. All rights reserved.\n// SPDX-License-Identifier: MIT\n\n\
module.exports = {{\n  name: '{name}',\n  root: true,\n}};\n"
    )
}

fn lockfile(router: &str, seed: u32) -> String {
    let mut out = String::from(
        "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n  .:\n    dependencies:\n",
    );
    out.push_str(&format!(
        "      react:\n        specifier: ^18.3.1\n        version: 18.3.1\n      react-router:\n        specifier: ^{router}\n        version: {router}\n\npackages:\n"
    ));
    for i in 0..60u32 {
        let v = (i * 7 + seed) % 23;
        out.push_str(&format!(
            "\n  dep-{i:02}@1.{v}.0:\n    resolution: {{integrity: sha512-{:08x}{:08x}}}\n    engines: {{node: '>=18'}}\n",
            i.wrapping_mul(2_654_435_761).wrapping_add(seed),
            (i + seed).wrapping_mul(40_503)
        ));
    }
    out
}

fn routes(pages: &[&str], v: u32) -> String {
    let mut out =
        format!("// @generated by router-gen v{v}. Do not edit.\n\nexport const routes = [\n");
    for p in pages {
        out.push_str(&format!(
            "  {{ path: '/{}', page: () => import('../pages/{p}') }},\n",
            kebab(p)
        ));
    }
    out.push_str("] as const;\n");
    out
}

const CART_V1: &str = "export interface LineItem {\n  sku: string;\n  price: number;\n  qty: number;\n}\n\n\
export function subtotal(items: LineItem[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n\n\
export function total(items: LineItem[], taxRate: number): number {\n  const sub = subtotal(items);\n  return sub + sub * taxRate;\n}\n\n\
export function isEmpty(items: LineItem[]): boolean {\n  return items.length === 0;\n}\n";

const CART_V2: &str = "export interface LineItem {\n  sku: string;\n  price: number;\n  qty: number;\n}\n\n\
export function subtotal(items: LineItem[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n\n\
export function total(items: LineItem[], taxRate: number): number {\n  const sub = subtotal(items);\n  const raw = sub + sub * taxRate;\n  return Math.round(raw * 100) / 100;\n}\n\n\
export function isEmpty(items: LineItem[]): boolean {\n  return items.length === 0;\n}\n";

/// The timeline push to #101: the same hunk, changed again.
pub const CART_V3: &str = "export interface LineItem {\n  sku: string;\n  price: number;\n  qty: number;\n}\n\n\
export function subtotal(items: LineItem[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n\n\
export function total(items: LineItem[], taxRate: number): number {\n  const sub = subtotal(items);\n  const raw = sub + sub * taxRate;\n  return Math.round((raw + Number.EPSILON) * 100) / 100;\n}\n\n\
export function isEmpty(items: LineItem[]): boolean {\n  return items.length === 0;\n}\n";

const PRICE_V1: &str = "export function formatPrice(cents: number, currency = 'USD'): string {\n  const value = (cents / 100).toFixed(2);\n  return `${currency} ${value}`;\n}\n\n\
export function parsePrice(input: string): number {\n  const n = Number(input.replace(/[^0-9.]/g, ''));\n  return Math.round(n * 100);\n}\n";

const PRICE_MAIN: &str = "export function formatPrice(cents: number, currency = 'USD'): string {\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);\n}\n\n\
export function parsePrice(input: string): number {\n  const n = Number(input.replace(/[^0-9.]/g, ''));\n  return Math.round(n * 100);\n}\n";

const PRICE_PR: &str = "export function formatPrice(cents: number, currency = 'USD', locale = 'en-US'): string {\n  const value = (cents / 100).toFixed(2);\n  return locale === 'de-DE' ? `${value} ${currency}` : `${currency} ${value}`;\n}\n\n\
export function parsePrice(input: string): number {\n  const n = Number(input.replace(/[^0-9.,]/g, '').replace(',', '.'));\n  return Math.round(n * 100);\n}\n";

const COUPONS: &str = "export interface CouponResult {\n  ok: boolean;\n  reason?: string;\n}\n\n\
export function validateCoupon(code: string, now = new Date()): CouponResult {\n  if (code.length === 0) return { ok: false, reason: 'empty' };\n  if (!/^[A-Z0-9-]+$/.test(code)) return { ok: false, reason: 'format' };\n  const expiry = expiries[code];\n  if (expiry && expiry < now) return { ok: false, reason: 'expired' };\n  return { ok: true };\n}\n\n\
const expiries: Record<string, Date> = {\n  'SPRING-24': new Date('2024-06-01'),\n};\n";

const SEARCH_V1: &str = "export function search(items: string[], q: string): string[] {\n  const needle = q.toLowerCase();\n  return items.filter((i) => i.toLowerCase().includes(needle));\n}\n";

const SEARCH_V2: &str = "export function search(items: string[], q: string): string[] {\n  const needle = q.toLowerCase();\n  return items.filter((i) => i.toLowerCase().includes(needle));\n}\n\n\
export function suggest(items: string[], q: string, limit = 5): string[] {\n  if (q.length < 2) return [];\n  return search(items, q)\n    .sort((a, b) => a.length - b.length)\n    .slice(0, limit + 1);\n}\n";

const ORDERS_V1: &str = "export interface Order {\n  id: string;\n  placedAt: string;\n  totalCents: number;\n}\n\n\
export async function listOrders(): Promise<Order[]> {\n  const res = await fetch('/api/orders');\n  return res.json();\n}\n";

const ORDERS_V2: &str = "export interface Order {\n  id: string;\n  placedAt: string;\n  totalCents: number;\n  status: 'placed' | 'shipped' | 'delivered';\n}\n\n\
export async function listOrders(page = 1): Promise<Order[]> {\n  const res = await fetch(`/api/orders?page=${page}`);\n  if (!res.ok) throw new Error(`orders: ${res.status}`);\n  return res.json();\n}\n";

const ORDERS_PAGE: &str = "import React from 'react';\nimport { listOrders, type Order } from '../lib/orders';\n\n\
export default function OrdersPage() {\n  const [orders, setOrders] = React.useState<Order[]>([]);\n  React.useEffect(() => {\n    listOrders().then(setOrders);\n  }, []);\n\
  return (\n    <table>\n      <tbody>\n        {orders.map((o) => (\n          <tr key={o.id}>\n            <td>{o.id}</td>\n            <td>{o.status}</td>\n          </tr>\n        ))}\n      </tbody>\n    </table>\n  );\n}\n";

const PAYMENTS_V1: &str = "export interface PaymentClient {\n  charge(cents: number, token: string): Promise<string>;\n}\n\n\
export function createClient(baseUrl: string): PaymentClient {\n  return {\n    async charge(cents, token) {\n      const res = await fetch(`${baseUrl}/charge`, {\n        method: 'POST',\n        body: JSON.stringify({ cents, token }),\n      });\n      return (await res.json()).id;\n    },\n  };\n}\n";

const PAYMENTS_V2: &str = "export interface PaymentClient {\n  charge(cents: number, token: string): Promise<string>;\n}\n\n\
const RETRIES = 3;\n\n\
export function createClient(baseUrl: string): PaymentClient {\n  return {\n    async charge(cents, token) {\n      for (let attempt = 1; ; attempt++) {\n        const res = await fetch(`${baseUrl}/charge`, {\n          method: 'POST',\n          body: JSON.stringify({ cents, token }),\n        });\n        if (res.ok || attempt >= RETRIES) return (await res.json()).id;\n      }\n    },\n  };\n}\n";

const CHECKOUT_V3: &str = "import React from 'react';\nimport { Header } from '../components/Header';\nimport { Footer } from '../components/Footer';\nimport { createClient } from '../lib/payments/client';\n\n\
const payments = createClient('/api/payments');\n\n\
export default function CheckoutPage() {\n  return (\n    <main style={{ display: 'grid', gap: '16px' }}>\n      <Header />\n      <h1>Checkout</h1>\n      <button onClick={() => payments.charge(1999, 'tok_test')}>Pay</button>\n      <Footer />\n    </main>\n  );\n}\n";

const CHECKOUT_DOC: &str = "# Checkout flow\n\nHow an order moves from the cart to a confirmed payment.\n\n\
## Steps\n\n1. **Cart** — line items and coupons are validated client-side.\n2. **Address** — shipping options depend on the country.\n3. **Payment** — the card token never touches our servers.\n4. **Confirmation** — the order id is shown and emailed.\n\n\
## Failure modes\n\n| Step | Failure | What the user sees |\n| --- | --- | --- |\n| Payment | card declined | inline error, cart kept |\n| Payment | timeout | retry button |\n\n\
```ts\nconst id = await payments.charge(totalCents, token);\n```\n\n> Payments are retried at most three times.\n";

const README_V1: &str =
    "# Storefront\n\nThe Acme web shop.\n\n## Develop\n\n```sh\npnpm install\npnpm dev\n```\n";

const README_V2: &str = "# Storefront\n\nThe Acme web shop.\n\n## Develop\n\n```sh\npnpm install\npnpm dev\n```\n\n## Docs\n\n- [Checkout flow](docs/checkout.md)\n- [Architecture](docs/architecture.md)\n";

const LOGO_V1: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"32\">\n  <rect width=\"120\" height=\"32\" rx=\"6\" fill=\"#111827\"/>\n  <text x=\"60\" y=\"21\" fill=\"#ffffff\" text-anchor=\"middle\">acme</text>\n</svg>\n";

const LOGO_V2: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"32\">\n  <rect width=\"120\" height=\"32\" rx=\"16\" fill=\"#4f46e5\"/>\n  <text x=\"60\" y=\"21\" fill=\"#ffffff\" text-anchor=\"middle\">acme</text>\n</svg>\n";

fn package_json(router: &str) -> String {
    format!(
        "{{\n  \"name\": \"storefront\",\n  \"private\": true,\n  \"scripts\": {{\n    \"dev\": \"vite\",\n    \"test\": \"vitest\"\n  }},\n  \"dependencies\": {{\n    \"react\": \"^18.3.1\",\n    \"react-router\": \"^{router}\"\n  }}\n}}\n"
    )
}

fn storefront_base() -> Vec<FileSpec> {
    let mut f = vec![
        t("package.json", package_json("6.26.0")),
        t("pnpm-lock.yaml", lockfile("6.26.0", 1)),
        t(
            "tsconfig.json",
            "{\n  \"compilerOptions\": {\n    \"strict\": true,\n    \"jsx\": \"react-jsx\"\n  }\n}\n",
        ),
        t(
            ".gitattributes",
            "src/generated/** linguist-generated=true\n",
        ),
        t("README.md", README_V1),
        t(
            "docs/architecture.md",
            "# Architecture\n\nPages compose components; components never fetch.\n",
        ),
        t("src/lib/price.ts", PRICE_V1),
        t("src/lib/cart.ts", CART_V1),
        t("src/lib/search.ts", SEARCH_V1),
        t("src/lib/orders.ts", ORDERS_V1),
        t(
            "src/lib/payments.ts",
            "export const PAYMENTS_URL = '/api/payments';\n",
        ),
        t("src/generated/routes.gen.ts", routes(&PAGES, 1)),
        asset("assets/placeholder.png", "assets/placeholder-v1.png"),
        t("assets/logo.svg", LOGO_V1),
        t(
            "src/styles/theme.css",
            ":root {\n  --color-text: #1f2937;\n  --color-surface: #ffffff;\n}\n",
        ),
        t(
            "tests/cart.test.ts",
            "import { total } from '../src/lib/cart';\n\ntest('total', () => {\n  expect(total([{ sku: 'a', price: 10, qty: 2 }], 0.1)).toBe(22);\n});\n",
        ),
        t(
            "tests/search.test.ts",
            "import { search } from '../src/lib/search';\n\ntest('search', () => {\n  expect(search(['Mug', 'Hat'], 'mu')).toEqual(['Mug']);\n});\n",
        ),
    ];
    f.extend(
        COMPONENTS
            .iter()
            .map(|c| t(&format!("src/components/{c}.tsx"), component(c, false))),
    );
    f.extend(
        PAGES
            .iter()
            .map(|p| t(&format!("src/pages/{p}.tsx"), page(p, false))),
    );
    f.extend(
        STYLES
            .iter()
            .map(|s| t(&format!("src/styles/{s}.css"), style(s, false))),
    );
    f.extend(
        HOOKS
            .iter()
            .map(|h| t(&format!("src/hooks/{h}.ts"), hook(h, false))),
    );
    f.extend(ROOT_CONFIGS.iter().map(|c| t(c, root_config(c, 2025))));
    f
}

/// ABC-142: design tokens across ~50 files in six directories, with a rename.
fn design_tokens() -> Vec<CommitSpec> {
    let mut first = vec![t(
        "src/styles/tokens.ts",
        "export const tokens = {\n  text: 'var(--color-text)',\n  surface: 'var(--color-surface)',\n  radius: 8,\n  space: (n: number) => `${n * 4}px`,\n  motion: { fast: 120, slow: 300 },\n} as const;\n",
    )];
    first.push(rename(
        "src/styles/theme.css",
        "src/styles/tokens/theme.css",
        ":root {\n  --color-text: #111827;\n  --color-surface: #ffffff;\n  --color-accent: #4f46e5;\n}\n",
    ));
    first.extend(
        STYLES
            .iter()
            .map(|s| t(&format!("src/styles/{s}.css"), style(s, true))),
    );
    let mut second: Vec<FileSpec> = COMPONENTS
        .iter()
        .map(|c| t(&format!("src/components/{c}.tsx"), component(c, true)))
        .collect();
    second.extend(
        PAGES
            .iter()
            .map(|p| t(&format!("src/pages/{p}.tsx"), page(p, true))),
    );
    second.extend(
        HOOKS
            .iter()
            .map(|h| t(&format!("src/hooks/{h}.ts"), hook(h, true))),
    );
    let mut third: Vec<FileSpec> = ["text", "surface", "radius", "space", "motion", "theme"]
        .iter()
        .map(|n| {
            t(
                &format!("tests/tokens/{n}.test.ts"),
                format!(
                    "import {{ tokens }} from '../../src/styles/tokens';\n\ntest('{n} token exists', () => {{\n  expect(tokens).toHaveProperty('{n}');\n}});\n"
                ),
            )
        })
        .collect();
    third.push(t(
        "docs/tokens.md",
        "# Design tokens\n\nUse `tokens.*` instead of literal colors, radii and spacing.\n\n| Token | Value |\n| --- | --- |\n| `text` | `--color-text` |\n| `surface` | `--color-surface` |\n| `radius` | 8 |\n",
    ));
    vec![
        commit("Add design tokens", "lee", "3d", first),
        commit(
            "Use tokens in components, pages and hooks",
            "lee",
            "2d",
            second,
        ),
        commit("Test and document tokens", "lee", "1d", third),
    ]
}

fn storefront() -> RepoSpec {
    let main_later = commit(
        "Format prices with Intl.NumberFormat",
        "mira",
        "20h",
        vec![t("src/lib/price.ts", PRICE_MAIN)],
    );
    RepoSpec {
        owner: "acme".into(),
        name: "storefront".into(),
        description: Some("The Acme web shop".into()),
        private: true,
        default_branch: "main".into(),
        hosted: true,
        require_up_to_date: false,
        branches: vec![
            branch(
                "main",
                None,
                vec![commit("Initial storefront", "mira", "4w", storefront_base())],
            ),
            // Branched before `main` moved on: conflicts with it.
            branch(
                "lee/ABC-160-price-locale",
                Some("main"),
                vec![commit(
                    "ABC-160 Locale-aware price formatting",
                    "lee",
                    "2d",
                    vec![t("src/lib/price.ts", PRICE_PR)],
                )],
            ),
            branch(
                "lee/ABC-120-grid",
                Some("main"),
                vec![commit(
                    "ABC-120 Virtualize the product grid",
                    "lee",
                    "4d",
                    vec![t(
                        "src/lib/grid.ts",
                        "export function visibleRange(scrollTop: number, rowHeight: number, rows: number) {\n  const first = Math.floor(scrollTop / rowHeight);\n  return [first, first + rows] as const;\n}\n",
                    )],
                )],
            ),
            branch(
                "tomas/css-in-js",
                Some("main"),
                vec![commit(
                    "Try CSS-in-JS for buttons",
                    "tomas",
                    "6d",
                    vec![t(
                        "src/styles/css-in-js.ts",
                        "export const button = {\n  padding: '8px 12px',\n  borderRadius: 6,\n};\n",
                    )],
                )],
            ),
            branch("main", None, vec![main_later]),
            branch(
                "mira/ABC-101-cart-rounding",
                Some("main"),
                vec![commit(
                    "ABC-101 Round cart totals to cents",
                    "mira",
                    "5h",
                    vec![t("src/lib/cart.ts", CART_V2)],
                )],
            ),
            branch("lee/ABC-142-design-tokens", Some("main"), design_tokens()),
            branch(
                "tomas/copyright-2026",
                Some("main"),
                vec![commit(
                    "Bump copyright headers to 2026",
                    "tomas",
                    "1d",
                    ROOT_CONFIGS.iter().map(|c| t(c, root_config(c, 2026))).collect(),
                )],
            ),
            branch(
                "renovate/react-router-7",
                Some("main"),
                vec![commit(
                    "chore(deps): update react-router to v7",
                    "renovate-bot",
                    "9h",
                    vec![
                        t("package.json", package_json("7.1.0")),
                        t("pnpm-lock.yaml", lockfile("7.1.0", 5)),
                        t("src/generated/routes.gen.ts", routes(&PAGES[..7], 2)),
                    ],
                )],
            ),
            branch(
                "priya/ABC-150-placeholder-art",
                Some("main"),
                vec![commit(
                    "ABC-150 Refresh placeholder art",
                    "priya",
                    "7h",
                    vec![
                        asset("assets/placeholder.png", "assets/placeholder-v2.png"),
                        asset("assets/badge.png", "assets/badge.png"),
                        t("assets/logo.svg", LOGO_V2),
                    ],
                )],
            ),
            branch(
                "mira/checkout-docs",
                Some("main"),
                vec![commit(
                    "Document the checkout flow",
                    "mira",
                    "6h",
                    vec![
                        t("docs/checkout.md", CHECKOUT_DOC),
                        t("README.md", README_V2),
                    ],
                )],
            ),
            branch(
                "sam/wishlist-sync",
                Some("main"),
                vec![commit(
                    "WIP wishlist sync",
                    VIEWER,
                    "3h",
                    vec![
                        t(
                            "src/lib/wishlist.ts",
                            "export async function syncWishlist(ids: string[]) {\n  // TODO: conflict resolution\n  await fetch('/api/wishlist', { method: 'PUT', body: JSON.stringify(ids) });\n}\n",
                        ),
                        t("src/pages/Wishlist.tsx", page("Wishlist", false).replace("<h1>Wishlist</h1>", "<h1>Wishlist</h1>\n      <p>Synced across devices.</p>")),
                    ],
                )],
            ),
            branch(
                "tomas/ABC-171-search-suggestions",
                Some("main"),
                vec![commit(
                    "ABC-171 Search suggestions",
                    "tomas",
                    "8h",
                    vec![
                        t("src/lib/search.ts", SEARCH_V2),
                        t(
                            "tests/search.test.ts",
                            "import { search, suggest } from '../src/lib/search';\n\ntest('search', () => {\n  expect(search(['Mug', 'Hat'], 'mu')).toEqual(['Mug']);\n});\n\ntest('suggest caps results', () => {\n  expect(suggest(['Mug', 'Mugs', 'Muggle'], 'mu', 2)).toHaveLength(2);\n});\n",
                        ),
                    ],
                )],
            ),
            branch(
                "sam/ABC-175-order-history",
                Some("main"),
                vec![
                    commit(
                        "ABC-175 Order history page",
                        VIEWER,
                        "2d",
                        vec![
                            t("src/lib/orders.ts", ORDERS_V2),
                            t("src/pages/Orders.tsx", ORDERS_PAGE),
                        ],
                    ),
                    commit(
                        "Paginate orders",
                        VIEWER,
                        "1d",
                        vec![t(
                            "src/pages/Orders.tsx",
                            ORDERS_PAGE.replace("listOrders()", "listOrders(1)"),
                        )],
                    ),
                ],
            ),
            branch(
                "sam/ABC-180-coupons",
                Some("main"),
                vec![commit(
                    "ABC-180 Validate coupon codes",
                    VIEWER,
                    "1d",
                    vec![t("src/lib/coupons.ts", COUPONS)],
                )],
            ),
            branch(
                "priya/ABC-190-1-payment-client",
                Some("main"),
                vec![commit(
                    "ABC-190 Extract the payment client",
                    "priya",
                    "3d",
                    vec![t("src/lib/payments/client.ts", PAYMENTS_V1)],
                )],
            ),
            branch(
                "priya/ABC-190-2-retries",
                Some("priya/ABC-190-1-payment-client"),
                vec![
                    commit(
                        "ABC-190 Retry failed charges",
                        "priya",
                        "3d",
                        vec![t("src/lib/payments/client.ts", PAYMENTS_V2)],
                    ),
                    commit(
                        "ABC-190 Name the retry budget",
                        "priya",
                        "20h",
                        vec![t(
                            "src/lib/payments/client.ts",
                            PAYMENTS_V2.replace("const RETRIES = 3;", "/** Attempts per charge, including the first. */\nconst RETRIES = 3;"),
                        )],
                    ),
                ],
            ),
            branch(
                "priya/ABC-190-3-checkout",
                Some("priya/ABC-190-2-retries"),
                vec![commit(
                    "ABC-190 Charge through the client at checkout",
                    "priya",
                    "18h",
                    vec![t("src/pages/Checkout.tsx", CHECKOUT_V3)],
                )],
            ),
            branch(
                "tomas/ABC-199-footer-links",
                Some("main"),
                vec![commit(
                    "ABC-199 Footer links",
                    "tomas",
                    "2h",
                    vec![t(
                        "src/lib/links.ts",
                        "export const footerLinks = [\n  { href: '/help', label: 'Help' },\n  { href: '/returns', label: 'Returns' },\n  { href: '/privacy', label: 'Privacy' },\n];\n",
                    )],
                )],
            ),
        ],
    }
}

fn storefront_prs() -> Vec<PrSpec> {
    let s = "acme/storefront";
    let mut out = Vec::new();

    let mut p = pr(
        s,
        101,
        "ABC-101 Round cart totals to cents",
        "mira",
        "mira/ABC-101-cart-rounding",
        None,
        PrStateSpec::Open,
        "Totals were showing `21.999999` for some tax rates.\n\nFixes ABC-101.",
    );
    p.reviewers = vec![requested(VIEWER)];
    let mut th = thread(
        "src/lib/cart.ts",
        14,
        vec![comment(
            "lee",
            "2h",
            "Should this be banker's rounding? Finance rounds half to even.",
        )],
    );
    th.comments[0]
        .reactions
        .insert("+1".into(), vec!["mira".into()]);
    p.threads = vec![th];
    out.push(p);

    let mut p = pr(
        s,
        102,
        "ABC-142 Introduce design tokens",
        "lee",
        "lee/ABC-142-design-tokens",
        None,
        PrStateSpec::Open,
        "Replaces literal colors, radii and spacing with `tokens.*` across components, pages, styles and hooks.\n\n- moves `theme.css` under `styles/tokens/`\n- adds token tests and docs\n\nPart of ABC-142.",
    );
    p.reviewers = vec![ReviewerSpec {
        user: None,
        team: Some("web-core".into()),
        state: ReviewerStateSpec::Requested,
        ago: None,
        body: String::new(),
    }];
    p.labels = vec!["design-system".into()];
    p.threads = vec![thread(
        "src/styles/tokens.ts",
        4,
        vec![comment(
            "mira",
            "20h",
            "8px radius is a visible change on every card — intended?",
        )],
    )];
    out.push(p);

    let mut p = pr(
        s,
        103,
        "Bump copyright headers to 2026",
        "tomas",
        "tomas/copyright-2026",
        None,
        PrStateSpec::Open,
        "Mechanical: the year in every root config header.",
    );
    p.assignees = vec![VIEWER.into()];
    out.push(p);

    let mut p = pr(
        s,
        104,
        "chore(deps): update react-router to v7",
        "renovate-bot",
        "renovate/react-router-7",
        None,
        PrStateSpec::Open,
        "Updates `react-router` from 6.26.0 to 7.1.0.\n\nRegenerates the lockfile and `routes.gen.ts`.",
    );
    p.reviewers = vec![requested(VIEWER)];
    p.labels = vec!["dependencies".into()];
    out.push(p);

    let mut p = pr(
        s,
        105,
        "ABC-150 Refresh placeholder art",
        "priya",
        "priya/ABC-150-placeholder-art",
        None,
        PrStateSpec::Open,
        "New placeholder gradient, a badge and a rounder logo.\n\n@sam can you check the contrast on the badge?",
    );
    p.reviewers = vec![requested("mira")];
    out.push(p);

    let mut p = pr(
        s,
        106,
        "Document the checkout flow",
        "mira",
        "mira/checkout-docs",
        None,
        PrStateSpec::Open,
        "Adds `docs/checkout.md` and links it from the README.",
    );
    p.reviewers = vec![requested(VIEWER)];
    p.labels = vec!["docs".into()];
    out.push(p);

    let mut p = pr(
        s,
        107,
        "ABC-160 Locale-aware price formatting",
        "lee",
        "lee/ABC-160-price-locale",
        None,
        PrStateSpec::Open,
        "German locale puts the currency after the amount. Also parses `12,50`.",
    );
    p.reviewers = vec![requested(VIEWER)];
    p.threads = vec![thread(
        "src/lib/price.ts",
        3,
        vec![comment(
            "mira",
            "1d",
            "@sam this collides with the Intl change on main — who rebases?",
        )],
    )];
    out.push(p);

    let mut p = pr(
        s,
        108,
        "WIP: Wishlist sync",
        VIEWER,
        "sam/wishlist-sync",
        None,
        PrStateSpec::Draft,
        "Not ready: conflict resolution is still a TODO.",
    );
    p.checks = vec![
        check("ci/build", CheckStatus::Pass),
        check("ci/test", CheckStatus::Pending),
    ];
    out.push(p);

    let mut p = pr(
        s,
        109,
        "ABC-171 Search suggestions",
        "tomas",
        "tomas/ABC-171-search-suggestions",
        None,
        PrStateSpec::Open,
        "Suggests up to five matches once two characters are typed.",
    );
    p.reviewers = vec![requested(VIEWER)];
    p.checks = vec![
        check("ci/build", CheckStatus::Pass),
        check("ci/test", CheckStatus::Fail),
        check("lint", CheckStatus::Fail),
    ];
    out.push(p);

    let mut p = pr(
        s,
        110,
        "ABC-175 Order history page",
        VIEWER,
        "sam/ABC-175-order-history",
        None,
        PrStateSpec::Open,
        "Lists past orders with their status, paginated.",
    );
    p.reviewers = vec![
        reviewed("mira", ReviewerStateSpec::Approved, "20h", "Looks good."),
        reviewed("lee", ReviewerStateSpec::Approved, "18h", ""),
    ];
    p.required_approvals = Some(2);
    out.push(p);

    let mut p = pr(
        s,
        111,
        "ABC-180 Validate coupon codes",
        VIEWER,
        "sam/ABC-180-coupons",
        None,
        PrStateSpec::Open,
        "Rejects empty, malformed and expired codes.",
    );
    p.reviewers = vec![reviewed(
        "lee",
        ReviewerStateSpec::ChangesRequested,
        "10h",
        "A couple of edge cases, see inline.",
    )];
    p.required_approvals = Some(1);
    let mut suggestion = thread(
        "src/lib/coupons.ts",
        7,
        vec![comment(
            "lee",
            "10h",
            "Whitespace-only codes slip through:\n\n```suggestion\n  if (!code.trim()) return { ok: false, reason: 'empty' };\n```",
        )],
    );
    suggestion.comments[0]
        .reactions
        .insert("+1".into(), vec!["mira".into(), VIEWER.into()]);
    suggestion.comments[0]
        .reactions
        .insert("eyes".into(), vec!["priya".into()]);
    let mut resolved = thread(
        "src/lib/coupons.ts",
        8,
        vec![
            comment("mira", "9h", "nit: accept lowercase and upper-case it?"),
            comment(VIEWER, "8h", "Good call, will do in a follow-up."),
        ],
    );
    resolved.resolved = true;
    let mut outdated = thread(
        "src/lib/coupons.ts",
        3,
        vec![comment(
            "priya",
            "1d",
            "Should `reason` be a union of literals?",
        )],
    );
    outdated.outdated = true;
    p.threads = vec![suggestion, resolved, outdated];
    out.push(p);

    let mut p = pr(
        s,
        112,
        "ABC-190 [1/3] Extract the payment client",
        "priya",
        "priya/ABC-190-1-payment-client",
        None,
        PrStateSpec::Open,
        "First of three: moves charging into `lib/payments/client.ts`.",
    );
    p.reviewers = vec![requested(VIEWER)];
    out.push(p);

    let mut p = pr(
        s,
        113,
        "ABC-190 [2/3] Retry failed charges",
        "priya",
        "priya/ABC-190-2-retries",
        Some("priya/ABC-190-1-payment-client"),
        PrStateSpec::Open,
        "Second of three: up to three attempts per charge.",
    );
    p.reviewers = vec![reviewed(
        VIEWER,
        ReviewerStateSpec::Commented,
        "2d",
        "Name the retry budget?",
    )];
    out.push(p);

    let mut p = pr(
        s,
        114,
        "ABC-190 [3/3] Charge through the client at checkout",
        "priya",
        "priya/ABC-190-3-checkout",
        Some("priya/ABC-190-2-retries"),
        PrStateSpec::Open,
        "Last of three: the checkout page uses the new client.",
    );
    p.reviewers = vec![requested("lee")];
    p.checks = vec![
        check("ci/build", CheckStatus::Pass),
        check("ci/test", CheckStatus::Pending),
    ];
    out.push(p);

    let mut p = pr(
        s,
        115,
        "ABC-120 Virtualize the product grid",
        "lee",
        "lee/ABC-120-grid",
        None,
        PrStateSpec::Merged,
        "Only renders visible rows.",
    );
    p.updated_ago = Some("3d".into());
    p.reviewers = vec![reviewed(VIEWER, ReviewerStateSpec::Approved, "3d", "")];
    out.push(p);

    let mut p = pr(
        s,
        116,
        "Try CSS-in-JS for buttons",
        "tomas",
        "tomas/css-in-js",
        None,
        PrStateSpec::Closed,
        "Experiment; closing in favour of design tokens.",
    );
    p.updated_ago = Some("5d".into());
    out.push(p);

    let p = pr(
        s,
        117,
        "ABC-199 Footer links",
        "tomas",
        "tomas/ABC-199-footer-links",
        None,
        PrStateSpec::Open,
        "Help, returns and privacy links in the footer.",
    );
    out.push(p);
    out
}

// ── billing (Python) ───────────────────────────────────────────────────

const RENDER_PY: &str = "\"\"\"Render invoices.\"\"\"\n\nfrom billing.invoice import Invoice\n\n\ndef render_text(invoice: Invoice) -> str:\n    lines = [f\"Invoice {invoice.number}\"]\n    for item in invoice.items:\n        lines.append(f\"{item.name}: {item.cents / 100:.2f}\")\n    return \"\\n\".join(lines)\n";

const PDF_PY: &str = "\"\"\"Render invoices as text or PDF.\"\"\"\n\nfrom billing.invoice import Invoice\n\n\ndef render_text(invoice: Invoice) -> str:\n    lines = [f\"Invoice {invoice.number}\"]\n    for item in invoice.items:\n        lines.append(f\"{item.name}: {item.cents / 100:.2f}\")\n    return \"\\n\".join(lines)\n\n\ndef render_pdf(invoice: Invoice) -> bytes:\n    text = render_text(invoice)\n    return b\"%PDF-1.4\\n\" + text.encode()\n";

const INVOICE_PY: &str = "from dataclasses import dataclass, field\n\n\n@dataclass\nclass Item:\n    name: str\n    cents: int\n\n\n@dataclass\nclass Invoice:\n    number: str\n    items: list[Item] = field(default_factory=list)\n\n    def total(self) -> int:\n        return sum(i.cents for i in self.items)\n";

const WEBHOOKS_V1: &str = "import requests\n\n\ndef deliver(url: str, payload: dict) -> bool:\n    response = requests.post(url, json=payload, timeout=5)\n    return response.ok\n";

const WEBHOOKS_V2: &str = "import time\n\nimport requests\n\nMAX_ATTEMPTS = 5\n\n\ndef deliver(url: str, payload: dict) -> bool:\n    for attempt in range(MAX_ATTEMPTS):\n        response = requests.post(url, json=payload, timeout=5)\n        if response.ok:\n            return True\n        if response.status_code < 500:\n            return False\n        time.sleep(2 ** attempt)\n    return False\n";

fn poetry_lock(seed: u32) -> String {
    let mut out = String::from(
        "# This file is automatically @generated by Poetry and should not be changed by hand.\n",
    );
    for i in 0..40u32 {
        out.push_str(&format!(
            "\n[[package]]\nname = \"lib{i:02}\"\nversion = \"2.{}.{}\"\noptional = false\n",
            (i + seed) % 9,
            (i * 3 + seed) % 7
        ));
    }
    out
}

fn billing() -> RepoSpec {
    RepoSpec {
        owner: "acme".into(),
        name: "billing".into(),
        description: Some("Invoices, payments and webhooks".into()),
        private: true,
        default_branch: "main".into(),
        hosted: true,
        require_up_to_date: false,
        branches: vec![
            branch(
                "main",
                None,
                vec![commit(
                    "Initial billing service",
                    "priya",
                    "6w",
                    vec![
                        t(
                            "pyproject.toml",
                            "[project]\nname = \"billing\"\nrequires-python = \">=3.9\"\n",
                        ),
                        t("poetry.lock", poetry_lock(1)),
                        t(
                            "README.md",
                            "# Billing\n\nInvoices, payments and webhooks.\n",
                        ),
                        t("billing/__init__.py", ""),
                        t("billing/invoice.py", INVOICE_PY),
                        t("billing/render.py", RENDER_PY),
                        t("billing/webhooks.py", WEBHOOKS_V1),
                        t(
                            "tests/test_invoice.py",
                            "from billing.invoice import Invoice, Item\n\n\ndef test_total():\n    assert Invoice(\"1\", [Item(\"a\", 250)]).total() == 250\n",
                        ),
                    ],
                )],
            ),
            branch(
                "lee/BIL-9-py310",
                Some("main"),
                vec![commit(
                    "BIL-9 Require Python 3.10",
                    "lee",
                    "8d",
                    vec![t(
                        "pyproject.toml",
                        "[project]\nname = \"billing\"\nrequires-python = \">=3.10\"\n",
                    )],
                )],
            ),
            branch(
                "priya/BIL-12-pdf",
                Some("main"),
                vec![commit(
                    "BIL-12 Invoice PDF export",
                    "priya",
                    "4h",
                    vec![
                        rename("billing/render.py", "billing/pdf.py", PDF_PY),
                        t(
                            "billing/invoice.py",
                            INVOICE_PY.replace(
                                "    number: str\n",
                                "    number: str\n    currency: str = \"USD\"\n",
                            ),
                        ),
                        t(
                            "tests/test_pdf.py",
                            "from billing.invoice import Invoice\nfrom billing.pdf import render_pdf\n\n\ndef test_pdf_header():\n    assert render_pdf(Invoice(\"7\")).startswith(b\"%PDF\")\n",
                        ),
                    ],
                )],
            ),
            branch(
                "sam/BIL-15-webhook-retries",
                Some("main"),
                vec![commit(
                    "BIL-15 Retry webhook deliveries with backoff",
                    VIEWER,
                    "1d",
                    vec![t("billing/webhooks.py", WEBHOOKS_V2)],
                )],
            ),
            branch(
                "renovate/poetry-lock",
                Some("main"),
                vec![commit(
                    "chore(deps): refresh poetry.lock",
                    "renovate-bot",
                    "12h",
                    vec![t("poetry.lock", poetry_lock(4))],
                )],
            ),
        ],
    }
}

fn billing_prs() -> Vec<PrSpec> {
    let s = "acme/billing";
    let mut out = Vec::new();
    let mut p = pr(
        s,
        201,
        "BIL-12 Invoice PDF export",
        "priya",
        "priya/BIL-12-pdf",
        None,
        PrStateSpec::Open,
        "Renames `render.py` to `pdf.py` and adds `render_pdf`.",
    );
    p.reviewers = vec![requested(VIEWER)];
    p.checks = vec![
        check("lint", CheckStatus::Pass),
        CheckSpec {
            name: "ci/test".into(),
            status: CheckStatus::Pending,
            duration_ms: None,
            url: None,
            after: Some("45s".into()),
            then: Some(CheckStatus::Pass),
        },
    ];
    out.push(p);

    let mut p = pr(
        s,
        202,
        "BIL-15 Retry webhook deliveries with backoff",
        VIEWER,
        "sam/BIL-15-webhook-retries",
        None,
        PrStateSpec::Open,
        "5xx responses are retried up to five times; 4xx never are.",
    );
    p.reviewers = vec![requested("lee")];
    out.push(p);

    let mut p = pr(
        s,
        203,
        "BIL-9 Require Python 3.10",
        "lee",
        "lee/BIL-9-py310",
        None,
        PrStateSpec::Merged,
        "",
    );
    p.updated_ago = Some("7d".into());
    out.push(p);

    let mut p = pr(
        s,
        204,
        "chore(deps): refresh poetry.lock",
        "renovate-bot",
        "renovate/poetry-lock",
        None,
        PrStateSpec::Open,
        "Lockfile maintenance.",
    );
    p.assignees = vec![VIEWER.into()];
    out.push(p);
    out
}

// ── handbook (local folder) ────────────────────────────────────────────

fn handbook() -> RepoSpec {
    RepoSpec {
        owner: "acme".into(),
        name: "handbook".into(),
        description: Some("Team handbook (local folder project)".into()),
        private: true,
        default_branch: "main".into(),
        hosted: false,
        require_up_to_date: false,
        branches: vec![
            branch(
                "main",
                None,
                vec![commit(
                    "Start the handbook",
                    VIEWER,
                    "3w",
                    vec![
                        t(
                            "README.md",
                            "# Handbook\n\n- [Onboarding](onboarding.md)\n- [On-call](on-call.md)\n",
                        ),
                        t(
                            "onboarding.md",
                            "# Onboarding\n\n1. Get a laptop.\n2. Clone the repos.\n3. Ship something small in week one.\n",
                        ),
                        t(
                            "on-call.md",
                            "# On-call\n\nOne week at a time, Monday to Monday.\n",
                        ),
                    ],
                )],
            ),
            branch(
                "draft/on-call-rotation",
                Some("main"),
                vec![commit(
                    "Describe the on-call handover",
                    VIEWER,
                    "2d",
                    vec![t(
                        "on-call.md",
                        "# On-call\n\nOne week at a time, Monday to Monday.\n\n## Handover\n\n- open incidents\n- noisy alerts\n- anything paged twice\n",
                    )],
                )],
            ),
            branch(
                "fix/typos",
                Some("main"),
                vec![commit(
                    "Fix typos in onboarding",
                    "mira",
                    "1d",
                    vec![t(
                        "onboarding.md",
                        "# Onboarding\n\n1. Get a laptop.\n2. Clone the repositories.\n3. Ship something small in your first week.\n",
                    )],
                )],
            ),
        ],
    }
}

/// The default scenario and the binary assets it references.
pub fn build() -> (Scenario, Vec<(&'static str, Vec<u8>)>) {
    let user = |login: &str, name: &str, avatar: Option<String>, bot: bool| UserSpec {
        login: login.into(),
        name: Some(name.into()),
        avatar,
        bot,
    };
    let mut prs = storefront_prs();
    prs.extend(billing_prs());
    let scenario = Scenario {
        name: "default".into(),
        viewer: VIEWER.into(),
        users: vec![
            user(VIEWER, "Sam Rivera", Some(avatar("SR", "#2563eb")), false),
            user("mira", "Mira Chen", Some(avatar("MC", "#db2777")), false),
            user("lee", "Lee Okafor", Some(avatar("LO", "#059669")), false),
            user("priya", "Priya Nair", Some(avatar("PN", "#d97706")), false),
            user("tomas", "Tomás Varga", None, false),
            user("ci-bot", "CI", Some(avatar("CI", "#4b5563")), true),
            user("renovate-bot", "Renovate", None, true),
        ],
        teams: vec![
            TeamSpec {
                slug: "web-core".into(),
                members: vec![VIEWER.into(), "mira".into(), "lee".into()],
            },
            TeamSpec {
                slug: "platform".into(),
                members: vec!["priya".into(), "tomas".into()],
            },
        ],
        repos: vec![storefront(), billing(), handbook()],
        prs,
        projects: vec![
            ProjectSpec::Host {
                repo: "acme/storefront".into(),
            },
            ProjectSpec::Host {
                repo: "acme/billing".into(),
            },
            ProjectSpec::Local {
                local: "handbook".into(),
                from: "acme/handbook".into(),
            },
        ],
        agents: AgentsMode::Real,
        faults: FaultConfig {
            not_found_prs: vec![107],
            ..FaultConfig::default()
        },
        ci: CiConfig::default(),
        timeline: vec![
            event(
                "push-101",
                Some("45s"),
                Action::Push {
                    pr: PrSel::Number(101),
                    files: vec![t("src/lib/cart.ts", CART_V3)],
                    message: Some("Guard rounding against float error".into()),
                    author: None,
                },
            ),
            event(
                "comment-110",
                Some("60s"),
                Action::Comment {
                    pr: PrSel::Number(110),
                    path: "src/pages/Orders.tsx".into(),
                    line: 7,
                    side: SideSpec::New,
                    body: "Could this effect cancel on unmount? It can set state after the page is gone.".into(),
                    author: Some("lee".into()),
                },
            ),
            event(
                "lint-109",
                Some("75s"),
                Action::Check {
                    pr: PrSel::Number(109),
                    name: "lint".into(),
                    status: CheckStatus::Pass,
                },
            ),
            event(
                "request-117",
                Some("90s"),
                Action::RequestReview {
                    pr: PrSel::Number(117),
                    user: None,
                    team: None,
                },
            ),
            event(
                "merge-106",
                Some("150s"),
                Action::Merge {
                    pr: PrSel::Number(106),
                    author: Some("lee".into()),
                },
            ),
            event(
                "push-102",
                None,
                Action::Push {
                    pr: PrSel::Number(102),
                    files: Vec::new(),
                    message: None,
                    author: None,
                },
            ),
            event(
                "fail-110",
                None,
                Action::Check {
                    pr: PrSel::Number(110),
                    name: "ci/test".into(),
                    status: CheckStatus::Fail,
                },
            ),
            event(
                "approve-111",
                None,
                Action::Review {
                    pr: PrSel::Number(111),
                    author: "lee".into(),
                    state: ReviewerStateSpec::Approved,
                    body: "Thanks for the fixes.".into(),
                },
            ),
        ],
    };
    (scenario, assets())
}

/// Writes the default scenario to `dir` (`scenario.json` + `assets/`).
pub fn write(dir: &Path) -> SandboxResult<PathBuf> {
    let (scenario, assets) = build();
    for (path, bytes) in assets {
        let p = dir.join(path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SandboxError::Io(parent.into(), e))?;
        }
        std::fs::write(&p, bytes).map_err(|e| SandboxError::Io(p.clone(), e))?;
    }
    scenario.save(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scenario_validates() {
        let (s, assets) = build();
        s.validate().unwrap();
        assert!(
            assets
                .iter()
                .all(|(_, b)| b.starts_with(&[0x89, b'P', b'N', b'G']))
        );
        assert!(s.prs.len() >= 20);
    }

    #[test]
    fn png_has_a_valid_structure() {
        let p = png(2, 2, |_, _| [1, 2, 3]);
        assert_eq!(&p[12..16], b"IHDR");
        assert_eq!(&p[p.len() - 8..p.len() - 4], b"IEND");
    }
}
