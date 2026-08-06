# Study Apps

One GitHub Pages site hosting a few small study-support apps as subfolders, plus one shared
Google Apps Script backend.

- `index.html` — homepage, picks an app. Redirects straight through if a participant link
  (`?base=`) or a remembered study is detected, so existing links and installed PWAs keep
  working.
- `studylink/` — [StudyLink Portal](studylink/README.md): participant sign-in and device
  verification codes, plus a study-management admin panel.
- `offline-redcap/` — [Offline Survey Generator](offline-redcap/README.md): turns a REDCap Data
  Dictionary into a single offline HTML survey for when the server is unreachable.
- `backend/Code.gs` — shared Apps Script Web App, used by `studylink/`. See
  [studylink/README.md](studylink/README.md) for deployment.

## Host on GitHub Pages

```bash
git remote add origin https://github.com/<you>/studylink-portal.git
git push -u origin main
```

Settings → Pages → Deploy from branch → `main` / root.
