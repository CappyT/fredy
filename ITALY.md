# Fredy, Italy fork

This fork of [orangecoding/fredy](https://github.com/orangecoding/fredy) adds Italian providers
and a few other changes. Everything that exists only in the fork is documented
here, so that `README.md` and `AGENTS.md` stay identical to upstream. Read those first; this file
covers the differences.

## Providers

-   🏠 Scrapes **25 portals** across 🇩🇪 🇮🇹 🇦🇹 🇨🇭 🇪🇸 🇵🇹: ImmoScout24, Immowelt, Kleinanzeigen,
    WG-Gesucht, Immobiliare.it, Idealista, Casa.it, Subito, Tecnocasa, willhaben, Flatfox and
    [14 more](./doc/providers.md)

Fredy ships with 25 providers. The German ones are listed in [Providers & scraping](./doc/providers.md);
the rest are offered Italy first:

**🇮🇹 Italy** · Immobiliare.it · Idealista · Casa.it · Subito · Tecnocasa · Tecnorete  
**🇪🇸 Spain · 🇵🇹 Portugal** · Idealista  
**🇦🇹 Austria** · willhaben  
**🇨🇭 Switzerland** · Flatfox

### Idealista

Idealista uses the mobile APIs for idealista.com, idealista.it and idealista.pt.
The search URL determines the country.
The provider supports `/multi/` URLs and rejects unrelated domains.
Searches with filters or categories unsupported by the APIs use Fredy's browser.
DataDome can block the browser fallback.
See the [provider documentation](./reverse-engineered-idealista.md) for supported endpoints and filters.

### Immobiliare.it

Immobiliare.it uses its search API and geography service to resolve location URLs.
Searches that cannot be translated into API requests use the job's browser.
The provider reads up to twenty pages.
See the [provider documentation](./reverse-engineered-immobiliare.md) for supported endpoints.

## For coding agents

Additions to [AGENTS.md](./AGENTS.md), which applies here unchanged.

### Bot protection

The fork adds nothing to get past bot protection such as DataDome: no captcha solvers, no cached
challenge cookies, no virtual display to make the browser look windowed. A page or api that answers
with a challenge is a failed read, the way upstream treats it.

## Syncing with upstream

- Preview conflicts before merging: `git merge-tree --write-tree --name-only master upstream/master`
  prints the merged tree followed by the conflicted files, and exits 1 when there are any.
- Sync on every upstream release, so each merge stays small.
- Before merging, adopt upstream's squash-merged version of our own PRs, so the fork does not keep
  its copy of the change next to upstream's.
- Start upstream-bound work on an `upstream-pr/*` branch cut from `upstream/master`, then bring the
  same commit into `master`.
- Put fork code in fork-only files and small hooks, and fork documentation in this file. Never
  append fork entries at the end of upstream lists, locale files or import lines: upstream appends
  there too.
- New fork migrations use a reserved high number range (e.g. `900.`) and must be idempotent. Never
  rename an applied migration: `schema_migrations` is keyed by the file name.
- After each sync, record the divergence of upstream files below. Added and deleted files are
  excluded, so fork-only files do not count:
  `git diff --numstat --no-renames --diff-filter=MD upstream/master master | awk '{a+=$1; d+=$2; n++} END {print a, d, n}'`

### Divergence log

| Date | Fork commit | Upstream | Lines added | Lines deleted | Files |
|---|---|---|---|---|---|
| 2026-09-13 | `620c77e` | `b7c7e68` (27.6.1) | 2719 | 285 | 79 |
| 2026-09-14 | `2349cc9` | `b7c7e68` (27.6.1) | 2768 | 290 | 80 |
| 2026-09-14 | `cda6d47` | `b7c7e68` (27.6.1) | 2611 | 217 | 72 |
| 2026-09-15 | `f96072a` | `45f42ad` (28.1.0) | 2617 | 219 | 74 |
