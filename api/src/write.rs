// What every write shares (ORR-1046): who is asking (`Actor`), what the write changed for the router to tell
// (`Effects`, `Told`), and the two helpers each store uses for its rows, `stamp` and `js`.
use serde_json::Value;

/// Who a request is, as the Nuxt server's `actorOf` worked it out: its name, whether it's the owner, and the session's
/// name, which are all a doc keeps; and, for the rails between people (ORR-927, as the store's `Actor` has them), the
/// member acting themselves (`person`), who it says it works for (`named`), whether it came from a request (`asked`),
/// and whether it's an untrusted session or the owner's chat.
#[derive(Clone, Debug, Default)]
pub struct Actor {
    pub name: String,
    pub owner: bool,
    pub session: Option<String>,
    pub person: Option<String>,
    pub named: Option<String>,
    pub asked: bool,
    pub untrusted: bool,
    pub chat: bool,
}

/// What a write changed, for the Nuxt server to tell: the projects (`changed`), whether the orrery's settings did, as
/// the statuses are in them (`settings`, ORR-926), and each event (`tell`).
#[derive(Default, Debug)]
pub struct Effects {
    pub changed: Vec<String>,
    pub settings: bool,
    pub told: Vec<Told>,
    /// The settings sent in a change (ORR-954), for the router's note in the event log.
    pub settings_keys: Vec<String>,
    /// Whether the epics changed (ORR-1004): open pages ask for them again.
    pub epics: bool,
}

/// An event a write told: its kind, project and subject, and where a value went (`from`, `to`) when one changed, as a
/// schedule's `on` matches on them (ORR-929).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Told {
    pub kind: String,
    pub project: String,
    pub subject: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl Effects {
    pub fn tell(&mut self, kind: &str, project: &str, subject: &str) {
        self.told.push(Told { kind: kind.into(), project: project.into(), subject: subject.into(), ..Told::default() })
    }

    /// Tells an event with where its value went (`issue.assignee`, `comment.asks`), as the store's `tell` does.
    pub fn tell_change(&mut self, kind: &str, project: &str, subject: &str, from: Option<&str>, to: Option<&str>) {
        self.told.push(Told { kind: kind.into(), project: project.into(), subject: subject.into(), from: from.map(Into::into), to: to.map(Into::into) })
    }
}

pub fn stamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn js(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
