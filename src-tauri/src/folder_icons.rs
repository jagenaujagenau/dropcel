use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use image::RgbaImage;

/// The Vercel triangle (official path), dark, for the root folder glyph.
#[cfg(test)]
const VERCEL_TRIANGLE_SVG: &[u8] =
    br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1155 1000"><path d="M577.3 0l577.4 1000H0z" fill="#1b1f23"/></svg>"##;

#[cfg(test)]
const SYSTEM_FOLDER_ICNS: &str =
    "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns";

/// Pull the best PNG representation out of an .icns (chunks: 4cc type +
/// u32 BE length incl. 8-byte header). ic10=1024 … ic07=128.
#[cfg(test)]
fn best_icns_png(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 8 || &data[0..4] != b"icns" {
        return None;
    }
    let rank = |t: &[u8]| match t {
        b"ic10" => Some(0u8),
        b"ic09" => Some(1),
        b"ic14" => Some(2),
        b"ic13" => Some(3),
        b"ic08" => Some(4),
        b"ic07" => Some(5),
        _ => None,
    };
    let mut best: Option<(u8, &[u8])> = None;
    let mut off = 8usize;
    while off + 8 <= data.len() {
        let len =
            u32::from_be_bytes([data[off + 4], data[off + 5], data[off + 6], data[off + 7]])
                as usize;
        if len < 8 || off + len > data.len() {
            break;
        }
        let payload = &data[off + 8..off + len];
        if let Some(r) = rank(&data[off..off + 4]) {
            if payload.starts_with(&[0x89, b'P', b'N', b'G'])
                && best.map_or(true, |(br, _)| r < br)
            {
                best = Some((r, payload));
            }
        }
        off += len;
    }
    best.map(|(_, p)| p.to_vec())
}

/// Blend a glyph INTO the folder the way macOS special folders do: the
/// glyph's alpha is a mask that darkens the folder surface underneath, so
/// the folder's gradient and texture show through — an embossed tint, not
/// a sticker. `strength` 0..1: how dark the glyph gets at full alpha.
#[cfg(test)]
#[derive(Clone, Copy)]
enum GlyphMask {
    /// The glyph IS the mark: alpha alone drives the engraving. Right for
    /// outline / letterform / single-tone logos.
    Silhouette,
    /// The glyph is a plate (disc / rounded tile / card) carrying marks:
    /// engrave by contrast with the plate's dominant tone, in either
    /// direction — the plate fades out, the marks press in.
    Plate { dominant: f32, spread: f32 },
}

/// Classify the glyph. A logo is a PLATE when its opaque region fills its
/// bounding box (disc, rounded tile, card — ember, ionic, next, koa) AND
/// carries tonal contrast (the marks). Everything else — letterforms,
/// outline glyphs, single-tone shapes like the Vue V or the eve stripes —
/// is a silhouette.
#[cfg(test)]
fn auto_mask(glyph: &resvg::tiny_skia::Pixmap) -> GlyphMask {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut lums: Vec<f32> = vec![];
    for y in 0..glyph.height() {
        for x in 0..glyph.width() {
            if let Some(p) = glyph.pixel(x, y) {
                let af = p.alpha() as f32 / 255.0;
                if af > 0.5 {
                    let lum = (0.2126 * p.red() as f32
                        + 0.7152 * p.green() as f32
                        + 0.0722 * p.blue() as f32)
                        / (255.0 * af);
                    lums.push(lum.clamp(0.0, 1.0));
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                }
            }
        }
    }
    if lums.is_empty() {
        return GlyphMask::Silhouette;
    }
    let bbox_area = ((max_x - min_x + 1) as f64) * ((max_y - min_y + 1) as f64);
    let fill_ratio = lums.len() as f64 / bbox_area;

    lums.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p05 = lums[lums.len() * 5 / 100];
    let p95 = lums[(lums.len() * 95 / 100).min(lums.len() - 1)];
    let spread = p95 - p05;

    if fill_ratio > 0.72 && spread > 0.25 {
        // Dominant tone = the plate; find it with a 16-bin histogram.
        let mut hist = [0u32; 16];
        for l in &lums {
            hist[((l * 15.999) as usize).min(15)] += 1;
        }
        let peak = hist.iter().enumerate().max_by_key(|(_, c)| **c).unwrap().0;
        GlyphMask::Plate {
            dominant: (peak as f32 + 0.5) / 16.0,
            spread: spread.max(0.25),
        }
    } else {
        GlyphMask::Silhouette
    }
}

