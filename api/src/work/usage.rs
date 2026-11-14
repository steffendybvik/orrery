// The owner's feature counts (ORR-1089): what web/server/utils/usage.ts does with `feature_use`, a `(feature, day,
// count)` row a day. Counting stays in the Nuxt server's memory (`countUse`); once a minute it sends what gathered here
// (`keep`), so this API is the table's one writer. Reading them for App settings' Usage (`list`) and forgetting them
// (`forget`) are here too. Whether the server lets anyone count (`ORRERY_USAGE`) is the Nuxt server's setting, which
// the router adds to the read.
use crate::db::sql;
use crate::error::{ApiError, Result};
use crate::text::natural_cmp;
use crate::work::settings::Settings;
use chrono::{Duration, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use sqlx::{AnyConnection, Row};
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// How long a day's count is kept.
const KEEP_DAYS: i64 = 365;

/// `FEATURES` in web/shared/usage.ts, copied to api/features.json by web/test/rust-features.test.ts.
static FEATURES: LazyLock<Map<String, Value>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../features.json")).expect("api/features.json is the listed features"));
/// `FEATURE_NAME`: a listed one, or a page's, tool's or dialog's, short and plain.
static FEATURE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((page|tool|dialog):[a-z0-9_-]{1,80}|[a-z0-9-]{1,40})$").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

/// The day `days` before today, `YYYY-MM-DD` in UTC (`daysBefore`).
fn days_before(days: i64) -> String {
    (Utc::now() - Duration::days(days)).format("%Y-%m-%d").to_string()
}

pub(crate) struct Usage<'c> {
    conn: &'c mut AnyConnection,
}

impl<'c> Usage<'c> {
    pub fn new(conn: &'c mut AnyConnection) -> Self {
        Usage { conn }
    }

    /// `{on, features}`: the owner's switch (`count_use`) and each feature counted or listed, its last use and its uses
    /// over 30 and 90 days, coldest first (`featureUse`).
    pub(crate) async fn list(&mut self) -> Result<Value> {
        let on = Settings::new(self.conn).get().await?["count_use"].clone();
        let rows = sqlx::query(&sql("SELECT feature, MAX(day) AS last, CAST(SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS BIGINT) AS days30, \
             CAST(SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS BIGINT) AS days90 FROM feature_use GROUP BY feature"))
        .bind(days_before(30))
        .bind(days_before(90))
        .fetch_all(&mut *self.conn)
        .await?;
        let mut by_name: BTreeMap<String, (Option<String>, i64, i64)> = BTreeMap::new();
        for row in &rows {
            by_name.insert(
                row.get("feature"),
                (row.get("last"), row.get::<Option<i64>, _>("days30").unwrap_or(0), row.get::<Option<i64>, _>("days90").unwrap_or(0)),
            );
        }
        let mut names: Vec<String> = FEATURES.keys().cloned().collect();
        names.extend(by_name.keys().filter(|name| !FEATURES.contains_key(*name)).cloned());
        let mut features: Vec<(String, String, Option<String>, i64, i64)> = names
            .into_iter()
            .map(|feature| {
                let label = match FEATURES.get(&feature).and_then(Value::as_str) {
                    Some(label) => label.to_string(),
                    None => ["page:", "tool:", "dialog:"].iter().find_map(|p| feature.strip_prefix(p)).unwrap_or(&feature).to_string(),
                };
                let (last, days30, days90) = by_name.get(&feature).cloned().unwrap_or((None, 0, 0));
                (feature, label, last, days30, days90)
            })
            .collect();
        features
            .sort_by(|a, b| a.4.cmp(&b.4).then_with(|| a.2.as_deref().unwrap_or("").cmp(b.2.as_deref().unwrap_or(""))).then_with(|| natural_cmp(&a.1, &b.1)));
        let features: Vec<Value> = features
            .into_iter()
            .map(|(feature, label, last, days30, days90)| json!({"feature": feature, "label": label, "last": last, "days30": days30, "days90": days90}))
            .collect();
        Ok(json!({"on": on, "features": features}))
    }

    /// What the Nuxt server gathered (`flushUse`): `{counts: [{feature, day, count}]}`, each added to its day's row, and
    /// rows over a year old dropped. A name that isn't one is refused, as `countUse` never gathers one. While the owner
    /// has counting off (`count_use`), what was sent is dropped, not kept, so the Nuxt server needn't read the setting.
    pub(crate) async fn keep(&mut self, body: &Value) -> Result<()> {
        let Some(counts) = body.get("counts").and_then(Value::as_array) else {
            return Err(ApiError::bad_request("Send the counts as {\"counts\": [{\"feature\", \"day\", \"count\"}]}"));
        };
        let mut kept = Vec::new();
        for count in counts {
            let feature = count.get("feature").and_then(Value::as_str).filter(|f| FEATURE_NAME.is_match(f));
            let day = count.get("day").and_then(Value::as_str).filter(|d| DAY.is_match(d));
            let n = count.get("count").and_then(Value::as_i64).filter(|n| *n >= 1);
            match (feature, day, n) {
                (Some(feature), Some(day), Some(n)) => kept.push((feature.to_string(), day.to_string(), n)),
                _ => return Err(ApiError::bad_request(format!("Each count is {{\"feature\", \"day\": \"YYYY-MM-DD\", \"count\": 1 or more}}, not {count}"))),
            }
        }
        if Settings::new(self.conn).get().await?["count_use"] != Value::Bool(true) {
            return Ok(());
        }
        for (feature, day, n) in kept {
            sqlx::query(&sql("INSERT INTO feature_use (feature, day, count) VALUES (?, ?, ?) ON CONFLICT (feature, day) DO UPDATE SET count = feature_use.count + excluded.count"))
                .bind(feature)
                .bind(day)
                .bind(n)
                .execute(&mut *self.conn)
                .await?;
        }
        sqlx::query(&sql("DELETE FROM feature_use WHERE day < ?")).bind(days_before(KEEP_DAYS)).execute(&mut *self.conn).await?;
        Ok(())
    }

    /// Forgets every count (`forgetUse`).
    pub(crate) async fn forget(&mut self) -> Result<()> {
        sqlx::query("DELETE FROM feature_use").execute(&mut *self.conn).await?;
        Ok(())
    }
}
