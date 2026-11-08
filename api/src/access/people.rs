// Who's on this orrery and how they get in (ORR-928): the people list, the keys people make and the logins a browser
// holds, as web/server/store/people.ts and keys.ts do them, answering as web/server/api/{people,keys,logins}/ do. Turning a
// credential into a person (`credential` in web/server/utils/auth.ts) stays with the router in front, which checks every
// request before it gets here and sends what it found (`Who`), with the asking browser's login hashed: its cookie never
// leaves that server. The API has the same checks (`credential`) and logs in and out by a key (`log_in`, `log_out`), for
// when it's the front door, but the router doesn't send them here yet. An OIDC provider's accounts and a phone's sign-in
// link stay there, as they read its settings and its memory. Removing a person unassigns their open issues, so it writes what it set off to the outbox in its own
// transaction (ORR-929), as the milestones do.
use crate::changes::{self, Outbox};
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::migrate::actor_id;
use crate::text::first_chars;
use crate::write::js;
use crate::write::{stamp, Actor, Effects};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{AnyConnection, Row};

/// A credential the router checked (`Who` in web/server/utils/auth.ts): a person in a browser, or one of their agents,
/// which can never act as them. None with auth off.
#[derive(Clone, Debug)]
pub struct Who {
    pub person: String,
    pub owner: bool,
    pub browser: bool,
}

/// What the router's settings say about getting in (`Orrery-Login-Ways`), which only it can read: whether a login
/// provider is set up, and whether ORRERY_AUTH=off is.
#[derive(Clone, Debug, Default)]
pub struct Ways {
    pub provider: bool,
    pub off: bool,
    /// ORRERY_AUTH=on: a login asked for even on loopback.
    pub on: bool,
}

/// What agents and orrery send or stand for (`RESERVED`): as a person's id, each would make them all that person.
const RESERVED: [&str; 4] = ["owner", "agent", "claude", "orrery"];
const INVITE_DAYS: i64 = 7;
/// How long a login lasts (`LOGIN_DAYS`), and how often a key's or a login's use is noted (`USED_EVERY`, a minute).
pub const LOGIN_DAYS: i64 = 30;
const USED_EVERY: i64 = 60_000;

/// Who a live key is (`Holder` in web/server/store/keys.ts): its person, whether they're the owner, the key's kind and id.
#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub person: String,
    pub owner: bool,
    pub agent: bool,
    pub key: String,
}

/// Whether a use noted at `last` is older than `USED_EVERY`, so it's noted again.
fn stale(last: Option<String>) -> bool {
    let Some(last) = last.and_then(|l| chrono::DateTime::parse_from_rfc3339(&l).ok()) else { return true };
    (chrono::Utc::now() - last.with_timezone(&chrono::Utc)).num_milliseconds() > USED_EVERY
}

/// The 403 for anyone but the owner, as `authorize(event, 'people.write')` words it for a session. With login on the
/// credential has the last word: only the owner in their browser, whatever the actor says.
fn owner_only(actor: &Actor, who: Option<&Who>) -> Result<()> {
    if actor.owner && who.map_or(true, |who| who.browser && who.owner) {
        return Ok(());
    }
    Err(ApiError::refused_for(
        "people.write",
        "Add, rename, remove or invite a person: owner only for a session (people.write). Who works on this orrery is the owner’s to decide. Send Orrery-Actor: <owner>",
    ))
}

/// A person's name from a body, as `personName` takes it: `checkInput(body, OWNER_FIELDS)`, trimmed to 60.
fn person_name(body: &Value) -> Result<String> {
    let Some(sent) = body.as_object() else {
        return Err(ApiError::bad_request("The body should be a JSON object"));
    };
    let mut problems: Vec<String> = sent.keys().filter(|k| *k != "name").map(|k| format!("unknown field \"{k}\"; this takes name")).collect();
    match sent.get("name") {
        None => problems.push("missing \"name\"".into()),
        Some(Value::Null) => problems.push("\"name\" can't be null".into()),
        Some(Value::String(name)) if name.trim().is_empty() => problems.push("\"name\" can't be empty".into()),
        Some(Value::String(_)) => {}
        Some(other) => problems.push(format!("\"name\" should be a string, not {}", js(other))),
    }
    if !problems.is_empty() {
        return Err(ApiError::problems(problems));
    }
    let name = first_chars(sent["name"].as_str().unwrap_or_default().trim(), 60);
    if name.is_empty() {
        return Err(ApiError::bad_request("The name needs a letter or a digit in it"));
    }
    Ok(name)
}