#[cfg(test)]
fn blend_glyph_into(
    base: &mut RgbaImage,
    glyph: &resvg::tiny_skia::Pixmap,
    ox: u32,
    oy: u32,
    strength: f32,
    mask: GlyphMask,
) {
    for y in 0..glyph.height() {
        for x in 0..glyph.width() {
            let (bx, by) = (ox + x, oy + y);
            if bx >= base.width() || by >= base.height() {
                continue;
            }
            if let Some(p) = glyph.pixel(x, y) {
                let af = p.alpha() as f32 / 255.0;
                if af > 0.0 {
                    let weight = match mask {
                        GlyphMask::Silhouette => af,
                        GlyphMask::Plate { dominant, spread } => {
                            let lum = (0.2126 * p.red() as f32
                                + 0.7152 * p.green() as f32
                                + 0.0722 * p.blue() as f32)
                                / (255.0 * af.max(0.004));
                            let contrast =
                                ((lum.clamp(0.0, 1.0) - dominant).abs() / spread).clamp(0.0, 1.0);
                            af * contrast
                        }
                    };
                    let factor = 1.0 - strength * weight;
                    let px = base.get_pixel_mut(bx, by);
                    px.0[0] = (px.0[0] as f32 * factor) as u8;
                    px.0[1] = (px.0[1] as f32 * factor) as u8;
                    px.0[2] = (px.0[2] as f32 * factor) as u8;
                }
            }
        }
    }
}

/// tiny-skia pixmap (premultiplied) → RgbaImage (straight alpha).
#[cfg(test)]
fn pixmap_to_image(pixmap: &resvg::tiny_skia::Pixmap) -> RgbaImage {
    let mut img = RgbaImage::new(pixmap.width(), pixmap.height());
    for y in 0..pixmap.height() {
        for x in 0..pixmap.width() {
            if let Some(p) = pixmap.pixel(x, y) {
                let a = p.alpha();
                if a > 0 {
                    let af = a as f32 / 255.0;
                    img.put_pixel(
                        x,
                        y,
                        image::Rgba([
                            (p.red() as f32 / af).min(255.0) as u8,
                            (p.green() as f32 / af).min(255.0) as u8,
                            (p.blue() as f32 / af).min(255.0) as u8,
                            a,
                        ]),
                    );
                }
            }
        }
    }
    img
}

/// Dropbox-style folder icons: the root ~/Vercel folder gets the app's
/// triangle icon, and each project folder gets a dark rounded tile with its
/// framework's logo (Vercel's icon set, bundled from public/icons) badged
/// with deployment status (green ready / amber deploying / red failed).
///
/// Implemented with NSWorkspace on macOS. On Windows (desktop.ini) and Linux
/// (gio metadata) this is a planned native integration — the entry points
/// here are platform-neutral no-ops so nothing else needs cfg-gating.

/// The app's identity icon (dock in dev builds; bundled builds use
/// icon.icns generated from the same source).
const APP_ICON: &[u8] = include_bytes!("../../public/icon.png");

/// Finder artwork for the root ~/Vercel folder: the macOS folder with the
/// Vercel triangle (generated by the generate_folder_icons test).
const ROOT_FOLDER_ICON: &[u8] = include_bytes!("../../public/icons/mac/folder-vercel.png");

/// Pre-composited macOS folder + framework badge (public/icons/mac/).
fn framework_folder_png(framework: &str) -> &'static [u8] {
    match framework {
        "nextjs" => include_bytes!("../../public/icons/mac/folder-nextjs.png"),
        "nuxt" => include_bytes!("../../public/icons/mac/folder-nuxt.png"),
        "astro" => include_bytes!("../../public/icons/mac/folder-astro.png"),
        "remix" => include_bytes!("../../public/icons/mac/folder-remix.png"),
        "svelte" => include_bytes!("../../public/icons/mac/folder-svelte.png"),
        "vue" => include_bytes!("../../public/icons/mac/folder-vue.png"),
        "vite" => include_bytes!("../../public/icons/mac/folder-vite.png"),
        "react" => include_bytes!("../../public/icons/mac/folder-react.png"),
        "hono" => include_bytes!("../../public/icons/mac/folder-hono.png"),
        "express" => include_bytes!("../../public/icons/mac/folder-express.png"),
        _ => include_bytes!("../../public/icons/mac/folder-other.png"),
    }
}

