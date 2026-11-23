// Which sessions are there to hear, on which projects (ORR-1172). The Nuxt server, which the sessions' channels connect
// to, says so (`PUT /api/session-presence/:session` with the projects it's heard on, from `sayPresence` in
// utils/presence.ts) as each connects or goes, and again every half minute; `DELETE` once it has gone. A claim on an
// issue holds only while its session is there (`present`), as `hears()` has it in the store, so a session that crashed
// or was closed doesn't keep its issue for good: one not said again within `FRESH` is taken as gone.
use crate::db::sql;
use crate::error::Result;
use crate::write::stamp;
use sqlx::AnyConnection;

/// How long a session is taken as there after it was last said to be: three of the Nuxt server's half-minute beats.
pub(crate) const FRESH: chrono::Duration = chrono::Duration::seconds(90);

pub(crate) struct Presence<'a> {
    conn: &'a mut AnyConnection,
}

impl<'a> Presence<'a> {
    pub(crate) fn new(conn: &'a mut AnyConnection) -> Self {
        Self { conn }
    }

    /// The session is there, heard on these projects and no others, as of now. Each is stamped before the others go, so
    /// a check in between never finds it gone.
    pub(crate) async fn keep(&mut self, session: &str, projects: &[String]) -> Result<()> {
        let now = stamp();
        for project in projects {
            sqlx::query(sql(
                "INSERT INTO session_presence (session, project, seen_at) VALUES (?, ?, ?) ON CONFLICT (session, project) DO UPDATE SET seen_at = excluded.seen_at",
            ))
            .bind(session)
            .bind(project)
            .bind(&now)
            .execute(&mut *self.conn)
            .await?;
        }
        sqlx::query(sql("DELETE FROM session_presence WHERE session = ? AND seen_at < ?")).bind(session).bind(&now).execute(&mut *self.conn).await?;
        // Those gone quiet for long are let go here too, so the table only holds what's recent.
        let stale = (chrono::Utc::now() - FRESH * 10).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        sqlx::query(sql("DELETE FROM session_presence WHERE seen_at < ?")).bind(stale).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The session has gone, from every project.
    pub(crate) async fn forget(&mut self, session: &str) -> Result<()> {
        sqlx::query(sql("DELETE FROM session_presence WHERE session = ?")).bind(session).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Whether the session is there to hear on the project: said to be within `FRESH`.
    pub(crate) async fn present(&mut self, project: &str, session: &str) -> Result<bool> {
        let since = (chrono::Utc::now() - FRESH).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let row = sqlx::query(sql("SELECT 1 AS one FROM session_presence WHERE session = ? AND project = ? AND seen_at >= ?"))
            .bind(session)
            .bind(project)
            .bind(since)
            .fetch_optional(&mut *self.conn)
            .await?;
        Ok(row.is_some())
    }
}
