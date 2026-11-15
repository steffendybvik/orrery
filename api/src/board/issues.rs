// A project's issues, reading them (ORR-927): what `listIssues` and `issue` in web/server/store/issues.ts do, on the
// same tables, answering as `GET …/issues` and `GET …/issues/{issue}` do. The board is built as `readBoard`
// (web/server/store/reads.ts) and `buildBoard` (web/server/utils/roadmap.ts) build it: each issue's column, kind and
// counts rolled up from its sub-issues. Writing issues stays the Nuxt server's for now, as a change wakes sessions
// (ORR-929); the router sends only these reads here.
use crate::board::statuses::Statuses;
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::match_of;
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{AnyConnection, Row};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// The kinds, as `emptyKinds` lists them.
const KINDS: [&str; 6] = ["proposed", "backlog", "todo", "started", "done", "canceled"];
const LEGACY_KINDS: [(&str, &str); 4] = [("doing", "started"), ("now", "todo"), ("next", "todo"), ("later", "todo")];
/// A person's own words on comment `o` since comment `c` (`SINCE`): the owner's, or a member's (ORR-658).
const SINCE: &str = "EXISTS (SELECT 1 FROM comments o WHERE o.project = c.project AND o.issue = c.issue AND (o.owned = 1 OR (o.person IS NOT NULL AND o.by_agent = 0)) AND o.id > c.id)";
/// The filters `GET …/issues` takes, as `IssueFilter` has them.
pub const FILTERS: [&str; 14] =
    ["status", "priority", "column", "assignee", "label", "external", "github_issue", "milestone", "release", "parent", "proposal", "blocked", "q", "in"];

static GITHUB_REPO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$").unwrap());
static GITHUB_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/(\d+)/?$").unwrap());
static GITHUB_FULL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\d+)$").unwrap());
pub(crate) static GITHUB_OWN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#?(\d+)$").unwrap());

/// The project's repo as `owner/name`, when it's on GitHub (`githubRepo`).
pub(crate) fn github_repo(repo: Option<&str>) -> Option<String> {
    let found = GITHUB_REPO.captures(repo?.trim())?;
    Some(format!("{}/{}", &found[1], &found[2]))
}

/// A GitHub issue as it's kept, `owner/name#523` (`githubIssueOf`): sent as that, as its link, or as `523` or `#523`
/// on `repo`.
pub(crate) fn github_issue_of(sent: &str, repo: Option<&str>) -> Option<String> {
    let text = sent.trim();
    let (on, number) = if let Some(link) = GITHUB_LINK.captures(text) {
        (link[1].to_string(), link[2].to_string())
    } else if let Some(full) = GITHUB_FULL.captures(text) {
        (full[1].to_string(), full[2].to_string())
    } else if let (Some(own), Some(repo)) = (GITHUB_OWN.captures(text), repo) {
        (repo.to_string(), own[1].to_string())
    } else {
        return None;
    };
    let number = number.trim_start_matches('0');
    (!number.is_empty()).then(|| format!("{on}#{number}"))
}

/// The id inside a full one with this `uid` (`shortId`): what a kind's full ids start with (`prefixes`), the id, then
/// `-<uid>`.
fn short_id(id: &str, prefixes: &[&str], uid: &str) -> Option<String> {
    let tail = format!("-{uid}");
    let prefix = prefixes.iter().find(|p| starts_with(id, p) && id.len() > p.len() + tail.len())?;
    (!uid.is_empty() && id.ends_with(&tail)).then(|| id[prefix.len()..id.len() - tail.len()].to_string())
}

/// Whether `id` starts with `prefix` in any case, so `MLS-` takes the `mls-` of before ORR-995 too.
fn starts_with(id: &str, prefix: &str) -> bool {
    id.get(..prefix.len()).is_some_and(|start| start.eq_ignore_ascii_case(prefix))
}

/// The number inside a milestone's id as it's shown (ORR-995), in any case: `MLS-14` → `14` (`shownNumber`).
fn shown_number(id: &str) -> Option<String> {
    let number = id.get(4..).filter(|n| starts_with(id, "MLS-") && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))?;
    Some(number.to_string())
}

/// A status as the board needs it: its id and kind, in board order.
pub(crate) struct Status {
    pub id: String,
    pub kind: String,
}

/// How many of an issue's leaves are in each kind (`Kinds`), in `KINDS` order.
pub(crate) type Kinds = [i64; 6];

/// Kinds as the board hands them out: `{proposed: 0, backlog: 2, …}`.
pub(crate) fn kinds_json(kinds: &Kinds) -> Value {
    Value::Object(KINDS.iter().zip(kinds).map(|(k, n)| (k.to_string(), json!(n))).collect())
}

fn kind_at(kind: &str) -> usize {
    KINDS.iter().position(|k| *k == kind).unwrap_or(1)
}

/// What `buildBoard`'s `Rules` decide from the statuses: each issue's column and kind.
pub(crate) struct Rules<'s> {
    statuses: &'s [Status],
    /// The open statuses, least along first: started, then todo, then backlog, each in board order.
    open: Vec<&'s Status>,
}

impl<'s> Rules<'s> {
    pub fn new(statuses: &'s [Status]) -> Self {
        let open = ["started", "todo", "backlog"].iter().flat_map(|kind| statuses.iter().filter(move |s| s.kind == *kind)).collect();
        Rules { statuses, open }
    }

    pub fn kind_of(&self, column: &str) -> String {
        if column == "proposed" {
            return column.into();
        }
        self.statuses.iter().find(|s| s.id == column).map(|s| s.kind.clone()).unwrap_or_else(|| "backlog".into())
    }

    fn known(&self, column: &str) -> bool {
        column == "proposed" || self.statuses.iter().any(|s| s.id == column)
    }

    /// The first status of a kind, in board order.
    fn first(&self, kind: &str) -> String {
        self.statuses.iter().find(|s| s.kind == kind).map(|s| s.id.clone()).unwrap_or_else(|| kind.into())
    }

    /// A milestone's column, kind and counts, from its issues (`buildBoard`).
    pub fn roll_up(&self, fields: &mut Map<String, Value>, tasks: &[Node]) {
        let (mut counts, mut kinds) = (Map::new(), [0; 6]);
        for task in tasks {
            sum(&mut counts, &mut kinds, task);
        }
        let column = self.column_of(&counts, &kinds);
        fields.insert("kind".into(), json!(self.kind_of(&column)));
        fields.insert("column".into(), json!(column));
        fields.insert("counts".into(), Value::Object(counts));
        fields.insert("kinds".into(), kinds_json(&kinds));
    }

    /// Closed when every committed leaf is: its first done status with leaves, or canceled when none was done. Else the
    /// least-along open status any leaf is in. Proposed when it's only proposals; nothing yet is in the backlog.
    pub fn column_of(&self, counts: &Map<String, Value>, kinds: &Kinds) -> String {
        let has = |s: &Status| counts.get(&s.id).and_then(Value::as_i64).unwrap_or(0) > 0;
        let [proposed, backlog, todo, started, done, canceled] = *kinds;
        if backlog + todo + started + done == 0 && canceled == 0 {
            return if proposed > 0 { "proposed".into() } else { self.first("backlog") };
        }
        if backlog + todo + started == 0 {
            let closed = self
                .statuses
                .iter()
                .find(|s| s.kind == "done" && has(s))
                .or_else(|| self.statuses.iter().find(|s| (s.kind == "done" || s.kind == "canceled") && has(s)));
            return closed.map(|s| s.id.clone()).unwrap_or_else(|| self.first("done"));
        }
        self.open.iter().find(|s| has(s)).map(|s| s.id.clone()).unwrap_or_else(|| self.first("backlog"))
    }
}

