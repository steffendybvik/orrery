// Who's on this orrery and how they get in (ORR-928): the people list, the keys people make and the logins a browser
// holds, as web/server/store/people.ts and keys.ts do them, answering as web/server/api/{people,keys,logins}/ do. Turning a
// credential into a person (`credential` in web/server/utils/auth.ts) stays with the router in front, which checks every
// request before it gets here and sends what it found (`Who`), with the asking browser's login hashed: its cookie never
// leaves that server. Logging in and out, an OIDC provider's accounts, invites and changing who's here stay there too,
// as they set cookies, read its settings or change issues.
use crate::db::sql;
use crate::docs::{stamp, Actor};
use crate::error::{ApiError, Result};
use crate::text::first_chars;
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
}

impl<'c> People<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        People { conn }
    }

    /// Everyone, the owner first, then in the order they were added; those removed stay listed, with `removed_at`.
    pub async fn people(&mut self) -> Result<Value> {
        let rows = sqlx::query("SELECT id, name, role, created_at, removed_at FROM people ORDER BY role = 'owner' DESC, created_at, id")
            .fetch_all(&mut *self.conn)
            .await?;
        Ok(Value::Array(
            rows.iter()
                .map(|r| {
                    let mut person = json!({"id": r.get::<String, _>("id"), "name": r.get::<String, _>("name"), "role": r.get::<String, _>("role"), "created_at": r.get::<String, _>("created_at")});
                    if let Some(at) = r.get::<Option<String>, _>("removed_at") {
                        person["removed_at"] = Value::String(at);
                    }
                    person
                })
                .collect(),
        ))
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
        let session = Actor { name: "agent".into(), owner: false, session: Some("s".into()) };
        let owner = Actor { name: "Steffen".into(), owner: true, session: None };
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
