use std::io::Write;
use std::process::{Command, Stdio};

fn helper(input: &[u8], allow_writes: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_razer-hid-helper"));
    if allow_writes {
        command.arg("--allow-writes");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn malformed_requests_and_raw_writes_are_rejected_before_hid_access() {
    let output = helper(
        concat!(
            "{\"action\":\"shell\",\"command\":\"anything\"}\n",
            "{\"action\":\"exchange\",\"command\":[2,7,3],\"data\":[0,1]}\n",
            "{\"action\":\"exchange\",\"command\":[37,11,19],\"data\":[]}\n",
            "{\"action\":\"exchange\",\"command\":[1,0,133],\"data\":[],\"extra\":true}\n",
            "{\"action\":\"exchange\",\"command\":[256,0,133],\"data\":[]}\n"
        )
        .as_bytes(),
        true,
    );
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 5);
    for line in stdout.lines() {
        let value: serde_json::Value = serde_json::from_str(line).unwrap();
        assert!(value["error"].is_string());
        assert!(!value["error"]
            .as_str()
            .unwrap()
            .contains("No HID interface"));
    }
}

#[test]
fn feature_writes_require_explicit_opt_in_and_input_is_bounded() {
    let output = helper(
        b"{\"action\":\"exchange\",\"command\":[2,7,3],\"data\":[0,60]}\n",
        false,
    );
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("read-only"));
    let output = helper(&vec![b' '; 16385], false);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
