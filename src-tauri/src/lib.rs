use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const APP_NAME: &str = "Internet File Searcher";

struct Http(reqwest::Client);
struct Cancels(Mutex<HashSet<String>>);

/// Address lookup with a fallback: the normal Windows lookup first (4 s limit), then
/// DNS-over-HTTPS at Cloudflare / Google by IP. Some networks hang on names such as
/// api.github.com; hosts that hung once go straight to the fallback. Results cached 10 min.
struct FallbackDns {
    doh: reqwest::Client,
    cache: Arc<Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>>,
    slow: Arc<Mutex<HashSet<String>>>,
}

fn to_addrs(ips: Vec<IpAddr>) -> reqwest::dns::Addrs {
    Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)))
}

async fn doh_lookup(doh: &reqwest::Client, host: &str) -> Vec<IpAddr> {
    for base in ["https://1.1.1.1/dns-query", "https://8.8.8.8/resolve"] {
        let url = format!("{base}?name={host}&type=A");
        let Ok(resp) = doh
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/dns-json")
            .timeout(Duration::from_secs(8))
            .send()
            .await
        else {
            continue;
        };
        let Ok(text) = resp.text().await else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let ips: Vec<IpAddr> = v["Answer"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|x| x["type"].as_u64() == Some(1))
                    .filter_map(|x| x["data"].as_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default();
        if !ips.is_empty() {
            return ips;
        }
    }
    Vec::new()
}

impl reqwest::dns::Resolve for FallbackDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let doh = self.doh.clone();
        let cache = self.cache.clone();
        let slow = self.slow.clone();
        Box::pin(async move {
            let cached = cache.lock().ok().and_then(|c| c.get(&host).cloned());
            if let Some((ips, t)) = cached {
                if t.elapsed() < Duration::from_secs(600) {
                    return Ok(to_addrs(ips));
                }
            }
            let skip_system = slow.lock().map(|s| s.contains(&host)).unwrap_or(false);
            if !skip_system {
                match tokio::time::timeout(Duration::from_secs(4), tokio::net::lookup_host((host.as_str(), 0))).await {
                    Ok(Ok(it)) => {
                        let ips: Vec<IpAddr> = it.map(|a| a.ip()).collect();
                        if !ips.is_empty() {
                            if let Ok(mut c) = cache.lock() {
                                c.insert(host.clone(), (ips.clone(), Instant::now()));
                            }
                            return Ok(to_addrs(ips));
                        }
                    }
                    _ => {
                        if let Ok(mut s) = slow.lock() {
                            s.insert(host.clone());
                        }
                    }
                }
            }
            let ips = doh_lookup(&doh, &host).await;
            if ips.is_empty() {
                return Err(format!("could not find the address of {host}").into());
            }
            if let Ok(mut c) = cache.lock() {
                c.insert(host.clone(), (ips.clone(), Instant::now()));
            }
            Ok(to_addrs(ips))
        })
    }
}