/// An issue on the board: its own fields as the board hands them out, and what it rolls up into its parent.
pub(crate) struct Node {
    pub fields: Map<String, Value>,
    pub counts: Map<String, Value>,
    pub kinds: Kinds,
    pub tasks: Vec<Node>,
}

impl Node {
    /// The issue as the board has it, its sub-issues within (`Issue`).
    pub fn json(&self) -> Value {
        let mut out = self.fields.clone();
        out.insert("tasks".into(), Value::Array(self.tasks.iter().map(Node::json).collect()));
        Value::Object(out)
    }

    pub fn id(&self) -> &str {
        self.fields["id"].as_str().unwrap_or_default()
    }
}

pub(crate) fn sum(into: &mut Map<String, Value>, kinds: &mut Kinds, from: &Node) {
    for (column, n) in &from.counts {
        let before = into.get(column).and_then(Value::as_i64).unwrap_or(0);
        into.insert(column.clone(), json!(before + n.as_i64().unwrap_or(0)));
    }
    for (k, n) in kinds.iter_mut().zip(from.kinds) {
        *k += n
    }
}

/// An issue's row, as `readBoard` reads it.
struct IssueRow {
    id: String,
    parent: Option<String>,
    milestone: Option<String>,
    status: String,
    proposal: Option<String>,
    owned: bool,
    row: AnyRow,
}

const ISSUE_COLUMNS: &str = "id, title, status, priority, assignee, labels, external, github_issues, notes, parent, milestone, \
    CAST(schedule AS BIGINT) AS schedule, proposal, decided_by, decided_at, decision_note, choices, picks, explore, ships_in, \
    CAST(epic AS BIGINT) AS epic, claimed_by, claimed_at, session_name, model, effort, created_by, CAST(owned AS BIGINT) AS owned, created_at, updated_at";

/// The columns a filter on the issue list reads (`sketch`), by filter; those in `WIDE_JSON` are lists kept as JSON.
const WIDE: [(&str, &str); 6] =
    [("priority", "priority"), ("assignee", "assignee"), ("label", "labels"), ("external", "external"), ("github_issue", "github_issues"), ("q", "title")];
const WIDE_JSON: [&str; 3] = ["labels", "external", "github_issues"];

pub(crate) const MILESTONE_COLUMNS: &str =
    "id, title, summary, priority, created_by, CAST(owned AS BIGINT) AS owned, CAST(position AS BIGINT) AS position, created_at, updated_at";

/// What an issue was linked to and by (ORR-601), each as a `linkRef` from the project.
#[derive(Default)]
struct Links {
    depends_on: HashMap<String, Vec<String>>,
    blocked_by: HashMap<String, Vec<String>>,
    blocks: HashMap<String, Vec<String>>,
}

pub(crate) fn link_ref(here: &str, project: &str, id: &str) -> String {
    if project == here {
        id.into()
    } else {
        format!("{project}/{id}")
    }
}

/// A milestone on the board, as `buildBoard` hands it out (`Milestone`): its own fields, with its column, kind and
/// counts rolled up from its issues, and its row's place and times (`milestoneRecord`). The issues in none are one more,
/// with an empty id and no row.
pub(crate) struct Group {
    pub id: String,
    pub fields: Map<String, Value>,
    pub tasks: Vec<Node>,
}

/// An issue's board, as `readBoard` gives it: its milestones in order, each with its issues.
pub(crate) struct Board {
    pub milestones: Vec<Group>,
}

impl Board {
    /// The board's issues as records, each with its parent and milestone, in board order (`issueRecords`).
    fn records(&self, project: &str) -> Vec<Map<String, Value>> {
        fn walk(out: &mut Vec<Map<String, Value>>, project: &str, issues: &[Node], parent: Option<&str>, milestone: &str) {
            for issue in issues {
                let mut record = issue.fields.clone();
                record.insert("project".into(), json!(project));
                record.insert("parent".into(), json!(parent));
                record.insert("milestone".into(), if milestone.is_empty() { Value::Null } else { json!(milestone) });
                record.insert("sub_issues".into(), json!(issue.tasks.iter().map(Node::id).collect::<Vec<_>>()));
                out.push(record);
                walk(out, project, &issue.tasks, Some(issue.id()), milestone);
            }
        }
        let mut out = Vec::new();
        for group in &self.milestones {
            walk(&mut out, project, &group.tasks, None, &group.id);
        }
        out
    }

    /// The issue on the board, with its parent and milestone (`findIssue`): what reading one issue alone must match.
    #[cfg(test)]
    fn find(&self, id: &str) -> Option<(&Node, Option<String>, String)> {
        fn search<'b>(issues: &'b [Node], parent: Option<&str>, id: &str) -> Option<(&'b Node, Option<String>)> {
            for issue in issues {
                if issue.id() == id {
                    return Some((issue, parent.map(String::from)));
                }
                if let Some(found) = search(&issue.tasks, Some(issue.id()), id) {
                    return Some(found);
                }
            }
            None
        }
        self.milestones.iter().find_map(|group| search(&group.tasks, None, id).map(|(issue, parent)| (issue, parent, group.id.clone())))
    }
}

/// The project's row, as far as reading its issues takes.
pub(crate) struct Project {
    pub name: String,
    pub uid: String,
    pub repo: Option<String>,
    pub release_mode: String,
    pub releases_from: Option<String>,
}

pub struct Issues<'c> {
    pub conn: &'c mut AnyConnection,
}

