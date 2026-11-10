use crate::process::{self, Observation, ProcessIdentity, ProcessTable};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub fn claim_path(guard: &Path) -> PathBuf {
    guard.with_extension("recovery-owner.json")
}
pub fn refuse_existing(guard: &Path) -> io::Result<()> {
    match fs::symlink_metadata(claim_path(guard)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::other(
            "A recovery owner claim requires explicit read-only recovery",
        )),
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimRecord {
    owner: ProcessIdentity,
    nonce: String,
}
fn load(path: &Path) -> io::Result<Vec<ClaimRecord>> {
    let mut bytes = vec![];
    File::open(path)?.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 || bytes.last() != Some(&b'\n') {
        return Err(io::Error::other("Invalid recovery owner claim"));
    }
    let mut claims = vec![];
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        crate::JsValue::parse(line).map_err(io::Error::other)?;
        let claim: ClaimRecord = serde_json::from_slice(line).map_err(io::Error::other)?;
        claim.owner.validate()?;
        if claim.nonce.len() != 64
            || !claim
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(io::Error::other("Invalid recovery owner claim"));
        }
        if claims
            .iter()
            .any(|old: &ClaimRecord| old.nonce == claim.nonce)
        {
            return Err(io::Error::other("Duplicate recovery owner claim"));
        }
        claims.push(claim);
    }
    if claims.is_empty() || claims.len() > 64 {
        return Err(io::Error::other("Recovery owner claim bound exceeded"));
    }
    Ok(claims)
}
pub struct RecoveryOwner {
    path: PathBuf,
    record: ClaimRecord,
}
impl RecoveryOwner {
    pub fn claim(guard: &Path, table: &mut dyn ProcessTable) -> io::Result<(Self, Vec<Value>)> {
        let path = claim_path(guard);
        let mut evidence = vec![];
        let previous = match load(&path) {
            Ok(records) => records,
            Err(error) if error.kind() == io::ErrorKind::NotFound => vec![],
            Err(error) => return Err(error),
        };
        let record = ClaimRecord {
            owner: process::current()?,
            nonce: process::nonce()?,
        };
        if previous.iter().any(|prior| prior.owner == record.owner) {
            return Err(io::Error::other(
                "This process already owns the recovery claim; guard retained",
            ));
        }
        if previous.len() >= 64 {
            return Err(io::Error::other("Recovery owner claim bound exceeded"));
        }
        let mut options = OpenOptions::new();
        options.append(true);
        if previous.is_empty() {
            options.create_new(true);
        }
        let mut file = options.open(&path)?;
        let mut bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        bytes.push(b'\n');
        if file.metadata()?.len() + bytes.len() as u64 > 65536 {
            return Err(io::Error::other("Recovery owner claim bound exceeded"));
        }
        file.write_all(&bytes)?;
        file.sync_all()?;
        // The current process is durable before any prior-owner audit receipt or session mutation.
        for previous in previous.iter().rev() {
            let observation = table.observe(&previous.owner)?;
            if observation == Observation::Active {
                table.wait(&previous.owner)?;
            }
            let audit = json!({"recoveryOwner":previous.owner,"claimNonce":previous.nonce,"observation":observation,"waited":observation==Observation::Active});
            let receipt =
                guard.with_file_name(format!("recovery-owner-exit-{}.json", process::nonce()?));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(receipt)?;
            file.write_all(&serde_json::to_vec(&audit).map_err(io::Error::other)?)?;
            file.sync_all()?;
            evidence.push(audit);
        }
        Ok((Self { path, record }, evidence))
    }
    pub fn adopted(self, guard: &crate::session_guard::SessionGuard) -> io::Result<()> {
        if guard.record().parent != self.record.owner
            || load(&self.path)?
                .last()
                .is_none_or(|claim| claim.nonce != self.record.nonce)
        {
            return Err(io::Error::other("Recovery ownership changed"));
        }
        fs::remove_file(self.path)
    }
}
