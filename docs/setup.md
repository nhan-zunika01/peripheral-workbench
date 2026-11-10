# Run Peripheral Workbench

Requires Node.js 24 or newer and npm. The default native transport also requires the inspected Synapse 4.0.896 installation at `C:\Program Files\Razer\RazerAppEngine\app-4.0.896`. It uses the installed Electron runtime and `node-rz-hid` module without modifying them. The optional Rust transport below opens HID directly. The companion runs on the Windows computer with the device attached; the browser connects to it directly.

## Start locally

From the cloned repository directory:

```powershell
npm install
npm start
```

The launcher reuses this app on port 8787 and a companion paired to `http://127.0.0.1:8787`, or starts the missing services. It opens the browser after both are ready. Keep its terminal open; Ctrl+C stops the process trees it started. A conflicting app or different companion origin produces a port-specific error. Services that were already running remain independently managed.

For separate terminals, use `npm run dev -- --ip 127.0.0.1` and:

```powershell
npm run bridge -- --origin http://127.0.0.1:8787
```

The default bridge origin is `http://127.0.0.1:8787`; `UI_ORIGIN` remains supported. CLI `--origin` takes precedence. The page displays and copies the exact command for its current origin. Browser JavaScript cannot start a Windows process: if the companion is unreachable, run that command locally. If it is running, check the browser's local network permission. No token entry is needed.

## Discovery and selection

The companion enumerates every attached Razer VID `1532` HID interface and Windows present PnP nodes identified by the Razer USB/Bluetooth vendor ID or Razer name. USB, Bluetooth and audio endpoints are included when Windows exposes that identity. Container IDs group interfaces belonging to one physical device; missing identifiers stay separate rather than guessing which unit owns them. Some virtual, unbranded, or disconnected endpoints cannot be identified as Razer devices by Windows.

Select a device from **Attached devices**. Discovery covers products beyond the Viper, but settings adapters currently cover only the inspected Viper V3 Pro SE `1532:00DE`/`00DF`. Other products show the exact unsupported reason and receive no device commands. This is not full Synapse feature parity.

Every read and Apply carries the selected stable identity. The companion rechecks attachment and constrains native access to that device's interface paths. If it disappears, selection remains disconnected and never falls back to a second identical mouse. Switching devices or discarding ordinary drafts requires confirmation. Background polling preserves edits. Checks run every 10 seconds while the tab is visible and serialize with writes.

Tabs requesting the same device share an in-progress read. Reads wait for an active operation to finish; a simultaneous second Apply is rejected so an explicit write is never silently queued.

## Editing and review

Edit a setting, choose **Review change**, then inspect its physical destination, before value and draft on **Review changes**. Applying the review sends operations sequentially and records each result separately. The browser supplies `expectedValue`; the bridge compares it with its fresh snapshot immediately before dispatch. A changed value returns `409 STATE_CONFLICT` for explicit re-review. Older three-field API callers remain compatible. This software check is not a device-side atomic transaction.

Successful operations are not replayed when another operation fails. A timeout retains the draft and blocks another batch until recovery. **Read device again** preserves the draft; compare the actual value before accepting it. When no independent getter or device is available, explicitly setting the attempt aside records an unresolved outcome without retrying it. Hardware readback and command acknowledgement have distinct result labels. Review history and hardware drafts belong to this page session.

## Macros, profiles and reference layouts

**Macros** edits data-only browser drafts: create, rename, delete, and edit ordered keyboard, mouse and standalone delay events. Import/export uses the app's version-1 JSON format, not Synapse's native macro format. Limits are 100 macros, 500 events per macro, 60,000 ms per delay and a 1 MB import. Launch, shell commands and unsupported event shapes are rejected. Import never executes events.

Use the library search to choose a macro, then select an event in the center sequence and edit its fields in Event details. Insert adds an event; Move up/down changes order without changing values. Arrow Up/Down selects an event and Alt+Arrow Up/Down moves it. Duplicate creates an independent macro with a new identity. The phone library picker can be opened or closed with its summary, and background device reads do not close menus or replace the local editor.

Drafts autosave to localStorage for the current browser and origin. Save explicitly retries a failed write; an unreadable or corrupt store is never overwritten. Export JSON to move drafts to another browser/origin or keep a backup. A storage failure leaves the library in memory with a visible warning, including when no macro is selected. Recording, playback, input injection, device assignment and onboard macro storage are unavailable until a verified runtime/adapter exists.