impl<'c> Issues<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Issues { conn }
    }

    pub(crate) async fn project(&mut self, project: &str) -> Result<Project> {
        let row = sqlx::query(&sql("SELECT name, uid, repo, release_mode, releases_from FROM projects WHERE id = ?"))
            .bind(project)
            .fetch_optional(&mut *self.conn)
            .await?;
        let row = row.ok_or_else(|| ApiError::not_found(format!("No project \"{project}\"")))?;
        Ok(Project {
            name: row.get("name"),
            uid: row.get::<Option<String>, _>("uid").unwrap_or_default(),
            repo: row.get("repo"),
            release_mode: row.get::<Option<String>, _>("release_mode").unwrap_or_default(),
            releases_from: row.get("releases_from"),
        })
    }

    /// The statuses of `project`'s workspace (ORR-1107): its board, and what its issues may be set to.
    pub(crate) async fn statuses(&mut self, project: &str) -> Result<Vec<Status>> {
        let workspace = sqlx::query(&sql("SELECT workspace FROM projects WHERE id = ?"))
            .bind(project)
            .fetch_optional(&mut *self.conn)
            .await?
            .map(|r| r.get::<String, _>("workspace"))
            .unwrap_or_else(|| "default".into());
        self.statuses_of(workspace).await
    }

    /// The statuses of `workspace`.
    pub(crate) async fn statuses_of(&mut self, workspace: String) -> Result<Vec<Status>> {
        let listed = Statuses::of(&mut *self.conn, workspace).list().await?;
        Ok(listed
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| Status { id: s["id"].as_str().unwrap_or_default().into(), kind: s["kind"].as_str().unwrap_or_default().into() })
            .collect())
    }

    pub(crate) async fn exists(&mut self, query: &str, binds: &[&str]) -> Result<bool> {
        let query = sql(query);
        let mut asked = sqlx::query(&query);
        for bind in binds {
            asked = asked.bind(*bind);
        }
        Ok(asked.fetch_optional(&mut *self.conn).await?.is_some())
    }

    /// An issue's or a milestone's id, from its id, one it had before (an alias), or the full form of either on this
    /// board (`issueId`, `milestoneId`).
    pub(crate) async fn resolve(&mut self, project: &str, sent: &str, milestone: bool) -> Result<String> {
        let (table, aliases, column, prefixes): (&str, &str, &str, &[&str]) =
            if milestone { ("milestones", "milestone_aliases", "milestone", &["MLS-", "chk-"]) } else { ("issues", "issue_aliases", "issue", &[""]) };
        let mut id = sent.to_string();
        loop {
            if self.exists(&format!("SELECT 1 FROM {table} WHERE project = ? AND id = ?"), &[project, &id]).await? {
                return Ok(id);
            }
            let alias = sqlx::query(&sql(&format!("SELECT {column} AS target FROM {aliases} WHERE project = ? AND alias = ?")))
                .bind(project)
                .bind(&id)
                .fetch_optional(&mut *self.conn)
                .await?;
            if let Some(alias) = alias {
                return Ok(alias.get("target"));
            }
            let short = if milestone { shown_number(&id) } else { None };
            match short.or(short_id(&id, prefixes, &self.project(project).await?.uid)) {
                Some(short) if short != id => id = short,
                _ => return Ok(id),
            }
        }
    }

    /// The handle in issues' references: the owner's, or else their id (`handle`).
    async fn handle(&mut self) -> Result<String> {
        let row = sqlx::query("SELECT value FROM settings WHERE key = 'handle'").fetch_optional(&mut *self.conn).await?;
        let handle = row.and_then(|r| serde_json::from_str::<Value>(&r.get::<String, _>("value")).ok()).and_then(|v| v.as_str().map(String::from));
        match handle.filter(|h| !h.is_empty()) {
            Some(handle) => Ok(handle),
            None => self.owner_id().await,
        }
    }

    /// The owner's id: what waits on them is assigned to it (`ownerId`).
    async fn owner_id(&mut self) -> Result<String> {
        let row = sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| r.get::<String, _>("id")).unwrap_or_else(|| "owner".into()))
    }

    /// The project's issues that are done (`doneIssues`, ORR-601), of `ids` only when given.
    async fn done_issues(&mut self, project: &str, statuses: &[Status], ids: Option<&[String]>) -> Result<HashSet<String>> {
        let query = sql(&format!("SELECT id, status, proposal FROM issues WHERE project = ?{}", within("id", ids)));
        let rows = scoped(&query, project, ids).fetch_all(&mut *self.conn).await?;
        Ok(rows
            .iter()
            .filter(|r| r.get::<Option<String>, _>("proposal").is_none() && statuses.iter().any(|s| s.kind == "done" && s.id == r.get::<String, _>("status")))
            .map(|r| r.get("id"))
            .collect())
    }

    /// The links on and by the project's issues, or only `ids` of them when given.
    async fn links(&mut self, project: &str, statuses: &[Status], ids: Option<&[String]>) -> Result<Links> {
        let query = sql(&format!(
            "SELECT issue, on_project, on_issue FROM issue_links WHERE project = ?{} ORDER BY created_at, on_project, on_issue",
            within("issue", ids)
        ));
        let on = scoped(&query, project, ids).fetch_all(&mut *self.conn).await?;
        let query = sql(&format!(
            "SELECT project, issue, on_issue FROM issue_links WHERE on_project = ?{} ORDER BY created_at, project, issue",
            within("on_issue", ids)
        ));
        let by = scoped(&query, project, ids).fetch_all(&mut *self.conn).await?;
        let mut done: HashMap<String, HashSet<String>> = HashMap::new();
        let mut others: HashMap<String, Vec<String>> = HashMap::new();
        for link in &on {
            others.entry(link.get("on_project")).or_default().push(link.get("on_issue"));
        }
        for (other, on_issues) in others {
            // For one issue's links, only the issues they're on; for the board, the other project's whole list.
            let found = self.done_issues(&other, statuses, ids.map(|_| on_issues.as_slice())).await?;
            done.insert(other, found);
        }
        let mut links = Links::default();
        for link in &on {
            let (issue, other, on_issue): (String, String, String) = (link.get("issue"), link.get("on_project"), link.get("on_issue"));
            let reference = link_ref(project, &other, &on_issue);
            links.depends_on.entry(issue.clone()).or_default().push(reference.clone());
            if !done.get(&other).is_some_and(|d| d.contains(&on_issue)) {
                links.blocked_by.entry(issue).or_default().push(reference);
            }
        }
        for link in &by {
            let (from, issue, on_issue): (String, String, String) = (link.get("project"), link.get("issue"), link.get("on_issue"));
            links.blocks.entry(on_issue).or_default().push(link_ref(project, &from, &issue));
        }
        Ok(links)
    }

    /// Each issue with a rated PR (ORR-879), and the riskiest of them (`readRisks`).
    async fn risks(&mut self, project: &str, ids: Option<&[String]>) -> Result<HashMap<String, Value>> {
        let query = sql(&format!(
            "SELECT issue, risk, risk_why, risk_by FROM issue_pulls WHERE project = ? AND risk IS NOT NULL{} ORDER BY number",
            within("issue", ids)
        ));
        let rows = scoped(&query, project, ids).fetch_all(&mut *self.conn).await?;
        let rank = |level: &str| ["high", "medium", "low"].iter().position(|l| *l == level).unwrap_or(3);
        let mut risks: HashMap<String, Value> = HashMap::new();
        for row in rows {
            let level: String = row.get("risk");
            let by = if row.get::<Option<String>, _>("risk_by").as_deref() == Some("owner") { "owner" } else { "session" };
            let risk = json!({"level": level, "why": row.get::<Option<String>, _>("risk_why").unwrap_or_default(), "by": by});
            let issue: String = row.get("issue");
            let higher = risks.get(&issue).map_or(true, |kept| rank(&level) < rank(kept["level"].as_str().unwrap_or_default()));
            if higher {
                risks.insert(issue, risk);
            }
        }
        Ok(risks)
    }

    /// The ids each issue or milestone had before, A–Z.
    pub(crate) async fn aliases(&mut self, project: &str, table: &str, column: &str, ids: Option<&[String]>) -> Result<HashMap<String, Vec<String>>> {
        let query = sql(&format!("SELECT alias, {column} AS target FROM {table} WHERE project = ?{} ORDER BY alias", within(column, ids)));
        let rows = scoped(&query, project, ids).fetch_all(&mut *self.conn).await?;
        let mut found: HashMap<String, Vec<String>> = HashMap::new();
        for row in rows {
            found.entry(row.get("target")).or_default().push(row.get("alias"));
        }
        Ok(found)
    }

    /// The project's board (`readBoard`, then `buildBoard`): its milestones and their issues, sub-issues within, each
    /// with its comment count, open question, the ids it had before, its dependency links and its risk.
    pub(crate) async fn board(&mut self, project: &str, statuses: &[Status]) -> Result<Board> {
        let milestones = sqlx::query(&sql(&format!("SELECT {MILESTONE_COLUMNS} FROM milestones WHERE project = ? ORDER BY position, created_at")))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?;
        let rows = issue_rows(
            sqlx::query(&sql(&format!("SELECT {ISSUE_COLUMNS} FROM issues WHERE project = ? ORDER BY position, created_at")))
                .bind(project)
                .fetch_all(&mut *self.conn)
                .await?,
        );
        let extras = self.extras(project, statuses, &rows, None, &[]).await?;
        let milestone_aliases = self.aliases(project, "milestone_aliases", "milestone", None).await?;
        let mut children: HashMap<Option<String>, Vec<&IssueRow>> = HashMap::new();
        for row in &rows {
            children.entry(row.parent.clone()).or_default().push(row);
        }

        let rules = Rules::new(statuses);
        let context = Context { rules: &rules, children: &children, extras: &extras };
        let top = children.get(&None).cloned().unwrap_or_default();
        let mut grouped: Vec<Group> = milestones
            .iter()
            .map(|m| {
                let id: String = m.get("id");
                let tasks: Vec<Node> = top.iter().filter(|t| t.milestone.as_deref() == Some(id.as_str())).map(|t| context.issue(t, false)).collect();
                milestone_group(project, m, &rules, &milestone_aliases, tasks)
            })
            .collect();
        let loose: Vec<&&IssueRow> = top.iter().filter(|t| t.milestone.as_deref().map_or(true, str::is_empty)).collect();
        if !loose.is_empty() {
            let tasks: Vec<Node> = loose.into_iter().map(|t| context.issue(t, false)).collect();
            let mut fields = Map::new();
            rules.roll_up(&mut fields, &tasks);
            grouped.push(Group { id: String::new(), fields, tasks });
        }
        Ok(Board { milestones: grouped })
    }

    /// What each issue on the board carries besides its row (`readBoard`): its comment count, open question, the ids it
    /// had before, its dependency links and its risk. With `ids`, for those issues only, `rows` being them; `above` is
    /// then the proposals outside `rows` that one of them is directly under.
    async fn extras(&mut self, project: &str, statuses: &[Status], rows: &[IssueRow], ids: Option<&[String]>, above: &[String]) -> Result<Extras> {
        let query = sql(&format!("SELECT issue, CAST(count(*) AS BIGINT) AS n FROM comments WHERE project = ?{} GROUP BY issue", within("issue", ids)));
        let comments: HashMap<String, i64> =
            scoped(&query, project, ids).fetch_all(&mut *self.conn).await?.iter().map(|r| (r.get("issue"), r.get("n"))).collect();
        // Each issue's latest question from an agent that no comment of the owner's has come after.
        let mut waiting: HashMap<String, String> = HashMap::new();
        let open_ask = sql(&format!(
            "SELECT c.issue, c.asks FROM comments c WHERE c.project = ?{} AND c.asks IS NOT NULL AND +c.owned = 0 AND NOT {SINCE} ORDER BY c.id",
            within("c.issue", ids)
        ));
        for row in scoped(&open_ask, project, ids).fetch_all(&mut *self.conn).await? {
            waiting.insert(row.get("issue"), row.get("asks"));
        }
        // An agent's proposal waiting on the owner (pending, not under another proposal) waits on their decision too,
        // when no question of its own is open.
        let mut proposals: HashSet<&str> = rows.iter().filter(|r| r.proposal.is_some()).map(|r| r.id.as_str()).collect();
        proposals.extend(above.iter().map(String::as_str));
        for row in rows {
            let under_proposal = row.parent.as_deref().is_some_and(|p| proposals.contains(p));
            if row.proposal.as_deref() == Some("pending") && !row.owned && !under_proposal && !waiting.contains_key(&row.id) {
                waiting.insert(row.id.clone(), "decision".into());
            }
        }
        // One that's done or canceled waits on nobody, whatever was left unanswered on it (ORR-640).
        let closed: HashSet<String> = statuses.iter().filter(|s| s.kind == "done" || s.kind == "canceled").map(|s| s.id.clone()).collect();
        let links = self.links(project, statuses, ids).await?;
        let risks = self.risks(project, ids).await?;
        let aliases = self.aliases(project, "issue_aliases", "issue", ids).await?;
        Ok(Extras { comments, waiting, closed, links, risks, aliases })
    }

    /// Where an issue sits on the board, read up its parents (ORR-1117): its parent, its milestone (its top issue's), and
    /// whether a proposal is above it. None when the board doesn't reach it, as `findIssue` wouldn't find it: under an
    /// issue there isn't, in a loop, or at the top in a milestone there isn't.
    async fn place(&mut self, project: &str, id: &str) -> Result<Option<Place>> {
        let ask = sql("SELECT parent, milestone, proposal FROM issues WHERE project = ? AND id = ?");
        let (mut at, mut seen) = (id.to_string(), HashSet::new());
        let mut place = Place { parent: None, parent_proposal: false, milestone: String::new(), proposed: false };
        loop {
            if !seen.insert(at.clone()) {
                return Ok(None);
            }
            let Some(row) = sqlx::query(&ask).bind(project).bind(&at).fetch_optional(&mut *self.conn).await? else {
                return Ok(None);
            };
            let above = at != id;
            if above && row.get::<Option<String>, _>("proposal").is_some() {
                place.proposed = true;
                if place.parent.as_deref() == Some(at.as_str()) {
                    place.parent_proposal = true;
                }
            }
            match row.get::<Option<String>, _>("parent") {
                Some(parent) => {
                    if !above {
                        place.parent = Some(parent.clone());
                    }
                    at = parent;
                }
                None => {
                    let milestone = row.get::<Option<String>, _>("milestone").unwrap_or_default();
                    if !milestone.is_empty() && !self.exists("SELECT 1 FROM milestones WHERE project = ? AND id = ?", &[project, &milestone]).await? {
                        return Ok(None);
                    }
                    place.milestone = milestone;
                    return Ok(Some(place));
                }
            }
        }
    }

    /// The issue and its sub-issues, as the board builds them, read without the rest of the board (ORR-1117).
    async fn subtree(&mut self, project: &str, id: &str, statuses: &[Status]) -> Result<Option<(Node, Place)>> {
        let Some(place) = self.place(project, id).await? else {
            return Ok(None);
        };
        let query = sql(&format!(
            "WITH RECURSIVE tree(id) AS (SELECT id FROM issues WHERE project = ? AND id = ? \
             UNION SELECT i.id FROM tree t CROSS JOIN issues i WHERE i.project = ? AND i.parent = t.id) \
             SELECT {ISSUE_COLUMNS} FROM issues WHERE project = ? AND id IN (SELECT id FROM tree) ORDER BY position, created_at"
        ));
        let rows = issue_rows(sqlx::query(&query).bind(project).bind(id).bind(project).bind(project).fetch_all(&mut *self.conn).await?);
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let above: Vec<String> = place.parent.clone().filter(|_| place.parent_proposal).into_iter().collect();
        let extras = self.extras(project, statuses, &rows, Some(&ids), &above).await?;
        let mut children: HashMap<Option<String>, Vec<&IssueRow>> = HashMap::new();
        for row in &rows {
            children.entry(row.parent.clone()).or_default().push(row);
        }
        let Some(top) = rows.iter().find(|r| r.id == id) else {
            return Ok(None);
        };
        let rules = Rules::new(statuses);
        let node = Context { rules: &rules, children: &children, extras: &extras }.issue(top, place.proposed);
        Ok(Some((node, place)))
    }

    /// Each of `roots` as the board builds it, its sub-issues within, read without the rest of the board (ORR-1118):
    /// their subtrees' rows and what `extras` gathers about those only. Each must be on the board.
    pub(crate) async fn nodes(&mut self, project: &str, statuses: &[Status], roots: &[String]) -> Result<HashMap<String, Node>> {
        if roots.is_empty() {
            return Ok(HashMap::new());
        }
        let query = sql(&format!(
            "WITH RECURSIVE tree(id) AS (SELECT id FROM issues WHERE project = ?{} \
             UNION SELECT i.id FROM tree t CROSS JOIN issues i WHERE i.project = ? AND i.parent = t.id) \
             SELECT {ISSUE_COLUMNS} FROM issues WHERE project = ? AND id IN (SELECT id FROM tree) ORDER BY position, created_at",
            within("id", Some(roots))
        ));
        let rows = issue_rows(scoped(&query, project, Some(roots)).bind(project).bind(project).fetch_all(&mut *self.conn).await?);
        // Where each issue hangs, its own rows and those above them, to know which roots are under a proposal.
        let mut up: HashMap<String, (Option<String>, bool)> = rows.iter().map(|r| (r.id.clone(), (r.parent.clone(), r.proposal.is_some()))).collect();
        let query = sql(&format!(
            "WITH RECURSIVE up(id) AS (SELECT parent FROM issues WHERE project = ?{} AND parent IS NOT NULL \
             UNION SELECT i.parent FROM up u CROSS JOIN issues i WHERE i.project = ? AND i.id = u.id AND i.parent IS NOT NULL) \
             SELECT id, parent, proposal FROM issues WHERE project = ? AND id IN (SELECT id FROM up)",
            within("id", Some(roots))
        ));
        for r in scoped(&query, project, Some(roots)).bind(project).bind(project).fetch_all(&mut *self.conn).await? {
            up.insert(r.get("id"), (r.get("parent"), r.get::<Option<String>, _>("proposal").is_some()));
        }
        let proposed = |id: &str| {
            let (mut at, mut seen) = (up.get(id).and_then(|(p, _)| p.clone()), HashSet::new());
            while let Some(here) = at.filter(|h| seen.insert(h.clone())) {
                match up.get(&here) {
                    Some((_, true)) => return true,
                    Some((parent, false)) => at = parent.clone(),
                    None => return false,
                }
            }
            false
        };
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let inside: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut above: Vec<String> = roots
            .iter()
            .filter_map(|root| up.get(root).and_then(|(p, _)| p.clone()))
            .filter(|p| !inside.contains(p.as_str()) && up.get(p).is_some_and(|(_, proposal)| *proposal))
            .collect();
        above.sort();
        above.dedup();
        let extras = self.extras(project, statuses, &rows, Some(&ids), &above).await?;
        let mut children: HashMap<Option<String>, Vec<&IssueRow>> = HashMap::new();
        for row in &rows {
            children.entry(row.parent.clone()).or_default().push(row);
        }
        let rules = Rules::new(statuses);
        let context = Context { rules: &rules, children: &children, extras: &extras };
        let roots: HashSet<&str> = roots.iter().map(String::as_str).collect();
        Ok(rows.iter().filter(|r| roots.contains(r.id.as_str())).map(|r| (r.id.clone(), context.issue(r, proposed(&r.id)))).collect())
    }

    /// The issue's tasks in the shape `listIssues` filters (ORR-1118): filtered on the board's wide outline, then only
    /// those listed built in full, with their subtrees.
    pub async fn list(&mut self, project: &str, filter: &HashMap<String, String>) -> Result<Value> {
        self.listing(project, filter, None).await
    }

    /// The list, building those listed from the `whole` board or not, or, with None, whichever is quicker.
    async fn listing(&mut self, project: &str, filter: &HashMap<String, String>, whole: Option<bool>) -> Result<Value> {
        let row = self.project(project).await?;
        let statuses = self.statuses(project).await?;
        let get = |key: &str| filter.get(key).map(String::as_str).filter(|v| !v.is_empty() && FILTERS.contains(&key));
        let wide: Vec<&str> = WIDE.iter().filter(|(by, _)| get(by).is_some()).map(|(_, column)| *column).collect();
        // With no filter, each is listed, so the whole board is read as it is.
        let unfiltered = FILTERS.iter().all(|key| get(key).is_none());
        let mut records = if unfiltered {
            self.board(project, &statuses).await?.records(project)
        } else {
            self.sketch(project, &statuses, Some(&wide)).await?.records(project)
        };
        let milestone = match get("milestone") {
            Some(m) if m != "none" => Some(self.resolve(project, m, true).await?),
            other => other.map(String::from),
        };
        let parent = match get("parent") {
            Some(p) if p != "none" => Some(self.resolve(project, p, false).await?),
            other => other.map(String::from),
        };
        if let Some(release) = get("release").filter(|r| *r != "none") {
            self.release_there(project, &row, release).await?;
        }
        let q = get("q").map(str::to_lowercase);
        let status_ids = |sent: &str| status_ids(&statuses, sent);
        let wanted_statuses = get("status").map(status_ids);
        let columns = get("column").map(|c| if c == "proposed" { vec!["proposed".to_string()] } else { status_ids(c) });
        let assignee = match get("assignee") {
            Some(a) if a != "none" => {
                let name = a.trim();
                Some(if name.eq_ignore_ascii_case("owner") { Some(self.owner_id().await?) } else { Some(name.to_string()).filter(|n| !n.is_empty()) })
            }
            _ => None,
        };
        let github = match get("github_issue") {
            Some(sent) => Some(self.github_issue(project, &row, sent)?.to_lowercase()),
            None => None,
        };
        let handle = self.handle().await?;
        // With `in: all`, every word in one place: the id and title, the description or a comment (ORR-641).
        let words: Option<Vec<String>> = q.as_ref().filter(|_| get("in") == Some("all")).map(|q| q.split_whitespace().map(String::from).collect());
        let text = |r: &Map<String, Value>, key: &str| r.get(key).and_then(Value::as_str).map(String::from);
        let has_in = |r: &Map<String, Value>, key: &str, value: &str| r[key].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(value)));
        if get("blocked").is_some() {
            let links = self.links(project, &statuses, None).await?;
            for record in &mut records {
                if let Some(blocked_by) = text(record, "id").and_then(|id| links.blocked_by.get(&id).cloned()) {
                    record.insert("blocked_by".into(), json!(blocked_by));
                }
            }
        }
        let total = records.len();
        let below: HashMap<String, Vec<Value>> =
            records.iter().map(|r| (text(r, "id").unwrap_or_default(), r["sub_issues"].as_array().cloned().unwrap_or_default())).collect();
        let matched: Vec<Map<String, Value>> = records
            .into_iter()
            .filter(|r| {
                let status = text(r, "status").unwrap_or_default();
                let column = text(r, "column").unwrap_or_default();
                let none_or = |key: &str, sent: Option<&str>| match sent {
                    None => true,
                    Some("none") => text(r, key).map_or(true, |v| v.is_empty()),
                    Some(value) => text(r, key).as_deref() == Some(value),
                };
                wanted_statuses.as_ref().map_or(true, |s| s.contains(&status))
                    && none_or("priority", get("priority"))
                    && columns.as_ref().map_or(true, |c| c.contains(&column))
                    && match (get("assignee"), &assignee) {
                        (None, _) => true,
                        (Some("none"), _) => text(r, "assignee").map_or(true, |v| v.is_empty()),
                        (_, Some(name)) => name.is_some() && text(r, "assignee") == *name,
                        _ => false,
                    }
                    && get("label").map_or(true, |l| has_in(r, "labels", l))
                    && get("external").map_or(true, |e| has_in(r, "external", e))
                    && github
                        .as_ref()
                        .map_or(true, |g| r["github_issues"].as_array().is_some_and(|a| a.iter().any(|v| v.as_str().is_some_and(|v| v.to_lowercase() == *g))))
                    && none_or("milestone", milestone.as_deref())
                    && none_or("release", get("release"))
                    && none_or("parent", parent.as_deref())
                    && match get("proposal") {
                        None => true,
                        Some("none") => column != "proposed",
                        Some(value) => text(r, "proposal").as_deref() == Some(value),
                    }
                    && get("blocked").map_or(true, |b| r.get("blocked_by").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) == (b == "true"))
                    && match (&q, &words) {
                        (None, _) | (_, Some(_)) => true,
                        (Some(q), None) => id_or_title(r).0.to_lowercase().contains(q) || id_or_title(r).1.to_lowercase().contains(q),
                    }
            })
            .collect();
        // Each listed in full, with its subtree. When those cover most of the board, building it whole is as quick.
        let ids: Vec<String> = matched.iter().filter_map(|r| text(r, "id")).collect();
        let covered = {
            let (mut seen, mut queue): (HashSet<&str>, Vec<&str>) = (HashSet::new(), ids.iter().map(String::as_str).collect());
            while let Some(id) = queue.pop() {
                if seen.insert(id) {
                    queue.extend(below.get(id).into_iter().flatten().filter_map(Value::as_str));
                }
            }
            seen.len()
        };
        let mut built: Option<HashMap<String, Map<String, Value>>> = if unfiltered {
            None
        } else if whole.unwrap_or(covered * 2 > total) {
            Some(self.board(project, &statuses).await?.records(project).into_iter().map(|r| (text(&r, "id").unwrap_or_default(), r)).collect())
        } else {
            Some(self.nodes(project, &statuses, &ids).await?.into_iter().map(|(id, node)| (id, node.fields)).collect())
        };
        let listed: Vec<Map<String, Value>> = matched
            .into_iter()
            .map(|sketched| {
                let id = text(&sketched, "id").unwrap_or_default();
                let mut r = match built.as_mut() {
                    Some(built) => {
                        let mut r = built.remove(&id).unwrap_or_default();
                        for key in ["project", "parent", "milestone", "sub_issues"] {
                            r.insert(key.into(), sketched[key].clone());
                        }
                        r
                    }
                    None => sketched,
                };
                r.insert("ref".into(), json!(format!("orrery-{}: {id}", handle.to_lowercase())));
                r.insert("full_id".into(), json!(format!("{id}-{}", row.uid)));
                r
            })
            .collect();
        let found = match words {
            Some(words) => self.found_in(project, listed, &words).await?,
            None => listed,
        };
        Ok(Value::Array(found.into_iter().map(Value::Object).collect()))
    }

    /// Those with every word in their id and title first, then those with them in the description or a comment, each
    /// saying where and the text around it (`foundIn`). What an outsider's session raised (`external`) says only where.
    /// orrery's own comments (a pull request's news) don't count.
    async fn found_in(&mut self, project: &str, listed: Vec<Map<String, Value>>, words: &[String]) -> Result<Vec<Map<String, Value>>> {
        let has = |text: &str| {
            let lower = text.to_lowercase();
            words.iter().all(|w| lower.contains(w.as_str()))
        };
        let comments: Vec<(String, String)> = sqlx::query(&sql("SELECT issue, body FROM comments WHERE project = ? AND created_by != ? ORDER BY id DESC"))
            .bind(project)
            .bind("orrery")
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| (r.get("issue"), r.get("body")))
            .collect();
        let (mut first, mut rest) = (Vec::new(), Vec::new());
        for mut record in listed {
            let (id, title) = id_or_title(&record);
            if has(&format!("{id} {title}")) {
                first.push(record);
                continue;
            }
            let notes = record.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty() && has(n)).map(String::from);
            let (body, place) = match notes {
                Some(notes) => (notes, "description"),
                None => match comments.iter().find(|(issue, body)| *issue == id && has(body)) {
                    Some((_, body)) => (body.clone(), "comment"),
                    None => continue,
                },
            };
            let external = record["labels"].as_array().is_some_and(|l| l.iter().any(|v| v.as_str() == Some("external")));
            record.insert("match_in".into(), json!(place));
            if !external {
                record.insert("match".into(), json!(match_of(&body, words)));
            }
            rest.push(record);
        }
        first.extend(rest);
        Ok(first)
    }

    /// Refuses a release there isn't, in the project's source when it takes its releases from another (`releaseRow`).
    pub(crate) async fn release_there(&mut self, project: &str, row: &Project, version: &str) -> Result<()> {
        let source = match row.release_mode.as_str() {
            "shared" => row.releases_from.clone(),
            "own" => Some(project.to_string()),
            _ => None,
        };
        let Some(source) = source else {
            return Err(ApiError::bad_request(format!(
                "{project} has no releases; turn them on with PATCH /api/projects/{project} {{\"release_mode\": \"own\"}}"
            )));
        };
        if !self.exists("SELECT 1 FROM releases WHERE project = ? AND version = ?", &[&source, version]).await? {
            let elsewhere = if source == project { String::new() } else { format!(" (where {project} takes its releases from)") };
            return Err(ApiError::not_found(format!("No release {version} in {source}{elsewhere}; make it with POST /api/projects/{source}/releases")));
        }
        Ok(())
    }

    /// The board's outline (ORR-1117): its milestones and issues in board order, each issue with only its id, release,
    /// column, counts and kinds, the milestones with only their roll-up. What counting the board up takes (a project's
    /// counts, its releases' tallies), read without each issue in full and what `board` gathers about it.
    pub(crate) async fn outline(&mut self, project: &str, statuses: &[Status]) -> Result<Board> {
        self.sketch(project, statuses, None).await
    }

    /// The outline, or, with `wide`, what filtering the issue list takes too (ORR-1118): each issue's status, column
    /// and proposal, and those of its title, priority, assignee, labels, external tasks and GitHub issues named.
    async fn sketch(&mut self, project: &str, statuses: &[Status], wide: Option<&[&str]>) -> Result<Board> {
        struct Thin {
            id: String,
            parent: Option<String>,
            milestone: Option<String>,
            status: String,
            proposal: Option<String>,
            release: Option<String>,
            wide: Option<Map<String, Value>>,
        }
        fn build(rules: &Rules, children: &HashMap<Option<String>, Vec<&Thin>>, issue: &Thin, proposed: bool) -> Node {
            let proposed = proposed || issue.proposal.is_some();
            let tasks: Vec<Node> = children.get(&Some(issue.id.clone())).into_iter().flatten().map(|t| build(rules, children, t, proposed)).collect();
            let (mut counts, mut kinds) = (Map::new(), [0; 6]);
            for task in &tasks {
                sum(&mut counts, &mut kinds, task);
            }
            if tasks.is_empty() {
                let column = if proposed {
                    "proposed".to_string()
                } else if rules.known(&issue.status) {
                    issue.status.clone()
                } else {
                    rules.first("backlog")
                };
                kinds[kind_at(&rules.kind_of(&column))] = 1;
                counts.insert(column, json!(1));
            }
            let mut fields = Map::new();
            fields.insert("id".into(), json!(issue.id));
            if let Some(release) = &issue.release {
                fields.insert("release".into(), json!(release));
            }
            if let Some(wide) = &issue.wide {
                fields.extend(wide.clone());
                fields.insert("status".into(), json!(issue.status));
                if let Some(proposal) = &issue.proposal {
                    fields.insert("proposal".into(), json!(proposal));
                }
                fields.insert("column".into(), json!(rules.column_of(&counts, &kinds)));
            }
            Node { fields, counts, kinds, tasks }
        }
        let milestones: Vec<String> = sqlx::query(&sql("SELECT id FROM milestones WHERE project = ? ORDER BY position, created_at"))
            .bind(project)
            .fetch_all(&mut *self.conn)
            .await?
            .iter()
            .map(|r| r.get("id"))
            .collect();
        let more: String = wide.into_iter().flatten().map(|c| format!(", {c}")).collect();
        let rows: Vec<Thin> = sqlx::query(&sql(&format!(
            "SELECT id, parent, milestone, status, proposal, ships_in{more} FROM issues WHERE project = ? ORDER BY position, created_at"
        )))
        .bind(project)
        .fetch_all(&mut *self.conn)
        .await?
        .iter()
        .map(|r| Thin {
            id: r.get("id"),
            parent: r.get("parent"),
            milestone: r.get("milestone"),
            status: r.get("status"),
            proposal: r.get("proposal"),
            release: r.get("ships_in"),
            wide: wide.map(|columns| {
                let mut f = Map::new();
                for key in columns {
                    let text = r.get::<Option<String>, _>(*key);
                    if WIDE_JSON.contains(key) {
                        f.insert(key.to_string(), text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!([])));
                    } else if let Some(value) = text {
                        f.insert(key.to_string(), json!(value));
                    }
                }
                f
            }),
        })
        .collect();
        let mut children: HashMap<Option<String>, Vec<&Thin>> = HashMap::new();
        for row in &rows {
            children.entry(row.parent.clone()).or_default().push(row);
        }
        let rules = Rules::new(statuses);
        let top = children.get(&None).cloned().unwrap_or_default();
        let group = |id: String, tasks: Vec<Node>| {
            let mut fields = Map::new();
            rules.roll_up(&mut fields, &tasks);
            Group { id, fields, tasks }
        };
        let mut grouped: Vec<Group> = milestones
            .into_iter()
            .map(|id| {
                let tasks = top.iter().filter(|t| t.milestone.as_deref() == Some(id.as_str())).map(|t| build(&rules, &children, t, false)).collect();
                group(id, tasks)
            })
            .collect();
        let loose: Vec<Node> = top.iter().filter(|t| t.milestone.as_deref().map_or(true, str::is_empty)).map(|t| build(&rules, &children, t, false)).collect();
        if !loose.is_empty() {
            grouped.push(group(String::new(), loose));
        }
        Ok(Board { milestones: grouped })
    }

    /// The GitHub issue a filter names, as kept (`githubIssuesOf`): refused when it isn't one.
    fn github_issue(&self, project: &str, row: &Project, sent: &str) -> Result<String> {
        let repo = github_repo(row.repo.as_deref());
        github_issue_of(sent, repo.as_deref()).ok_or_else(|| {
            ApiError::bad_request(if GITHUB_OWN.is_match(sent) {
                format!("{project}'s repo isn't on GitHub, so say whose issue {sent} is: owner/name#{}", sent.strip_prefix('#').unwrap_or(sent))
            } else {
                format!("\"{sent}\" isn't a GitHub issue: send its number on {}, owner/name#523 or its link", repo.as_deref().unwrap_or("the project's repo"))
            })
        })
    }

    /// One issue, with its column, counts and sub-issues (`issue`).
    pub async fn issue(&mut self, project: &str, sent: &str) -> Result<Value> {
        let id = self.resolve(project, sent, false).await?;
        let row = self.project(project).await?;
        let statuses = self.statuses(project).await?;
        let (issue, place) = self.subtree(project, &id, &statuses).await?.ok_or_else(|| ApiError::not_found(format!("No issue {id} in {project}")))?;
        let Value::Object(mut out) = issue.json() else { unreachable!() };
        out.insert("project".into(), json!(project));
        out.insert("parent".into(), json!(place.parent));
        out.insert("milestone".into(), if place.milestone.is_empty() { Value::Null } else { json!(place.milestone) });
        out.insert("ref".into(), json!(format!("orrery-{}: {id}", self.handle().await?.to_lowercase())));
        out.insert("full_id".into(), json!(format!("{id}-{}", row.uid)));
        Ok(Value::Object(out))
    }
}

