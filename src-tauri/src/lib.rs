use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const APP_NAME: &str = "Internet File Searcher";

struct Http(reqwest::Client);
struct Cancels(Mutex<HashSet<String>>);

fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .cookie_store(true)
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(12))
        .build()
        .expect("http client")
}

fn short_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "could not connect".into()
    } else {
        let s = e.to_string();
        s.chars().take(160).collect()
    }
}

fn pct_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Next body chunk; Err on timeout or connection error.
async fn next_chunk(r: &mut reqwest::Response) -> Result<Option<Vec<u8>>, String> {
    match tokio::time::timeout(Duration::from_secs(60), r.chunk()).await {
        Err(_) => Err("download stalled".into()),
        Ok(Err(e)) => Err(format!("connection lost: {}", short_err(e))),
        Ok(Ok(c)) => Ok(c.map(|b| b.to_vec())),
    }
}

/// File name from a Content-Disposition header, if any.
fn disposition_name(h: &reqwest::header::HeaderMap) -> String {
    let Some(v) = h.get(reqwest::header::CONTENT_DISPOSITION).and_then(|v| v.to_str().ok()) else {
        return String::new();
    };
    for part in v.split(';') {
        let p = part.trim();
        if let Some(val) = p.strip_prefix("filename*=") {
            let val = val.trim_matches('"');
            let val = val.rsplit('\'').next().unwrap_or(val);
            return pct_decode(val);
        }
    }
    for part in v.split(';') {
        let p = part.trim();
        if let Some(val) = p.strip_prefix("filename=") {
            return val.trim_matches('"').to_string();
        }
    }
    String::new()
}

fn is_text_type(ct: &str) -> bool {
    ct.is_empty()
        || ct.starts_with("text/")
        || ct.contains("html")
        || ct.contains("xml")
        || ct.contains("json")
        || ct.contains("javascript")
}

#[derive(Serialize)]
struct FetchResult {
    status: u16,
    final_url: String,
    content_type: String,
    length: Option<u64>,
    filename: String,
    is_text: bool,
    body: String,
}

fn is_cancelled(cancels: &Cancels, id: &Option<String>) -> bool {
    match id {
        Some(id) => cancels.0.lock().map(|s| s.contains(id)).unwrap_or(false),
        None => false,
    }
}

/// Runs `fut`, but gives up (None) as soon as the search `id` is cancelled.
async fn unless_cancelled<F: std::future::Future>(cancels: &Cancels, id: &Option<String>, fut: F) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    loop {
        if is_cancelled(cancels, id) {
            return None;
        }
        match tokio::time::timeout(Duration::from_millis(200), &mut fut).await {
            Ok(out) => return Some(out),
            Err(_) => continue,
        }
    }
}

/// GET a URL without browser CORS limits. Text bodies are returned (up to max_bytes);
/// for binary responses only the headers are read. `run_id` lets Stop abort it mid-way.
#[tauri::command]
async fn http_get(
    http: State<'_, Http>,
    cancels: State<'_, Cancels>,
    url: String,
    referer: Option<String>,
    max_bytes: Option<usize>,
    accept_json: Option<bool>,
    run_id: Option<String>,
) -> Result<FetchResult, String> {
    let cancels: &Cancels = &cancels;
    match unless_cancelled(cancels, &run_id, fetch_page(&http.0, cancels, &run_id, url, referer, max_bytes, accept_json)).await {
        Some(r) => r,
        None => Err("stopped".into()),
    }
}

/// Mark a search as stopped: its pending http_get calls return "stopped" within 0.2 s.
#[tauri::command]
fn cancel_run(cancels: State<'_, Cancels>, run_id: String) {
    if let Ok(mut s) = cancels.0.lock() {
        s.insert(run_id);
    }
}

