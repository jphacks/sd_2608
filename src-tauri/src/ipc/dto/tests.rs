use super::*;

#[test]
fn shared_contract_cases_round_trip_or_reject() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../tests/fixtures/ipc/cases.json")).unwrap();
    for case in cases {
        let input = case["value"].clone();
        macro_rules! check {
            ($ty:ty) => {{
                let result = serde_json::from_value::<$ty>(input.clone());
                assert_eq!(
                    result.is_ok(),
                    case["valid"].as_bool().unwrap(),
                    "{}",
                    case["name"]
                );
                if let Ok(decoded) = result {
                    assert_eq!(
                        serde_json::to_value(decoded).unwrap(),
                        input,
                        "{}",
                        case["name"]
                    );
                }
            }};
        }
        match case["kind"].as_str().unwrap() {
            "snapshot" => check!(ApiResult<AppSnapshot>),
            "report" => check!(ApiResult<Report>),
            "page" => check!(ApiResult<ReportPage>),
            "faceReceipt" => check!(ApiResult<FaceReceipt>),
            "respond" => check!(ApiResult<RespondReminderResult>),
            "faceInput" => check!(FaceInput),
            _ => panic!("unknown fixture"),
        }
    }
}

#[test]
fn safe_integers_reject_negative_fractional_and_unsafe_values() {
    for input in [
        json!(-1),
        json!(1.5),
        json!(MAX_SAFE_INTEGER + 1),
        json!("1"),
    ] {
        assert!(serde_json::from_value::<SafeInt>(input).is_err());
    }
    assert_eq!(
        serde_json::from_value::<SafeInt>(json!(MAX_SAFE_INTEGER))
            .unwrap()
            .get(),
        MAX_SAFE_INTEGER
    );
}

#[test]
fn debug_output_does_not_expose_keys() {
    let request: UpdateSettingsRequest = serde_json::from_value(json!({
        "requestId":"settings", "expectedSettingsRevision":0,
        "values":{"reportMode":"local","provider":null,"excludedApps":[],"reducedMotion":false},
        "keyChange":{"kind":"replace","value":"fixture-secret-never-log"}
    }))
    .unwrap();
    assert!(!format!("{request:?}").contains("fixture-secret-never-log"));
}