fn id_or_title(record: &Map<String, Value>) -> (String, String) {
    let get = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    (get("id"), get("title"))
}

/// The status ids a status's id or kind stands for; several, comma-separated, stand for all of theirs (`statusIds`).
fn status_ids(statuses: &[Status], sent: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for one in sent.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let found: Vec<String> = if statuses.iter().any(|s| s.id == one) {
            vec![one.to_string()]
        } else {
            let kind = KINDS[1..].iter().find(|k| **k == one).copied().or_else(|| LEGACY_KINDS.iter().find(|(old, _)| *old == one).map(|(_, kind)| *kind));
            kind.map(|kind| statuses.iter().filter(|s| s.kind == kind).map(|s| s.id.clone()).collect()).unwrap_or_default()
        };
        for id in found {
            if !out.contains(&id) {
                out.push(id)
            }
        }
    }
    out
}

/// What building each issue reads from: the board's rows, and what `readBoard` gathered about them.
struct Context<'a> {
    rules: &'a Rules<'a>,
    children: &'a HashMap<Option<String>, Vec<&'a IssueRow>>,
    extras: &'a Extras,
}

/// What `readBoard` gathers about the issues besides their rows.
struct Extras {
    comments: HashMap<String, i64>,
    waiting: HashMap<String, String>,
    closed: HashSet<String>,
    links: Links,
    risks: HashMap<String, Value>,
    aliases: HashMap<String, Vec<String>>,
}

