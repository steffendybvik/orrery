// The workspaces a request reaches, and the projects in them (ORR-1106, decision 6 of decision-workspaces): what the
// rails hold a project's routes to, and what the lists and feeds across projects keep.
use crate::access::people::Who;
use crate::access::scope::Workspace;
use crate::access::session_records::as_recorded;
use crate::board::issue_writes::IssueWrites;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::request::{actor_of, came_of, header, who_of};
use crate::write::Actor;
use axum::http::HeaderMap;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use sqlx::{AnyConnection, Row};
use std::collections::HashSet;

/// What a request may see.
#[derive(Clone, Debug)]
pub(crate) enum Seen {
    /// Every workspace: the Nuxt server's own work (`Orrery-Came: server`), which isn't a request.
    All,
    /// The workspaces the asker is a member of, and the project an untrusted session was started for. `off` is the
    /// projects in those workspaces that they still don't see, as they aren't on the board (ORR-985).
    Only { workspaces: Vec<String>, own: Option<String>, off: HashSet<String> },
}

impl Seen {
    /// What the request these headers came with may see.
    pub(crate) async fn of(conn: &mut AnyConnection, headers: &HeaderMap) -> Result<Seen> {
        if came_of(headers).server {
            return Ok(Seen::All);
        }
        // The session's record says whether it's untrusted and the project it was started for (ORR-1171).
        let (actor, own) = as_recorded(conn, headers, &actor_of(headers)).await?;
        Seen::asking(conn, who_of(headers).as_ref(), &actor, own.as_deref()).await
    }

    /// What a list of the workspace's own (its projects, releases, schedules, a session's project choices) shows
    /// (ORR-1108, ORR-1251): one workspace, the one the request acts in. That's the one it names in `Orrery-Workspace`
    /// when the asker is in it, as a page sends its address's, else the one `pick` acts in with none named: `default`
    /// when they're in it, else their first. A page with no `/w/…` in its address shows itself in that same one, so
    /// it lists only that workspace's projects. The Nuxt server's own work still sees every workspace.
    pub(crate) async fn listed(conn: &mut AnyConnection, headers: &HeaderMap) -> Result<Seen> {
        let seen = Seen::of(conn, headers).await?;
        let named = header(headers, "orrery-workspace").map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
        let one = seen.pick(named.as_deref()).or_else(|_| seen.pick(None)).ok().map(|w| w.id().to_string());
        Ok(match seen {
            Seen::Only { own, off, .. } => Seen::Only { workspaces: one.into_iter().collect(), own, off },
            all => all,
        })
    }

    /// The workspaces the asker is a member of: the credential's person, the owner's own (their chat's too), or the
    /// person a session names; the owner sees only the ones they're in. A request naming nobody who's here, as with
    /// login off, sees only `default`. An agent key reaches only its own workspace. An untrusted session also reaches
    /// `own`, the project it was started for. Inside a workspace, a member sees only the boards they're on (`off`).
    pub(crate) async fn asking(conn: &mut AnyConnection, who: Option<&Who>, actor: &Actor, own: Option<&str>) -> Result<Seen> {
        let own = own.filter(|_| actor.untrusted).map(|own| percent_decode_str(own).decode_utf8_lossy().into_owned());
        let person = Seen::person(conn, who, actor).await?;
        let mut workspaces: Vec<String> = match &person {
            Some(person) => sqlx::query(&sql("SELECT workspace FROM workspace_members WHERE person = ? ORDER BY workspace"))
                .bind(person)
                .fetch_all(&mut *conn)
                .await?
                .iter()
                .map(|r| r.get::<String, _>("workspace"))
                .collect(),
            None => vec!["default".to_string()],
        };
        // An agent key reaches only its own workspace, whatever else its person is in.
        if let Some(only) = who.and_then(|w| w.workspace.as_deref()) {
            workspaces.retain(|w| w == only);
        }
        let off = match &person {
            Some(person) => Seen::off_boards(conn, person).await?,
            None => HashSet::new(),
        };
        // A session's record is named by an id, not held by a credential, so a request with a credential (a login, a
        // key) has its project counted only in a workspace that credential is in already: naming another workspace's
        // session doesn't reach that workspace (ORR-1387). One with none, as with login off, is held by the record alone.
        let own = match own {
            Some(own) if who.is_some() => {
                let there: Option<String> =
                    sqlx::query_scalar(&sql("SELECT workspace FROM projects WHERE id = ?")).bind(&own).fetch_optional(&mut *conn).await?;
                there.filter(|w| workspaces.contains(w)).map(|_| own)
            }
            own => own,
        };
        Ok(Seen::Only { workspaces, own, off })
    }

