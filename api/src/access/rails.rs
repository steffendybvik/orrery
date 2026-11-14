// The rails a write is held to before its route runs (ORR-1059), as the Nuxt server's middleware holds it: the owner's
// chat and an untrusted schedule's session to their columns of the permissions table (`guard` in
// web/server/utils/guard.ts, middleware/chat.ts and untrusted.ts), and anyone else, on an orrery with more than one
// person, to the member column and the board the route names (`checkBoards` in web/server/utils/board.ts). So a request
// that reaches this API with the token and no Nuxt in front is refused what Nuxt would refuse. Who's asking is what the
// `Orrery-Actor-*` and `Orrery-Who-*` headers say (request.rs).
//
// The table is web/shared/permissions.ts, copied whole to api/permissions.json by web/test/rust-permissions.test.ts,
// which `GET /api/permissions` answers with (routes/permissions.rs, ORR-1086); the rails read its rows. Reads
// go through: a board's reads are each route's (`needsBoard`), as they are on Nuxt, save that a read or write of a project
// in a workspace the asker isn't a member of is answered 404 (`workspace_check`, ORR-1106).
use crate::access::people::Who;
use crate::board::issue_writes::IssueWrites;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::request::{actor_of, who_of};
use crate::write::Actor;
use crate::Shared;
use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
pub(crate) struct Cell {
    level: String,
    routes: Option<Vec<String>>,
    check: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Permission {
    id: String,
    action: String,
    why: String,
    routes: Vec<String>,
    chat: Cell,
    untrusted: Cell,
    member: Cell,
    unnamed: Option<Vec<String>>,
}

/// api/permissions.json as written: `GET /api/permissions`'s reply, `{levels, kinds, permissions}`.
pub(crate) const TABLE: &str = include_str!("../../permissions.json");

#[derive(Deserialize)]
struct Table {
    permissions: Vec<Permission>,
}

pub(crate) static PERMISSIONS: LazyLock<Vec<Permission>> =
    LazyLock::new(|| serde_json::from_str::<Table>(TABLE).expect("api/permissions.json is the permissions table").permissions);

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Chat,
    Untrusted,
    Member,
}

impl Permission {
    fn cell(&self, kind: Kind) -> &Cell {
        match kind {
            Kind::Chat => &self.chat,
            Kind::Untrusted => &self.untrusted,
            Kind::Member => &self.member,
        }
    }
}

/// The request's parameters if it's `route` (`POST /api/projects/:project/issues`), decoded, else nothing: its method,
/// and its path with each `:name` one part, a trailing slash allowed (`matchRoute`).
pub(crate) fn match_route(route: &str, method: &str, path: &str) -> Option<HashMap<String, String>> {
    let (wanted, pattern) = route.split_once(' ')?;
    if wanted != method {
        return None;
    }
    let path = path.strip_suffix('/').filter(|p| !p.is_empty()).unwrap_or(path);
    let (want, got): (Vec<&str>, Vec<&str>) = (pattern.split('/').collect(), path.split('/').collect());
    if want.len() != got.len() {
        return None;
    }
    let mut params = HashMap::new();
    for (w, g) in want.iter().zip(&got) {
        match w.strip_prefix(':') {
            Some(name) if !g.is_empty() => {
                params.insert(name.to_string(), percent_decode_str(g).decode_utf8_lossy().into_owned());
            }
            Some(_) => return None,
            None if w == g => {}
            None => return None,
        }
    }
    Some(params)
}

/// Whether more than one person is here: only then do the rails between people hold.
async fn shared(conn: &mut AnyConnection) -> Result<bool> {
    let n: i64 = sqlx::query("SELECT CAST(count(*) AS BIGINT) AS n FROM people WHERE removed_at IS NULL").fetch_one(&mut *conn).await?.get("n");
    Ok(n > 1)
}

/// Whether `person` is on `project`'s board: the owner always, else a row in project_members (`onBoard`).
async fn on_board(conn: &mut AnyConnection, project: &str, person: &str, owner: &str) -> Result<bool> {
    if person == owner {
        return Ok(true);
    }
    let row = sqlx::query(&sql("SELECT 1 FROM project_members WHERE project = ? AND person = ?")).bind(project).bind(person).fetch_optional(&mut *conn).await?;
    Ok(row.is_some())
}

