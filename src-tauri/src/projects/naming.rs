//! What a dropped thing is called once it becomes a project.
//!
//! Naming is product policy, and ARCHITECTURE.md puts policy in TypeScript —
//! but not this policy. A name is chosen *inside* the import, between "this
//! path arrived" and "this directory now exists", and the frontend never sees
//! that moment: it hands over a path and gets a project back. Routing the
//! decision across IPC would mean exposing a half-finished import and making
//! the uniqueness check race with the watcher. It stays here, on its own,
//! where its rules are readable and tested without the rest of the module.

use std::path::Path;

/// Stems that name a *file* but not a *project*. `index.html` is what a page
/// is called on disk; it says nothing about what the site is, and a folder of
/// them comes out `index`, `index-2`, `index-3` — ten projects nobody can tell
/// apart. A deliberate name (`portfolio.html`, `invoice.html`) is left alone.
const GENERIC_STEMS: &[&str] = &[
    "index", "untitled", "document", "page", "home", "default", "new", "copy", "site", "main",
    "test", "temp", "download", "file",
];

/// Colours and animals, ~500 pairs. Two lists rather than one adjective/noun
/// grab-bag because a colour is the one modifier that never accidentally
/// describes the project ("broken-otter" would read as a status).
const NAME_COLOURS: &[&str] = &[
    "amber", "azure", "cobalt", "coral", "crimson", "emerald", "indigo", "ivory", "jade", "lilac",
    "maroon", "olive", "onyx", "plum", "russet", "saffron", "scarlet", "sienna", "slate", "teal",
    "umber", "violet",
];

const NAME_ANIMALS: &[&str] = &[
    "otter", "falcon", "heron", "ibex", "jackal", "lemur", "lynx", "marlin", "narwhal", "ocelot",
    "osprey", "panther", "quokka", "raven", "tapir", "viper", "walrus", "wombat", "badger", "bison",
    "gecko", "puffin",
];

/// True for `index`, `Untitled`, `index copy`, `untitled-3`, `page 2` — the
/// shapes an OS and a browser produce when nobody named anything.
pub(super) fn is_generic_stem(stem: &str) -> bool {
    let lower = stem.trim().to_lowercase();
    // Strip what a duplicate picks up: "index copy 2", "untitled-3", "page (1)".
    let stripped = lower
        .trim_end_matches(|c: char| c.is_ascii_digit() || ['-', '_', ' ', '(', ')'].contains(&c))
        .trim_end_matches("copy")
        .trim_end_matches(['-', '_', ' ']);
    GENERIC_STEMS.contains(&stripped)
}

/// A name for a page that arrived without one, e.g. `amber-otter`.
///
/// Randomness comes from a v4 UUID's bytes — already a dependency, and this
/// does not need a real RNG. Retries on collision rather than appending a
/// number, so a second generated project is `slate-puffin` and not
/// `amber-otter-2`; falling through to the numeric path after 24 tries means a
/// pathological folder still gets a name instead of looping.
pub(super) fn generated_project_name(root: &Path) -> String {
    for _ in 0..24 {
        let bytes = uuid::Uuid::new_v4().into_bytes();
        let colour = NAME_COLOURS[bytes[0] as usize % NAME_COLOURS.len()];
        let animal = NAME_ANIMALS[bytes[1] as usize % NAME_ANIMALS.len()];
        let candidate = format!("{colour}-{animal}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    unique_project_name(root, "site")
}

/// The project name for a single dropped/copied page: its own stem when that
/// stem means something, a generated one when it doesn't.
pub(super) fn project_name_for_page(root: &Path, stem: &str) -> String {
    if is_generic_stem(stem) {
        generated_project_name(root)
    } else {
        unique_project_name(root, stem)
    }
}

/// Pick a project name that doesn't collide: "blog", "blog-2", "blog-3"…
pub(super) fn unique_project_name(root: &Path, base: &str) -> String {
    let clean = base.trim().trim_matches('.').replace(['/', '\\'], "-");
    let base = if clean.is_empty() { "project".to_string() } else { clean };
    if !root.join(&base).exists() {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("vercel-folder-projects-tests")
            .join(format!("{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unique_names_dedupe_and_sanitize() {
        let root = scratch("names");
        assert_eq!(unique_project_name(&root, "blog"), "blog");
        std::fs::create_dir(root.join("blog")).unwrap();
        assert_eq!(unique_project_name(&root, "blog"), "blog-2");
        std::fs::create_dir(root.join("blog-2")).unwrap();
        assert_eq!(unique_project_name(&root, "blog"), "blog-3");
        assert_eq!(unique_project_name(&root, "a/b"), "a-b");
        assert_eq!(unique_project_name(&root, ""), "project");
    }

    /// The whole point of the generated name: ten `index.html` files must not
    /// become ten projects called some flavour of "index".
    #[test]
    fn generic_stems_get_a_generated_name_and_real_ones_do_not() {
        for generic in ["index", "Untitled", "index copy", "untitled-3", "page (1)", "NEW", "file"]
        {
            assert!(is_generic_stem(generic), "{generic} should be generic");
        }
        for real in ["portfolio", "invoice", "acme-landing", "index-of-terms", "pagerank"] {
            assert!(!is_generic_stem(real), "{real} should be kept");
        }

        let root = scratch("generated-names");
        let a = project_name_for_page(&root, "index");
        std::fs::create_dir(root.join(&a)).unwrap();
        let b = project_name_for_page(&root, "index");

        // Two pages both called index.html get two distinct, readable names —
        // not "index" and "index-2".
        assert_ne!(a, b);
        for name in [&a, &b] {
            let (colour, animal) = name.split_once('-').expect("colour-animal");
            assert!(NAME_COLOURS.contains(&colour), "{colour} not a colour");
            assert!(NAME_ANIMALS.contains(&animal), "{animal} not an animal");
        }

        // A named page keeps its name, and still dedupes numerically.
        assert_eq!(project_name_for_page(&root, "portfolio"), "portfolio");
        std::fs::create_dir(root.join("portfolio")).unwrap();
        assert_eq!(project_name_for_page(&root, "portfolio"), "portfolio-2");
    }
}
