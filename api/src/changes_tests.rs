// A write's transaction when its request is cut off (ORR-1164).
use crate::testing::TestApi;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn a_write_cut_off_inside_its_transaction_doesnt_hold_up_the_next() {
    let api = TestApi::new().await;
    let project = api.project("Primes").await;
    // A write that begins, then never finishes: its request's future is dropped, as when the router gives up on it.
    let pool = api.app.pool.clone();
    let cut_off = tokio::time::timeout(Duration::from_millis(50), async move {
        let mut conn = pool.acquire().await.unwrap();
        super::begin(&mut conn).await.unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    assert!(cut_off.is_err(), "the write was cut off");
    for title in ["One", "Two", "Three", "Four", "Five"] {
        let reply = api.post(&format!("/api/projects/{project}/docs"), json!({"title": title})).send().await;
        assert_eq!(reply.status, 201, "{title}: {:?}", reply.body);
    }
}