async fn fetch_page(
    client: &reqwest::Client,
    cancels: &Cancels,
    run_id: &Option<String>,
    url: String,
    referer: Option<String>,
    max_bytes: Option<usize>,
    accept_json: Option<bool>,
) -> Result<FetchResult, String> {
    let accept = if accept_json.unwrap_or(false) {
        "application/json,*/*;q=0.5"
    } else {
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };
    let mut req = client
        .get(&url)
        .timeout(Duration::from_secs(40))
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(r) = referer.filter(|r| !r.is_empty()) {
        req = req.header(reqwest::header::REFERER, r);
    }
    let mut resp = req.send().await.map_err(short_err)?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let length = resp.content_length();
    let filename = disposition_name(resp.headers());
    let is_text = is_text_type(&content_type) && !filename.contains('.') || content_type.contains("html");
    let mut body = Vec::new();
    if is_text {
        let max = max_bytes.unwrap_or(2_000_000);
        while let Some(c) = resp.chunk().await.map_err(short_err)? {
            if is_cancelled(cancels, run_id) {
                return Err("stopped".into());
            }
            body.extend_from_slice(&c);
            if body.len() >= max {
                break;
            }
        }
    }
    Ok(FetchResult {
        status,
        final_url,
        content_type,
        length,
        filename,
        is_text,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

#[derive(Serialize, Default)]
struct DlResult {
    ok: bool,
    reason: String,
    path: String,
    bytes: u64,
    content_type: String,
    final_url: String,
    html: String,
}

#[derive(Serialize, Clone)]
struct DlProgress {
    job: String,
    got: u64,
    total: u64,
}

fn fail(reason: impl Into<String>) -> DlResult {
    DlResult { ok: false, reason: reason.into(), ..Default::default() }
}

fn looks_html(head: &[u8]) -> bool {
    let s: String = String::from_utf8_lossy(&head[..head.len().min(1024)])
        .trim_start_matches('\u{feff}')
        .trim_start()
        .chars()
        .take(300)
        .collect::<String>()
        .to_lowercase();
    s.starts_with("<!doctype html") || s.starts_with("<html") || (s.starts_with("<") && s.contains("<head"))
}

/// Some(true/false) when the extension has a known signature, None when it can't be checked.
fn magic_ok(ext: &str, h: &[u8]) -> Option<bool> {
    let starts = |p: &[u8]| h.starts_with(p);
    Some(match ext {
        "pdf" => h.windows(4).take(1024).any(|w| w == b"%PDF"),
        "zip" | "docx" | "xlsx" | "pptx" | "epub" | "cbz" | "odt" | "ods" | "odp" | "jar" | "apk" | "xpi" | "kmz" => starts(b"PK"),
        "rar" | "cbr" => starts(b"Rar!"),
        "7z" => starts(&[0x37, 0x7A, 0xBC, 0xAF]),
        "png" => starts(&[0x89, b'P', b'N', b'G']),
        "jpg" | "jpeg" => starts(&[0xFF, 0xD8, 0xFF]),
        "gif" => starts(b"GIF8"),
        "webp" => h.len() >= 12 && &h[0..4] == b"RIFF" && &h[8..12] == b"WEBP",
        "mp4" | "m4a" | "m4v" | "mov" => h.len() >= 8 && &h[4..8] == b"ftyp",
        "doc" | "xls" | "ppt" | "msi" => starts(&[0xD0, 0xCF, 0x11, 0xE0]),
        "exe" | "dll" => starts(b"MZ"),
        "flac" => starts(b"fLaC"),
        "ogg" => starts(b"OggS"),
        "mkv" | "webm" => starts(&[0x1A, 0x45, 0xDF, 0xA3]),
        _ => return None,
    })
}

fn sanitize(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    s = s.trim().trim_matches('.').trim().to_string();
    if s.chars().count() > 180 {
        let (stem, ext) = match s.rfind('.') {
            Some(i) if s.len() - i <= 9 => (s[..i].to_string(), s[i..].to_string()),
            _ => (s.clone(), String::new()),
        };
        s = stem.chars().take(170).collect::<String>() + &ext;
    }
    if s.is_empty() {
        "download".into()
    } else {
        s
    }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    first
}

/// One download attempt. On success the file is saved; when the server answers with a
/// web page instead of the file, that page is returned so the caller can look for links.
#[tauri::command]
async fn download_try(
    app: AppHandle,
    http: State<'_, Http>,
    cancels: State<'_, Cancels>,
    job: String,
    url: String,
    referer: Option<String>,
    dir: String,
    filename: String,
    expect_ext: String,
) -> Result<DlResult, String> {
    let cancelled = || cancels.0.lock().map(|s| s.contains(&job)).unwrap_or(false);
    let mut req = http
        .0
        .get(&url)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(r) = referer.filter(|r| !r.is_empty()) {
        req = req.header(reqwest::header::REFERER, r);
    }
    let mut resp = match tokio::time::timeout(Duration::from_secs(60), req.send()).await {
        Err(_) => return Ok(fail("no answer (timed out)")),
        Ok(Err(e)) => return Ok(fail(short_err(e))),
        Ok(Ok(r)) => r,
    };
    let status = resp.status();
    let final_url = resp.url().to_string();
    if !status.is_success() {
        return Ok(DlResult { final_url, ..fail(format!("HTTP {}", status.as_u16())) });
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let total = resp.content_length().unwrap_or(0);
    let cd_name = disposition_name(resp.headers());
    let ext = expect_ext.trim().trim_start_matches('.').to_lowercase();
    let page_types = ["html", "htm", "xhtml", "shtml", "php", "asp", "aspx", "mht", "mhtml"];
    let wants_page = page_types.contains(&ext.as_str());

    let first = match next_chunk(&mut resp).await {
        Err(e) => return Ok(fail(e)),
        Ok(c) => c.unwrap_or_default(),
    };

    // A web page instead of the file: hand it back for link scraping.
    if !wants_page && (ct.contains("text/html") || looks_html(&first)) {
        let mut body = first;
        while body.len() < 2_000_000 {
            match next_chunk(&mut resp).await {
                Ok(Some(c)) => body.extend_from_slice(&c),
                _ => break,
            }
        }
        return Ok(DlResult {
            content_type: ct,
            final_url,
            html: String::from_utf8_lossy(&body).into_owned(),
            ..fail("got a web page, not the file")
        });
    }

    let dirp = PathBuf::from(&dir);
    if let Err(e) = tokio::fs::create_dir_all(&dirp).await {
        return Ok(fail(format!("cannot create folder: {e}")));
    }
    let base_name = if !filename.trim().is_empty() {
        filename.clone()
    } else if !cd_name.is_empty() {
        cd_name.clone()
    } else {
        "download".into()
    };
    let name = sanitize(&base_name);
    let target = unique_path(&dirp, &name);
    let part = target.with_file_name(format!(
        "{}.part",
        target.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let mut f = match tokio::fs::File::create(&part).await {
        Ok(f) => f,
        Err(e) => return Ok(fail(format!("cannot write file: {e}"))),
    };

    let mut head: Vec<u8> = first.iter().take(4096).cloned().collect();
    let mut got: u64 = first.len() as u64;
    if let Err(e) = f.write_all(&first).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Ok(fail(format!("write error: {e}")));
    }
    let mut last_emit = Instant::now();
    let _ = app.emit("dl-progress", DlProgress { job: job.clone(), got, total });
    loop {
        if cancelled() {
            drop(f);
            let _ = tokio::fs::remove_file(&part).await;
            return Ok(fail("cancelled"));
        }
        let chunk = match next_chunk(&mut resp).await {
            Err(e) => {
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return Ok(fail(e));
            }
            Ok(None) => break,
            Ok(Some(c)) => c,
        };
        if head.len() < 4096 {
            head.extend(chunk.iter().take(4096 - head.len()));
        }
        if let Err(e) = f.write_all(&chunk).await {
            drop(f);
            let _ = tokio::fs::remove_file(&part).await;
            return Ok(fail(format!("write error: {e}")));
        }
        got += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(300) {
            last_emit = Instant::now();
            let _ = app.emit("dl-progress", DlProgress { job: job.clone(), got, total });
        }
    }
    let _ = f.flush().await;
    drop(f);

    if got == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Ok(fail("empty file"));
    }
    if total > 0 && got < total {
        let _ = tokio::fs::remove_file(&part).await;
        return Ok(fail(format!("incomplete ({got} of {total} bytes)")));
    }
    if let Some(false) = magic_ok(&ext, &head) {
        let _ = tokio::fs::remove_file(&part).await;
        return Ok(fail(format!("content is not a real .{ext} file")));
    }
    let final_path = if target.exists() { unique_path(&dirp, &name) } else { target };
    if let Err(e) = tokio::fs::rename(&part, &final_path).await {
        return Ok(fail(format!("cannot finish file: {e}")));
    }
    let _ = app.emit("dl-progress", DlProgress { job, got, total: got });
    Ok(DlResult {
        ok: true,
        reason: String::new(),
        path: final_path.to_string_lossy().into_owned(),
        bytes: got,
        content_type: ct,
        final_url,
        html: String::new(),
    })
}

#[tauri::command]
fn cancel_download(cancels: State<'_, Cancels>, job: String) {
    if let Ok(mut s) = cancels.0.lock() {
        s.insert(job);
    }
}

#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
}

fn short_version(v: &str) -> String {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() == 3 && parts[2] == "0" {
        format!("{}.{}", parts[0], parts[1])
    } else {
        v.to_string()
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo { name: APP_NAME.into(), version: short_version(&app.package_info().version.to_string()) }
}

#[tauri::command]
fn default_dir(app: AppHandle) -> String {
    let base = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join(APP_NAME).to_string_lossy().into_owned()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not a web link".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    if p.is_dir() {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    } else if p.exists() {
        app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    } else if let Some(parent) = p.parent().filter(|d| d.is_dir()) {
        app.opener().open_path(parent.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
    } else {
        let _ = std::fs::create_dir_all(&p);
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Http(make_client()))
        .manage(Cancels(Mutex::new(HashSet::new())))
        .setup(|app| {
            let v = short_version(&app.package_info().version.to_string());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("{APP_NAME} {v}"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            http_get,
            cancel_run,
            download_try,
            cancel_download,
            app_info,
            default_dir,
            pick_folder,
            open_url,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
