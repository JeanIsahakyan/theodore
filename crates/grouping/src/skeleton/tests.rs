use super::*;
use theodore_domain::{DiffLine, FileStatus, HunkId};

/// One hunk with `header`; `+`/`-`/` ` prefixes. New-side line numbers
/// start at `new_start`.
fn hunk(header: &str, new_start: u32, lines: &[&str]) -> Hunk {
    let mut n = new_start;
    let lines = lines
        .iter()
        .map(|l| {
            let (kind, text) = match l.split_at(1) {
                ("+", t) => (LineKind::Add, t),
                ("-", t) => (LineKind::Del, t),
                (_, t) => (LineKind::Ctx, t),
            };
            let new_no = (kind != LineKind::Del).then(|| {
                n += 1;
                n - 1
            });
            DiffLine {
                kind,
                text: text.to_string(),
                old_no: None,
                new_no,
            }
        })
        .collect();
    Hunk {
        id: HunkId::new(format!("h{new_start}")),
        path: String::new(),
        old_start: new_start,
        old_lines: 1,
        new_start,
        new_lines: 1,
        header: header.into(),
        lines,
    }
}

fn file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
    FileDiff {
        path: path.into(),
        old_path: None,
        status: FileStatus::Modified,
        similarity: None,
        old_mode: None,
        new_mode: None,
        flags: vec![],
        additions: 0,
        deletions: 0,
        hunks,
    }
}

fn sk(path: &str, header: &str, lines: &[&str]) -> Skeleton {
    extract(&file(path, vec![hunk(header, 1, lines)]), None)
}

#[test]
fn typescript_route_handler_hook_calls() {
    let s = sk(
        "web/src/api/invoices.ts",
        "",
        &[
            "+export async function billInvoice(id: string) {",
            "+  const row = await db.insert(invoices).values({ id });",
            "+  await stripe.charges.create({ amount: row.total });",
            "+  console.log('billed');",
            "+}",
            "+router.post('/invoices/:id/bill', billInvoice);",
            "+  const { data } = useInvoice(id);",
        ],
    );
    assert_eq!(s.adds, vec!["billInvoice"]);
    assert_eq!(s.routes, vec!["POST /invoices/:id/bill"]);
    assert!(s.calls.contains(&"db.insert".to_string()), "{:?}", s.calls);
    assert!(s.calls.contains(&"charges.create".to_string()));
    assert!(!s.calls.iter().any(|c| c.starts_with("console.")));
    assert_eq!(s.hooks, vec!["useInvoice"]);
}

#[test]
fn react_component_defining_a_hook_lists_it_once() {
    let s = sk(
        "web/src/hooks/useCart.tsx",
        "",
        &[
            "+export function useCart() {",
            "+  const [items, setItems] = useState<Item[]>([]);",
            "+  const query = useQuery({ queryKey: ['cart'] });",
        ],
    );
    assert_eq!(s.adds, vec!["useCart"]);
    assert_eq!(s.hooks, vec!["useState", "useQuery"]);
}

#[test]
fn python_decorator_route_sql_and_enclosing_method_from_header() {
    let s = sk(
        "api/users/service.py",
        "class UserService:",
        &[
            "     def save(self, user):",
            "-        self.db.commit()",
            "+        cursor.execute(\"UPDATE users SET name = %s WHERE id = %s\", args)",
            "+        self.db.commit()",
        ],
    );
    assert_eq!(s.edits, vec!["UserService.save"]);
    assert_eq!(s.tables, vec!["users"]);
    assert!(s.calls.contains(&"cursor.execute".to_string()));

    let r = sk(
        "api/users/routes.py",
        "",
        &[
            "+@router.post(\"/users\")",
            "+def create_user(body: UserIn):",
        ],
    );
    assert_eq!(r.routes, vec!["POST /users"]);
    assert_eq!(r.adds, vec!["create_user"]);
}

