// The store every write on an issue goes through (ORR-1049): its connection, what the write changed (`effects`) and
// the outbox it lands in, finding the issue from what was sent, the rails between people (who holds an issue, who's
// asking), the activity a change records, and the issue writes of their own: claiming one, letting it go and deleting
// it (`claimIssue`, `releaseIssue`, `deleteIssue` in web/server/store). Its other writes are in comments.rs (comments),
// issue_edits.rs (creating and changing an issue) and decisions.rs (deciding a proposal).
use crate::access::people::Who;
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::migrate::actor_id;
use crate::write::{stamp, Actor, Effects};
use serde_json::json;
use sqlx::{AnyConnection, Row};

/// The issue id inside a full one with this `uid` (`shortId('issue', …)`): `ORR-12-x7k2m3qd` → `ORR-12`.
pub(crate) fn short_issue_id(id: &str, uid: &str) -> Option<String> {
    let tail = format!("-{uid}");
    (!uid.is_empty() && id.len() > tail.len() && id.ends_with(&tail)).then(|| id[..id.len() - tail.len()].to_string())
}

pub struct IssueWrites<'c> {
    pub conn: &'c mut AnyConnection,
    pub effects: Effects,
    /// Set for a write: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
    /// The session an edit is for, by the id it goes by now (`Orrery-Worked-By`): starting the issue takes its lock
    /// (`lockFor`, ORR-1130). None for the owner, their chat and what orrery does itself.
    pub session: Option<String>,
}

