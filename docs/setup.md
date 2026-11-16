# Run Peripheral Workbench

Requires Node.js 24.x and npm. The tested toolchain is Node 24.19.0 and Rust 1.100.0; `rust-toolchain.toml` pins Rust for local builds and CI. Rust builds also require Visual Studio C++ Build Tools with the Windows SDK. The default native transport requires the inspected Synapse 4.0.896 installation at `C:\Program Files\Razer\RazerAppEngine\app-4.0.896`. It uses the installed Electron runtime and `node-rz-hid` module without modifying them. The optional Rust transport below opens HID directly. The companion runs on the Windows computer with the device attached; the browser connects to it directly.

## Start locally

From the cloned repository directory:

```powershell
npm ci
npm start
```

The launcher reuses this app on port 8787 and a companion paired to `http://127.0.0.1:8787`, or starts the missing services. It opens the browser after both are ready. Keep its terminal open; Ctrl+C stops the process trees it started. A conflicting app or different companion origin produces a port-specific error. Services that were already running remain independently managed.

For separate terminals, use `npm run dev -- --ip 127.0.0.1` and:

```powershell
npm run bridge -- --origin http://127.0.0.1:8787
```

The default bridge origin is `http://127.0.0.1:8787`; `UI_ORIGIN` remains supported. CLI `--origin` takes precedence. The page displays and copies the exact command for its current origin. Browser JavaScript cannot start a Windows process: if the companion is unreachable, run that command locally. If it is running, check the browser's local network permission. No token entry is needed.

## Continuous checks

The Windows workflow in `.github/workflows/ci.yml` separates core, browser and offline hardware checks. Install locked npm/Cargo dependencies and Chromium before running these gates. From PowerShell 7.5 or newer:

```powershell
./scripts/ci.ps1 -Suite core
./scripts/ci.ps1 -Suite browser
./scripts/ci.ps1 -Suite hardware
```

Each run needs a new output directory; use `-Output` when repeating a suite. Receipts include source hashes and command exit codes, and failed runs retain their logs. The browser suite includes two-tab macro storage and the large backup picker checks. Hardware tests use synthetic data and local HTTP fixtures.

The workflow provisions tools, then uses `scripts/ci-network.ps1` only on GitHub-hosted Windows runners. It verifies direct TCP access before the policy, denies it during the project gates while keeping loopback available, then restores the original firewall policy and verifies access again. DNS and runner control traffic remain allowed; this is not a fully disconnected VM. Local commands above use `ci.ps1` without changing the host firewall. Advisory and dependency-license reports run separately with network access using checksum-pinned cargo-deny 0.20.2. Those reports do not settle application ownership or select its license.

