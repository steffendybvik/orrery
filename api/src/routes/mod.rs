// The API's routes, a module per domain (ORR-1048): each has its handlers and a `routes()`, and `all` merges them in
// one fixed order, the order the rust-api-structure doc lists them in.
use crate::App;
use axum::Router;
use std::sync::Arc;

pub(crate) mod auth;
pub(crate) mod changes;
pub(crate) mod chats;
pub(crate) mod database;
pub(crate) mod docs;
pub(crate) mod epics;
pub(crate) mod event_log;
pub(crate) mod issues;
pub(crate) mod mcp;
pub(crate) mod milestones;
pub(crate) mod notices;
pub(crate) mod people;
pub(crate) mod permissions;
pub(crate) mod presets;
pub(crate) mod projects;
pub(crate) mod pulls;
pub(crate) mod releases;
pub(crate) mod schedules;
pub(crate) mod secrets;
pub(crate) mod session_work;
pub(crate) mod settings;
pub(crate) mod signals;
pub(crate) mod statuses;
pub(crate) mod threads;
pub(crate) mod uploads;
pub(crate) mod usage;
pub(crate) mod workspaces;

/// A project's routes start here.
pub(crate) const P: &str = "/api/projects/{project}";

pub(crate) fn all() -> Router<Arc<App>> {
    Router::new()
        .merge(docs::routes())
        .merge(issues::routes())
        .merge(milestones::routes())
        .merge(releases::routes())
        .merge(epics::routes())
        .merge(threads::routes())
        .merge(projects::routes())
        .merge(statuses::routes())
        .merge(settings::routes())
        .merge(people::routes())
        .merge(workspaces::routes())
        .merge(auth::routes())
        .merge(permissions::routes())
        .merge(presets::routes())
        .merge(notices::routes())
        .merge(secrets::routes())
        .merge(pulls::routes())
        .merge(schedules::routes())
        .merge(signals::routes())
        .merge(session_work::routes())
        .merge(chats::routes())
        .merge(uploads::routes())
        .merge(usage::routes())
        .merge(event_log::routes())
        .merge(changes::routes())
        .merge(database::routes())
        .merge(mcp::routes())
}