fn person_json(r: &sqlx::any::AnyRow) -> Value {
    let mut person = json!({"id": r.get::<String, _>("id"), "name": r.get::<String, _>("name"), "role": r.get::<String, _>("role"), "created_at": r.get::<String, _>("created_at")});
    if let Some(at) = r.get::<Option<String>, _>("removed_at") {
        person["removed_at"] = Value::String(at);
    }
    person
}

/// How much of a login's hash names it in the list (`LOGIN_REF`): enough to tell them apart, nothing a cookie could be
/// made from.
const LOGIN_REF: usize = 16;

fn hash_of(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn random(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    getrandom::getrandom(&mut bytes).expect("the system's random numbers");
    bytes
}

/// What `String(value ?? '')` makes of a body's field.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().map(|v| js_string(Some(v))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// The 403 for a session, as `refused(row, 'session')` words keys.write and logins.write in web/shared/permissions.ts.
fn refused_for_session(row: &str) -> ApiError {
    match row {
        "keys.write" => ApiError::refused_for(
            row,
            "Make or revoke a key: owner only for a session (keys.write). A key can’t make or widen a key, so an agent can never become its person. A person handles their own, and the owner issues them to others. Send Orrery-Actor: <owner>",
        ),
        _ => ApiError::refused_for(
            row,
            "End a browser’s login: refused for a session (logins.write). A login is a browser signed in, a phone’s too (ORR-838), so a person ends their own, the owner anyone’s, from App settings: how a lost phone is shut out. Never a session, which has no login and no business with them.",
        ),
    }
}

/// The person handling keys or logins, and whether they may for others (`keyHolderOf`, `loginHolderOf` in
/// web/server/utils/key-rights.ts): a browser's person, each for themselves and the owner for everyone, and with auth off
/// the owner by name. Never a session, whatever key it has. The router has already refused the chat and an untrusted
/// session (their middleware holds them to their columns), so what's left here is a session or the owner.
pub fn holder_of(row: &str, who: Option<&Who>, actor: &Actor) -> Result<(String, bool)> {
    match who {
        Some(who) if who.browser => Ok((who.person.clone(), who.owner)),
        Some(_) => Err(refused_for_session(row)),
        None if !actor.owner => Err(refused_for_session(row)),
        None => Ok((actor.name.to_lowercase(), true)),
    }
}

fn key_of(row: &sqlx::any::AnyRow) -> Value {
    let mut key = Map::new();
    for field in ["id", "person", "kind", "name", "created_at"] {
        key.insert(field.into(), Value::String(row.get(field)));
    }
    for field in ["last_used_at", "revoked_at"] {
        if let Some(at) = row.get::<Option<String>, _>(field) {
            key.insert(field.into(), Value::String(at));
        }
    }
    Value::Object(key)
}

pub struct People<'c> {
    pub conn: &'c mut AnyConnection,
    /// What a removal set off: the projects whose issues it unassigned, and each `issue.assignee` it told.
    pub effects: Effects,
    /// Set for a removal: what it sets off goes into the outbox in its transaction (ORR-929).
    pub outbox: Option<Outbox>,
}

