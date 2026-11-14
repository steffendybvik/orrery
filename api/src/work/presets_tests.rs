use super::*;

#[test]
fn ids() {
    assert_eq!(preset_id("12", "x7k2m9qd").unwrap(), 12);
    assert_eq!(preset_id("pst-12-x7k2m9qd", "x7k2m9qd").unwrap(), 12);
    assert!(preset_id("pst-12-aaaaaaaa", "x7k2m9qd").is_err());
    assert!(preset_id("abc", "x7k2m9qd").is_err() && preset_id("1.5", "").is_err());
}

#[test]
fn shipped() {
    assert!(SHIPPED.iter().any(|d| d.key == "release"), "the presets orrery ships are read");
}

#[test]
fn input() {
    assert!(check_input(&json!({"name": "A", "text": "B", "icon": null, "color": "rose"}), false).is_ok());
    let refused = |body: Value, partial: bool| check_input(&body, partial).err().map(|e| e.message).unwrap_or_default();
    assert_eq!(refused(json!({"name": "A"}), false), "missing \"text\"");
    assert_eq!(refused(json!({"name": " "}), true), "\"name\" can't be empty");
    assert_eq!(refused(json!({"icon": "Bad Icon"}), true), "\"icon\" is \"Bad Icon\"; use a Heroicon's name, e.g. shield-check");
    assert_eq!(refused(json!({"text": null, "x": 1}), true), "2 problems in the body");
}
