use razer_hid_helper::{packet, response};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    name: String,
    command: [u8; 3],
    data: Vec<u8>,
    transaction: u8,
    packet: Vec<u8>,
    response: Vec<u8>,
    result: Option<Vec<u8>>,
    error: Option<String>,
}

#[test]
fn node_golden_packets_and_responses() {
    let fixtures: Vec<Fixture> =
        serde_json::from_str(include_str!("../fixtures/protocol.json")).unwrap();
    for fixture in fixtures {
        let sent = packet(fixture.command, &fixture.data, fixture.transaction).unwrap();
        assert_eq!(sent.as_slice(), fixture.packet, "{} packet", fixture.name);
        let received = response(&fixture.response, &sent);
        if let Some(expected) = fixture.result {
            assert_eq!(received.unwrap(), expected, "{} result", fixture.name);
        } else {
            assert_eq!(
                received.unwrap_err(),
                fixture.error.unwrap(),
                "{} error",
                fixture.name
            );
        }
    }
}