/// `other.svg` is the fallback for unknown/static projects.
#[cfg(test)]
fn framework_svg(framework: &str) -> &'static [u8] {
    match framework {
        "nextjs" => include_bytes!("../../public/icons/next-dark.svg"),
        "nuxt" => include_bytes!("../../public/icons/nuxt.svg"),
        "astro" => include_bytes!("../../public/icons/astro-dark.svg"),
        "remix" => include_bytes!("../../public/icons/remix-no-shadow.svg"),
        "svelte" => include_bytes!("../../public/icons/svelte.svg"),
        "vue" => include_bytes!("../../public/icons/vue.svg"),
        "vite" => include_bytes!("../../public/icons/vite.svg"),
        "react" => include_bytes!("../../public/icons/react.svg"),
        "hono" => include_bytes!("../../public/icons/hono.svg"),
        "express" => include_bytes!("../../public/icons/express-dark.svg"),
        _ => include_bytes!("../../public/icons/other.svg"),
    }
}

/// Remember what we last painted per path so unchanged statuses don't
/// re-touch the filesystem (NSWorkspace calls are not free).
#[derive(Default)]
pub struct FolderIconCache(pub Mutex<HashMap<String, String>>);

fn status_color(status: &str) -> Option<[u8; 4]> {
    match status {
        "ready" => Some([69, 212, 131, 255]),
        "deploying" => Some([245, 166, 35, 255]),
        "failed" => Some([255, 77, 79, 255]),
        _ => None,
    }
}

#[cfg(test)]
const SIZE: u32 = 256;

fn blend(px: &mut image::Rgba<u8>, r: u8, g: u8, b: u8, alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    px.0 = [
        (r as f32 * a + px.0[0] as f32 * (1.0 - a)) as u8,
        (g as f32 * a + px.0[1] as f32 * (1.0 - a)) as u8,
        (b as f32 * a + px.0[2] as f32 * (1.0 - a)) as u8,
        px.0[3].max((a * 255.0) as u8),
    ];
}

/// Signed coverage of a rounded rect at (x, y): 1 inside, 0 outside,
/// fractional on the edge for cheap anti-aliasing.
#[cfg(test)]
fn rounded_rect_coverage(x: f32, y: f32, min: f32, max: f32, radius: f32) -> f32 {
    let cx = x.clamp(min + radius, max - radius);
    let cy = y.clamp(min + radius, max - radius);
    let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
    (radius - d + 0.5).clamp(0.0, 1.0)
}

fn draw_status_dot(img: &mut RgbaImage, color: [u8; 4]) {
    let [r, g, b, _] = color;
    let w = img.width();
    let (cx, cy) = (w as f32 * 0.80, w as f32 * 0.80);
    let radius = w as f32 * 0.13;
    let ring = w as f32 * 0.027;
    for y in 0..img.height().min(w) {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if d <= radius + 1.0 {
                let px = img.get_pixel_mut(x, y);
                if d <= radius - ring {
                    blend(px, r, g, b, radius - ring - d + 0.5);
                    blend(px, r, g, b, 1.0);
                } else {
                    // White ring separates the dot from the artwork below.
                    blend(px, 255, 255, 255, (radius - d + 0.5).clamp(0.0, 1.0));
                }
            }
        }
    }
    // Refill the dot core over the ring gradient.
    let h = img.height().min(w);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if d <= radius - ring + 1.0 {
                let px = img.get_pixel_mut(x, y);
                blend(px, r, g, b, (radius - ring - d + 0.5).clamp(0.0, 1.0));
            }
        }
    }
}

/// Fonts for SVGs that use <text> (some logos are wordmarks). Loaded once.
#[cfg(test)]
fn svg_options() -> &'static resvg::usvg::Options<'static> {
    static OPTIONS: std::sync::OnceLock<resvg::usvg::Options<'static>> = std::sync::OnceLock::new();
    OPTIONS.get_or_init(|| {
        let mut opt = resvg::usvg::Options::default();
        let db = std::sync::Arc::make_mut(&mut opt.fontdb);
        db.load_system_fonts();
        opt
    })
}

