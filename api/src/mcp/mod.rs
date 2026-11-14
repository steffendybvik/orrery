// orrery's MCP tools, served at `/mcp` (ORR-1098, part of ORR-923): streamable HTTP, a JSON answer to each JSON-RPC
// message and no server-sent stream. This is the groundwork: `initialize`, `ping`, `tools/list` for each kind of session
// (tools.rs) and `tools/call` for `guide` (guide.rs) and `more_tools`. The board's tools are served from ORR-1099 on;
// until then a call to one says so, and the channel (channel/tools.mjs) keeps serving them.
//
// Who's asking is the guard's (request.rs): with login on, an agent key as the bearer. A browser's login is refused, as
// a session's tools are an agent's. The kind of session is the router's `Orrery-Actor-Kind`, as on the REST routes.
pub(crate) mod board;
pub(crate) mod guide;
pub(crate) mod relay;
pub(crate) mod sessions;
pub(crate) mod tools;

use crate::db::sql;
use crate::error::Result;
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};
use tools::Kind;

/// The protocol versions this server speaks, newest first: a client's is taken when it's one of them.
pub(crate) const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// orrery's release version, from web/package.json as the Nuxt server's own `public.version` (ORR-1189): the crate's
/// version stays 0.0.0, so `initialize`'s `serverInfo` would say nothing useful.
pub(crate) static ORRERY_VERSION: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let package: Value = serde_json::from_str(include_str!("../../../web/package.json")).expect("web/package.json is JSON");
    package["version"].as_str().expect("web/package.json has a version").to_string()
});

/// The projects on this orrery, as `GET /api/projects` orders them: a tool on one takes which when there are several.
async fn projects(conn: &mut AnyConnection) -> Result<Vec<String>> {
    let rows = sqlx::query(&sql("SELECT id FROM projects ORDER BY lower(name), name")).fetch_all(conn).await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("id")).collect())
}

/// What answers one JSON-RPC message: `None` for a notification, which has no answer.
pub(crate) struct Call<'a> {
    pub(crate) app: &'a std::sync::Arc<crate::App>,
    /// The `/mcp` request's headers: who's asking, for the routes a board tool calls (board.rs).
    pub(crate) headers: &'a axum::http::HeaderMap,
    pub(crate) kind: Kind,
    /// The `Mcp-Session-Id` it came with.
    pub(crate) session: Option<&'a str>,
    /// What the routes its tools ran set off, for its reply (relay.rs).
    pub(crate) relay: &'a relay::Relay,
}

fn error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn text(said: impl Into<String>, is_error: bool) -> Value {
    let mut answer = json!({"content": [{"type": "text", "text": said.into()}]});
    if is_error {
        answer["isError"] = json!(true);
    }
    answer
}

impl Call<'_> {
    /// The answer to `message`, or `None` when it's a notification or a client's answer.
    pub(crate) async fn answer(&self, conn: &mut AnyConnection, message: &Value) -> Result<Option<Value>> {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            // A client's answer to something asked of it, which this server never asks: nothing to say.
            if message.get("result").is_some() || message.get("error").is_some() {
                return Ok(None);
            }
            return Ok(Some(error(message.get("id").unwrap_or(&Value::Null), -32600, "Not a JSON-RPC request: it has no method")));
        };
        let Some(id) = message.get("id") else { return Ok(None) };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        Ok(Some(match method {
            "initialize" => {
                let asked = params["protocolVersion"].as_str().unwrap_or_default();
                let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
                result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": "orrery", "version": ORRERY_VERSION.as_str()},
                        "instructions": "orrery keeps the roadmap: projects, issues, comments and docs. Name the project on a call when there are several; how orrery itself works is the guide tool.",
                    }),
                )
            }
            "ping" => result(id, json!({})),
            "tools/list" => {
                let tools = tools::tools_for(&projects(conn).await?, self.kind, &self.app.mcp.loaded(self.session));
                result(id, json!({"tools": tools}))
            }
            "tools/call" => {
                let Some(name) = params["name"].as_str() else { return Ok(Some(error(id, -32602, "tools/call names its tool"))) };
                result(id, self.call(conn, name, &params["arguments"]).await?)
            }
            other => error(id, -32601, format!("No method \"{other}\" here")),
        }))
    }

    /// A tool's answer, as the channel's `callTool` gives it: refused in its words when the session doesn't have it.
    async fn call(&self, conn: &mut AnyConnection, name: &str, args: &Value) -> Result<Value> {
        // Every tool the session's kind could ever have listed, whatever it has loaded.
        let all: Vec<String> = tools::groups().iter().map(|g| g.to_string()).collect();
        let projects = projects(conn).await?;
        let listed = tools::tools_for(&projects, self.kind, &all);
        let has = listed.iter().any(|t| t["name"] == name) || (name == "more_tools" && self.kind == Kind::Work);
        if !has {
            return Ok(text(format!("No tool \"{name}\""), true));
        }
        Ok(match name {
            "guide" => match args["section"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                Some(asked) => text(guide::section(guide::USING, asked), false),
                None => text(guide::contents(guide::USING), false),
            },
            "more_tools" => {
                let group = args["group"].as_str().unwrap_or_default();
                match tools::group(group) {
                    Some(names) => {
                        self.app.mcp.load(self.session, group);
                        text(format!("Added {} to your tools.", names.join(", ")), false)
                    }
                    None => text(format!("orrery said no: group is {}", tools::groups().join(", ")), true),
                }
            }
            // The chat's request actions, read through one tool so they aren't all listed (ORR-624).
            "request_fields" => match tools::request_fields(&args["action"]) {
                Ok(fields) => text(fields, false),
                Err(no) => text(no, true),
            },
            "request" if tools::chat_request(args["action"].as_str().unwrap_or_default()).is_none() => text(tools::no_action(&args["action"]), true),
            // Not text: the image as itself.
            "image" => match (board::Api { app: self.app, headers: self.headers, projects: &projects, relay: self.relay }).image(args).await {
                Ok(image) => image,
                Err(board::No(why)) => text(format!("orrery said no: {why}"), true),
            },
            _ => match (board::Api { app: self.app, headers: self.headers, projects: &projects, relay: self.relay }).run(name, args).await {
                Some(Ok(said)) => text(said, false),
                Some(Err(board::No(why))) => text(format!("orrery said no: {why}"), true),
                None => text(format!("{name} isn't served at /mcp yet: orrery's channel still has it"), true),
            },
        })
    }
}