#[test]
fn python_imports_are_not_sql() {
    let s = sk(
        "app/models.py",
        "",
        &[
            "+from sqlalchemy import select",
            "+from app.db import session",
        ],
    );
    assert!(s.tables.is_empty(), "{:?}", s.tables);
}

#[test]
fn multi_line_sql_continuation_lines_name_their_tables() {
    let s = sk(
        "internal/store/orders.go",
        "func (s *Store) ListOrders(ctx context.Context) ([]Order, error) {",
        &[
            "+\tq := `SELECT o.id, c.name",
            "+\t\tFROM orders o",
            "+\t\tJOIN customers c ON c.id = o.customer_id`",
        ],
    );
    assert_eq!(s.tables, vec!["orders", "customers"]);
    assert_eq!(s.edits, vec!["ListOrders"]);
}

#[test]
fn rust_axum_route_attribute_route_impl_and_sql() {
    let s = sk(
        "server/src/routes.rs",
        "impl AppState {",
        &[
            "     pub fn router(&self) -> Router {",
            "+        Router::new().route(\"/health\", get(health))",
            "     }",
        ],
    );
    assert_eq!(s.routes, vec!["/health"]);
    assert_eq!(s.edits, vec!["AppState.router"]);

    let a = sk(
        "server/src/api.rs",
        "",
        &[
            "+#[get(\"/accounts/{id}\")]",
            "+pub async fn get_account(id: Path<u64>) -> impl Responder {",
            "+    sqlx::query(\"UPDATE accounts SET seen = now() WHERE id = $1\")",
        ],
    );
    assert_eq!(a.routes, vec!["GET /accounts/{id}"]);
    assert_eq!(a.adds, vec!["get_account"]);
    assert_eq!(a.tables, vec!["accounts"]);
    assert!(a.calls.contains(&"sqlx.query".to_string()));
}

#[test]
fn go_handlefunc_route_and_method() {
    let s = sk(
        "internal/http/handler.go",
        "",
        &[
            "+\tr.HandleFunc(\"/users\", h.listUsers).Methods(\"GET\")",
            "+func (h *Handler) listUsers(w http.ResponseWriter, r *http.Request) {",
            "+\tusers, err := h.store.ListUsers(r.Context())",
        ],
    );
    assert_eq!(s.routes, vec!["/users"]);
    assert!(s.adds.contains(&"listUsers".to_string()), "{:?}", s.adds);
    assert!(s.calls.contains(&"store.ListUsers".to_string()));
}

#[test]
fn php_laravel_route_query_builder_and_method() {
    let s = sk(
        "app/Http/Controllers/ProfileController.php",
        "class ProfileController extends Controller",
        &[
            "+    public function show(Request $request)",
            "+    {",
            "+        $user = DB::table('users')->where('id', $request->id)->first();",
            "+        return $this->profiles->render($user);",
        ],
    );
    assert_eq!(s.adds, vec!["show"]);
    assert_eq!(s.tables, vec!["users"]);
    assert!(
        s.calls.contains(&"profiles.render".to_string()),
        "{:?}",
        s.calls
    );

    let r = sk(
        "routes/web.php",
        "",
        &["+Route::get('/profile', [ProfileController::class, 'show']);"],
    );
    assert_eq!(r.routes, vec!["GET /profile"]);
}

#[test]
fn swift_vapor_route_extension_and_func() {
    let s = sk(
        "Sources/App/UserController.swift",
        "extension UserController {",
        &[
            "     func boot(routes: RoutesBuilder) throws {",
            "+        routes.get(\"users\", \":id\", use: show)",
            "     }",
            "+    func fetchUser(id: UUID) async throws -> User {",
            "+        try await client.send(FetchUser(id: id))",
        ],
    );
    assert_eq!(s.routes, vec!["GET /users/:id"]);
    assert_eq!(s.adds, vec!["fetchUser"]);
    assert!(
        s.edits.contains(&"UserController.boot".to_string()),
        "{:?}",
        s.edits
    );
    assert!(s.calls.contains(&"client.send".to_string()));
}

