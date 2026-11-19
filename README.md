# Internet File Searcher

A Windows desktop app that hunts the internet for a file by name.

- Type file names (comma-separated packs) and optional file types.
- Searches DuckDuckGo, Bing and Mojeek (`filetype:` and `intitle:"index of"` queries), opens each result page, collects file links and follows relevant links deeper (respects robots.txt).
- Also searches Internet Archive, Wikimedia Commons, Zenodo, OpenAlex and GitHub, reading the full file list of every matching item.
- Options: Match words, Match case, Strict mode, Depth.
- Best 50 matches, re-sorted after every find.
- **Download** tries many ways: the direct link, host-specific direct links (GitHub raw, Google Drive/Docs, Dropbox, Zenodo, SourceForge, arXiv), links on the page the server returns, the page where the file was found, Wayback Machine copies, and mirrors found by searching the exact file name. Every saved file is checked (not a web page, correct file signature, complete size).

Build: `build.bat` (Tauri 2, needs the MSVC build tools).
