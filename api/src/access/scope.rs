// The one guard around a workspace's rows (ORR-1355): a store of a workspace's own rows (epics, statuses, presets,
// settings, secrets, the event log, schedules, projects) is made with a `Workspace`, and only the guard makes one. A
// `Workspace` comes from what the asker sees (`Seen::workspace`, `Seen::pick`), from the project a request already
// reached through the rails (`Workspace::of_project`), or crosses workspaces for one of the reasons in `Across`, listed
// here and nowhere else. Its id is private, so a store can't be pointed at a workspace by a bare string, and none has a
// constructor that falls back to `default`: forgetting the scope doesn't compile.
use crate::db::sql;
use crate::error::{ApiError, Result};
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

/// Whether a request on project `from` may reach project `to`, one it named in its body rather than its path, which the
/// rails held (ORR-1395): moving an issue there, an issue there in `depends_on`. Only a project of `from`'s own
/// workspace: another's is a 404, as one that isn't there, whatever the asker sees, so nothing joins two workspaces'
/// rows. Then a board marked as moved takes nothing from another (ORR-1229). Every such reference goes through here.
pub(crate) async fn reach(conn: &mut AnyConnection, from: &str, to: &str) -> Result<()> {
    if from != to {
        let (here, there) = (Workspace::of_project_or_none(&mut *conn, from).await?, Workspace::of_project_or_none(&mut *conn, to).await?);
        if here.is_none() || here != there {
            return Err(ApiError::not_found(format!("No project \"{to}\"")));
        }
    }
    crate::board::projects::not_moved(conn, to).await
}

impl fmt::Display for Workspace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod tests;
