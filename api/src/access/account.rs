// A signed-in person's own account (ORR-1203): what it holds, as `GET /api/me` shows it on Settings → You, and deleting
// it (`DELETE /api/me`), with every workspace they own and everything in those, in one transaction with its outbox row.
use crate::access::people::People;
use crate::board::projects::Projects;
use crate::changes;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::write::Actor;
use serde_json::{json, Value};
use sqlx::Row;

/// What a workspace holds of its own beyond its projects, each table with a `workspace` column (migrations 089, 090,
/// 093), in an order the foreign keys allow. Epics go after their comments' cascade, secrets after their uses.
const WORKSPACE_TABLES: [&str; 14] = [
    "epics",
    "events",
    "chats",
    "schedules_across",
    "session_people",
    "invites",
    "uploads",
    "feature_use",
    "secret_uses",
    "secrets",
    "presets",
    "preset_defaults",
    "statuses",
    "keys",
];

/// Of those, what `default` keeps when it's emptied rather than deleted: every row of these still lands in `default`
/// whatever workspace it's for (uploads, chats, use counts, sessions' people), or is what orrery ships and seeds once
/// (statuses since step 020, the shipped presets and their seeding marks), so deleting them would reach past this
/// person's workspace or leave a new board in `default` with nothing to draw it with.
const DEFAULT_KEEPS: [&str; 6] = ["chats", "session_people", "uploads", "feature_use", "preset_defaults", "statuses"];