Hosted acceptance and three expected-failure refusal cases are recorded in [the M1 manifest](quality/m1-validation.json). The `main` branch requires Windows core, browser, hardware and dependency checks, strict and including administrators. [PR #1](https://github.com/nhan-zunika01/peripheral-workbench/pull/1) was merged into `main` at `52cd1a063334d08180f8b555fbb62c23f081771f`; the [main CI run](https://github.com/nhan-zunika01/peripheral-workbench/actions/runs/43913838429) passed all four jobs. The refusal cases live on a separate test branch and cannot satisfy those positive checks.

## Discovery and selection

The companion enumerates every attached Razer VID `1532` HID interface and Windows present PnP nodes identified by the Razer USB/Bluetooth vendor ID or Razer name. USB, Bluetooth and audio endpoints are included when Windows exposes that identity. Container IDs group interfaces belonging to one physical device; missing identifiers stay separate rather than guessing which unit owns them. Some virtual, unbranded, or disconnected endpoints cannot be identified as Razer devices by Windows.

Select a device from **Attached devices**. Discovery covers products beyond the Viper, but settings adapters currently cover only the inspected Viper V3 Pro SE `1532:00DE`/`00DF`. Other products show the exact unsupported reason and receive no device commands. This is not full Synapse feature parity.

Every read and Apply carries the selected stable identity. The companion rechecks attachment and constrains native access to that device's interface paths. If it disappears, selection remains disconnected and never falls back to a second identical mouse. Switching devices or discarding ordinary drafts requires confirmation. Background polling preserves edits. Checks run every 10 seconds while the tab is visible and serialize with writes.

Tabs requesting the same device share an in-progress read. Reads wait for an active operation to finish; a simultaneous second Apply is rejected so an explicit write is never silently queued.

## Editing and review

Production companions are read-only during M0. Settings remain visible, but hardware Apply is disabled. The review and write-verification flows described below are exercised by synthetic tests; they are not approval to enable physical writes. Update the local checkout and restart older companions after upgrading the website.

The hosted transport also blocks Apply before pairing or fetching, and copies every setting as read-only even if an older companion advertises write access. Reload existing tabs to load this transport. Deployment cannot change JavaScript already running in a tab or replace a local companion process.

Edit a setting, choose **Review change**, then inspect its physical destination, before value and draft on **Review changes**. Applying the review sends operations sequentially and records each result separately. The browser supplies `expectedValue`; the bridge compares it with its fresh snapshot immediately before dispatch. A changed value returns `409 STATE_CONFLICT` for explicit re-review. Older three-field API callers remain compatible. This software check is not a device-side atomic transaction.

Successful operations are not replayed when another operation fails. A timeout retains the draft and blocks another batch until recovery. **Read device again** preserves the draft; compare the actual value before accepting it. When no independent getter or device is available, explicitly setting the attempt aside records an unresolved outcome without retrying it. Hardware readback and command acknowledgement have distinct result labels. Review history and hardware drafts belong to this page session.

## Macros, profiles and reference layouts

**Macros** edits data-only browser drafts: create, rename, delete, and edit ordered keyboard, mouse and standalone delay events. Import/export uses the app's version-1 JSON format, not Synapse's native macro format. Limits are 100 macros, 500 events per macro, 60,000 ms per delay and a 32,000,000-byte import. The file picker and parser use the same byte limit. A backup can include the full library, including escaped Unicode. Launch, shell commands and unsupported event shapes are rejected. Import never executes events.

Use the library search to choose a macro, then select an event in the center sequence and edit its fields in Event details. Insert adds an event; Move up/down changes order without changing values. Arrow Up/Down selects an event and Alt+Arrow Up/Down moves it. Duplicate creates an independent macro with a new identity. The phone library picker can be opened or closed with its summary, and background device reads do not close menus or replace the local editor.

After upgrading, reload all tabs at the same origin before editing; older loaded pages do not participate in the new Web Lock.

One tab holds permission to autosave drafts to localStorage for the current browser and origin, using an exclusive Web Lock. Other tabs show a read-only library and receive saved updates. Close the editing tab, then use the permission retry control in another tab; it reloads the saved library before editing. Export JSON to keep a backup or move drafts to another browser/origin.

Without Web Locks, edits remain in memory and must be exported. A failed storage write keeps the draft in memory and leaves the previous stored library intact; Save retries the write. An unreadable or corrupt store is never overwritten. The status message distinguishes these conditions from saved data. Recording, playback, input injection, device assignment and onboard macro storage are unavailable until a verified runtime/adapter exists.

Export keeps an unsaved draft protected even if the download fails or is cancelled. When retrying editing access with such a draft, the app asks before replacing it with the saved browser library. Confirm only after keeping the backup you need. The replacement happens after receiving the lock and reading valid storage; a failed read keeps the draft. Updates from another tab preserve search focus and do not replace unrelated settings controls.

Valid name and delay edits update the draft while typing, without waiting for blur. Invalid input shows an error and does not write an invalid library. If reading storage failed and later recovers, retry checks storage again; an unsaved draft still requires the replacement decision above.

**Profiles** exposes only runtime-provided controls and distinguishes host from onboard storage. **Device families** includes a labelled keyboard reference and other family capability references. These do not add devices to inventory or enable unsupported controls. No host profile engine or additional hardware adapter is implied.

## Deploy the interface

Current deployment: [peripheral.zhkxt.id.vn](https://peripheral.zhkxt.id.vn), deployed from source commit `835f439` using Wrangler. All 23 public asset hashes matched the tested source. M1 has not been deployed. GitHub automatic deployment is not connected: the current OAuth lacks Workers Builds access and dashboard access could not be verified by the browser tool. The steps below describe the remaining connection; they are not a claim that it is configured.

```powershell
npm test
npm run build
npx wrangler login
npm run deploy
```

The repository configures `peripheral.zhkxt.id.vn` as the Worker custom domain. Its DNS zone must be active in the deploying Cloudflare account. Wrangler manages the hostname and certificate through the [custom domain configuration](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

For deployment from GitHub, connect `nhan-zunika01/peripheral-workbench` in Workers Builds, select `main`, keep the repository root, and set build command `npm run build` and deploy command `npm run deploy`. Authorize the Cloudflare GitHub App for this repository. [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) documents the required connection and permissions. A successful local Wrangler deployment does not establish this GitHub connection.

For the configured domain, start the local companion with:

```powershell
npm run bridge -- --origin https://peripheral.zhkxt.id.vn
```

Run `npm run bridge -- --origin https://YOUR-WORKER.workers.dev` with the exact HTTPS origin printed by deployment, without a trailing slash. Open that same HTTPS origin. The companion accepts one configured origin; `localhost` and `127.0.0.1` are different origins.

No hardware token or USB device access is configured in Cloudflare. Keep the companion console private and stop it with Ctrl+C when finished. The service binds to `127.0.0.1:17321` only.

## Connection problems

- Use a current Chromium browser with local network permission support. If connection is blocked, allow local network access in the browser’s site settings and reconnect.
- Confirm that `UI_ORIGIN` matches the address bar, including scheme and port.
- Restart the companion after a transport timeout; the page automatically obtains its new token and reconnects.
- An unavailable backend or unsupported setting is an error, never a successful device change.

## Native transport and verification

The companion supports the inspected Razer Viper V3 Pro SE wired/dongle IDs `1532:00DE` and `1532:00DF`. It discovers HID interface 0, probes it with the firmware getter, and uses the inspected Synapse 90-byte feature protocol. Close Synapse while using direct hardware controls to prevent concurrent access.

Historical read-only checks observed firmware `1.0`, DPI `1600 × 1600`, five DPI stages, polling `1000 Hz`, battery `35%`, sleep `300 seconds`, and low-power threshold `30%`. The interface uses current snapshots rather than these example readings. Independent controls cover current DPI, stages, polling, sleep and low-power threshold; these writes require a successful response and matching getter readback.

Native controls also implement rotation, dynamic sensitivity modes/custom curves, and asymmetric/smart tracking where the firmware getters succeed. Smart tracking has command acknowledgement only and says so explicitly; it does not claim an independent mode readback. Firmware can reject advanced commands on unsupported versions. Unsupported commands appear under **Unavailable controls**.

## Experimental Rust HID transport

The Rust helper implements HID access, packet framing and response validation. The setting adapter remains JavaScript and HTTP remains Node. Native is still the default; there is no automatic transport fallback or write retry.

With Rust and the matching Windows build tools installed:

```powershell
cargo test --locked --manifest-path bridge/rust/Cargo.toml
cargo build --locked --release --manifest-path bridge/rust/Cargo.toml
$env:RAZER_TRANSPORT = 'rust'
$env:RAZER_RUST_HELPER = (Resolve-Path bridge/rust/target/release/razer-hid-helper.exe).Path
npm run bridge -- --origin http://127.0.0.1:8787
```

This workspace includes the locally verified executable in the ignored `bridge/rust/target/release/` directory. A new checkout must build it. It uses Windows system DLLs and does not need a Rust runtime DLL or Synapse. Invalid transport names or a missing helper fail explicitly.

Rust publishes non-writable schemas and reports its experimental status. M0 ignores the former `RAZER_RUST_ALLOW_WRITES` opt-in, and the production helper rejects `--allow-writes`. To select the native transport again, set `$env:RAZER_TRANSPORT = 'native'` and restart the companion.

The 2026-11-02 sequential read-only comparison matched the selected physical device, 14 setting schemas/values and 250 curve samples on one Viper V3 Pro SE. See `tests/fixtures/rust-read-only-parity.json`. This does not verify setters, reconnect, two identical units, every model, or performance improvements.

## Experimental standalone Rust companion

The standalone companion serves the browser API directly from Rust. Build only its production binary:

```powershell
cargo build --release --locked --manifest-path bridge/rust/Cargo.toml --bin razer-companion
Remove-Item Env:SYNAPSE_INSPECTOR_URL -ErrorAction SilentlyContinue
.\bridge\rust\target\release\razer-companion.exe --origin http://127.0.0.1:8787
```

Starting this command permits device discovery and read-only inspection from the connected page. The Rust companion rejects `SYNAPSE_INSPECTOR_URL` before binding or opening a device. Its HTTP runtime does not need Node, PowerShell or Synapse. The npm commands use the shared selector described below.

The executable defaults to read-only. M0 rejects an effective `--allow-writes` request before opening hardware or session resources because no model, firmware and setting combination has approved evidence. `--read-only` overrides that flag, and recovery always stays read-only. Pairing returns backend and write-mode headers; the browser obtains the session token automatically. Keep the exact configured origin and port `17321` free before starting.

Stop with Ctrl+C and wait for the process to exit. If an unclean shutdown leaves a session guard, ordinary Rust and legacy startup refuse it. Use explicit `--recover-read-only --origin <exact-origin>` to audit the old processes. Open the configured page and request fresh state for the affected device. Recovery prints that state to its console for inspection. Press Ctrl+C after inspecting it to record an observation. Stopping before a qualifying read or after a failed observation keeps the guard. Acknowledgement is a separate explicit recovery action. See the [task 4 handoff](evidence/rust-companion-2026-11-09/task-4-handoff.md) for the process audit limits and unresolved acknowledgement conditions.

The `contract-server` Cargo test target and `lifecycle-fixture` binary are test tools. Do not include them in the runtime package. Offline HTTP and fake-device tests do not establish physical setter parity.

### Selecting the companion with npm

Both `npm start` and `npm run bridge -- --origin <exact-origin>` use `scripts/bridge.mjs`. Legacy remains the default until the separate G3 gate. `RAZER_TRANSPORT` continues to select only the legacy HID transport.

To select the experimental Rust companion for inspection:

```powershell
$env:RAZER_COMPANION_BACKEND = 'rust'
$env:RAZER_COMPANION_EXE = (Resolve-Path bridge/rust/target/release/razer-companion.exe).Path
$env:RAZER_COMPANION_WRITES = '0'
Remove-Item Env:SYNAPSE_INSPECTOR_URL -ErrorAction SilentlyContinue
npm run bridge -- --origin http://127.0.0.1:8787
```

Use an absolute executable path. A missing executable or invalid selector stops startup. Pairing must match the exact origin and requested backend before the launcher can reuse a companion. Production reuse also requires an explicit read-only marker. Older legacy listeners without that marker and writable Rust listeners are rejected. Stop a conflicting process yourself. A reused process stays outside this launcher's shutdown ownership.

Rust remains read-only. With the Rust backend selected, `RAZER_COMPANION_WRITES=1` is rejected before the launcher probes or starts an executable, including an older installed binary. `RAZER_COMPANION_WRITES=0` explicitly requests `--read-only`. Direct Rust CLI `--allow-writes` requests are rejected by the production binary. The older `RAZER_RUST_ALLOW_WRITES` variable cannot enable legacy writes. To return to legacy, set `RAZER_COMPANION_BACKEND=legacy` and restart.

Keep the launcher terminal open. Ctrl+C sends the owned Rust process a shutdown frame through its private inherited pipe. Rust stops accepting work and drains active operations. If it has not exited after 90 seconds, the launcher terminates its owned process tree; the retained session guard requires explicit recovery. Direct executable use still stops with Ctrl+C.

### Building and copying a portable folder

Install the public Rust MSVC toolchain and Visual Studio C++ Build Tools with the Windows SDK. Run the locked production build in a Developer PowerShell:

```powershell
rustc -vV
cargo --version
cargo fetch --locked --manifest-path bridge/rust/Cargo.toml
cargo build --offline --locked --release --manifest-path bridge/rust/Cargo.toml --bin razer-companion
```

Copy `razer-companion.exe` with its dependency license notices into the portable folder. Keep test tools out of that folder. Run it directly from that folder:

```powershell
.\razer-companion.exe --origin http://127.0.0.1:8787
```

Record the compiler target, Cargo.lock hash, executable hash and PE imports for the copied build. Dependency inspection applies to that exact binary. Windows system libraries, the CRT and a compatible Windows installation remain runtime dependencies. No installer or service is supplied. See the [M0 baseline](quality/baseline.md) for the toolchain and cache limits of this session.

### Candidate browser and launcher checks

Set `UI_SCHEMA_FIXTURE` to an absolute JSON snapshot exported by the Rust Cargo test server's adapter command. Use `UI_OUTPUT` and `QA_OUTPUT` for new or empty output directories. Both scripts refuse nonempty override directories, including files left by an interrupted run. `QA_SOURCE_ROOT` points to the isolated source; `UI_URL` points to an owned Wrangler dev server on a free port. All companion responses in these browser checks are mocked.

The separate launcher check uses the exact executable returned by `cargo test --test contract-server --no-run --message-format=json`:

```powershell
node scripts/verify-companion-launcher.mjs --candidate-test-server <absolute-Cargo-test-executable>
```

It checks both launcher callers against Rust fake HTTP. Future promoted defaults must produce writable fake schemas and one fake apply. A read-only override must produce non-writable schemas and zero applies. Child ownership in this harness is synthetic; it does not start the production companion or grant hardware write permission.

## Synapse session mode

The reconstructed session adapter remains in the source for research, but the multi-device companion disables its controls when `SYNAPSE_INSPECTOR_URL` is set. The loaded Synapse product page has not been proven to identify a selected physical unit. This prevents directing a selected device's change at a different identical unit. Remove `SYNAPSE_INSPECTOR_URL` from the terminal environment and restart the companion to use native controls. No Synapse restart is required by this companion.

## Verification limits

No setting writes were performed during development verification. Setters and middleware event payloads were reconstructed from inspected source and remain untested against live hardware. The real device and real Synapse reducers were read. Full session Apply confirmation was exercised with a mock Inspector, not a physical setting change.

Tests use explicitly fake backends and an Inspector mock to exercise validation, authentication, serialization, framing, mapping invariants and receipt handling. They do not perform hardware writes.

### Hardware evidence gates

Task 7 adds `scripts/verify-companion-hardware.ps1`. Running it without an operation prints usage and exits before connecting. It requires PowerShell 7.5 or newer. Run the offline assertions with `pwsh -NoProfile -File tests/support/hardware-gates-check.ps1`. The complete Windows gate check is `node --test tests/companion-hardware-check.mjs`; it includes the PowerShell assertions and actual HTTP fixture. Run it separately from `npm test`, whose Node-only prerequisites are preserved.

Live reads require separate approval. Prepare a `companion-source` receipt using the JSON recipe below. It pins the executable and each runtime source file by SHA256. It also pins the expected device ID with its public identity and firmware. For legacy, pin the direct `bridge/server.mjs` entrypoint. Use a directly launched helper and its PID. The script verifies the listener owner against that process generation. It checks the process image and exact launch arguments, then rechecks the hashes before requests. Historical source receipts are local evidence and are excluded from the public repository. A live operation still requires a device pin and approval.

After read-only approval, capture legacy first. Stop and wait for that helper before starting standalone Rust in its default read-only mode. Use a new absolute output path for each invocation:

```powershell
pwsh -NoProfile -File scripts/verify-companion-hardware.ps1 -ReadOnly -SourceReceipt $legacyPin -Output $legacyRead -CompanionPid $legacyPid -Origin $approvedOrigin
pwsh -NoProfile -File scripts/verify-companion-hardware.ps1 -ReadOnly -SourceReceipt $rustPin -CompareReceipt $legacyRead -Output $rustRead -CompanionPid $rustPid -Origin $approvedOrigin
```

G1 checks every Rust schema is non-writable and compares the complete snapshots after copying only each matching legacy `writable` field. Other metadata and values must match, including getter errors and the 250 curve samples when available. The result pins the compared legacy receipt path and SHA256, along with its source pin. Reconnect, port changes and two identical units need their own physical observations. Missing equipment remains unverified.

G2 starts with DPI only, after approval of the exact requested JSON and restoration. Change both DPI axes by exactly 100 within the current schema. Save the read-only baseline. Restart the same pinned Rust build with `--allow-writes`, then invoke `-Setting dpi -RequestedValue $approvedDpiJson -BaselineReceipt $rustRead` with the pin, new PID and a new output path. The operation sends `expectedValue`, then checks a separate getter. Restoration is another explicit invocation using `-Restore` and the apply receipt as `-BaselineReceipt`. An unknown result stops the attempt. Timeouts and disconnects are treated as unknown. Do not retry or automatically restore it; obtain a fresh read and a separate decision on any concrete restoration.

The Task 7 evidence files record G1/G2 as not run and G3 as blocked. Other setters, curve side effects and ACK-only smart-tracking recovery still need setting-specific approval and accepted evidence. Legacy remains the default and Rust writes remain disabled by default. A subset of setter receipts cannot establish full parity. Promotion requires a separate review and approval.

For rollback, stop Rust. Wait for it to exit. A remaining guard requires the documented explicit recovery protocol and process audit before clearing. A write-risk guard also requires observation of the affected device. An unresolved acknowledgement needs separate approval. Select `RAZER_COMPANION_BACKEND=legacy` after the protocol clears the guard. Do not replay settings.

M0 blocks G2 because production binaries reject write mode. The G2 steps above describe a future lab procedure after an evidence policy is implemented; they cannot be run against this candidate to enable writes.

File hashes describe the files currently on disk. They do not prove which module bytes an already-running Node process loaded. A hardware lab must start legacy from a reviewed immutable snapshot and record its startup before treating a receipt as evidence tied to that source. M0 offline tests do not establish this binding.

#### Preparing the operation pin

Use an independently saved state JSON from an approved inspection of the intended device. The following creates the Rust operation pin from that state and an independently reviewed `companion-build` receipt. `$approvedSnapshotPath`, `$buildReceiptPath` and `$rustPin` are absolute paths chosen for the approved session; `$rustPin` must not exist. This does not connect to a helper or grant permission to run it.

```powershell
$state = Get-Content -LiteralPath $approvedSnapshotPath -Raw | ConvertFrom-Json -AsHashtable
$build = Get-Content -LiteralPath $buildReceiptPath -Raw | ConvertFrom-Json -AsHashtable
$files = $build.files
$device = @($state.devices | Where-Object { $_.id -ceq $state.selectedDeviceId })
$firmware = @($state.settings | Where-Object { $_.id -ceq 'firmware' })
if ($device.Count -ne 1 -or $firmware.Count -ne 1) { throw 'Selected identity or firmware missing' }
$pin = @{format=1;kind='companion-source';backend='rust';binary=$build.binary;files=$files;buildReceipt=@{path=$buildReceiptPath;sha256=(Get-FileHash -LiteralPath $buildReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()};device=@{id=$device[0].id;identity=$device[0];firmware=$firmware[0].value}}
$stream = [IO.File]::Open($rustPin,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $bytes=[Text.Encoding]::UTF8.GetBytes(($pin | ConvertTo-Json -Depth 64)); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
```

The pin contains `format=1` and `kind=companion-source`. Its `backend` is `rust` or `legacy`. Both `binary` and `buildReceipt` contain an absolute `path` and lowercase 64-character SHA256. The `files` array must exactly match the complete reviewed build manifest. The `device` object contains a 24-character ID, complete public `identity` and JSON `firmware` value. IDs use 24 lowercase hexadecimal characters. Paths are absolute. A `companion-build` receipt has `format=1`, `kind=companion-build`, the same backend and binary, and the complete `files` array. Review that manifest and its expected hash before preparing the device pin. Keep every runtime source input in the manifest. The retained build snapshot is for audit; `files` points to the actual source whose hashes must still match.

A legacy pin uses the same device fields and `backend='legacy'`. Its `binary` pins the actual Node executable. Its reviewed build manifest covers the bridge modules and applicable native artifacts. `entrypoint` is the absolute pinned `bridge/server.mjs` path. Start it directly with that Node path and entrypoint, followed by `--origin` and the exact approved origin. Start Rust directly with the pinned executable, `--origin` and the same origin; add `--allow-writes` only for the separately approved DPI invocation. Other launch argument shapes fail closed. The script validates the source hashes and process/listener binding again during the operation.

The script writes a durable intent before a setter. It keeps a per-device pending journal in its fixed local application-data directory, independent of executable and receipt filenames. A successful apply still leaves the journal pending until explicit restoration succeeds. Moving the executable or changing an output or source-receipt filename does not clear it. Preserve the journal and attempt receipts after an unknown result. The script never clears an unresolved journal automatically. After a separately approved fresh read, an unknown DPI attempt can be reconciled only by an explicit restore command using both receipts.

For an unknown DPI result, retain its receipt and pending journal. If the verifier died after dispatch and left its result empty, retain that file too; the durable intent can be the baseline receipt for explicit reconciliation. Obtain separate approval for a fresh read on the same pinned device and build. Capture that read in read-only mode. Review its values against the original intent and obtain approval of the concrete restoration before restarting the same helper with writes enabled. Then use a new output path:

```powershell
pwsh -NoProfile -File scripts/verify-companion-hardware.ps1 -Setting dpi -Restore -BaselineReceipt $unknownAttempt -ObservedReceipt $freshRead -SourceReceipt $rustPin -Output $reconciliationResult -CompanionPid $rustPid -Origin $approvedOrigin
```

For a process crash, use the preserved intent JSON as `$unknownAttempt`. The global journal must contain that exact intent path and its pre-dispatch SHA256. A missing journal or mismatched intent stays blocked. This restores only the original intent's DPI baseline. It checks the current observation against the separately captured fresh read, then verifies the restore through an independent getter and checks the original side effects. It preserves the unknown receipt. A mismatch or another unknown result leaves the journal blocking further setters. Do not delete journal files to bypass that block.
A reconciliation read must be captured while the same attempt is pending. Its receipt carries that attempt's identity and intent hash; a pre-apply read cannot qualify. Keep the separately captured observation with the original attempt evidence. The restore command refuses a stale observation before sending a setter.

Each operation holds an exclusive per-device verifier lease through receipt finalization. A second verifier cannot capture an observation while an attempt is active. The kernel releases this lease if the verifier dies. It proves only that the previous verifier released its handle. Hardware worker ownership and any unclean companion guard still require the companion's normal transaction and recovery protocol before a fresh observation can qualify.
