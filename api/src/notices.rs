// The bell (ORR-1005): what `notices`, `noticeChanges`, `clearNotices` and `readNotices` in web/server/store/owner.ts
// do, on the same tables, answering as `GET /api/notices`, `GET /api/notices/changes`, `POST /api/notices/clear` and
// `POST /api/notices/read` do. Agents' comments across projects, with the agents' proposals waiting on the owner ahead of
// them; what the owner has cleared and read is on the comment (`cleared`, `was_read`), a member's in rows of their own
// (`notice_clears`, `notice_reads`, ORR-658). Clearing and reading tell nothing: the page that did it reads the bell again.
use crate::comments::{columns, comment_of, Comments};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::people::Who;
use crate::write::{stamp, Actor};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::{AnyConnection, Row};
use std::collections::HashMap;

/// A person's own words on comment `o` since comment `c` (`SINCE`): the owner's, or a member's (ORR-658).
const SINCE: &str = "EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND (o.owned = 1 OR (o.person IS NOT NULL AND o.by_agent = 0)) AND o.id > c.id)";

/// The notifications page's lists (`NOTICE_LISTS`).
const LISTS: [&str; 4] = ["bell", "waiting", "inbox", "cleared"];

/// A person's bell, as SQL on a comment `c` joined to its issue `i` (`Bell`): what's in it, what they have and haven't
/// cleared, and what they've read.
struct Bell {
    cleared: String,
    left: String,
    mine: String,
    read: String,
}

/// On the comments' own flag, in the order of their index (`OWNERS_BELL`, ORR-441).
fn owners_bell() -> Bell {
    Bell { cleared: "c.cleared = 1".into(), left: "c.cleared = 0".into(), mine: "c.owned = 0".into(), read: "c.was_read = 1".into() }
}

/// What the notices' query asks for (`?list=&before=&limit=`), as the route reads it: `Number(x) || undefined`.
#[derive(Default)]
pub struct Asked {
    pub list: Option<String>,
    pub before: Option<f64>,
    pub limit: Option<f64>,
}

impl Asked {
    pub fn of(query: &HashMap<String, String>) -> Self {
        let number = |key: &str| query.get(key).and_then(|v| js_number(v)).filter(|n| *n != 0.0 && !n.is_nan());
        Asked { list: query.get("list").cloned(), before: number("before"), limit: number("limit") }
    }
}

/// What JavaScript's `Number(text)` makes of a query's value, enough for an id or a count: blank is 0.
fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A whole number sent in a body (`Number.isInteger`).
fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64)),
        _ => None,
    }
}

/// The ids in `ids`, when it's a list of whole numbers.
fn ids_of(value: Option<&Value>) -> Option<Vec<i64>> {
    match value {
        None => Some(vec![]),
        Some(Value::Array(items)) => items.iter().map(integer).collect(),
        Some(_) => None,
    }
}

/// `since` as `new Date(since)` takes it, in UTC (`toISOString`): a full time with its zone, a date (UTC midnight), or a
/// date and time without a zone (this machine's).
fn time_of(since: &str) -> Option<String> {
    let at: DateTime<Utc> = if let Ok(at) = DateTime::parse_from_rfc3339(since) {
        at.with_timezone(&Utc)
    } else if let Ok(day) = NaiveDate::parse_from_str(since, "%Y-%m-%d") {
        Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0)?)
    } else {
        let naive = ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"].iter().find_map(|f| NaiveDateTime::parse_from_str(since, f).ok())?;
        Local.from_local_datetime(&naive).earliest()?.with_timezone(&Utc)
    };
    Some(at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(", ")
}

