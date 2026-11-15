# Peripheral Workbench

A browser interface and local Windows companion for Razer devices. The interface runs on a Cloudflare Worker; hardware access stays on the Windows computer connected to the device.

Device discovery covers Razer endpoints exposed by Windows. Settings adapters currently support the inspected Viper V3 Pro SE (`1532:00DE` / `1532:00DF`). Other models are detected without enabling device commands. Macros are browser-local drafts without recording or execution.

## Run locally

Install Node.js 24 or newer. The default native transport requires Synapse 4.0.896 at `C:\Program Files\Razer\RazerAppEngine\app-4.0.896` and uses its installed runtime and HID module. Those third-party files are not bundled here.

```powershell
npm ci
npm start
```

Keep the terminal open. The launcher starts the interface and companion, then opens the browser. Close Synapse before using direct hardware controls to avoid concurrent access.

[Setup and deployment](docs/setup.md) covers exact-origin pairing, the experimental Rust transport and troubleshooting. Hardware setting writes have not been verified on a physical device; automated tests use fake transports.

M0 locks production companions to read-only. Legacy write variables cannot enable setters, and Rust rejects an effective `--allow-writes` request until model, firmware and setting evidence exists. Update and restart an older companion before connecting the website. The [baseline](docs/quality/baseline.md) records validation limits; the [rights inventory](docs/legal/status.md) records the unresolved license decisions.

The hosted transport also rejects Apply and exposes read-only settings when connected to an older companion. Reload existing browser tabs after upgrading. [M0 validation](docs/quality/m0-validation.json) records the three regression rounds and cumulative checks.

## Verify

```powershell
npm test
npm run build
```

The build command is a deployment dry run. To check the optional Rust companion on Windows with Rust and the matching build tools installed:

```powershell
cargo test --locked --manifest-path bridge/rust/Cargo.toml
```

## Repository contents

The [project review](docs/audits/2026-11-13-project-audit.md), [roadmap](docs/roadmap.md), and [implementation plan](docs/superpowers/plans/2026-11-13-stability-open-source.md) document the stability, performance and open-source release work identified on 2026-11-13. These planning documents are in Vietnamese; they do not establish hardware verification or select a project license.

`public/` contains the interface, `src/` the Worker, `bridge/` the local companion, and `tests/` the automated checks and synthetic fixtures.

Local credentials, device captures, extracted Synapse files, agent data, design working copies and generated builds are excluded through `.gitignore`. Local investigation and design documents are also excluded.

This is an unofficial project and is not affiliated with, sponsored by or endorsed by Razer. Razer and Synapse names identify compatible hardware and installed software; their trademarks belong to their respective owners. See the [Razer trademark guidelines](https://www.razer.com/legal/trademark-use-guidelines). Bundled GSAP files retain their [distribution notice](public/vendor/gsap/NOTICE.txt). No project license has been selected.