/// Where an issue sits on the board (`Issues::place`).
struct Place {
    parent: Option<String>,
    /// Whether its parent is a proposal, so a pending proposal under it doesn't wait on the owner.
    parent_proposal: bool,
    milestone: String,
    /// Whether a proposal is above it, so it's in the proposed column.
    proposed: bool,
}

fn issue_rows(rows: Vec<AnyRow>) -> Vec<IssueRow> {
    rows.into_iter()
        .map(|row| IssueRow {
            id: row.get("id"),
            parent: row.get("parent"),
            milestone: row.get("milestone"),
            status: row.get("status"),
            proposal: row.get("proposal"),
            owned: row.get::<i64, _>("owned") != 0,
            row,
        })
        .collect()
}

/// ` AND column IN (?, …)` for `ids`, or nothing for the whole project.
fn within(column: &str, ids: Option<&[String]>) -> String {
    match ids {
        Some([]) => " AND 1 = 0".into(),
        Some(ids) => format!(" AND {column} IN ({})", vec!["?"; ids.len()].join(", ")),
        None => String::new(),
    }
}

/// The query with the project bound, then `ids`, as `within` asks.
fn scoped<'q>(query: &'q str, project: &'q str, ids: Option<&'q [String]>) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>> {
    let mut asked = sqlx::query(query).bind(project);
    for id in ids.into_iter().flatten() {
        asked = asked.bind(id.as_str());
    }
    asked
}