/// Rasterize a framework SVG centered into a box of `target` px.
#[cfg(test)]
fn rasterize_logo(svg: &[u8], target: f32) -> Option<resvg::tiny_skia::Pixmap> {
    let opt = svg_options();
    let tree = resvg::usvg::Tree::from_data(svg, opt).ok()?;
    let size = tree.size();
    let scale = target / size.width().max(size.height());
    let w = (size.width() * scale).ceil() as u32;
    let h = (size.height() * scale).ceil() as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w.max(1), h.max(1))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Some(pixmap)
}

/// Project folder icon: the pre-composited macOS folder + framework badge,
/// with the live status dot drawn on top.
fn project_icon_png(framework: &str, status: &str) -> Option<Vec<u8>> {
    let mut img = image::load_from_memory(framework_folder_png(framework))
        .ok()?
        .to_rgba8();
    if let Some(color) = status_color(status) {
        draw_status_dot(&mut img, color);
    }
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Dark rounded tile + framework logo (no dot) — used by the asset
/// generator to build the folder badges.
#[cfg(test)]
fn tile_png(framework: &str) -> Option<Vec<u8>> {
    let mut img = RgbaImage::from_pixel(SIZE, SIZE, image::Rgba([0, 0, 0, 0]));

    // Tile: near-black rounded square with a subtle border, matching the
    // app's dark aesthetic and keeping white "-dark" logos legible.
    let (min, max, radius) = (12.0f32, SIZE as f32 - 12.0, 58.0f32);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let cov = rounded_rect_coverage(x as f32 + 0.5, y as f32 + 0.5, min, max, radius);
            if cov > 0.0 {
                let px = img.get_pixel_mut(x, y);
                blend(px, 17, 17, 17, cov);
            }
            let border =
                cov * (1.0 - rounded_rect_coverage(x as f32 + 0.5, y as f32 + 0.5, min + 3.0, max - 3.0, radius - 3.0));
            if border > 0.0 {
                let px = img.get_pixel_mut(x, y);
                blend(px, 58, 58, 58, border);
            }
        }
    }

    // Logo centered.
    if let Some(logo) = rasterize_logo(framework_svg(framework), 132.0) {
        let ox = (SIZE - logo.width()) / 2;
        let oy = (SIZE - logo.height()) / 2;
        for y in 0..logo.height() {
            for x in 0..logo.width() {
                if let Some(p) = logo.pixel(x, y) {
                    let a = p.alpha();
                    if a > 0 {
                        // tiny-skia pixels are premultiplied.
                        let af = a as f32 / 255.0;
                        let (r, g, b) = (
                            (p.red() as f32 / af).min(255.0) as u8,
                            (p.green() as f32 / af).min(255.0) as u8,
                            (p.blue() as f32 / af).min(255.0) as u8,
                        );
                        blend(img.get_pixel_mut(ox + x, oy + y), r, g, b, af);
                    }
                }
            }
        }
    }

    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

fn root_icon_png() -> Option<Vec<u8>> {
    // Already a PNG — hand it to NSWorkspace as-is.
    Some(ROOT_FOLDER_ICON.to_vec())
}

#[cfg(target_os = "macos")]
fn set_folder_icon(path: &Path, png: &[u8]) -> bool {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{NSData, NSString};

    let data = NSData::with_bytes(png);
    let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return false;
    };
    let ws = NSWorkspace::sharedWorkspace();
    let ns_path = NSString::from_str(&path.to_string_lossy());
    ws.setIcon_forFile_options(Some(&img), &ns_path, NSWorkspaceIconCreationOptions::empty())
}

#[cfg(not(target_os = "macos"))]
fn set_folder_icon(_path: &Path, _png: &[u8]) -> bool {
    false
}

