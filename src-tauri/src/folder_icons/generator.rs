//! Build-time asset generator for the committed folder artwork. Nothing here
//! ships: the runtime links the pre-composited PNGs via include_bytes!.
//! Regenerate public/icons/mac and public/icons/win with:
//!   cargo test generate_folder_icons -- --ignored
//! (Reads the genuine macOS folder from CoreTypes, so run on a Mac.)

use image::RgbaImage;

use super::blend;

/// The Vercel triangle (official path), dark, for the root folder glyph.
const VERCEL_TRIANGLE_SVG: &[u8] =
    br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1155 1000"><path d="M577.3 0l577.4 1000H0z" fill="#1b1f23"/></svg>"##;

const SYSTEM_FOLDER_ICNS: &str =
    "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericFolderIcon.icns";

/// Pull the best PNG representation out of an .icns (chunks: 4cc type +
/// u32 BE length incl. 8-byte header). ic10=1024 … ic07=128.
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
/// Retained for tile experiments; not called by the current generator pass.
#[allow(dead_code)]
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

/// `other.svg` is the fallback for unknown/static projects.
fn framework_svg(framework: &str) -> &'static [u8] {
    match framework {
        "nextjs" => include_bytes!("../../../public/icons/next-dark.svg"),
        "nuxt" => include_bytes!("../../../public/icons/nuxt.svg"),
        "astro" => include_bytes!("../../../public/icons/astro-dark.svg"),
        "remix" => include_bytes!("../../../public/icons/remix-no-shadow.svg"),
        "svelte" => include_bytes!("../../../public/icons/svelte.svg"),
        "vue" => include_bytes!("../../../public/icons/vue.svg"),
        "vite" => include_bytes!("../../../public/icons/vite.svg"),
        "react" => include_bytes!("../../../public/icons/react.svg"),
        "hono" => include_bytes!("../../../public/icons/hono.svg"),
        "express" => include_bytes!("../../../public/icons/express-dark.svg"),
        _ => include_bytes!("../../../public/icons/other.svg"),
    }
}

#[allow(dead_code)]
const SIZE: u32 = 256;

/// Signed coverage of a rounded rect at (x, y): 1 inside, 0 outside,
/// fractional on the edge for cheap anti-aliasing.
#[allow(dead_code)]
fn rounded_rect_coverage(x: f32, y: f32, min: f32, max: f32, radius: f32) -> f32 {
    let cx = x.clamp(min + radius, max - radius);
    let cy = y.clamp(min + radius, max - radius);
    let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
    (radius - d + 0.5).clamp(0.0, 1.0)
}

/// Fonts for SVGs that use <text> (some logos are wordmarks). Loaded once.
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

/// Dark rounded tile + framework logo (no dot) — used by the asset
/// generator to build the folder badges.
/// Retained for tile experiments; not called by the current generator pass.
#[allow(dead_code)]
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