/// The limits a cell names (`LIMITS`), held as the request comes in: true lets it through.
async fn check(conn: &mut AnyConnection, check: &str, params: &HashMap<String, String>, person: Option<&str>) -> Result<bool> {
    let project = params.get("project").map(String::as_str).unwrap_or_default();
    match check {
        // A comment only on one of the proposals an untrusted session raised: pending, labelled `external`.
        "externalProposal" => {
            let Some(issue) = params.get("issue").filter(|_| !project.is_empty()) else { return Ok(false) };
            let mut issues = IssueWrites::new(conn);
            let Ok(id) = issues.issue_id(project, issue).await else { return Ok(false) };
            let row = sqlx::query(&sql("SELECT proposal, labels FROM issues WHERE project = ? AND id = ?"))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *conn)
                .await?;
            Ok(row.is_some_and(|r| {
                let labels: Vec<String> = serde_json::from_str(&r.get::<Option<String>, _>("labels").unwrap_or_default()).unwrap_or_default();
                r.get::<Option<String>, _>("proposal").as_deref() == Some("pending") && labels.iter().any(|l| l == "external")
            }))
        }
        // Only the person holding the board the route names (ORR-654).
        "boardHolder" => {
            let Some(person) = person.filter(|_| !project.is_empty()) else { return Ok(false) };
            let row = sqlx::query(&sql("SELECT 1 FROM project_members WHERE project = ? AND person = ? AND role = 'owner'"))
                .bind(project)
                .bind(person)
                .fetch_optional(&mut *conn)
                .await?;
            Ok(row.is_some())
        }
        // A session of the person asking (`ownSession`): the sessions are the local app's, so never here.
        _ => Ok(false),
    }
}

/// Whether `kind` may make this write: a row its cell allows, on a route the cell allows, past its check (`lets`).
async fn lets(conn: &mut AnyConnection, row: &Permission, kind: Kind, method: &str, path: &str, person: Option<&str>) -> Result<bool> {
    let cell = row.cell(kind);
    if cell.level != "free" && cell.level != "limited" {
        return Ok(false);
    }
    for route in cell.routes.as_ref().unwrap_or(&row.routes) {
        if let Some(params) = match_route(route, method, path) {
            match &cell.check {
                Some(name) if !check(conn, name, &params, person).await? => {}
                _ => return Ok(true),
            }
        }
    }
    Ok(false)
}

/// The first row naming this route.
fn row_of(method: &str, path: &str) -> Option<&'static Permission> {
    PERMISSIONS.iter().find(|p| p.routes.iter().any(|r| match_route(r, method, path).is_some()))
}

/// The chat's or an untrusted session's write, refused unless its column lets it (`guard`).
async fn guard(conn: &mut AnyConnection, kind: Kind, method: &str, path: &str) -> Result<()> {
    for row in PERMISSIONS.iter() {
        if lets(conn, row, kind, method, path, None).await? {
            return Ok(());
        }
    }
    let message = match kind {
        Kind::Chat => "This session is the owner's chat: it answers (reply), makes and changes issues, milestones and epics (create_issue, edit_issue, create_milestone, create_epic…) and comments, asks the owner before messaging sessions or changing settings, schedules, releases, docs or an issue's status, and works on nothing",
        _ => "This session reads what others wrote (an untrusted schedule), so it only raises proposals (create_issue) and comments on them",
    };
    Err(match row_of(method, path) {
        Some(row) => ApiError::refused_for(&row.id, message),
        None => ApiError::forbidden(message),
    })
}

/// A member's write, or their agent's, on an orrery with more than one person (`checkBoards`). One the Nuxt server
/// makes itself (`writeToApi` as `orrery`, the chat's row) isn't a request, so it says nothing of being asked
/// (`Orrery-Actor-Asked`), and no middleware there holds it either.
async fn board_check(conn: &mut AnyConnection, who: Option<&Who>, actor: &Actor, method: &str, path: &str) -> Result<()> {
    if !actor.asked || actor.owner || who.is_some_and(|w| w.owner) || !shared(conn).await? {
        return Ok(());
    }
    let mut issues = IssueWrites::new(conn);
    // A member acting themselves, as the router worked it out; else whose the request is (`personOf`).
    let person = match &actor.person {
        Some(person) => Some(person.clone()),
        None => issues.person_asking(who, actor).await?,
    };
    let owner = issues.owner_id().await?;
    if person.as_deref() == Some(owner.as_str()) {
        return Ok(());
    }
    let matches: Vec<(&Permission, &String, HashMap<String, String>)> = PERMISSIONS
        .iter()
        .flat_map(|row| row.routes.iter().filter_map(move |route| match_route(route, method, path).map(|params| (row, route, params))))
        .collect();
    let Some((first, _, params)) = matches.first() else {
        return Err(ApiError::forbidden(format!("Nobody has said who may {method} {path}, so with more than one person on this orrery it's refused")));
    };
    let Some(person) = person else {
        if matches.iter().any(|(row, route, _)| row.unnamed.as_ref().is_some_and(|u| u.contains(route))) {
            return Ok(());
        }
        let message = match &actor.named {
            Some(named) => format!("\"{named}\" isn't anyone on this orrery"),
            None => "This session names nobody".into(),
        };
        return Err(ApiError::conflict(format!("{message}, and this orrery has more than one person, so it can read and comment but can't take up or change an issue. Set ORRERY_PERSON to your id (GET /api/people) where you start Claude Code, or send Orrery-Person.")));
    };
    if let Some(project) = params.get("project") {
        if !on_board(conn, project, &person, &owner).await? {
            return Err(ApiError::not_found(format!("No project {project}")));
        }
    }
    for (row, _, _) in &matches {
        if lets(conn, row, Kind::Member, method, path, Some(&person)).await? {
            return Ok(());
        }
    }
    Err(ApiError::refused_for(
        &first.id,
        format!("{}: the owner's alone for now, or past what {person} may on this board ({}). {}", first.action, first.id, first.why),
    ))
}