fn make_client() -> reqwest::Client {
    let dns = FallbackDns {
        doh: reqwest::Client::builder()
            .user_agent(UA)
            .connect_timeout(Duration::from_secs(8))
            .build()
            .expect("doh client"),
        cache: Arc::new(Mutex::new(HashMap::new())),
        slow: Arc::new(Mutex::new(HashSet::new())),
    };
    reqwest::Client::builder()
        .dns_resolver(Arc::new(dns))
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
    headers: Option<HashMap<String, String>>,
) -> Result<FetchResult, String> {
    let cancels: &Cancels = &cancels;
    match unless_cancelled(cancels, &run_id, fetch_page(&http.0, cancels, &run_id, url, referer, max_bytes, accept_json, headers)).await {
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
    headers: Option<HashMap<String, String>>,
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
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k.as_str(), v.as_str());
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

/* ---------------- probe: is the file real, alive, and what is its own title ---------------- */

const PROBE_HEAD: usize = 262_144;
const ZIP_MAX: u64 = 8_000_000;

#[derive(Serialize, Default)]
struct ProbeResult {
    ok: bool,
    dead: bool,
    status: u16,
    final_url: String,
    content_type: String,
    size: u64,
    kind: String,
    title: String,
    note: String,
}

fn find_bytes(h: &[u8], n: &[u8]) -> Option<usize> {
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    h.windows(n.len()).position(|w| w == n)
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// PDF literal string "( ... )", starting right after the "(".
fn pdf_literal(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut depth = 1;
    let mut i = 0;
    while i < b.len() && i < 4000 {
        let c = b[i];
        match c {
            b'\\' => {
                i += 1;
                let Some(&e) = b.get(i) else { break };
                match e {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' | b'f' => {}
                    b'0'..=b'7' => {
                        let mut v: u32 = 0;
                        let mut k = 0;
                        while k < 3 && i < b.len() && (b'0'..=b'7').contains(&b[i]) {
                            v = v * 8 + (b[i] - b'0') as u32;
                            i += 1;
                            k += 1;
                        }
                        out.push((v & 0xFF) as u8);
                        continue;
                    }
                    b'\r' | b'\n' => {}
                    other => out.push(other),
                }
            }
            b'(' => {
                depth += 1;
                out.push(c);
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(out);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    None
}

/// PDF hex string "< ... >", starting right after the "<".
fn pdf_hex(b: &[u8]) -> Option<Vec<u8>> {
    let mut digits = Vec::new();
    for &c in b.iter().take(4000) {
        if c == b'>' {
            if digits.len() % 2 == 1 {
                digits.push(0);
            }
            return Some(digits.chunks(2).map(|p| p[0] * 16 + p[1]).collect());
        }
        if let Some(d) = (c as char).to_digit(16) {
            digits.push(d as u8);
        }
    }
    None
}

fn pdf_text(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        let units: Vec<u16> = b[2..]
            .chunks(2)
            .filter(|p| p.len() == 2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_string();
    }
    b.iter().map(|&c| c as char).collect()
}

fn pdf_title(b: &[u8]) -> String {
    let mut i = 0;
    while let Some(p) = find_bytes(&b[i..], b"/Title") {
        let mut j = i + p + 6;
        while j < b.len() && b[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < b.len() {
            let raw = if b[j] == b'(' {
                pdf_literal(&b[j + 1..])
            } else if b[j] == b'<' && b.get(j + 1) != Some(&b'<') {
                pdf_hex(&b[j + 1..])
            } else {
                None
            };
            if let Some(bytes) = raw {
                let t = pdf_text(&bytes).split_whitespace().collect::<Vec<_>>().join(" ");
                if !t.is_empty() {
                    return t;
                }
            }
        }
        i = i + p + 6;
    }
    if let Some(p) = find_bytes(b, b"<dc:title") {
        let rest = &b[p..b.len().min(p + 6000)];
        if let Some(e) = find_bytes(rest, b"</dc:title>") {
            return strip_tags(&String::from_utf8_lossy(&rest[..e]));
        }
    }
    String::new()
}

/// Title from DOCX/XLSX/PPTX (docProps/core.xml) or EPUB (.opf).
fn zip_title(b: &[u8]) -> String {
    use std::io::Read;
    let Ok(mut z) = zip::ZipArchive::new(std::io::Cursor::new(b)) else {
        return String::new();
    };
    for i in 0..z.len() {
        let Ok(f) = z.by_index(i) else { continue };
        let name = f.name().to_string();
        if !(name.ends_with(".opf") || name == "docProps/core.xml") {
            continue;
        }
        let mut s = String::new();
        if f.take(500_000).read_to_string(&mut s).is_ok() {
            if let Some(p) = s.find("<dc:title") {
                let rest = &s[p..];
                if let Some(e) = rest.find("</dc:title>") {
                    let t = strip_tags(&rest[..e]);
                    if !t.is_empty() {
                        return t;
                    }
                }
            }
        }
    }
    String::new()
}

fn sniff_kind(head: &[u8], ct: &str) -> &'static str {
    if find_bytes(&head[..head.len().min(1024)], b"%PDF").is_some() {
        "pdf"
    } else if head.starts_with(b"PK") {
        "zip"
    } else if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        "ole"
    } else if looks_html(head) || ct.contains("text/html") {
        "html"
    } else {
        "other"
    }
}

async fn read_up_to(resp: &mut reqwest::Response, max: usize, cancels: &Cancels, run_id: &Option<String>) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    while buf.len() < max {
        if is_cancelled(cancels, run_id) {
            return Err("stopped".into());
        }
        match next_chunk(resp).await? {
            Some(c) => buf.extend_from_slice(&c),
            None => break,
        }
    }
    buf.truncate(max);
    Ok(buf)
}

async fn ranged_get(client: &reqwest::Client, url: &str, referer: &Option<String>, range: Option<&str>) -> Result<reqwest::Response, reqwest::Error> {
    let mut req = client
        .get(url)
        .timeout(Duration::from_secs(45))
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");
    if let Some(r) = range {
        req = req.header(reqwest::header::RANGE, r);
    }
    if let Some(r) = referer.as_ref().filter(|r| !r.is_empty()) {
        req = req.header(reqwest::header::REFERER, r.as_str());
    }
    req.send().await
}

async fn probe_inner(client: &reqwest::Client, cancels: &Cancels, run_id: &Option<String>, url: String, referer: Option<String>, expect_ext: String) -> ProbeResult {
    let mut out = ProbeResult::default();
    let mut resp = match ranged_get(client, &url, &referer, Some("bytes=0-262143")).await {
        Ok(r) => r,
        Err(e) => {
            out.dead = e.is_connect();
            out.note = short_err(e);
            return out;
        }
    };
    out.status = resp.status().as_u16();
    out.final_url = resp.url().to_string();
    if matches!(out.status, 404 | 410) {
        out.dead = true;
        out.note = format!("HTTP {} (link is dead)", out.status);
        return out;
    }
    if !resp.status().is_success() {
        out.note = format!("HTTP {}", out.status);
        return out;
    }
    out.content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let partial = out.status == 206;
    let total = if partial {
        resp.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<u64>().ok())
    } else {
        resp.content_length()
    };
    let head = match read_up_to(&mut resp, PROBE_HEAD, cancels, run_id).await {
        Ok(b) => b,
        Err(e) => {
            out.note = e;
            return out;
        }
    };
    drop(resp);
    let complete = match total {
        Some(t) => head.len() as u64 >= t,
        None => !partial && head.len() < PROBE_HEAD,
    };
    out.size = total.unwrap_or(if complete { head.len() as u64 } else { 0 });
    out.kind = sniff_kind(&head, &out.content_type).into();
    let ext = expect_ext.trim().trim_start_matches('.').to_lowercase();
    let page_types = ["html", "htm", "xhtml", "shtml", "php", "asp", "aspx", "mht", "mhtml"];
    if out.kind == "html" && !page_types.contains(&ext.as_str()) {
        out.note = "web page, not the file".into();
        return out;
    }
    if let Some(false) = magic_ok(&ext, &head) {
        out.note = format!("not a real .{ext} file");
        return out;
    }
    out.ok = true;
    if out.kind == "pdf" {
        let mut t = pdf_title(&head);
        if t.is_empty() && !complete && out.size > 0 {
            if let Ok(mut r2) = ranged_get(client, &url, &referer, Some("bytes=-131072")).await {
                if r2.status().as_u16() == 206 {
                    if let Ok(tail) = read_up_to(&mut r2, 131_072, cancels, run_id).await {
                        t = pdf_title(&tail);
                    }
                }
            }
        }
        out.title = t;
    } else if out.kind == "zip" {
        let full = if complete {
            Some(head)
        } else if out.size > 0 && out.size <= ZIP_MAX {
            match ranged_get(client, &url, &referer, None).await {
                Ok(mut r2) if r2.status().is_success() => read_up_to(&mut r2, ZIP_MAX as usize, cancels, run_id).await.ok(),
                _ => None,
            }
        } else {
            None
        };
        if let Some(b) = full {
            out.title = zip_title(&b);
        }
    }
    out
}

/// Check one file link: alive? real file of the expected type? size? its own title?
#[tauri::command]
async fn probe_file(
    http: State<'_, Http>,
    cancels: State<'_, Cancels>,
    url: String,
    referer: Option<String>,
    run_id: Option<String>,
    expect_ext: Option<String>,
) -> Result<ProbeResult, String> {
    let cancels: &Cancels = &cancels;
    match unless_cancelled(cancels, &run_id, probe_inner(&http.0, cancels, &run_id, url, referer, expect_ext.unwrap_or_default())).await {
        Some(r) => Ok(r),
        None => Err("stopped".into()),
    }
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
            probe_file,
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