#[test]
fn csharp_attribute_routes_and_typed_methods() {
    let s = sk(
        "src/Orders/OrdersController.cs",
        "",
        &[
            "+    [HttpGet(\"{id}\")]",
            "+    public async Task<IActionResult> GetOrder(int id)",
            "+    {",
            "+        var order = await _db.Orders.FindAsync(id);",
        ],
    );
    assert_eq!(s.routes, vec!["GET {id}"]);
    assert_eq!(s.adds, vec!["GetOrder"]);
    assert!(
        s.calls.contains(&"Orders.FindAsync".to_string()),
        "{:?}",
        s.calls
    );
}

#[test]
fn signature_change_is_an_edit_and_deleted_names_are_removes() {
    let s = sk(
        "lib/billing.ts",
        "",
        &[
            "-export function charge(amount: number) {",
            "+export function charge(amount: number, currency: string) {",
            "-export function legacyCharge() {}",
        ],
    );
    assert_eq!(s.edits, vec!["charge"]);
    assert_eq!(s.removes, vec!["legacyCharge"]);
    assert!(s.adds.is_empty());
}

#[test]
fn head_file_names_the_enclosing_definition_beyond_the_hunk_header() {
    let head = "\
export class Invoice {
  constructor(private items: Item[]) {}

  total(): number {
    let sum = 0;
    for (const i of this.items) {
      sum += i.price;
    }
    return sum;
  }
}
";
    // Line 7 (`sum += i.price;`) changed; the hunk header is empty and the
    // hunk shows no definition.
    let f = file(
        "web/src/invoice.ts",
        vec![hunk(
            "",
            6,
            &[
                "     for (const i of this.items) {",
                "-      sum += i.cost;",
                "+      sum += i.price;",
                "     }",
            ],
        )],
    );
    assert!(extract(&f, None).edits.is_empty());
    assert_eq!(extract(&f, Some(head)).edits, vec!["Invoice.total"]);
}

#[test]
fn prose_files_define_nothing() {
    let s = sk(
        "docs/billing.md",
        "",
        &["+The `charge` function calls stripe.charges.create(...) FROM orders."],
    );
    assert!(s.is_empty(), "{s:?}");
}

#[test]
fn render_caps_each_list_and_the_line() {
    let lines: Vec<String> = (0..12)
        .map(|i| format!("+export function someRatherLongFunctionName{i}() {{"))
        .collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let f = file(
        "web/src/a/very/deep/path/to/module.ts",
        vec![hunk("", 1, &refs)],
    );
    let s = extract(&f, None);
    assert_eq!(s.adds.len(), 12);
    let line = render(&f, &s, LINE_MAX_CHARS);
    assert!(line.len() <= LINE_MAX_CHARS, "{} > cap: {line}", line.len());
    assert!(line.starts_with("web/src/a/very/deep/path/to/module.ts (+12 -0): adds "));
    assert!(line.ends_with('…'), "{line}");

    let short = file("a.ts", vec![hunk("", 1, &refs[..7])]);
    let line = render(&short, &extract(&short, None), 400);
    assert!(
        line.ends_with(" +2"),
        "only {MAX_NAMES} names shown: {line}"
    );

    let mut new = file(
        "db/migrations/001_init.sql",
        vec![hunk("", 1, &["+CREATE TABLE invoices (id int);"])],
    );
    new.status = FileStatus::Added;
    let line = render(&new, &extract(&new, None), LINE_MAX_CHARS);
    assert_eq!(
        line,
        "db/migrations/001_init.sql (new, +1 -0): sql invoices"
    );
}

#[test]
fn render_never_splits_a_multibyte_path() {
    let path = format!("{}é.ts", "a".repeat(LINE_MAX_CHARS));
    let f = file(&path, vec![hunk("", 1, &["+x"])]);
    let line = render(&f, &extract(&f, None), LINE_MAX_CHARS);
    assert!(line.len() <= LINE_MAX_CHARS);
    assert!(line.ends_with('…'));
}