impl<'c> People<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        People { conn, effects: Effects::default(), outbox: None }
    }

    /// Whether the owner has a person key to log in with (`ownerHasKey`).
    pub async fn owner_has_key(&mut self) -> Result<bool> {
        let row =
            sqlx::query("SELECT 1 AS one FROM keys k JOIN people p ON p.id = k.person WHERE p.role = 'owner' AND k.kind = 'person' AND k.revoked_at IS NULL")
                .fetch_optional(&mut *self.conn)
                .await?;
        Ok(row.is_some())
    }

    /// Whose `session` is, if anyone's yet (ORR-705). Only read here: the Nuxt server claims it (`fixSessionPerson`),
    /// as `session_people`'s one writer (ORR-1010).
    pub async fn session_holder(&mut self, session: &str) -> Result<Option<String>> {
        let row = sqlx::query(&sql("SELECT person FROM session_people WHERE session = ?")).bind(session).fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|row| row.get("person")))
    }

    /// Whether auth stays on (`authStaysOn`): once a second person is here, it does for good, even after they go.
    pub async fn auth_stays_on(&mut self) -> Result<bool> {
        if sqlx::query("SELECT 1 AS one FROM settings WHERE key = 'auth_on'").fetch_optional(&mut *self.conn).await?.is_some() {
            return Ok(true);
        }
        let row = sqlx::query("SELECT count(*) AS n FROM people WHERE removed_at IS NULL").fetch_one(&mut *self.conn).await?;
        if row.get::<i64, _>("n") < 2 {
            return Ok(false);
        }
        sqlx::query("INSERT INTO settings (key, value) VALUES ('auth_on', 'true') ON CONFLICT (key) DO NOTHING").execute(&mut *self.conn).await?;
        Ok(true)
    }

    /// The owner's id, if they've given their name (`ownerOf`).
    pub async fn named_owner(&mut self) -> Result<Option<String>> {
        let row = sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_optional(&mut *self.conn).await?;
        Ok(row.map(|r| r.get::<String, _>("id")))
    }

    /// Everyone, the owner first, then in the order they were added; those removed stay listed, with `removed_at`.
    pub async fn people(&mut self) -> Result<Value> {
        let rows = sqlx::query("SELECT id, name, role, created_at, removed_at FROM people ORDER BY role = 'owner' DESC, created_at, id")
            .fetch_all(&mut *self.conn)
            .await?;
        Ok(Value::Array(rows.iter().map(person_json).collect()))
    }

    async fn person(&mut self, id: &str) -> Result<sqlx::any::AnyRow> {
        sqlx::query(&sql("SELECT id, name, role, created_at, removed_at FROM people WHERE id = ?"))
            .bind(id)
            .fetch_optional(&mut *self.conn)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("No person \"{id}\"")))
    }

    /// A second person turns login on, so without a way in that would lock the owner out (`needsWayInForPeople`).
    async fn needs_way_in(&mut self, ways: &Ways) -> Result<()> {
        if ways.off || ways.provider {
            return Ok(());
        }
        let key = "SELECT 1 FROM keys k JOIN people p ON p.id = k.person WHERE p.role = 'owner' AND k.kind = 'person' AND k.revoked_at IS NULL";
        if sqlx::query(key).fetch_optional(&mut *self.conn).await?.is_some() {
            return Ok(());
        }
        Err(ApiError::conflict("A second person turns login on, and nobody could log in yet: claim it first, with `pnpm orrery:claim` on this machine (or `docker compose exec orrery node /app/server/claim.mjs`). To only try people out on this machine, start orrery with ORRERY_AUTH=off"))
    }

    /// Adds a person, a member (`POST /api/people`): the owner's only. Their id comes from the name as the owner's does,
    /// and never changes. One a removed person had stays theirs, so history can't come to mean someone else.
    pub async fn add_person(&mut self, body: &Value, actor: &Actor, who: Option<&Who>, ways: &Ways) -> Result<Value> {
        owner_only(actor, who)?;
        self.needs_way_in(ways).await?;
        if sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_optional(&mut *self.conn).await?.is_none() {
            return Err(ApiError::bad_request("Give your own name first (PUT /api/owner): you are the first person"));
        }
        let name = person_name(body)?;
        let id = actor_id(&name);
        if id.is_empty() {
            return Err(ApiError::bad_request("The name needs a letter or a digit in it"));
        }
        if RESERVED.contains(&id.as_str()) {
            return Err(ApiError::bad_request(format!("\"{id}\" is what agents or orrery go by; pick another name")));
        }
        let taken = sqlx::query(&sql("SELECT name, removed_at FROM people WHERE id = ?")).bind(&id).fetch_optional(&mut *self.conn).await?;
        if let Some(taken) = taken {
            let what = match taken.get::<Option<String>, _>("removed_at") {
                Some(_) => "was someone who has been removed".to_string(),
                None => format!("is {}", taken.get::<String, _>("name")),
            };
            return Err(ApiError::conflict(format!("\"{id}\" {what}; pick another name")));
        }
        sqlx::query(&sql("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'member', ?)"))
            .bind(&id)
            .bind(&name)
            .bind(stamp())
            .execute(&mut *self.conn)
            .await?;
        Ok(person_json(&self.person(&id).await?))
    }

    /// Renames a member (`PATCH /api/people/:person`): the owner's only. Only the name changes, as their id stays what
    /// history holds. The owner's own goes through `PUT /api/owner`.
    pub async fn rename_person(&mut self, id: &str, body: &Value, actor: &Actor, who: Option<&Who>) -> Result<Value> {
        owner_only(actor, who)?;
        let person = self.person(id).await?;
        if person.get::<String, _>("role") == "owner" {
            return Err(ApiError::bad_request("The owner's name is changed with PUT /api/owner"));
        }
        if person.get::<Option<String>, _>("removed_at").is_some() {
            return Err(ApiError::conflict(format!("{} has been removed", person.get::<String, _>("name"))));
        }
        let name = person_name(body)?;
        let id: String = person.get("id");
        sqlx::query(&sql("UPDATE people SET name = ? WHERE id = ?")).bind(&name).bind(&id).execute(&mut *self.conn).await?;
        Ok(person_json(&self.person(&id).await?))
    }

    /// Removes a member (`DELETE /api/people/:person`, `removePerson`): the owner's only. Their name stays on history,
    /// what they held goes to the owner, their keys are revoked and their logins and invites end, and their open issues go
    /// back to unassigned, each noted and told. One already removed is left as it is.
    pub async fn remove_person(&mut self, id: &str, actor: &Actor, who: Option<&Who>) -> Result<()> {
        owner_only(actor, who)?;
        let person = self.person(id).await?;
        if person.get::<String, _>("role") == "owner" {
            return Err(ApiError::bad_request("The owner can't be removed"));
        }
        if person.get::<Option<String>, _>("removed_at").is_some() {
            return Ok(());
        }
        let id: String = person.get("id");
        let open = sqlx::query(&sql(
            "SELECT project, id, assignee FROM issues WHERE lower(assignee) = ? AND status NOT IN (SELECT id FROM statuses WHERE kind IN ('done', 'canceled'))",
        ))
        .bind(&id)
        .fetch_all(&mut *self.conn)
        .await?;
        let open: Vec<(String, String, String)> = open.iter().map(|r| (r.get("project"), r.get("id"), r.get("assignee"))).collect();
        let owner: String = sqlx::query("SELECT id FROM people WHERE role = 'owner'").fetch_one(&mut *self.conn).await?.get("id");
        changes::begin(self.conn).await?;
        let done: Result<()> = async {
            let now = stamp();
            sqlx::query(&sql("UPDATE people SET removed_at = ? WHERE id = ?")).bind(&now).bind(&id).execute(&mut *self.conn).await?;
            // What they held goes to the owner, who may already be on it.
            sqlx::query(&sql("DELETE FROM project_members WHERE person = ? AND role = 'member'")).bind(&id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM project_members WHERE person = ? AND project IN (SELECT project FROM project_members WHERE person = ?)"))
                .bind(&owner)
                .bind(&id)
                .execute(&mut *self.conn)
                .await?;
            sqlx::query(&sql("UPDATE project_members SET person = ? WHERE person = ?")).bind(&owner).bind(&id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("UPDATE keys SET revoked_at = ? WHERE person = ? AND revoked_at IS NULL")).bind(&now).bind(&id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM logins WHERE person = ?")).bind(&id).execute(&mut *self.conn).await?;
            sqlx::query(&sql("DELETE FROM invites WHERE person = ?")).bind(&id).execute(&mut *self.conn).await?;
            for (project, issue, assignee) in &open {
                sqlx::query(&sql("UPDATE issues SET assignee = NULL, updated_at = ? WHERE project = ? AND id = ?"))
                    .bind(stamp())
                    .bind(project)
                    .bind(issue)
                    .execute(&mut *self.conn)
                    .await?;
                sqlx::query(&sql(
                    "INSERT INTO issue_events (project, issue, field, \"before\", \"after\", created_by, session_name, owned, created_at) VALUES (?, ?, 'assignee', ?, NULL, ?, ?, ?, ?)",
                ))
                .bind(project)
                .bind(issue)
                .bind(assignee)
                .bind(&actor.name)
                .bind(actor.session.as_deref())
                .bind(i64::from(actor.owner))
                .bind(stamp())
                .execute(&mut *self.conn)
                .await?;
                self.effects.tell_change("issue.assignee", project, issue, Some(assignee), None);
                if !self.effects.changed.contains(project) {
                    self.effects.changed.push(project.clone());
                }
            }
            Ok(())
        }
        .await;
        changes::finish(self.conn, self.outbox.as_mut(), &self.effects, done).await
    }

    /// An invite for a person to attach their first login (`POST /api/invites`): the owner's only, and only with a login
    /// provider to log in through. A link good once and for a week, at `origin`, the address the request came to.
    pub async fn invite(&mut self, body: &Value, actor: &Actor, who: Option<&Who>, ways: &Ways, origin: &str) -> Result<Value> {
        owner_only(actor, who)?;
        if !ways.provider {
            return Err(ApiError::conflict("This orrery has no login provider to invite someone through: give them a person key instead (POST /api/keys)"));
        }
        let Some(person) = body.get("person").and_then(Value::as_str) else {
            return Err(ApiError::bad_request("\"person\" is the id of who to invite"));
        };
        self.needs_person(person).await?;
        let secret = URL_SAFE_NO_PAD.encode(random(32));
        let expires = (chrono::Utc::now() + chrono::Duration::days(INVITE_DAYS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        sqlx::query(&sql("INSERT INTO invites (id, person, expires_at) VALUES (?, ?, ?)"))
            .bind(hash_of(&secret))
            .bind(person)
            .bind(&expires)
            .execute(&mut *self.conn)
            .await?;
        Ok(json!({"url": format!("{origin}/login?invite={secret}"), "expires_at": expires}))
    }

    async fn needs_person(&mut self, id: &str) -> Result<()> {
        if sqlx::query(&sql("SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL")).bind(id).fetch_optional(&mut *self.conn).await?.is_none() {
            return Err(ApiError::not_found(format!("No person \"{id}\"")));
        }
        Ok(())
    }

    /// The keys of `person`, or everyone's, the newest first; a revoked one stays listed. Never the key itself.
    pub async fn keys(&mut self, person: Option<&str>) -> Result<Value> {
        let text = format!(
            "SELECT id, person, kind, name, created_at, last_used_at, revoked_at FROM keys{} ORDER BY created_at DESC, id",
            if person.is_some() { " WHERE person = ?" } else { "" }
        );
        let text = sql(&text);
        let mut query = sqlx::query(&text);
        if let Some(person) = person {
            query = query.bind(person);
        }
        Ok(Value::Array(query.fetch_all(&mut *self.conn).await?.iter().map(key_of).collect()))
    }

    /// Makes a key for `whose` (`POST /api/keys`): a person their own, and the owner anyone's. This is the only time its
    /// secret is seen. The prefix says its kind, so the channel can refuse a person key before sending it anywhere.
    pub async fn make_key(&mut self, body: &Value, person: &str, owner: bool) -> Result<Value> {
        let whose = body.get("person").and_then(Value::as_str).unwrap_or(person).to_string();
        if whose != person && !owner {
            return Err(ApiError::refused_for("keys.write", "A person makes their own keys; only the owner gives them to others"));
        }
        let kind = match body.get("kind").and_then(Value::as_str) {
            Some(kind @ ("agent" | "person")) => kind.to_string(),
            _ => return Err(ApiError::bad_request("\"kind\" is \"agent\", for a machine's sessions, or \"person\", to sign in to the page")),
        };
        let label = first_chars(js_string(body.get("name")).trim(), 60);
        if label.is_empty() {
            return Err(ApiError::bad_request("\"name\" says what the key is for, such as the machine it's on"));
        }
        self.needs_person(&whose).await?;
        let key = format!("orrery_{kind}_{}", URL_SAFE_NO_PAD.encode(random(32)));
        let id: String = random(6).iter().map(|b| format!("{b:02x}")).collect();
        let created = stamp();
        sqlx::query(&sql("INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"))
            .bind(&id)
            .bind(&whose)
            .bind(&kind)
            .bind(&label)
            .bind(hash_of(&key))
            .bind(&created)
            .execute(&mut *self.conn)
            .await?;
        Ok(json!({"id": id, "person": whose, "kind": kind, "name": label, "created_at": created, "key": key}))
    }

    /// Revokes a key, at once, with the logins it started (ORR-786), and its person's logins from before orrery kept which
    /// key started one; revoking it again changes nothing. `mine`, when given, is whose it has to be.
    pub async fn revoke_key(&mut self, id: &str, mine: Option<&str>) -> Result<()> {
        let row = sqlx::query(&sql("SELECT person, revoked_at FROM keys WHERE id = ?")).bind(id).fetch_optional(&mut *self.conn).await?;
        let Some(row) = row.filter(|r| mine.map_or(true, |mine| r.get::<String, _>("person") == mine)) else {
            return Err(ApiError::not_found(format!("No key \"{id}\"")));
        };
        if row.get::<Option<String>, _>("revoked_at").is_some() {
            return Ok(());
        }
        let person: String = row.get("person");
        sqlx::query(if crate::db::on_postgres() { "BEGIN" } else { "BEGIN IMMEDIATE" }).execute(&mut *self.conn).await?;
        let done = self.revoke(id, &person).await;
        match done {
            Ok(()) => {
                sqlx::query("COMMIT").execute(&mut *self.conn).await?;
                Ok(())
            }
            Err(error) => {
                sqlx::query("ROLLBACK").execute(&mut *self.conn).await.ok();
                Err(error)
            }
        }
    }

    async fn revoke(&mut self, id: &str, person: &str) -> Result<()> {
        sqlx::query(&sql("UPDATE keys SET revoked_at = ? WHERE id = ?")).bind(stamp()).bind(id).execute(&mut *self.conn).await?;
        sqlx::query(&sql("DELETE FROM logins WHERE by_key = ? OR person = ? AND known = 0")).bind(id).bind(person).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// The live logins of `person`, or everyone's, the latest used first (ORR-838); `mine` is the asking browser's login,
    /// hashed, to mark it `current`.
    pub async fn logins(&mut self, person: Option<&str>, mine: Option<&str>) -> Result<Value> {
        let text = format!(
            "SELECT id, person, name, created_at, last_used_at, expires_at FROM logins WHERE expires_at > ?{} ORDER BY COALESCE(last_used_at, created_at, '') DESC, id",
            if person.is_some() { " AND person = ?" } else { "" }
        );
        let text = sql(&text);
        let mut query = sqlx::query(&text).bind(stamp());
        if let Some(person) = person {
            query = query.bind(person);
        }
        let rows = query.fetch_all(&mut *self.conn).await?;
        Ok(Value::Array(
            rows.iter()
                .map(|r| {
                    let id: String = r.get("id");
                    let mut login = Map::new();
                    login.insert("id".into(), Value::String(id.chars().take(LOGIN_REF).collect()));
                    login.insert("person".into(), Value::String(r.get("person")));
                    for field in ["name", "created_at", "last_used_at"] {
                        if let Some(value) = r.get::<Option<String>, _>(field).filter(|v| !v.is_empty()) {
                            login.insert(field.into(), Value::String(value));
                        }
                    }
                    login.insert("expires_at".into(), Value::String(r.get("expires_at")));
                    if mine == Some(id.as_str()) {
                        login.insert("current".into(), Value::Bool(true));
                    }
                    Value::Object(login)
                })
                .collect(),
        ))
    }

    /// Who a key is, if it's live and its person is still here (`keyHolder`), noting its use at most once a minute.
    pub async fn key_holder(&mut self, secret: &str) -> Result<Option<Holder>> {
        self.key_hash_holder(&hash_of(secret)).await
    }

    /// Who a key is, by its hash as the keys table keeps it: the router sends a bearer hashed (`Orrery-Key`), so the key
    /// itself stays with it.
    async fn key_hash_holder(&mut self, hash: &str) -> Result<Option<Holder>> {
        let row = sqlx::query(&sql("SELECT k.id, k.kind, k.person, p.role, k.last_used_at FROM keys k JOIN people p ON p.id = k.person \
             WHERE k.hash = ? AND k.revoked_at IS NULL AND p.removed_at IS NULL"))
        .bind(hash)
        .fetch_optional(&mut *self.conn)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let id: String = row.get("id");
        if stale(row.get("last_used_at")) {
            sqlx::query(&sql("UPDATE keys SET last_used_at = ? WHERE id = ?")).bind(stamp()).bind(&id).execute(&mut *self.conn).await?;
        }
        Ok(Some(Holder { person: row.get("person"), owner: row.get::<String, _>("role") == "owner", agent: row.get::<String, _>("kind") == "agent", key: id }))
    }

    /// Starts a browser's login for `person` (`startLogin`): the secret for its cookie. `key` is the id of the key it was
    /// started with, so revoking that ends it; `name` says how it was made, for the list (ORR-838).
    pub async fn start_login(&mut self, person: &str, key: Option<&str>, name: Option<&str>) -> Result<String> {
        let secret = URL_SAFE_NO_PAD.encode(random(32));
        let now = stamp();
        let expires = (chrono::Utc::now() + chrono::Duration::days(LOGIN_DAYS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        sqlx::query(&sql("DELETE FROM logins WHERE expires_at < ?")).bind(&now).execute(&mut *self.conn).await?;
        sqlx::query(&sql("INSERT INTO logins (id, person, expires_at, by_key, known, name, created_at, last_used_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)"))
            .bind(hash_of(&secret))
            .bind(person)
            .bind(&expires)
            .bind(key.map(str::to_owned))
            .bind(name.map(str::to_owned))
            .bind(&now)
            .bind(&now)
            .execute(&mut *self.conn)
            .await?;
        Ok(secret)
    }

    /// Who a login is, by its cookie hashed as the logins table keeps it (`loginHolder`), if it hasn't run out and
    /// they're still here: a person in a browser. The router sends the cookie hashed (`Orrery-Login`).
    async fn login_holder(&mut self, id: &str) -> Result<Option<Who>> {
        let row = sqlx::query(&sql(
            "SELECT l.person, p.role, l.last_used_at FROM logins l JOIN people p ON p.id = l.person WHERE l.id = ? AND l.expires_at > ? AND p.removed_at IS NULL",
        ))
        .bind(id)
        .bind(stamp())
        .fetch_optional(&mut *self.conn)
        .await?;
        let Some(row) = row else { return Ok(None) };
        if stale(row.get("last_used_at")) {
            sqlx::query(&sql("UPDATE logins SET last_used_at = ? WHERE id = ?")).bind(stamp()).bind(id).execute(&mut *self.conn).await?;
        }
        Ok(Some(Who { person: row.get("person"), owner: row.get::<String, _>("role") == "owner", browser: true }))
    }

    /// Who a request's credential says it is (`credential` in web/server/utils/auth.ts), from its bearer's hash and its
    /// login cookie's, as the router sends them. A bearer is an agent key only: a person key is swapped for a cookie at
    /// login, so nothing with a key in its environment can act as a person.
    pub async fn credential(&mut self, bearer: Option<&str>, login: Option<&str>) -> Result<Option<Who>> {
        if let Some(key) = bearer {
            return Ok(self.key_hash_holder(key).await?.filter(|h| h.agent).map(|h| Who { person: h.person, owner: h.owner, browser: false }));
        }
        match login {
            Some(login) => self.login_holder(login).await,
            None => Ok(None),
        }
    }

    /// Swaps a person key for a login (`POST /api/auth/login`): the person, and the secret for the cookie. An agent key
    /// can't sign in, so an agent can't become its person.
    pub async fn log_in(&mut self, body: &Value) -> Result<(String, String)> {
        let holder = match body.get("key").and_then(Value::as_str) {
            Some(key) => self.key_holder(key.trim()).await?,
            None => None,
        };
        let Some(holder) = holder.filter(|h| !h.agent) else {
            return Err(ApiError::unauthorized("That isn't a person key on this orrery, or it's been revoked"));
        };
        let secret = self.start_login(&holder.person, Some(&holder.key), None).await?;
        Ok((holder.person, secret))
    }

    /// The person an account is, by its issuer and subject and never its email (`identity` in web/server/store/keys.ts).
    /// With `invite`, an account orrery doesn't know yet attaches to the invited person, using the invite up, in one step
    /// so it can't be used twice. An account a removed person had moves to the invited person (ORR-787); one that
    /// belongs to someone here never does.
    pub async fn identity(&mut self, issuer: &str, subject: &str, invite: Option<&str>) -> Result<Option<String>> {
        let known = sqlx::query(&sql(
            "SELECT i.person FROM identities i JOIN people p ON p.id = i.person WHERE i.issuer = ? AND i.subject = ? AND p.removed_at IS NULL",
        ))
        .bind(issuer)
        .bind(subject)
        .fetch_optional(&mut *self.conn)
        .await?;
        if let Some(row) = known {
            return Ok(Some(row.get("person")));
        }
        let Some(invite) = invite else { return Ok(None) };
        sqlx::query(if crate::db::on_postgres() { "BEGIN" } else { "BEGIN IMMEDIATE" }).execute(&mut *self.conn).await?;
        let done = self.attach(issuer, subject, invite).await;
        match done {
            Ok(person) => {
                sqlx::query("COMMIT").execute(&mut *self.conn).await?;
                Ok(Some(person))
            }
            Err(error) => {
                sqlx::query("ROLLBACK").execute(&mut *self.conn).await.ok();
                Err(error)
            }
        }
    }

    async fn attach(&mut self, issuer: &str, subject: &str, invite: &str) -> Result<String> {
        let gone = || ApiError::conflict("That invite has been used or has run out: ask for a new one");
        let now = stamp();
        let used = sqlx::query(&sql("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?"))
            .bind(&now)
            .bind(hash_of(invite))
            .bind(&now)
            .execute(&mut *self.conn)
            .await?;
        if used.rows_affected() == 0 {
            return Err(gone());
        }
        let row = sqlx::query(&sql("SELECT person FROM invites WHERE id = ?")).bind(hash_of(invite)).fetch_optional(&mut *self.conn).await?;
        let person: String = row.ok_or_else(gone)?.get("person");
        let attached = sqlx::query(&sql(
            "INSERT INTO identities (issuer, subject, person) VALUES (?, ?, ?) ON CONFLICT (issuer, subject) DO UPDATE SET person = excluded.person \
             WHERE identities.person IN (SELECT id FROM people WHERE removed_at IS NOT NULL)",
        ))
        .bind(issuer)
        .bind(subject)
        .bind(&person)
        .execute(&mut *self.conn)
        .await?;
        if attached.rows_affected() == 0 {
            return Err(ApiError::conflict("That account already belongs to someone here"));
        }
        Ok(person)
    }

    /// Ends a browser's login by its cookie's secret (`endLogin`), on the server as well as its cookie.
    pub async fn log_out(&mut self, secret: &str) -> Result<()> {
        sqlx::query(&sql("DELETE FROM logins WHERE id = ?")).bind(hash_of(secret)).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Ends a login by its listed id, at once: `mine`, when given, is whose it has to be.
    pub async fn end_login(&mut self, reference: &str, mine: Option<&str>) -> Result<()> {
        let listed = reference.len() == LOGIN_REF && reference.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        let row = if listed {
            sqlx::query(&sql(&format!("SELECT id, person FROM logins WHERE substr(id, 1, {LOGIN_REF}) = ?")))
                .bind(reference)
                .fetch_optional(&mut *self.conn)
                .await?
        } else {
            None
        };
        let Some(row) = row.filter(|r| mine.map_or(true, |mine| r.get::<String, _>("person") == mine)) else {
            return Err(ApiError::not_found(format!("No login \"{reference}\"")));
        };
        sqlx::query(&sql("DELETE FROM logins WHERE id = ?")).bind(row.get::<String, _>("id")).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Ends every login of `person`, or everyone's, but the asking browser's (`keep`, hashed): what a lost phone calls
    /// for. How many ended.
    pub async fn end_other_logins(&mut self, person: Option<&str>, keep: Option<&str>) -> Result<Value> {
        let only = if person.is_some() { " AND person = ?" } else { "" };
        let keep = keep.unwrap_or("");
        let count = sql(&format!("SELECT CAST(count(*) AS BIGINT) AS n FROM logins WHERE id <> ?{only}"));
        let mut query = sqlx::query(&count).bind(keep);
        if let Some(person) = person {
            query = query.bind(person);
        }
        let ended: i64 = query.fetch_one(&mut *self.conn).await?.get("n");
        let delete = sql(&format!("DELETE FROM logins WHERE id <> ?{only}"));
        let mut query = sqlx::query(&delete).bind(keep);
        if let Some(person) = person {
            query = query.bind(person);
        }
        query.execute(&mut *self.conn).await?;
        Ok(json!({"ended": ended}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_as_the_store_does() {
        assert_eq!(hash_of("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn holds_keys_to_a_person() {
        let session = Actor { name: "agent".into(), owner: false, session: Some("s".into()), ..Default::default() };
        let owner = Actor { name: "Steffen".into(), owner: true, session: None, ..Default::default() };
        let browser = Who { person: "ada".into(), owner: false, browser: true };
        let agent = Who { person: "steffen".into(), owner: true, browser: false };
        assert_eq!(holder_of("keys.write", Some(&browser), &session).unwrap(), ("ada".into(), false));
        assert_eq!(holder_of("keys.write", None, &owner).unwrap(), ("steffen".into(), true));
        assert_eq!(holder_of("keys.write", None, &session).unwrap_err().status.as_u16(), 403);
        assert_eq!(holder_of("logins.write", Some(&agent), &owner).unwrap_err().status.as_u16(), 403);
    }

    #[test]
    fn reads_a_field_as_javascript_would() {
        assert_eq!(js_string(Some(&json!(12))), "12");
        assert_eq!(js_string(Some(&json!(null))), "");
        assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
    }
}
