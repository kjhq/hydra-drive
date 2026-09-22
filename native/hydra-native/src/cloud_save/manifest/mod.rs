mod cache;
mod indexer;
mod lookup;
mod rules;
mod source;
pub(crate) mod types;

use std::path::Path;

use napi::bindgen_prelude::Error;
use napi_derive::napi;

pub use types::{GameSaveRules, GetSaveRulesForGameInput};

#[napi]
pub async fn get_save_rules_for_game(
    input: GetSaveRulesForGameInput,
) -> napi::Result<GameSaveRules> {
    let source_url = source::resolve_source_url(input.source_url);
    let index = cache::get_manifest_index(Path::new(&input.user_data_path), &source_url)
        .await
        .map_err(|error| Error::from_reason(format!("{error:#}")))?;
    let entry = lookup::find_manifest_entry(
        &index,
        &input.object_id,
        input.remote_id.as_deref(),
        input.title.as_deref(),
    );

    Ok(rules::build_game_save_rules(
        input.shop,
        input.object_id,
        entry,
    ))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::indexer::build_manifest_index;
    use std::path::Path;

    // Representative save and config rules from the public read-only manifest.
    // Network availability is qualified separately; path and parser tests must
    // not share a reqwest connection pool across separate Tokio test runtimes.
    pub const MANIFEST: &str = r#"
"2379780":
  files:
    <winAppData>/Balatro:
      tags: [save]
      when: [{os: windows, store: steam}]
    <winAppData>/Balatro/settings.jkr:
      tags: [config]
      when: [{os: windows}]
"#;

    pub fn seed_cache(directory: &Path, source_url: &str) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let index = build_manifest_index(MANIFEST, source_url, now).unwrap();
        std::fs::write(
            directory.join("cloud-save-manifest-index.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
    }
}