fn part(label: &str, n: usize, relevance: f64) -> Part {
    Part {
        label: label.into(),
        files: (0..n)
            .map(|i| {
                (
                    format!("{label}/file{i}.ts (+1 -0): adds thing{i}"),
                    relevance,
                )
            })
            .collect(),
    }
}

#[test]
fn section_lists_other_parts_only() {
    let parts = vec![part("api", 2, 0.0), part("web", 2, 0.0)];
    let s = section(0, &parts, 4_000);
    assert!(s.contains("## Part 2 of 2 (web): 2 file(s)"), "{s}");
    assert!(s.contains("- web/file0.ts"));
    assert!(!s.contains("api/file0.ts"));
    assert!(section(0, &parts[..1], 4_000).is_empty());
}

#[test]
fn section_keeps_the_most_related_files_within_its_cap() {
    let mut far = part("far", 60, 0.0);
    far.files[7].1 = 3.0; // one file strongly linked to this part
    let parts = vec![part("here", 3, 0.0), far, part("near", 5, 1.0)];
    let cap = 1_200;
    let s = section(0, &parts, cap);
    assert!(s.len() <= cap, "{} > {cap}", s.len());
    assert!(s.contains("far/file7.ts"), "{s}");
    for i in 0..5 {
        assert!(s.contains(&format!("near/file{i}.ts")), "{s}");
    }
    assert!(s.contains("more file(s)"));
    assert!(
        section(0, &parts, 200).is_empty(),
        "no room even for headers"
    );
}

#[test]
fn swiftui_trailing_closures_and_extensions_are_not_definitions() {
    let s = sk(
        "App/Views/ChatView.swift",
        "extension Color {",
        &[
            "+    static let honk = Color(red: 1, green: 0.5, blue: 0)",
            "+struct ChatView: View {",
            "+    var body: some View {",
            "+        VStack(spacing: 8) {",
            "+            Button(\"Send\") {",
            "+                store.sendDraft(text)",
        ],
    );
    // Properties inside a type are members, not listed; `Color`, `VStack`
    // and `Button` are not defined here.
    assert_eq!(s.adds, vec!["ChatView"]);
    assert_eq!(
        s.edits,
        vec!["Color"],
        "the change sits in `extension Color`"
    );
    assert_eq!(s.calls, vec!["store.sendDraft"]);
}

#[test]
fn c_type_words_are_not_names() {
    let s = sk(
        "engines/api/api-engine.cpp",
        "",
        &[
            "+static const char* kRoute = \"/v1\";",
            "+thread_local std::string scratch;",
            "+static int handle_login(Conn* c) {",
        ],
    );
    assert_eq!(s.adds, vec!["handle_login"]);
}

#[test]
fn omitted_files_are_counted_by_folder() {
    let line = more_line(&[
        "app/Screens/a.swift (+1 -0)",
        "app/Screens/b.swift (+1 -0)",
        "tools/gen/c.rs (+1 -0)",
        "README.md (+1 -0)",
    ]);
    assert_eq!(
        line,
        "- … +4 more file(s) in app/Screens (2), (root) (1), tools/gen (1)"
    );
}

#[test]
fn imports_and_data_files_define_nothing_but_config_keys() {
    let s = sk(
        "apps/auth/src/store.ts",
        "",
        &[
            "+import type { Redis } from 'ioredis';",
            "+export const WINDOW_SECONDS = 60;",
        ],
    );
    assert_eq!(s.adds, vec!["WINDOW_SECONDS"]);

    let j = sk(
        "contract/openapi.json",
        "",
        &["+        \"type\": \"array\",", "+        \"items\": {"],
    );
    assert!(j.is_empty(), "{j:?}");

    let e = sk(".env.example", "", &["+AUTH_SYNC_SECRET=change-me"]);
    assert_eq!(e.adds, vec!["AUTH_SYNC_SECRET"]);
}
