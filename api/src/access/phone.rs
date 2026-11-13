// The one-time sign-in links App settings' QR code carries (ORR-837), as web/server/utils/phone-sign-in.ts keeps them:
// scanned, a phone is signed in as the owner with a login of its own. Each is good once, for a few minutes, and kept
// only in memory, hashed, so a restart ends them all. Each also has a six-letter code shown under the QR (ORR-875),
// typed where there's no camera. Using either uses up both. A few wrong codes in a row end every code still open (the
// QR links keep working), so guessing one is out of reach: at most 5 tries against 31⁶ codes per round.
//
// Written ahead of the swap (ORR-928): until the API is the front door, the Nuxt server makes and takes its own links,
// and these are never routed here. Which port a request came in on is the router's to say (`Orrery-Came: phone`).
use std::collections::HashMap;
use std::sync::Mutex;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

pub const LINK_MINUTES: i64 = 5;
pub const WRONG_CODES: u32 = 5;
const MAX: usize = 20;
/// No 0/O, 1/I/L: easy to read off a screen and type on a phone.
const LETTERS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 6;
/// The login's name in App settings' list, as web/shared/phone.ts has it, so it's ended on its own (ORR-838).
pub const PHONE_LOGIN: &str = "Phone, signed in by QR code";

struct Link {
    person: String,
    /// Milliseconds since the epoch.
    expires: i64,
    /// The code's hash, until a run of wrong codes ends it.
    code: Option<String>,
    /// The order it was made in, so the oldest go first.
    made: u64,
}

#[derive(Default)]
struct Inner {
    links: HashMap<String, Link>,
    wrong: u32,
    made: u64,
}

/// The links not yet used, in memory.
#[derive(Default)]
pub struct Links(Mutex<Inner>);

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn bytes(n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    getrandom::getrandom(&mut out).expect("the system's randomness");
    out
}

/// A letter picked evenly: a byte over the last whole multiple of the alphabet is drawn again.
fn letter() -> u8 {
    let limit = 256 - 256 % LETTERS.len();
    loop {
        let b = bytes(1)[0] as usize;
        if b < limit {
            return LETTERS[b % LETTERS.len()];
        }
    }
}

/// A code as it's typed: upper case, with spaces and dashes taken out.
fn normalize(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A new link (`makeSignInLink`).
pub struct Made {
    pub token: String,
    pub code: String,
    pub expires_at: String,
}

impl Links {
    /// A new link's token and code for `person`, and when they stop working.
    pub fn make(&self, person: &str, now: i64) -> Made {
        let mut inner = self.0.lock().unwrap();
        inner.links.retain(|_, link| link.expires > now);
        // The oldest go first, so a page left open making them can't fill memory.
        while inner.links.len() >= MAX {
            let oldest = inner.links.iter().min_by_key(|(_, l)| l.made).map(|(id, _)| id.clone());
            match oldest {
                Some(id) => inner.links.remove(&id),
                None => break,
            };
        }
        let token = URL_SAFE_NO_PAD.encode(bytes(24));
        let code = loop {
            let code: String = (0..CODE_LENGTH).map(|_| letter() as char).collect();
            let id = hash(&code);
            if !inner.links.values().any(|l| l.code.as_deref() == Some(id.as_str())) {
                break code;
            }
        };
        let expires = now + LINK_MINUTES * 60_000;
        inner.made += 1;
        let made = inner.made;
        inner.links.insert(hash(&token), Link { person: person.to_owned(), expires, code: Some(hash(&code)), made });
        Made { token, code, expires_at: iso(expires) }
    }

    /// Whose a link is, using it up: nobody's once used, expired or never made.
    pub fn take_link(&self, token: Option<&str>, now: i64) -> Option<String> {
        let token = token?;
        let shaped = (20..=64).contains(&token.len()) && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !shaped {
            return None;
        }
        let link = self.0.lock().unwrap().links.remove(&hash(token))?;
        (link.expires > now).then_some(link.person)
    }

    /// Whose a typed code is, using up its link: nobody's once used, expired or never made. Each wrong one counts, and
    /// the `WRONG_CODES`th in a row ends every code still open.
    pub fn take_code(&self, code: Option<&str>, now: i64) -> Option<String> {
        let typed = code.map(normalize).unwrap_or_default();
        let id = if typed.chars().count() == CODE_LENGTH { hash(&typed) } else { String::new() };
        let mut inner = self.0.lock().unwrap();
        let found = (!id.is_empty())
            .then(|| inner.links.iter().find(|(_, l)| l.code.as_deref() == Some(id.as_str()) && l.expires > now).map(|(k, _)| k.clone()))
            .flatten();
        if let Some(key) = found {
            inner.wrong = 0;
            return inner.links.remove(&key).map(|l| l.person);
        }
        inner.wrong += 1;
        if inner.wrong >= WRONG_CODES {
            for link in inner.links.values_mut() {
                link.code = None;
            }
            inner.wrong = 0;
        }
        None
    }
}

#[cfg(test)]
#[path = "phone_tests.rs"]
mod tests;