**Profiles** exposes only runtime-provided controls and distinguishes host from onboard storage. **Device families** includes a labelled keyboard reference and other family capability references. These do not add devices to inventory or enable unsupported controls. No host profile engine or additional hardware adapter is implied.

## Deploy the interface

```powershell
npm test
npm run build
npx wrangler login
npm run deploy
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

Rust defaults to **read only**, publishes non-writable schemas and reports its experimental status. Setting writes additionally require `RAZER_RUST_ALLOW_WRITES=1`; they remain unverified on physical hardware. Keep this flag unset for inspection. To select the native transport again, set `$env:RAZER_TRANSPORT = 'native'` and restart the companion.

The 2026-11-02 sequential read-only comparison matched the selected physical device, 14 setting schemas/values and 250 curve samples on one Viper V3 Pro SE. See `tests/fixtures/rust-read-only-parity.json`. This does not verify setters, reconnect, two identical units, every model, or performance improvements.

## Experimental standalone Rust companion

The standalone companion serves the browser API directly from Rust. Build only its production binary:

```powershell
cargo build --release --locked --manifest-path bridge/rust/Cargo.toml --bin razer-companion
Remove-Item Env:SYNAPSE_INSPECTOR_URL -ErrorAction SilentlyContinue
.\bridge\rust\target\release\razer-companion.exe --origin http://127.0.0.1:8787
```

Starting this command permits device discovery and read-only inspection from the connected page. The Rust companion rejects `SYNAPSE_INSPECTOR_URL` before binding or opening a device. Its HTTP runtime does not need Node, PowerShell or Synapse. The npm commands use the shared selector described below.

The executable defaults to read-only. Do not enable `--allow-writes` until the separate hardware verification gate is approved. `--read-only` overrides that flag, and recovery always stays read-only. Pairing returns backend and write-mode headers; the browser obtains the session token automatically. Keep the exact configured origin and port `17321` free before starting.

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

Use an absolute executable path. A missing executable or invalid selector stops startup. Pairing must match the exact origin and requested backend before the launcher can reuse a companion. Rust must also match the requested write mode. Stop a conflicting process yourself. A reused process stays outside this launcher's shutdown ownership.

Rust remains read-only by default. `RAZER_COMPANION_WRITES=1` explicitly requests `--allow-writes`; use it only after the hardware write gate has been approved for the intended settings. `RAZER_COMPANION_WRITES=0` explicitly requests `--read-only`. The older `RAZER_RUST_ALLOW_WRITES` variable controls the legacy helper, and does not grant standalone Rust writes. To return to legacy, set `RAZER_COMPANION_BACKEND=legacy` and restart.

Keep the launcher terminal open. Ctrl+C sends the owned Rust process a shutdown frame through its private inherited pipe. Rust stops accepting work and drains active operations. If it has not exited after 90 seconds, the launcher terminates its owned process tree; the retained session guard requires explicit recovery. Direct executable use still stops with Ctrl+C.

### Building and copying a portable folder

Use a Rust target and matching Windows linker. For an installed MSVC toolchain, run the locked production build above in a Developer PowerShell with the Windows SDK available. This workspace also has a task-local GNU toolchain; the following uses its matching bundled linker:

```powershell
$rustBin = 'D:/Razer-agents-20261102/toolchain/rustup/toolchains/stable-x86_64-pc-windows-gnu/bin'
$env:CARGO_HOME = 'D:/Razer/.superpowers/sdd/2026-11-09-rust-companion/cargo-home'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$rustBin/../lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/x86_64-w64-mingw32-gcc.exe"
$env:RUSTFLAGS = '-C link-self-contained=yes'
& "$rustBin/rustc.exe" -vV
& "$rustBin/cargo.exe" build --offline --locked --release --manifest-path bridge/rust/Cargo.toml --bin razer-companion
```

Copy `razer-companion.exe` with its dependency license notices into the portable folder. Keep test tools out of that folder. Run it directly from that folder:

```powershell
.\razer-companion.exe --origin http://127.0.0.1:8787
```

The task 6 receipt records the compiler target, Cargo.lock hash, executable hash and PE imports. Dependency inspection applies to that exact GNU build. Windows system libraries, the CRT and a compatible Windows installation remain runtime dependencies; another target or build needs its own inspection. This task does not supply an installer or service.

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