/// A milestone on the board from its row and its issues (`buildBoard`, `milestoneRecord`), rolled up from them.
pub(crate) fn milestone_group(project: &str, m: &AnyRow, rules: &Rules, aliases: &HashMap<String, Vec<String>>, tasks: Vec<Node>) -> Group {
    let id: String = m.get("id");
    let text = |key: &str| m.get::<Option<String>, _>(key);
    let mut fields = Map::new();
    fields.insert("id".into(), json!(id));
    fields.insert("title".into(), json!(text("title").unwrap_or_default()));
    if let Some(summary) = text("summary").filter(|s| !s.is_empty()) {
        fields.insert("summary".into(), json!(summary));
    }
    if let Some(priority) = text("priority") {
        fields.insert("priority".into(), json!(priority));
    }
    fields.insert("aliases".into(), json!(aliases.get(&id).cloned().unwrap_or_default()));
    fields.insert("created_by".into(), json!(text("created_by").unwrap_or_default()));
    fields.insert("protected".into(), json!(m.get::<i64, _>("owned") != 0));
    fields.insert("project".into(), json!(project));
    fields.insert("position".into(), json!(m.get::<i64, _>("position")));
    fields.insert("created_at".into(), json!(text("created_at").unwrap_or_default()));
    fields.insert("updated_at".into(), json!(text("updated_at").unwrap_or_default()));
    rules.roll_up(&mut fields, &tasks);
    Group { id, fields, tasks }
}

