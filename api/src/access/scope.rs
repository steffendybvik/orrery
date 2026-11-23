// The one guard around a workspace's rows (ORR-1355): a store of a workspace's own rows (epics, statuses, presets,
// settings, secrets, the event log, schedules, projects) is made with a `Workspace`, and only the guard makes one. A
// `Workspace` comes from what the asker sees (`Seen::workspace`, `Seen::pick`), from the project a request already
// reached through the rails (`Workspace::of_project`), or crosses workspaces for one of the reasons in `Across`, listed
// here and nowhere else. Its id is private, so a store can't be pointed at a workspace by a bare string, and none has a
// constructor that falls back to `default`: forgetting the scope doesn't compile.
use crate::db::sql;
use crate::error::{ApiError, Result};
use axum::extract::{FromRequestParts, OptionalFromRequestParts};
use axum::http::request::Parts;
use percent_encoding::percent_decode_str;
use sqlx::{AnyConnection, Row};
use std::fmt;

/// A workspace a request may act in, made only by the guard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Workspace(String);

/// Why a store is made for a workspace that isn't one the asker was checked against. Each says why it's safe; a new
/// way across goes here, with its reason, and nowhere else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Across {
    /// The Nuxt server's own work (`Orrery-Came: server`), which isn't a request: it names the workspace it acts for
    /// (`?workspace=`, `?project=`, `Orrery-Workspace`) and is trusted to (decision-workspaces, Access).
    Server,
    /// The installation's own keys in `settings` (`id`, `uid`, `count_use`), which are nobody's workspace's: read
    /// through `default`, whose workspace keys the caller doesn't use.
    Installation,
    /// A schedule's run, a launch or another row acting in the workspace stored on it: the row was made in a workspace
    /// its maker was checked against, and carries it.
    Stored,
    /// A list across every workspace a `Seen` holds it to, which leaves out each row it doesn't see.
    Listed,
    /// A workspace the asker has just made, as its owner, being given what a new one starts with.
    Made,
    /// Deleting a workspace or an account (ORR-1203): it goes with everything in the workspaces being deleted.
    Deleting,
}

impl Across {
    /// Every way across, for the test that holds each to a reason.
    #[cfg(test)]
    pub(crate) const ALL: [Across; 6] = [Across::Server, Across::Installation, Across::Stored, Across::Listed, Across::Made, Across::Deleting];

    /// Why this way across is allowed.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn why(self) -> &'static str {
        match self {
            Across::Server => "the Nuxt server's own work names the workspace it acts for",
            Across::Installation => "the installation's own settings are nobody's workspace's",
            Across::Stored => "a row acts in the workspace it was made in",
            Across::Listed => "a list held to what the asker sees leaves out the rest itself",
            Across::Made => "the asker made the workspace and owns it",
            Across::Deleting => "deleting a workspace or an account takes everything in it",
        }
    }
}

impl Workspace {
    /// A workspace the asker was checked against: only `Seen` makes these.
    pub(in crate::access) fn seen(id: String) -> Workspace {
        Workspace(id)
    }

    /// `id`, crossing workspaces for `why`.
    pub(crate) fn across(_why: Across, id: impl Into<String>) -> Workspace {
        Workspace(id.into())
    }

    /// `default`, for the installation's own settings.
    pub(crate) fn installation() -> Workspace {
        Workspace::across(Across::Installation, "default")
    }

    /// The workspace `project` is in, a 404 when there's no such project. The rails let a request through to a project's
    /// routes only when the asker sees it (`workspace_check`), so its workspace is one they may act in.
    pub(crate) async fn of_project(conn: &mut AnyConnection, project: &str) -> Result<Workspace> {
        Workspace::of_project_or_none(conn, project).await?.ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))
    }

    /// As `of_project`, `None` when there's no such project.
    pub(crate) async fn of_project_or_none(conn: &mut AnyConnection, project: &str) -> Result<Option<Workspace>> {
        let row = sqlx::query(sql("SELECT workspace FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *conn).await?;
        Ok(row.map(|r| Workspace(r.get::<String, _>("workspace"))))
    }

    /// Its id, to bind in a query.
    pub(crate) fn id(&self) -> &str {
        &self.0
    }

    /// Whether it's the `default` workspace, which every table falls back to.
    pub(crate) fn is_default(&self) -> bool {
        self.0 == "default"
    }
}

/// Project `to`, which a request on project `from` named in its body rather than its path (ORR-1395): moving an issue
/// there, an issue there in `depends_on`. Only a project of `from`'s own workspace: another's is a 404, as one that isn't
/// there, whatever the asker sees, so nothing joins two workspaces' rows. Then a board marked as moved takes nothing from
/// another (ORR-1229). Every such reference goes through here, and it's the one way to a second `ScopedProject`.
pub(crate) async fn reach(conn: &mut AnyConnection, from: &ScopedProject, to: &str) -> Result<ScopedProject> {
    if from.id != to {
        let there = Workspace::of_project_or_none(&mut *conn, to).await?;
        if there.as_ref() != Some(&from.workspace) {
            return Err(ApiError::not_found(format!("No project \"{to}\"")));
        }
    }
    crate::board::projects::not_moved(conn, to).await?;
    Ok(ScopedProject { id: to.to_string(), workspace: from.workspace.clone() })
}

/// A project a request may act on, and the workspace it's in (ORR-1395): what the stores of a project's rows (issues,
/// comments, docs, milestones, releases…) are handed instead of a bare id. Only the rails make one, once the asker is
/// checked against the project its path names (`workspace_check`), and `reach` makes one for a project named in a body,
/// from one already made. Crossing workspaces is `ScopedProject::across`, for one of the reasons in `Across`. Its fields
/// are private, so a store can't be pointed at a project by a string that skipped the guard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopedProject {
    id: String,
    workspace: Workspace,
}

impl ScopedProject {
    /// A project the rails checked the asker against.
    pub(in crate::access) fn checked(id: String, workspace: String) -> ScopedProject {
        ScopedProject { id, workspace: Workspace(workspace) }
    }

    /// Project `id`, crossing workspaces for `why`: a 404 when there's no such project.
    pub(crate) async fn across(conn: &mut AnyConnection, _why: Across, id: &str) -> Result<ScopedProject> {
        let workspace = Workspace::of_project(conn, id).await?;
        Ok(ScopedProject { id: id.to_string(), workspace })
    }

    /// Its id, to bind in a query.
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// The workspace it's in.
    pub(crate) fn workspace(&self) -> &Workspace {
        &self.workspace
    }
}

impl fmt::Display for ScopedProject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.id)
    }
}

/// A handler under `/api/projects/{project}` takes its project as a `ScopedProject`, which the rails put on the request.
/// None there is the rails' 404, as for a project that isn't here: a route the rails don't run before can't reach one.
impl<S: Send + Sync> FromRequestParts<S> for ScopedProject {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self> {
        if let Some(project) = parts.extensions.get::<ScopedProject>() {
            return Ok(project.clone());
        }
        let named = parts.uri.path().strip_prefix("/api/projects/").and_then(|rest| rest.split('/').next()).unwrap_or_default();
        Err(ApiError::not_found(format!("No project \"{}\"", percent_decode_str(named).decode_utf8_lossy())))
    }
}

/// As `Option<ScopedProject>`, for the Nuxt server's own routes that answer a project that isn't here with nothing
/// rather than a 404 (`release-peers`, `issue-sessions`).
impl<S: Send + Sync> OptionalFromRequestParts<S> for ScopedProject {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Option<Self>> {
        Ok(parts.extensions.get::<ScopedProject>().cloned())
    }
}

impl fmt::Display for Workspace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
