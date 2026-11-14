use super::*;

#[test]
fn hashes_as_the_store_does() {
    assert_eq!(hash_of("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

#[test]
fn holds_keys_to_a_person() {
    let session = Actor { name: "agent".into(), owner: false, session: Some("s".into()), ..Default::default() };
    let owner = Actor { name: "Steffen".into(), owner: true, session: None, ..Default::default() };
    let browser = Who { person: "ada".into(), owner: false, browser: true, workspace: None };
    let agent = Who { person: "steffen".into(), owner: true, browser: false, workspace: None };
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

// The first person to sign in through the provider on an orrery nobody is on yet becomes its owner (ORR-1185).
#[tokio::test]
async fn the_first_account_in_owns_an_empty_orrery_and_the_next_needs_an_invite() {
    let api = crate::testing::TestApi::new().await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    let mut people = People::new(&mut conn);
    assert_eq!(people.identity("https://id.example", "sub-1", None, Some("Ada Lovelace")).await.unwrap().as_deref(), Some("ada_lovelace"));
    assert_eq!(people.owner().await.unwrap()["display"], "Ada Lovelace");
    assert_eq!(people.identity("https://id.example", "sub-1", None, None).await.unwrap().as_deref(), Some("ada_lovelace"));
    assert_eq!(people.identity("https://id.example", "sub-2", None, Some("Bo")).await.unwrap(), None);
    let member: Option<String> = sqlx::query("SELECT role FROM workspace_members WHERE workspace = 'default' AND person = 'ada_lovelace'")
        .fetch_optional(&mut *people.conn)
        .await
        .unwrap()
        .map(|r| r.get("role"));
    assert_eq!(member.as_deref(), Some("owner"));
}

#[tokio::test]
async fn the_first_owner_is_owner_when_the_provider_gives_no_usable_name() {
    let api = crate::testing::TestApi::new().await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    let mut people = People::new(&mut conn);
    assert_eq!(people.identity("https://id.example", "sub-1", None, Some("claude")).await.unwrap().as_deref(), Some("owner"));
    assert_eq!(people.owner().await.unwrap()["display"], "Owner");
}

#[tokio::test]
async fn an_orrery_someone_is_on_lets_no_stranger_in() {
    let api = crate::testing::TestApi::new().await;
    api.owner().await;
    let mut conn = api.app.pool.acquire().await.unwrap();
    assert_eq!(People::new(&mut conn).identity("https://id.example", "sub-1", None, Some("Mallory")).await.unwrap(), None);
}
