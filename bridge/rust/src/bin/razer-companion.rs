#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = razer_hid_helper::cli::parse(
        &std::env::args().skip(1).collect::<Vec<_>>(),
        std::env::var("UI_ORIGIN").ok().as_deref(),
    )?;
    razer_hid_helper::cli::run(options).await
}