impl Context<'_> {
    /// The issue as the board has it (`input`, then `Rules.issue`): `proposed` when it's under a proposal.
    fn issue(&self, issue: &IssueRow, proposed: bool) -> Node {
        let proposed = proposed || issue.proposal.is_some();
        let tasks: Vec<Node> = self.children.get(&Some(issue.id.clone())).into_iter().flatten().map(|t| self.issue(t, proposed)).collect();
        let (mut counts, mut kinds) = (Map::new(), [0; 6]);
        for task in &tasks {
            sum(&mut counts, &mut kinds, task);
        }
        if tasks.is_empty() {
            let column = if proposed {
                "proposed".to_string()
            } else if self.rules.known(&issue.status) {
                issue.status.clone()
            } else {
                self.rules.first("backlog")
            };
            kinds[kind_at(&self.rules.kind_of(&column))] = 1;
            counts.insert(column, json!(1));
        }
        let column = self.rules.column_of(&counts, &kinds);
        let row = &issue.row;
        let text = |key: &str| row.get::<Option<String>, _>(key);
        let parsed = |key: &str| text(key).and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let mut f = Map::new();
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                f.insert(key.into(), value);
            }
        };
        put("id", Some(json!(issue.id)));
        put("title", text("title").map(Value::from));
        put("priority", text("priority").map(Value::from));
        put("assignee", text("assignee").map(Value::from));
        put("labels", Some(parsed("labels").unwrap_or(json!([]))));
        put("status", Some(json!(issue.status)));
        put("notes", text("notes").map(Value::from));
        put("proposal", issue.proposal.clone().map(Value::from));
        put("decided_by", text("decided_by").map(Value::from));
        put("decided_at", text("decided_at").map(Value::from));
        put("decision_note", text("decision_note").map(Value::from));
        put("picks", parsed("picks").filter(|_| text("picks").is_some_and(|t| !t.is_empty())));
        put("explore", parsed("explore").filter(|_| text("explore").is_some_and(|t| !t.is_empty())));
        put("waiting", if self.extras.closed.contains(&issue.status) { None } else { self.extras.waiting.get(&issue.id).map(|w| json!(w)) });
        put("schedule", row.get::<Option<i64>, _>("schedule").map(Value::from));
        put("release", text("ships_in").map(Value::from));
        put("epic", row.get::<Option<i64>, _>("epic").filter(|e| *e != 0).map(Value::from));
        put("model", text("model").filter(|m| !m.is_empty()).map(Value::from));
        put("effort", text("effort").filter(|e| !e.is_empty()).map(Value::from));
        put("session_name", text("session_name").filter(|s| !s.is_empty()).map(Value::from));
        if let Some(claimed) = text("claimed_by").filter(|c| !c.is_empty()) {
            put("claimed_by", Some(json!(claimed)));
            put("claimed_at", text("claimed_at").filter(|c| !c.is_empty()).map(Value::from));
        }
        put("depends_on", self.extras.links.depends_on.get(&issue.id).map(|l| json!(l)));
        put("blocked_by", self.extras.links.blocked_by.get(&issue.id).map(|l| json!(l)));
        put("blocks", self.extras.links.blocks.get(&issue.id).map(|l| json!(l)));
        put("risk", self.extras.risks.get(&issue.id).cloned());
        put("external", Some(parsed("external").unwrap_or(json!([]))));
        put("github_issues", Some(parsed("github_issues").unwrap_or(json!([]))));
        put("choices", Some(parsed("choices").unwrap_or(json!([]))));
        put("comments", Some(json!(self.extras.comments.get(&issue.id).copied().unwrap_or(0))));
        put("aliases", Some(json!(self.extras.aliases.get(&issue.id).cloned().unwrap_or_default())));
        put("created_by", Some(json!(text("created_by").unwrap_or_default())));
        put("protected", Some(json!(issue.owned)));
        put("created_at", Some(json!(text("created_at").unwrap_or_default())));
        put("updated_at", Some(json!(text("updated_at").unwrap_or_default())));
        put("kind", Some(json!(self.rules.kind_of(&column))));
        put("column", Some(json!(column)));
        put("counts", Some(Value::Object(counts.clone())));
        put("kinds", Some(kinds_json(&kinds)));
        Node { fields: f, counts, kinds, tasks }
    }
}

#[cfg(test)]
#[path = "issues_tests.rs"]
mod tests;
