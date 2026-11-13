// How `numbered` reads SQL for Postgres (ORR-1166).
use super::numbered;

#[test]
fn numbers_each_placeholder_in_turn() {
    assert_eq!(numbered("SELECT a FROM t WHERE b = ? AND c IN (?, ?)"), "SELECT a FROM t WHERE b = $1 AND c IN ($2, $3)");
}

#[test]
fn leaves_a_question_mark_in_text_alone() {
    assert_eq!(numbered("SELECT 'why?', ? FROM t WHERE d = 'it''s ?'"), "SELECT 'why?', $1 FROM t WHERE d = 'it''s ?'");
}

#[test]
fn leaves_a_question_mark_in_a_quoted_name_alone() {
    assert_eq!(numbered("SELECT \"what?\" FROM t WHERE a = ?"), "SELECT \"what?\" FROM t WHERE a = $1");
}

#[test]
fn leaves_a_question_mark_in_a_comment_alone() {
    assert_eq!(numbered("SELECT a -- is it?\nFROM t WHERE b = ?"), "SELECT a -- is it?\nFROM t WHERE b = $1");
    assert_eq!(numbered("SELECT /* is it? */ a FROM t WHERE b = ?"), "SELECT /* is it? */ a FROM t WHERE b = $1");
}

#[test]
fn an_apostrophe_in_a_comment_doesnt_open_text() {
    assert_eq!(numbered("SELECT a -- the owner's\nFROM t WHERE b = ?"), "SELECT a -- the owner's\nFROM t WHERE b = $1");
    assert_eq!(numbered("SELECT /* don't */ a WHERE b = ?"), "SELECT /* don't */ a WHERE b = $1");
}

#[test]
fn a_minus_sign_isnt_a_comment() {
    assert_eq!(numbered("SELECT a - ? FROM t"), "SELECT a - $1 FROM t");
}
