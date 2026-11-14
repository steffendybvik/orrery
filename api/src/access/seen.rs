// The workspaces a request reaches, and the projects in them (ORR-1106, decision 6 of decision-workspaces): what the
// rails hold a project's routes to, and what the lists and feeds across projects keep.
use crate::access::people::Who;
use crate::board::issue_writes::IssueWrites;
use crate::db::sql;
use crate::error::Result;
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
    /// The workspaces the asker is a member of, and the project an untrusted session was started for.
    Only { workspaces: Vec<String>, own: Option<String> },
}

impl Seen {
    /// What the request these headers came with may see.
    pub(crate) async fn of(conn: &mut AnyConnection, headers: &HeaderMap) -> Result<Seen> {
        if came_of(headers).server {
            return Ok(Seen::All);
        }
        let own = header(headers, "orrery-untrusted-project").filter(|p| !p.is_empty());
        Seen::asking(conn, who_of(headers).as_ref(), &actor_of(headers), own.as_deref()).await
    }

    /// The workspaces the asker is a member of: the credential's person, the owner's own (their chat's too), or the
    /// person a session names; the owner sees only the ones they're in. A request naming nobody who's here, as with
    /// login off, sees only `default`. An untrusted session also reaches `own`, the project it was started for.
    pub(crate) async fn asking(conn: &mut AnyConnection, who: Option<&Who>, actor: &Actor, own: Option<&str>) -> Result<Seen> {
        let own = own.filter(|_| actor.untrusted).map(|own| percent_decode_str(own).decode_utf8_lossy().into_owned());
        let mut issues = IssueWrites::new(conn);
        let person = match (who, &actor.person) {
            (Some(who), _) => Some(who.person.clone()),
            (None, Some(person)) => Some(person.clone()),
            (None, None) if actor.owner || actor.chat => Some(issues.owner_id().await?),
            (None, None) => issues.person_asking(None, actor).await?,
        };
        let here = match &person {
            Some(person) => sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(person).fetch_optional(&mut *conn).await?.is_some(),
            None => false,
        };
        let workspaces = match person.filter(|_| here) {
            Some(person) => sqlx::query(&sql("SELECT workspace FROM workspace_members WHERE person = ? ORDER BY workspace"))
                .bind(&person)
                .fetch_all(&mut *conn)
                .await?
                .iter()
                .map(|r| r.get::<String, _>("workspace"))
                .collect(),
            None => vec!["default".to_string()],
        };
        Ok(Seen::Only { workspaces, own })
    }

    /// Whether a project in `workspace`, with id `project`, is seen.
    pub(crate) fn sees_in(&self, workspace: &str, project: &str) -> bool {
        match self {
            Seen::All => true,
            Seen::Only { workspaces, own } => workspaces.iter().any(|w| w == workspace) || own.as_deref() == Some(project),
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