impl<'c> IssueWrites<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        IssueWrites { conn, effects: Effects::default(), outbox: None, session: None }
    }

    /// Notes that `session` is working an issue it just made (`workedBy`), so the owner's comments on it go to that
    /// session. A new issue has no session on it yet, so there's no one else's to keep (`takenFrom`).
    pub async fn worked_by(&mut self, project: &str, issue: &str, session: &str) -> Result<()> {
        let now = stamp();
        sqlx::query(&sql(
            "INSERT INTO issue_sessions (project, issue, session, at, since) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issues WHERE project = ? AND id = ?) \
             ON CONFLICT (project, issue) DO UPDATE SET since = CASE WHEN issue_sessions.session = excluded.session THEN issue_sessions.since ELSE excluded.since END, \
             session = excluded.session, at = excluded.at",
        ))
        .bind(project)
        .bind(issue)
        .bind(session)
        .bind(&now)
        .bind(&now)
        .bind(project)
        .bind(issue)
        .execute(&mut *self.conn)
        .await?;
        Ok(())
    }

    async fn exists(&mut self, query: &str, project: &str, key: &str) -> Result<bool> {
        Ok(sqlx::query(&sql(query)).bind(project).bind(key).fetch_optional(&mut *self.conn).await?.is_some())
    }

    pub(crate) async fn project_uid(&mut self, project: &str) -> Result<String> {
        let row = sqlx::query(&sql("SELECT uid FROM projects WHERE id = ?")).bind(project).fetch_optional(&mut *self.conn).await?;
        row.map(|r| r.get::<Option<String>, _>("uid").unwrap_or_default()).ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))
    }

    /// The issue's id, from its id, an id it had before (an alias), or the full form of either on this board (`issueId`).
    pub(crate) async fn issue_id(&mut self, project: &str, sent: &str) -> Result<String> {
        let mut id = sent.to_string();
        loop {
            if self.exists("SELECT 1 FROM issues WHERE project = ? AND id = ?", project, &id).await? {
                return Ok(id);
            }
            let alias = sqlx::query(&sql("SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?"))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *self.conn)
                .await?;
            if let Some(alias) = alias {
                return Ok(alias.get("issue"));
            }
            match short_issue_id(&id, &self.project_uid(project).await?) {
                Some(short) => id = short,
                None => return Ok(id),
            }
        }
    }

    /// Refuses a project or issue there isn't (`issueRow`).
    pub(crate) async fn issue_there(&mut self, project: &str, issue: &str) -> Result<()> {
        self.project_uid(project).await?;
        if !self.exists("SELECT 1 FROM issues WHERE project = ? AND id = ?", project, issue).await? {
            return Err(ApiError::not_found(format!("No issue {issue} in {project}")));
        }
        Ok(())
    }

    // Claiming.

    /// A person taking up an issue themselves (`claimIssue`, ORR-657), or an agent its person's: their own, or one that's
    /// nobody's, which it assigns to them; the owner's on anyone's, which takes it over. 409 naming the holder otherwise.
    pub async fn claim(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<String> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let (held, claimed) = self.claim_of(project, &issue).await?;
        let rails = self.rails_for(actor).await?;
        let person = if actor.owner {
            Some(self.owner_id().await?)
        } else if let Some(person) = &actor.person {
            Some(person.clone())
        } else {
            match &rails {
                Some(person) => person.clone(),
                None => Some(self.owner_id().await?),
            }
        };
        let holder = self.holder_of(held.as_deref()).await?;
        // Only the owner takes one over, and only a person assigns themselves what's nobody's.
        if let Some(rails) = &rails {
            if (person.is_none() || holder != person) && !(actor.person.is_some() && holder.is_none()) {
                self.must_hold(rails.as_deref(), &issue, held.as_deref(), "take it up").await?;
            }
        }
        let assignee = if holder == person { held.clone() } else { person.clone() };
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let guard = if actor.owner { "" } else { " AND coalesce(assignee, '') = ?" };
            let query = format!("UPDATE issues SET assignee = ?, claimed_by = ?, claimed_at = ?, claimed_session = NULL WHERE project = ? AND id = ?{guard}");
            let query = sql(&query);
            let mut update = sqlx::query(&query).bind(assignee.clone()).bind(person.clone()).bind(stamp()).bind(project).bind(&issue);
            if !actor.owner {
                update = update.bind(held.clone().unwrap_or_default());
            }
            if update.execute(&mut *self.conn).await?.rows_affected() == 0 {
                return Err(ApiError::conflict(format!("{issue} has just been reassigned; read it again")));
            }
            if assignee != held {
                self.record_field(project, &issue, actor, "assignee", held.as_deref(), assignee.as_deref()).await?;
            }
            if person != claimed {
                self.record_field(project, &issue, actor, "claim", claimed.as_deref(), person.as_deref()).await?;
            }
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(issue)
    }

    /// Lets go of a claim, which leaves the issue assigned (`releaseIssue`): its holder's, or the owner's on anyone's.
    pub async fn release(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<String> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let Some(claimed) = self.claim_of(project, &issue).await?.1.filter(|c| !c.is_empty()) else { return Ok(issue) };
        let rails = self.rails_for(actor).await?;
        let person = if actor.owner { Some(self.owner_id().await?) } else { actor.person.clone().or_else(|| rails.clone().flatten()) };
        if rails.is_some() && person.as_deref() != Some(claimed.as_str()) {
            return Err(ApiError::conflict(format!("{issue} is held by {claimed}, so only they or the owner can let it go")));
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            sqlx::query(&sql("UPDATE issues SET claimed_by = NULL, claimed_at = NULL, claimed_session = NULL, updated_at = ? WHERE project = ? AND id = ?"))
                .bind(stamp())
                .bind(project)
                .bind(&issue)
                .execute(&mut *self.conn)
                .await?;
            self.record_field(project, &issue, actor, "claim", Some(&claimed), None).await?;
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await?;
        Ok(issue)
    }

    // Deleting.

    /// Deletes the issue, its sub-issues and comments with it (`deleteIssue`): an agent's only when every one is its
    /// person's, and none the owner made. What names them without a foreign key lets go of them (`issuesMoved`).
    pub async fn delete_issue(&mut self, project: &str, sent: &str, actor: &Actor) -> Result<()> {
        let issue = self.issue_id(project, sent).await?;
        self.issue_there(project, &issue).await?;
        let subtree = self.subtree(project, &issue).await?;
        if let Some(rails) = self.rails_for(actor).await? {
            for id in &subtree {
                let held = self.claim_of(project, id).await?.0;
                self.must_hold(rails.as_deref(), id, held.as_deref(), "delete it").await?;
            }
        }
        if !actor.owner {
            let owned = self.owned_under(project, &subtree).await?;
            if !owned.is_empty() {
                let shown = if owned.len() > 4 { [owned[..3].to_vec(), vec![format!("{} more", owned.len() - 3)]].concat() } else { owned.clone() };
                let was = if owned.len() == 1 { "was" } else { "were" };
                return Err(ApiError::refused_for(
                    "issues.delete",
                    format!("Deleting {issue} is the owner's call: {} {was} made by the owner", shown.join(", ")),
                ));
            }
        }
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            for id in &subtree {
                sqlx::query(&sql("DELETE FROM issue_aliases WHERE project = ? AND issue = ?")).bind(project).bind(id).execute(&mut *self.conn).await?;
            }
            for id in &subtree {
                sqlx::query(&sql("DELETE FROM signals WHERE project = ? AND issue = ?")).bind(project).bind(id).execute(&mut *self.conn).await?;
                self.drop_blocker(project, id, &subtree).await?;
                sqlx::query(&sql("DELETE FROM issue_links WHERE (project = ? AND issue = ?) OR (on_project = ? AND on_issue = ?)"))
                    .bind(project)
                    .bind(id)
                    .bind(project)
                    .bind(id)
                    .execute(&mut *self.conn)
                    .await?;
                sqlx::query(&sql("UPDATE schedule_runs SET issue = NULL WHERE issue = ? AND schedule IN (SELECT id FROM schedules WHERE project = ?)"))
                    .bind(id)
                    .bind(project)
                    .execute(&mut *self.conn)
                    .await?;
            }
            sqlx::query(&sql("DELETE FROM issues WHERE project = ? AND id = ?")).bind(project).bind(&issue).execute(&mut *self.conn).await?;
            self.touch_project(project).await
        }
        .await;
        self.effects.changed = vec![project.into()];
        self.effects.tell("issue.deleted", project, &issue);
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// The issue's id and every id under it, depth first (`subtree`).
    pub(crate) async fn subtree(&mut self, project: &str, id: &str) -> Result<Vec<String>> {
        let mut out = vec![id.to_string()];
        let children: Vec<String> = sqlx::query(&sql("SELECT id FROM issues WHERE project = ? AND parent = ?"))
            .bind(project)
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| r.get("id"))
            .collect();
        for child in children {
            out.extend(Box::pin(self.subtree(project, &child)).await?);
        }
        Ok(out)
    }

    /// The owner's issues and comments among these issues (`ownedUnder`).
    pub(crate) async fn owned_under(&mut self, project: &str, issues: &[String]) -> Result<Vec<String>> {
        let marks = vec!["?"; issues.len()].join(", ");
        let mut out = vec![];
        let query = format!("SELECT id FROM issues WHERE project = ? AND owned = 1 AND id IN ({marks})");
        let query = sql(&query);
        let mut find = sqlx::query(&query).bind(project);
        for id in issues {
            find = find.bind(id);
        }
        out.extend(find.fetch_all(&mut *self.conn).await?.iter().map(|r| r.get::<String, _>("id")));
        let query = format!("SELECT CAST(id AS BIGINT) AS id, issue FROM comments WHERE project = ? AND owned = 1 AND issue IN ({marks})");
        let query = sql(&query);
        let mut find = sqlx::query(&query).bind(project);
        for id in issues {
            find = find.bind(id);
        }
        out.extend(find.fetch_all(&mut *self.conn).await?.iter().map(|r| format!("comment {} on {}", r.get::<i64, _>("id"), r.get::<String, _>("issue"))));
        Ok(out)
    }

    /// Each issue depending on `id`, which is going with `going`, without it in its activity as a `depends` change
    /// (`dropBlocker`, ORR-601): the dispatch reads that, and hands one out that it freed.
    pub(crate) async fn drop_blocker(&mut self, project: &str, id: &str, going: &[String]) -> Result<()> {
        let dependents: Vec<(String, String)> = sqlx::query(&sql("SELECT project, issue FROM issue_links WHERE on_project = ? AND on_issue = ?"))
            .bind(project)
            .bind(id)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| (r.get("project"), r.get("issue")))
            .collect();
        let orrery =
            Actor { name: "orrery".into(), owner: false, session: None, person: None, named: None, asked: false, untrusted: false, chat: false, cause: None };
        for (on, dependent) in dependents {
            if on == project && going.contains(&dependent) {
                continue;
            }
            let before: Vec<(String, String)> = sqlx::query(&sql(
                "SELECT on_project AS project, on_issue AS id FROM issue_links WHERE project = ? AND issue = ? ORDER BY created_at, on_project, on_issue",
            ))
            .bind(&on)
            .bind(&dependent)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| (r.get("project"), r.get("id")))
            .collect();
            let refs = |list: Vec<&(String, String)>| {
                (!list.is_empty())
                    .then(|| json!(list.iter().map(|(p, i)| if *p == on { i.clone() } else { format!("{p}/{i}") }).collect::<Vec<_>>()).to_string())
            };
            let from = refs(before.iter().collect());
            let to = refs(before.iter().filter(|(p, i)| p != project || i != id).collect());
            if from != to {
                self.record_field(&on, &dependent, &orrery, "depends", from.as_deref(), to.as_deref()).await?;
            }
        }
        Ok(())
    }

    /// The issue's assignee and who has claimed it.
    async fn claim_of(&mut self, project: &str, issue: &str) -> Result<(Option<String>, Option<String>)> {
        let row = sqlx::query(&sql("SELECT assignee, claimed_by FROM issues WHERE project = ? AND id = ?"))
            .bind(project)
            .bind(issue)
            .fetch_one(&mut *self.conn)
            .await?;
        Ok((row.get("assignee"), row.get("claimed_by")))
    }

    /// Refuses an agent an issue that isn't its person's, naming who has it (`mustHold`), or one that names nobody.
    pub(crate) async fn must_hold(&mut self, person: Option<&str>, issue: &str, assignee: Option<&str>, what: &str) -> Result<()> {
        let Some(person) = person else {
            return Err(ApiError::conflict(format!(
                "This session names nobody on this orrery, so it can read and comment, but can't {what}. Set ORRERY_PERSON to your id (GET /api/people) where you start Claude Code, or send Orrery-Person."
            )));
        };
        let holder = self.holder_of(assignee).await?;
        if holder.as_deref() == Some(person) {
            return Ok(());
        }
        let (with, instead) = match &holder {
            Some(holder) => (format!("assigned to {holder}"), "comment on it instead, or pick another issue"),
            None => ("assigned to nobody".to_string(), "a person has to assign it first"),
        };
        Err(ApiError::conflict(format!("{issue} is {with}, and this session is {person}'s, so it can't {what}; {instead}")))
    }

    pub(crate) async fn touch_project(&mut self, project: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(stamp()).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The owner's id: what waits on them is assigned to it (`ownerId`).
    pub(crate) async fn owner_id(&mut self) -> Result<String> {
        let row = sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| r.get::<String, _>("id")).unwrap_or_else(|| "owner".into()))
    }

    /// The people here, by id.
    async fn people_here(&mut self) -> Result<Vec<String>> {
        let rows = sqlx::query("SELECT id FROM people WHERE removed_at IS NULL").fetch_all(&mut *self.conn).await?;
        Ok(rows.iter().map(|r| r.get("id")).collect())
    }

    /// Whose a session is (`personFor`): with one person, theirs; with more, the person it names, by name or id.
    pub(crate) async fn person_for(&mut self, named: &str) -> Result<Option<String>> {
        let here = self.people_here().await?;
        if here.len() < 2 {
            return Ok(Some(self.owner_id().await?));
        }
        let id = actor_id(named);
        Ok(here.into_iter().find(|p| !id.is_empty() && *p == id))
    }

    /// Whose a request is (`personOf`): the credential's person, the owner's own, their chat's the owner's, and a
    /// session's the person it names; an untrusted session's nobody's.
    pub(crate) async fn person_asking(&mut self, who: Option<&Who>, actor: &Actor) -> Result<Option<String>> {
        if actor.untrusted {
            return Ok(None);
        }
        if let Some(who) = who {
            return Ok(Some(who.person.clone()));
        }
        if actor.owner {
            return Ok(Some(actor.name.to_lowercase()));
        }
        if actor.chat {
            return Ok(Some(self.owner_id().await?));
        }
        self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await
    }

    /// Whose agent is asking, as `railsFor` has it: `None` when the rails don't hold it (the owner, their chat, what
    /// isn't a request, or one person here), else `Some` of the person it names, if any.
    pub(crate) async fn rails_for(&mut self, actor: &Actor) -> Result<Option<Option<String>>> {
        if !actor.asked || actor.owner || actor.chat || self.people_here().await?.len() < 2 {
            return Ok(None);
        }
        if actor.untrusted {
            return Ok(Some(None));
        }
        Ok(Some(self.person_for(actor.named.as_deref().unwrap_or(&actor.name)).await?))
    }

    /// The person an issue is assigned to (`holderOf`): `claude` counts as the owner's, and one who isn't a person is nobody.
    pub(crate) async fn holder_of(&mut self, assignee: Option<&str>) -> Result<Option<String>> {
        let id = assignee.unwrap_or_default().to_lowercase();
        if id.is_empty() {
            return Ok(None);
        }
        if id == "claude" {
            return Ok(Some(self.owner_id().await?));
        }
        let here = sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(&id).fetch_optional(&mut *self.conn).await?;
        Ok(here.map(|_| id))
    }

    /// Notes the issue's new assignee in its activity, and tells it (`record`).
    pub(crate) async fn record_assignee(&mut self, project: &str, issue: &str, actor: &Actor, before: Option<&str>, after: &str) -> Result<()> {
        self.record_field(project, issue, actor, "assignee", before, Some(after)).await
    }

    /// Notes a field's change in the issue's activity, and tells it as `issue.<field>` (`record`).
    pub(crate) async fn record_field(
        &mut self,
        project: &str,
        issue: &str,
        actor: &Actor,
        field: &str,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Result<()> {
        sqlx::query(&sql(
            "INSERT INTO issue_events (project, issue, field, \"before\", \"after\", created_by, session_name, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(project)
        .bind(issue)
        .bind(field)
        .bind(before)
        .bind(after)
        .bind(&actor.name)
        .bind(actor.session.as_deref())
        .bind(i64::from(actor.owner))
        .bind(stamp())
        .execute(&mut *self.conn)
        .await?;
        self.effects.tell_change(&format!("issue.{field}"), project, issue, before, after);
        Ok(())
    }

    pub(crate) async fn touch_issue(&mut self, project: &str, issue: &str) -> Result<()> {
        let now = stamp();
        sqlx::query(&sql("UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?"))
            .bind(&now)
            .bind(project)
            .bind(issue)
            .execute(&mut *self.conn)
            .await?;
        sqlx::query(&sql("UPDATE projects SET updated_at = ? WHERE id = ?")).bind(&now).bind(project).execute(&mut *self.conn).await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "issue_writes_tests.rs"]
mod tests;