pub struct Notices<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Notices<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Notices { conn }
    }

    async fn owner_id(&mut self) -> Result<String> {
        Comments::new(&mut *self.conn).owner_id().await
    }

    /// Whether more than one person is here (`shared`).
    async fn shared(&mut self) -> Result<bool> {
        let n: i64 = sqlx::query("SELECT CAST(count(*) AS BIGINT) AS n FROM people WHERE removed_at IS NULL").fetch_one(&mut *self.conn).await?.get("n");
        Ok(n > 1)
    }

    /// Whose bell is asked for (`personOf`).
    pub async fn person_of(&mut self, who: Option<&Who>, actor: &Actor) -> Result<Option<String>> {
        Comments::new(&mut *self.conn).person_asking(who, actor).await
    }

    /// Whose bell it is, as what filters its comments (`bellOf`, ORR-658).
    async fn bell_of(&mut self, person: Option<&str>) -> Result<Bell> {
        let owner = self.owner_id().await?;
        let id = person.map(str::to_string).unwrap_or_else(|| owner.clone());
        if !self.shared().await? {
            return Ok(owners_bell());
        }
        let quoted = format!("'{}'", id.replace('\'', "''"));
        let assigned = format!("lower(i.assignee) = {quoted}");
        if id == owner {
            return Ok(Bell { mine: format!("c.owned = 0 AND (c.person IS NULL OR c.person = {quoted} OR {assigned})"), ..owners_bell() });
        }
        let cleared = format!("EXISTS (SELECT 1 FROM notice_clears n WHERE n.comment = c.id AND n.person = {quoted})");
        Ok(Bell {
            left: format!("NOT {cleared}"),
            read: format!("EXISTS (SELECT 1 FROM notice_reads n WHERE n.comment = c.id AND n.person = {quoted})"),
            mine: format!("((c.person = {quoted} AND c.by_agent = 1) OR ({assigned} AND (c.person IS NULL OR c.person <> {quoted} OR c.by_agent = 1)))"),
            cleared,
        })
    }

    /// Agents' comments across projects, with the agents' proposals waiting on the owner (`notices`): the `bell`, or the
    /// notifications page's `waiting`, `inbox` and `cleared`, the last two a page at a time.
    pub async fn notices(&mut self, asked: &Asked, person: Option<&str>) -> Result<Value> {
        let list = asked.list.as_deref().unwrap_or("bell");
        let comments = self.comment_notices(list, asked, person).await?;
        // A proposal is the owner's to decide, so a member's bell has none.
        if let Some(person) = person {
            if person != self.owner_id().await? {
                return Ok(Value::Array(comments));
            }
        }
        if list == "inbox" || list == "cleared" && asked.before.is_some() {
            return Ok(Value::Array(comments));
        }
        let mut all = self.proposal_notices(list == "cleared").await?;
        all.extend(comments);
        if list != "bell" {
            all.sort_by(|a, b| {
                let at = |n: &Value| n["created_at"].as_str().unwrap_or_default().to_string();
                at(b).cmp(&at(a)).then_with(|| b["id"].as_i64().cmp(&a["id"].as_i64()))
            });
        }
        Ok(Value::Array(all))
    }

    /// Agents' proposals waiting on the owner, newest put up first: those not cleared, or only those `cleared` since
    /// they were last put up (`proposalNotices`).
    async fn proposal_notices(&mut self, cleared: bool) -> Result<Vec<Value>> {
        let query = format!(
            "SELECT * FROM (
                SELECT i.project, i.id, i.title, i.notes, i.choices, i.created_by, i.created_at, i.updated_at,
                    coalesce((SELECT max(e.created_at) FROM issue_events e WHERE e.project = i.project AND e.issue = i.id AND e.field = 'proposal' AND e.after = 'pending'), i.created_at) AS put_up
                FROM issues i
                WHERE i.proposal = 'pending' AND i.owned = 0
                    AND NOT EXISTS (SELECT 1 FROM issues p WHERE p.project = i.project AND p.id = i.parent AND p.proposal IS NOT NULL)) AS pending
            WHERE {}EXISTS (SELECT 1 FROM proposal_clears c WHERE c.project = pending.project AND c.issue = pending.id AND c.put_up = pending.put_up)",
            if cleared { "" } else { "NOT " }
        );
        let rows = sqlx::query(&query).fetch_all(&mut *self.conn).await?;
        let mut out: Vec<Value> = rows
            .iter()
            .map(|row| {
                let choices = row.get::<Option<String>, _>("choices").filter(|c| !c.is_empty()).unwrap_or_else(|| "[]".into());
                let count = serde_json::from_str::<Value>(&choices).ok().and_then(|v| v.as_array().map(Vec::len)).unwrap_or(0);
                let mut notice = json!({
                    "id": 0, "issue": row.get::<String, _>("id"), "body": row.get::<Option<String>, _>("notes").unwrap_or_default(),
                    "asks": "decision", "answered": false, "created_by": row.get::<String, _>("created_by"), "protected": false,
                    "created_at": row.get::<String, _>("put_up"), "updated_at": row.get::<String, _>("updated_at"),
                    "project": row.get::<String, _>("project"), "title": row.get::<String, _>("title"), "proposal": {"choices": count},
                });
                if cleared {
                    notice["cleared"] = json!(true);
                }
                notice
            })
            .collect();
        out.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
        Ok(out)
    }

    async fn comment_notices(&mut self, list: &str, asked: &Asked, person: Option<&str>) -> Result<Vec<Value>> {
        let bell = self.bell_of(person).await?;
        if !LISTS.contains(&list) {
            return Err(ApiError::bad_request(format!("Unknown list \"{list}\"; use {}", LISTS.join(", "))));
        }
        // The bell: those waiting on the owner first, then the latest, 30 in all.
        if list == "bell" {
            let waiting = self.comment_rows(&format!("{} AND c.asks IS NOT NULL AND NOT {SINCE}", bell.left), Some(30.0), None, &bell).await?;
            let latest = self.comment_rows(&bell.left, Some(30.0), None, &bell).await?;
            let seen: Vec<i64> = waiting.iter().filter_map(|n| n["id"].as_i64()).collect();
            let mut all = waiting;
            all.extend(latest.into_iter().filter(|n| !seen.contains(&n["id"].as_i64().unwrap_or_default())));
            all.truncate(30);
            return Ok(all);
        }
        let which = match list {
            "waiting" => format!("{} AND c.asks IS NOT NULL AND NOT {SINCE}", bell.left),
            "inbox" => format!("{} AND (c.asks IS NULL OR {SINCE})", bell.left),
            _ => bell.cleared.clone(),
        };
        let paged = list == "inbox" || list == "cleared";
        let count = paged.then(|| asked.limit.unwrap_or(50.0).clamp(1.0, 200.0));
        self.comment_rows(&which, count, if paged { asked.before } else { None }, &bell).await
    }

    /// Agents' comments matching `which`, newest first, at most `count`, older than the comment `before` (`commentRows`).
    async fn comment_rows(&mut self, which: &str, count: Option<f64>, before: Option<f64>, bell: &Bell) -> Result<Vec<Value>> {
        let after = if before.is_some() { "AND (c.created_at, c.id) < (SELECT created_at, id FROM comments WHERE id = ?)" } else { "" };
        let limit = if count.is_some() { "LIMIT ?" } else { "" };
        let query = format!(
            "SELECT {}, c.project, i.title, CAST(CASE WHEN {} THEN 1 ELSE 0 END AS BIGINT) AS gone, CAST(CASE WHEN {} THEN 1 ELSE 0 END AS BIGINT) AS opened
             FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
             WHERE {} AND {which} {after}
             ORDER BY c.created_at DESC, c.id DESC {limit}",
            columns(),
            bell.cleared,
            bell.read,
            bell.mine
        );
        let query = sql(&query);
        let mut q = sqlx::query(&query);
        if let Some(before) = before {
            q = if before.fract() == 0.0 { q.bind(before as i64) } else { q.bind(before) };
        }
        if let Some(count) = count {
            // SQLite takes a fraction of a row as the rows below it; Postgres rounds. Whole counts are what's sent.
            q = q.bind(count.trunc() as i64);
        }
        let rows = q.fetch_all(&mut *self.conn).await?;
        Ok(rows
            .iter()
            .map(|row| {
                let mut notice = comment_of(row);
                notice.insert("project".into(), json!(row.get::<String, _>("project")));
                notice.insert("title".into(), json!(row.get::<String, _>("title")));
                if row.get::<i64, _>("gone") != 0 {
                    notice.insert("cleared".into(), json!(true));
                }
                if row.get::<i64, _>("opened") != 0 {
                    notice.insert("read".into(), json!(true));
                }
                Value::Object(notice)
            })
            .collect())
    }

    /// Status changes at or after `since`, oldest first, on the issues someone's bell has a comment on (`noticeChanges`,
    /// ORR-803). The latest 2000, if there are more.
    pub async fn changes(&mut self, since: Option<&str>, person: Option<&str>) -> Result<Value> {
        let Some(since) = since.filter(|s| !s.is_empty()).and_then(time_of) else { return Err(ApiError::bad_request("Send \"since\", a time")) };
        let mine = self.bell_of(person).await?.mine;
        let query = format!(
            "SELECT CAST(e.id AS BIGINT) AS id, e.project, e.issue, e.\"before\", e.\"after\", e.created_by, e.session_name, e.created_at FROM issue_events e
             WHERE e.field = 'status' AND e.created_at >= ?
                AND EXISTS (SELECT 1 FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue WHERE c.project = e.project AND c.issue = e.issue AND {mine})
             ORDER BY e.created_at DESC, e.id DESC LIMIT 2000"
        );
        let rows = sqlx::query(&sql(&query)).bind(since).fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(
            rows.iter()
                .rev()
                .map(|row| {
                    let mut change = json!({"id": row.get::<i64, _>("id"), "project": row.get::<String, _>("project"), "issue": row.get::<String, _>("issue")});
                    for column in ["before", "after"] {
                        if let Some(value) = row.get::<Option<String>, _>(column) {
                            change[column] = json!(value);
                        }
                    }
                    change["created_by"] = json!(row.get::<String, _>("created_by"));
                    if let Some(name) = row.get::<Option<String>, _>("session_name").filter(|s| !s.is_empty()) {
                        change["session_name"] = json!(name);
                    }
                    change["created_at"] = json!(row.get::<String, _>("created_at"));
                    change
                })
                .collect(),
        ))
    }

    async fn changed(&mut self, query: &str, binds: Vec<Bound<'_>>) -> Result<i64> {
        let query = sql(query);
        let mut q = sqlx::query(&query);
        for bound in binds {
            q = match bound {
                Bound::Id(id) => q.bind(id),
                Bound::Text(text) => q.bind(text.to_string()),
            };
        }
        Ok(q.execute(&mut *self.conn).await?.rows_affected() as i64)
    }

    /// Takes notices out of the bell (`clearNotices`): comments by id and proposals by `{project, issue}`, every comment
    /// made at or before `before`, or every one `read`, leaving those still waiting on the owner. A member's are their own.
    pub async fn clear(&mut self, body: &Value, person: Option<&str>) -> Result<i64> {
        if let Some(person) = person {
            if person != self.owner_id().await? {
                return self.clear_own(body, person).await;
            }
        }
        // As destructuring with defaults takes them: only a field left out is none, and a null isn't a list.
        let field = |key: &str| body.as_object().and_then(|o| o.get(key));
        let ids = ids_of(field("ids"));
        let proposals: Option<Vec<(String, String)>> = match field("proposals") {
            None => Some(vec![]),
            Some(Value::Array(items)) => items
                .iter()
                .map(|p| match (p.get("project"), p.get("issue")) {
                    (Some(Value::String(project)), Some(Value::String(issue))) => Some((project.clone(), issue.clone())),
                    _ => None,
                })
                .collect(),
            Some(_) => None,
        };
        if let (Some(ids), Some(proposals)) = (ids, proposals) {
            if !ids.is_empty() || !proposals.is_empty() {
                let mut cleared = if ids.is_empty() {
                    0
                } else {
                    let query = format!("UPDATE comments SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND id IN ({})", marks(ids.len()));
                    self.changed(&query, ids.iter().map(|id| Bound::Id(*id)).collect()).await?
                };
                let waiting: HashMap<String, String> = self
                    .proposal_notices(false)
                    .await?
                    .iter()
                    .map(|n| {
                        (
                            format!("{}/{}", n["project"].as_str().unwrap_or_default(), n["issue"].as_str().unwrap_or_default()),
                            n["created_at"].as_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect();
                let now = stamp();
                for (project, issue) in &proposals {
                    let Some(put_up) = waiting.get(&format!("{project}/{issue}")) else { continue };
                    self.changed(
                        "INSERT INTO proposal_clears (project, issue, put_up, cleared_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                        vec![Bound::Text(project), Bound::Text(issue), Bound::Text(put_up), Bound::Text(&now)],
                    )
                    .await?;
                    cleared += 1;
                }
                return Ok(cleared);
            }
        }
        // Not the ones still waiting on the owner: those go when they're answered, or one by one.
        let answered = "(asks IS NULL OR EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND o.owned = 1 AND o.id > c.id))";
        if let Some(Value::String(before)) = field("before").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
            let query = format!("UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND created_at <= ? AND {answered}");
            return self.changed(&query, vec![Bound::Text(before)]).await;
        }
        if field("read") == Some(&Value::Bool(true)) {
            let query = format!("UPDATE comments AS c SET cleared = 1 WHERE owned = 0 AND cleared = 0 AND was_read = 1 AND {answered}");
            return self.changed(&query, vec![]).await;
        }
        Err(ApiError::bad_request("Send \"ids\" (comment ids), \"proposals\" ([{project, issue}]), \"before\" (a time) or \"read\": true to clear"))
    }

    /// What a member's clearing takes out of their bell alone (`clearOwnNotices`).
    async fn clear_own(&mut self, body: &Value, person: &str) -> Result<i64> {
        let field = |key: &str| body.as_object().and_then(|o| o.get(key));
        let bell = self.bell_of(Some(person)).await?;
        if let Some(Value::Array(_)) = field("ids") {
            if let Some(ids) = ids_of(field("ids")).filter(|ids| !ids.is_empty()) {
                let query = format!(
                    "INSERT INTO notice_clears (comment, person) SELECT c.id, ? FROM comments c WHERE c.id IN ({}) ON CONFLICT DO NOTHING",
                    marks(ids.len())
                );
                let mut binds = vec![Bound::Text(person)];
                binds.extend(ids.iter().map(|id| Bound::Id(*id)));
                return self.changed(&query, binds).await;
            }
        }
        if let Some(Value::String(before)) = field("before").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
            let query = format!(
                "INSERT INTO notice_clears (comment, person) SELECT c.id, ? FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
                 WHERE {} AND c.created_at <= ? AND (c.asks IS NULL OR {SINCE}) ON CONFLICT DO NOTHING",
                bell.mine
            );
            return self.changed(&query, vec![Bound::Text(person), Bound::Text(before)]).await;
        }
        if field("read") == Some(&Value::Bool(true)) {
            let query = format!(
                "INSERT INTO notice_clears (comment, person) SELECT c.id, ? FROM comments c JOIN issues i ON i.project = c.project AND i.id = c.issue
                 WHERE {} AND {} AND (c.asks IS NULL OR {SINCE}) ON CONFLICT DO NOTHING",
                bell.mine, bell.read
            );
            return self.changed(&query, vec![Bound::Text(person)]).await;
        }
        Err(ApiError::bad_request("Send \"ids\" (comment ids), \"before\" (a time) or \"read\": true to clear"))
    }

    /// Marks comments read, for whoever opened them (`readNotices`): the owner's on the comment, a member's their own.
    pub async fn read(&mut self, body: &Value, person: Option<&str>) -> Result<i64> {
        let ids = match body.as_object().and_then(|o| o.get("ids")) {
            Some(Value::Array(_)) => ids_of(body.get("ids")).filter(|ids| !ids.is_empty()),
            _ => None,
        };
        let Some(ids) = ids else { return Err(ApiError::bad_request("Send \"ids\" (comment ids) to mark read")) };
        if let Some(person) = person {
            if person != self.owner_id().await? {
                let query = format!(
                    "INSERT INTO notice_reads (comment, person) SELECT c.id, ? FROM comments c WHERE c.id IN ({}) ON CONFLICT DO NOTHING",
                    marks(ids.len())
                );
                let mut binds = vec![Bound::Text(person)];
                binds.extend(ids.iter().map(|id| Bound::Id(*id)));
                return self.changed(&query, binds).await;
            }
        }
        let query = format!("UPDATE comments SET was_read = 1 WHERE owned = 0 AND was_read = 0 AND id IN ({})", marks(ids.len()));
        self.changed(&query, ids.iter().map(|id| Bound::Id(*id)).collect()).await
    }
}

enum Bound<'a> {
    Id(i64),
    Text(&'a str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_since_as_a_date_does() {
        assert_eq!(time_of("2026-11-06T10:00:00+01:00").as_deref(), Some("2026-11-06T09:00:00.000Z"));
        assert_eq!(time_of("2026-11-06T09:00:00.5Z").as_deref(), Some("2026-11-06T09:00:00.500Z"));
        assert_eq!(time_of("2026-11-06").as_deref(), Some("2026-11-06T00:00:00.000Z"));
        assert_eq!(time_of("yesterday"), None);
    }

    #[test]
    fn reads_numbers_as_the_route_does() {
        let asked = Asked::of(&HashMap::from([("before".into(), "12".into()), ("limit".into(), "x".into())]));
        assert_eq!(asked.before, Some(12.0));
        assert_eq!(asked.limit, None);
        assert_eq!(Asked::of(&HashMap::from([("before".into(), "0".into())])).before, None);
    }
}