    /// The projects in the workspaces `person` is a member of whose boards they aren't on (ORR-985), as `onBoard` in
    /// web/server/utils/roster.ts holds a member to them: the design's "a board you're not on is a 404, in lists and
    /// streams too". None with one person here, for the server's owner, or in a workspace they own: those see it all.
    pub(crate) async fn off_boards(conn: &mut AnyConnection, person: &str) -> Result<HashSet<String>> {
        let present: i64 = sqlx::query_scalar(&sql("SELECT CAST(count(*) AS BIGINT) FROM people WHERE removed_at IS NULL")).fetch_one(&mut *conn).await?;
        let owner: Option<String> = sqlx::query_scalar(&sql("SELECT id FROM people WHERE role = 'owner' AND removed_at IS NULL ORDER BY created_at LIMIT 1"))
            .fetch_optional(&mut *conn)
            .await?;
        if present < 2 || owner.as_deref() == Some(person) {
            return Ok(HashSet::new());
        }
        let rows =
            sqlx::query(&sql("SELECT p.id FROM projects p JOIN workspace_members w ON w.workspace = p.workspace AND w.person = ? AND w.role = 'member' \
             WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project = p.id AND m.person = ?)"))
            .bind(person)
            .bind(person)
            .fetch_all(&mut *conn)
            .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("id")).collect())
    }

    /// The person asking, if they're here: the credential's, the owner's own (their chat's too), or the one a session
    /// names. Nobody, as with login off, is `None`.
    pub(crate) async fn person(conn: &mut AnyConnection, who: Option<&Who>, actor: &Actor) -> Result<Option<String>> {
        let mut issues = IssueWrites::new(conn);
        let person = match (who, &actor.person) {
            (Some(who), _) => Some(who.person.clone()),
            (None, Some(person)) => Some(person.clone()),
            (None, None) if actor.owner || actor.chat => Some(issues.owner_id().await?),
            (None, None) => issues.person_asking(None, actor).await?,
        };
        let Some(person) = person else { return Ok(None) };
        let here = sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(&person).fetch_optional(&mut *conn).await?.is_some();
        Ok(here.then_some(person))
    }

    /// The workspace a request for the workspace's own rows (epics, statuses, presets, secrets, events, chats) acts in
    /// (ORR-1107): the one it names in `Orrery-Workspace`, else `default` when it's seen, else the first one seen. Naming
    /// one it doesn't see is a 404, as if it weren't here; seeing none at all is one too. The Nuxt server's own work acts
    /// in the one named, or `default`.
    pub(crate) async fn workspace(conn: &mut AnyConnection, headers: &HeaderMap) -> Result<Workspace> {
        let named = header(headers, "orrery-workspace").map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
        Seen::of(conn, headers).await?.pick(named.as_deref())
    }

    /// The workspace `named` (or the one to act in, with none named) among those seen; see `workspace`.
    pub(crate) fn pick(&self, named: Option<&str>) -> Result<Workspace> {
        let picked = match (self, named) {
            (Seen::All, Some(named)) => Ok(named.to_string()),
            (Seen::All, None) => Ok("default".to_string()),
            (Seen::Only { workspaces, .. }, Some(named)) if workspaces.iter().any(|w| w == named) => Ok(named.to_string()),
            (Seen::Only { .. }, Some(named)) => Err(ApiError::not_found(format!("No workspace {named}"))),
            (Seen::Only { workspaces, .. }, None) => workspaces
                .iter()
                .find(|w| *w == "default")
                .or_else(|| workspaces.first())
                .cloned()
                .ok_or_else(|| ApiError::not_found("You aren't in any workspace here")),
        };
        picked.map(Workspace::seen)
    }

    /// Whether a project in `workspace`, with id `project`, is seen.
    pub(crate) fn sees_in(&self, workspace: &str, project: &str) -> bool {
        match self {
            Seen::All => true,
            Seen::Only { workspaces, own, off } => workspaces.iter().any(|w| w == workspace) && !off.contains(project) || own.as_deref() == Some(project),
        }
    }

    /// The ids of the projects here that aren't seen: none for the Nuxt server's own work.
    pub(crate) async fn hidden(&self, conn: &mut AnyConnection) -> Result<HashSet<String>> {
        if let Seen::All = self {
            return Ok(HashSet::new());
        }
        let rows = sqlx::query(&sql("SELECT id, workspace FROM projects")).fetch_all(&mut *conn).await?;
        Ok(rows
            .iter()
            .map(|r| (r.get::<String, _>("id"), r.get::<String, _>("workspace")))
            .filter(|(id, workspace)| !self.sees_in(workspace, id))
            .map(|(id, _)| id)
            .collect())
    }

    /// Keeps the items of the array `list` whose `key` doesn't name a project hidden: what names none is the
    /// workspace's (which waits for ORR-1107), and a project that isn't here any more (`project.deleted`) is in none.
    pub(crate) async fn keep(&self, conn: &mut AnyConnection, list: &mut Value, key: &str) -> Result<()> {
        let hidden = self.hidden(conn).await?;
        if !hidden.is_empty() {
            keep_in(&hidden, list, key);
        }
        Ok(())
    }
}

/// Keeps the items of the array `list` whose `key` isn't a project in `hidden`.
pub(crate) fn keep_in(hidden: &HashSet<String>, list: &mut Value, key: &str) {
    if let Value::Array(items) = list {
        items.retain(|item| !item[key].as_str().is_some_and(|project| hidden.contains(project)));
    }
}

#[cfg(test)]
#[path = "seen_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "isolation_tests.rs"]
mod isolation_tests;