/// An untrusted session's write to a project other than the one it was started for (ORR-1069), refused: the router says
/// which it was (`Orrery-Untrusted-Project`) once it knows the session, as middleware/untrusted.ts holds it there. It's
/// held here too for the tools at `/mcp` (ORR-1102), whose routes the router's middleware never sees.
fn own_project(own: Option<&str>, path: &str) -> Result<()> {
    let Some(own) = own else { return Ok(()) };
    let Some(named) = path.strip_prefix("/api/projects/").and_then(|rest| rest.split_once('/')).map(|(project, _)| project) else { return Ok(()) };
    let named = percent_encoding::percent_decode_str(named).decode_utf8_lossy();
    // The router percent-encodes it (`askerHeaders`), as the path names it.
    if named == percent_encoding::percent_decode_str(own).decode_utf8_lossy() {
        return Ok(());
    }
    Err(ApiError::forbidden(format!("This session reads what others wrote (an untrusted schedule) for {own}, so it only writes there")))
}

/// The project a path names (`/api/projects/:project/…`), decoded.
fn project_named(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/projects/")?;
    let named = rest.split('/').next().filter(|p| !p.is_empty())?;
    Some(percent_decode_str(named).decode_utf8_lossy().into_owned())
}

/// A read or write of a project in a workspace the asker isn't a member of, answered as if the project weren't here
/// (ORR-1106, decision 6 of decision-workspaces): the owner too, who sees only the workspaces they're in. Who's asking is
/// the credential's person, the owner's own (their chat's too), or the person a session names; a request naming nobody
/// who's here, as with login off, sees only `default`. An untrusted session reaches the project it was started for. The
/// Nuxt server's own work (`Orrery-Came: server`) isn't a request, so nothing holds it here.
async fn workspace_check(conn: &mut AnyConnection, who: Option<&Who>, actor: &Actor, own: Option<&str>, path: &str) -> Result<()> {
    let Some(project) = project_named(path) else { return Ok(()) };
    let row = sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?")).bind(&project).fetch_optional(&mut *conn).await?;
    // A project that isn't here is the route's to say so.
    let Some(workspace) = row.map(|r| r.get::<String, _>("workspace")) else { return Ok(()) };
    if actor.untrusted && own.is_some_and(|own| percent_decode_str(own).decode_utf8_lossy() == project) {
        return Ok(());
    }
    let mut issues = IssueWrites::new(conn);
    let person = match (who, &actor.person) {
        (Some(who), _) => Some(who.person.clone()),
        (None, Some(person)) => Some(person.clone()),
        (None, None) if actor.owner || actor.chat => Some(issues.owner_id().await?),
        (None, None) => issues.person_asking(None, actor).await?,
    };
    let member = match person {
        Some(person) if is_person(conn, &person).await? => sqlx::query(&sql("SELECT 1 FROM workspace_members WHERE workspace = ? AND person = ?"))
            .bind(&workspace)
            .bind(&person)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
        _ => workspace == "default",
    };
    if member {
        return Ok(());
    }
    Err(ApiError::not_found(format!("No project {project}")))
}

/// Whether `id` is someone here, not removed.
async fn is_person(conn: &mut AnyConnection, id: &str) -> Result<bool> {
    let row = sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(id).fetch_optional(&mut *conn).await?;
    Ok(row.is_some())
}

/// Holds each request to its project's workspace, and each write to its rails, before its route runs; a route this API
/// doesn't have is left to say so.
pub(crate) async fn rails(State(app): Shared, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    if !request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    let path = request.uri().path().to_string();
    let (actor, who) = (actor_of(request.headers()), who_of(request.headers()));
    let own = crate::request::header(request.headers(), "orrery-untrusted-project").filter(|p| !p.is_empty());
    let server = crate::request::came_of(request.headers()).server;
    let read = [Method::GET, Method::HEAD, Method::OPTIONS].contains(&method);
    let held = async {
        let mut conn = app.pool.acquire().await?;
        if !server && method != Method::OPTIONS {
            workspace_check(&mut conn, who.as_ref(), &actor, own.as_deref(), &path).await?;
        }
        if read {
            return Ok(());
        }
        match (actor.chat, actor.untrusted) {
            (true, _) => guard(&mut conn, Kind::Chat, method.as_str(), &path).await,
            (_, true) => {
                guard(&mut conn, Kind::Untrusted, method.as_str(), &path).await?;
                own_project(own.as_deref(), &path)
            }
            _ => board_check(&mut conn, who.as_ref(), &actor, method.as_str(), &path).await,
        }
    };
    match held.await {
        Ok(()) => next.run(request).await,
        Err(refused) => refused.into_response(),
    }
}

#[cfg(test)]
#[path = "rails_tests.rs"]
mod tests;