/// Set the Dock icon at runtime. Bundled builds get it from icon.icns, but
/// `tauri dev` runs an unbundled binary that would otherwise show the
/// generic icon.
#[cfg(target_os = "macos")]
pub fn set_dock_icon() {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(APP_ICON);
    if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
        let app = NSApplication::sharedApplication(mtm);
        unsafe { app.setApplicationIconImage(Some(&img)) };
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_dock_icon() {}

fn apply_icon(cache: &FolderIconCache, path: &Path, cache_key: &str, png: Option<Vec<u8>>) {
    let path_key = path.to_string_lossy().to_string();
    {
        let mut seen = cache.0.lock().unwrap();
        if seen.get(&path_key).map(String::as_str) == Some(cache_key) {
            return;
        }
        seen.insert(path_key, cache_key.to_string());
    }
    if let Some(png) = png {
        let _ = set_folder_icon(path, &png);
    }
}

/// Give the root folder the plain app icon. Called once at setup.
pub fn apply_root_icon(cache: &FolderIconCache, root: &Path) {
    if root.is_dir() {
        apply_icon(cache, root, "root", root_icon_png());
    }
}

/// Badge each project folder: framework logo + current status.
/// Tuples are (name, status, framework).
pub fn apply_project_icons(
    cache: &FolderIconCache,
    root: &Path,
    projects: &[(String, String, String)],
) {
    for (name, status, framework) in projects {
        let dir = root.join(name);
        if dir.is_dir() {
            let key = format!("{framework}:{status}");
            apply_icon(cache, &dir, &key, project_icon_png(framework, status));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_icons_encode_for_every_framework_and_status() {
        for framework in [
            "nextjs", "nuxt", "astro", "remix", "svelte", "vue", "vite", "react", "hono",
            "express", "static", "unknown",
        ] {
            for status in ["ready", "deploying", "failed", "idle"] {
                let png = project_icon_png(framework, status)
                    .unwrap_or_else(|| panic!("{framework}/{status} renders"));
                assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']);
            }
        }
    }

    #[test]
    fn root_icon_encodes() {
        assert!(root_icon_png().is_some());
    }

    #[test]
    fn cache_prevents_redundant_paints() {
        let cache = FolderIconCache::default();
        let path = Path::new("/nonexistent/x");
        apply_icon(&cache, path, "nextjs:ready", None);
        apply_icon(&cache, path, "nextjs:ready", None);
        assert_eq!(cache.0.lock().unwrap().len(), 1);
    }

    /// One-shot: make public/icon.png's black matte transparent. Flood
    /// fills near-black from the canvas borders, so dark pixels INSIDE the
    /// tile are untouched. Run: cargo test strip_app_icon_matte -- --ignored
    #[test]
    #[ignore]
    fn strip_app_icon_matte() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/icon.png");
        let mut img = image::open(&path).unwrap().to_rgba8();
        let (w, h) = img.dimensions();
        let is_bg = |px: &image::Rgba<u8>| px.0[0].max(px.0[1]).max(px.0[2]) < 24;

        let mut queue: std::collections::VecDeque<(u32, u32)> = std::collections::VecDeque::new();
        let mut seen = vec![false; (w * h) as usize];
        for x in 0..w {
            queue.push_back((x, 0));
            queue.push_back((x, h - 1));
        }
        for y in 0..h {
            queue.push_back((0, y));
            queue.push_back((w - 1, y));
        }
        let mut cleared = 0u64;
        while let Some((x, y)) = queue.pop_front() {
            let idx = (y * w + x) as usize;
            if seen[idx] {
                continue;
            }
            seen[idx] = true;
            let px = img.get_pixel(x, y);
            if px.0[3] == 0 {
                // already transparent — keep flooding through it
            } else if is_bg(px) {
                img.get_pixel_mut(x, y).0 = [0, 0, 0, 0];
                cleared += 1;
            } else {
                continue; // hit the tile edge — stop this branch
            }
            if x > 0 { queue.push_back((x - 1, y)); }
            if x + 1 < w { queue.push_back((x + 1, y)); }
            if y > 0 { queue.push_back((x, y - 1)); }
            if y + 1 < h { queue.push_back((x, y + 1)); }
        }
        img.save(&path).unwrap();
        println!("cleared {cleared} background pixels of {}", w * h);
    }

    /// Generate one complete blended set onto a folder base image.
    /// `glyph_center_y`: vertical center of the folder body, 0..1.
    fn generate_set(folder: &RgbaImage, out_dir: &std::path::Path, glyph_center_y: f32) {
        std::fs::create_dir_all(out_dir).unwrap();

        // Root/app icon: 1024 folder, Vercel triangle blended into the body.
        {
            let size = 1024u32;
            let mut base = image::imageops::resize(
                folder, size, size, image::imageops::FilterType::Lanczos3,
            );
            let glyph = rasterize_logo(VERCEL_TRIANGLE_SVG, size as f32 * 0.36).unwrap();
            let x = (size - glyph.width()) / 2;
            let y = (size as f32 * glyph_center_y) as u32 - glyph.height() / 2;
            blend_glyph_into(&mut base, &glyph, x, y, 0.55, GlyphMask::Silhouette);
            base.save(out_dir.join("folder-vercel.png")).unwrap();
        }

        let make = |svg: &[u8], name: &str| {
            let size = 512u32;
            let mut base = image::imageops::resize(
                folder, size, size, image::imageops::FilterType::Lanczos3,
            );
            let Some(glyph) = rasterize_logo(svg, size as f32 * 0.40) else {
                eprintln!("skipped {name}: svg failed to rasterize");
                return;
            };
            let x = (size - glyph.width()) / 2;
            let y = (size as f32 * glyph_center_y) as u32 - glyph.height() / 2;
            let mask = auto_mask(&glyph);
            blend_glyph_into(&mut base, &glyph, x, y, 0.55, mask);
            base.save(out_dir.join(format!("folder-{name}.png"))).unwrap();
        };

        // Canonical names the runtime links against (detected frameworks).
        for fw in [
            "nextjs", "nuxt", "astro", "remix", "svelte", "vue", "vite", "react",
            "hono", "express", "other",
        ] {
            let key = if fw == "other" { "unknown" } else { fw };
            make(framework_svg(key), fw);
        }

        // The full library: every other SVG in public/icons.
        let canonical_sources = [
            "next-dark.svg", "nuxt.svg", "astro-dark.svg", "remix-no-shadow.svg",
            "svelte.svg", "vue.svg", "vite.svg", "react.svg", "hono.svg",
            "express-dark.svg", "other.svg",
        ];
        let icons_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/icons");
        for entry in std::fs::read_dir(&icons_dir).unwrap() {
            let path = entry.unwrap().path();
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !fname.ends_with(".svg") || fname.contains("(1)") {
                continue;
            }
            if canonical_sources.contains(&fname) {
                continue;
            }
            let stem = fname.trim_end_matches(".svg");
            let svg = std::fs::read(&path).unwrap();
            make(&svg, stem);
        }
        println!("wrote {}", out_dir.display());
    }

    /// One-shot asset generator: blends the Vercel triangle and every
    /// framework logo into folder artwork — the genuine macOS folder (read
    /// from CoreTypes on this machine) → public/icons/mac/, and the vendored
    /// Windows folder (public/icons/windows-folder.png) → public/icons/win/.
    /// Run: cargo test generate_folder_icons -- --ignored
    #[test]
    #[ignore]
    fn generate_folder_icons() {
        let icons_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/icons");

        let raw = std::fs::read(SYSTEM_FOLDER_ICNS).expect("system folder icns");
        let png = best_icns_png(&raw).expect("png rep in icns");
        let mac = image::load_from_memory(&png).unwrap().to_rgba8();
        generate_set(&mac, &icons_root.join("mac"), 0.585);

        let win_base = icons_root.join("windows-folder.png");
        if win_base.is_file() {
            let win = image::open(&win_base).unwrap().to_rgba8();
            generate_set(&win, &icons_root.join("win"), 0.55);
        } else {
            eprintln!("no windows-folder.png — skipped win set");
        }
    }

    #[test]
    #[ignore] // manual inspection helper: cargo test -p vercel-folder -- --ignored
    fn dump_folder_icons() {
        for (framework, status) in [
            ("nextjs", "ready"),
            ("astro", "deploying"),
            ("unknown", "failed"),
            ("react", "idle"),
        ] {
            let png = project_icon_png(framework, status).unwrap();
            let path = std::env::temp_dir().join(format!("folder-{framework}-{status}.png"));
            std::fs::write(&path, png).unwrap();
            println!("wrote {}", path.display());
        }
    }
}