impl People<'_> {
    /// `GET /api/me`: the person signed in, `{id, name, role, created_at, identities: [{issuer}], workspaces: [{id, name,
    /// color, role}]}`. `identities` are the login provider's accounts they sign in with, by issuer alone: orrery keeps
    /// no email, and the subject is the provider's own number for them.
    pub async fn me(&mut self, person: &str) -> Result<Value> {
        let row = self.person(person).await?;
        if row.get::<Option<String>, _>("removed_at").is_some() {
            return Err(ApiError::not_found(format!("No person \"{person}\"")));
        }
        let issuers: Vec<String> =
            sqlx::query_scalar(&sql("SELECT issuer FROM identities WHERE person = ? ORDER BY issuer")).bind(person).fetch_all(&mut *self.conn).await?;
        let workspaces = sqlx::query(&sql("SELECT w.id, w.name, w.color, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace \
             WHERE m.person = ? ORDER BY CASE WHEN w.id = 'default' THEN 0 ELSE 1 END, lower(w.name), w.id"))
        .bind(person)
        .fetch_all(&mut *self.conn)
        .await?;
        Ok(json!({
            "id": row.get::<String, _>("id"),
            "name": row.get::<String, _>("name"),
            "role": row.get::<String, _>("role"),
            "created_at": row.get::<Option<String>, _>("created_at"),
            "identities": issuers.into_iter().map(|issuer| json!({"issuer": issuer})).collect::<Vec<_>>(),
            "workspaces": workspaces.iter().map(|w| json!({
                "id": w.get::<String, _>("id"),
                "name": w.get::<String, _>("name"),
                "color": w.get::<Option<String>, _>("color"),
                "role": w.get::<String, _>("role"),
            })).collect::<Vec<_>>(),
        }))
    }

    /// `DELETE /api/me` `{confirm}`: deletes `person`'s own account, `confirm` their name in any case. Every workspace
    /// they own goes, with everything in it, even one others are members of; then they're removed as `remove_person`
    /// removes someone (`retire`): their name stays on history, their open issues elsewhere go back to unassigned, their
    /// keys are revoked and their logins and invites end. Their memberships elsewhere end, and the login provider's
    /// accounts they signed in with are let go, so the same account can sign up again as someone new.
    pub async fn delete_account(&mut self, person: &str, body: &Value, actor: &Actor) -> Result<()> {
        let row = self.person(person).await?;
        if row.get::<Option<String>, _>("removed_at").is_some() {
            return Err(ApiError::not_found(format!("No person \"{person}\"")));
        }
        let name: String = row.get("name");
        let confirm = body.get("confirm").and_then(Value::as_str).unwrap_or_default().trim();
        if confirm.to_lowercase() != name.trim().to_lowercase() {
            return Err(ApiError::bad_request(format!("Type your name, {name}, to delete your account")));
        }
        let owner = row.get::<String, _>("role") == "owner";
        let owned: Vec<String> = sqlx::query_scalar(&sql("SELECT workspace FROM workspace_members WHERE person = ? AND role = 'owner' ORDER BY workspace"))
            .bind(person)
            .fetch_all(&mut *self.conn)
            .await?;
        // The members of a shared workspace aren't told on the bell: it holds only comments on issues (ORR-1005), and
        // every issue they could see one on goes with the workspace. They find it gone from their workspace switcher.
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for workspace in &owned {
                self.delete_workspace(workspace).await?;
            }
            sqlx::query(&sql("DELETE FROM workspace_members WHERE person = ?")).bind(person).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM identities WHERE person = ?")).bind(person).execute(&mut *self.conn).await?;
            // The orrery's owner deleting themselves: the role goes to whoever has been here longest, so the server always
            // has an owner while anyone is on it (an orrery with none lets anyone name themselves owner, `PUT /api/owner`,
            // and every "the owner's" check would fall to nobody). Handing it to the next person to sign up instead would
            // give a stranger the orrery over everyone already here. With nobody left, the slot is free: the orrery is as
            // a new one, and the next account to sign in becomes its owner (`first_owner`, ORR-1185).
            let heir: Option<String> = if owner {
                let heir: Option<String> =
                    sqlx::query_scalar(&sql("SELECT id FROM people WHERE removed_at IS NULL AND id <> ? ORDER BY created_at, id LIMIT 1"))
                        .bind(person)
                        .fetch_optional(&mut *self.conn)
                        .await?;
                sqlx::query(&sql("UPDATE people SET role = 'member' WHERE id = ?")).bind(person).execute(&mut *self.conn).await?;
                if let Some(heir) = &heir {
                    sqlx::query(&sql("UPDATE people SET role = 'owner' WHERE id = ?")).bind(heir).execute(&mut *self.conn).await?;
                }
                self.effects.settings = true;
                heir
            } else {
                sqlx::query_scalar(&sql("SELECT id FROM people WHERE role = 'owner'")).fetch_optional(&mut *self.conn).await?
            };
            // `default` with no owner left is the orrery owner's, as the first person's is (ORR-1106, ORR-1192).
            if let Some(heir) = &heir {
                if sqlx::query(&sql("SELECT 1 FROM workspace_members WHERE workspace = 'default' AND role = 'owner'"))
                    .fetch_optional(&mut *self.conn)
                    .await?
                    .is_none()
                {
                    sqlx::query(&sql("DELETE FROM workspace_members WHERE workspace = 'default' AND person = ?")).bind(heir).execute(&mut *self.conn).await?;
                    sqlx::query(&sql("INSERT INTO workspace_members (workspace, person, role, created_at) VALUES ('default', ?, 'owner', ?)"))
                        .bind(heir)
                        .bind(crate::write::stamp())
                        .execute(&mut *self.conn)
                        .await?;
                }
            }
            self.retire(person, heir.as_deref(), actor).await
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// Deletes a workspace and everything in it, inside the caller's transaction: each project as deleting a project
    /// does (`Projects::delete_rows`), then what the workspace holds of its own, its members and its row. `default` is
    /// emptied instead: the server needs it, as every table's `workspace` falls back to it and a request naming nobody
    /// sees it, so its row stays, with what `DEFAULT_KEEPS` lists.
    async fn delete_workspace(&mut self, workspace: &str) -> Result<()> {
        let projects: Vec<String> =
            sqlx::query_scalar(&sql("SELECT id FROM projects WHERE workspace = ? ORDER BY id")).bind(workspace).fetch_all(&mut *self.conn).await?;
        for project in &projects {
            // A project elsewhere taking its releases from this one has none of its own now, as when its source changes.
            let drawing: Vec<String> = sqlx::query_scalar(&sql("SELECT id FROM projects WHERE releases_from = ? AND workspace <> ?"))
                .bind(project)
                .bind(workspace)
                .fetch_all(&mut *self.conn)
                .await?;
            for other in drawing {
                sqlx::query(&sql("UPDATE issues SET ships_in = NULL WHERE project = ?")).bind(&other).execute(&mut *self.conn).await?;
                sqlx::query(&sql("UPDATE projects SET release_mode = 'none', releases_from = NULL, updated_at = ? WHERE id = ?"))
                    .bind(crate::write::stamp())
                    .bind(&other)
                    .execute(&mut *self.conn)
                    .await?;
                if !self.effects.changed.contains(&other) {
                    self.effects.changed.push(other);
                }
            }
            // Its own projects drawing on it go in this same loop, so none is left pointing at it.
            sqlx::query(&sql("UPDATE projects SET releases_from = NULL WHERE releases_from = ?")).bind(project).execute(&mut *self.conn).await?;
        }
        for project in &projects {
            let mut rows = Projects::new(&mut *self.conn);
            rows.delete_rows(project).await?;
            let effects = rows.effects;
            self.effects.changed.extend(effects.changed);
            self.effects.schedules.extend(effects.schedules);
        }
        let default = workspace == "default";
        // An issue elsewhere in one of its epics is in none now, as when an epic is deleted.
        sqlx::query(&sql("UPDATE issues SET epic = NULL WHERE epic IN (SELECT id FROM epics WHERE workspace = ?)"))
            .bind(workspace)
            .execute(&mut *self.conn)
            .await?;
        for table in WORKSPACE_TABLES {
            if default && DEFAULT_KEEPS.contains(&table) {
                continue;
            }
            // `default`'s shipped presets stay with their seeding marks; the ones its people made go.
            let only = if default && table == "presets" { " AND default_key IS NULL" } else { "" };
            sqlx::query(&sql(&format!("DELETE FROM {table} WHERE workspace = ?{only}"))).bind(workspace).execute(&mut *self.conn).await?;
        }
        self.effects.epics = true;
        sqlx::query(&sql("DELETE FROM workspace_settings WHERE workspace = ?")).bind(workspace).execute(&mut *self.conn).await?;
        sqlx::query(&sql("DELETE FROM workspace_members WHERE workspace = ?")).bind(workspace).execute(&mut *self.conn).await?;
        if !default {
            sqlx::query(&sql("DELETE FROM workspaces WHERE id = ?")).bind(workspace).execute(&mut *self.conn).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
