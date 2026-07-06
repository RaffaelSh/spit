# spit — Live End-to-End Acceptance Runbook

This is the **step-exact, trap-free** procedure for the M001 acceptance scenario: run
the whole `spit` command chain **for real** against your own Spotify account, using a
throwaway playlist you own. It is the human-run counterpart to the offline wiring smoke
in `test/e2e-smoke.test.ts` (which proves the git-side subcommands compose over the
built binary without a network). The live Spotify legs — `login`, `init`, `commit`,
`push` — are inherently human actions (interactive OAuth, real credentials, network,
an **irreversible** write) and are captured as UAT evidence at milestone validation.

Run every command with the **built** binary, not `tsx`. Follow the order literally.
Three failure modes will make a *correct* build look broken if you deviate; each is
called out inline as **⚠ TRAP**.

---

## 1. Prerequisites

- **Build first.** The acceptance runs the shipped CLI (`dist/cli.js`), not the
  TypeScript sources:

  ```sh
  npm run build
  ```

  Invoke it as `node dist/cli.js <cmd>` (or via the linked `spit` bin if you ran
  `npm link`). This runbook writes `spit <cmd>` for brevity.

- **Spotify Client ID.** Export the client id of *your* Spotify app:

  ```sh
  export SPOTIFY_CLIENT_ID=<your-app-client-id>
  ```

  PKCE is used, so there is **no client secret**.

- **Redirect URI — exact match.** The Spotify app's registered redirect URI must be
  **literally** `http://127.0.0.1:8888/callback`.

  > **⚠ TRAP #1 — `127.0.0.1`, not `localhost`.** Spotify treats `localhost` and
  > `127.0.0.1` as different strings. A mismatch fails the token exchange with
  > `invalid_client` / `INVALID_CLIENT`. `spit login` detects this and appends the hint
  > *"Check the redirect URI is exactly http://127.0.0.1:8888/callback (127.0.0.1, not
  > localhost)."* — but you avoid it entirely by registering the exact string above.

- **A throwaway playlist you OWN.** Create a fresh, disposable playlist under your own
  account for the run.

  > **⚠ TRAP #2 — the first `push` is irreversible and ownership-gated.** `spit push`
  > *replaces* the live playlist's tracks (one atomic PUT). Spotify has **no undo**. If
  > you do not own the playlist, the write returns 403 (`missing write scopes — re-run
  > spit login (or you don't own this playlist)`). Never point the acceptance push at a
  > playlist you care about.

- **Regular tracks only.** The playlist must contain only ordinary Spotify tracks. A
  local file or podcast-episode entry has a null URI; `extractPushUris` rejects the
  **entire** push up front with *"This snapshot contains local tracks with no Spotify
  URI and cannot be pushed."* rather than silently dropping tracks.

---

## 2. Start with a FRESH login (the #1 live-run failure)

> **⚠ TRAP #3 — stale token, missing write scopes.** Write scopes
> (`playlist-modify-public`, `playlist-modify-private`) were added in S05
> (`src/auth/oauth.ts`). A token cached **before** that change was minted with
> read-only scopes; `spit push` will then 403 with *"missing write scopes"* even though
> everything else is correct. **Always begin the acceptance with a fresh login** so a
> write-scoped token is minted and cached:

```sh
spit login
```

Expected: a browser opens to the Spotify consent screen; after you approve, the tab
shows *"spit: login successful …"* and the terminal prints:

```
Login successful. Token cached at ~/.spit/tokens.json (0600).
```

---

## 3. Corrected canonical order

The roadmap's shorthand (`init→commit→ändern→diff→commit→log→…`) has two ordering
traps baked in. The **corrected** order below is what actually produces meaningful
output at every step. `<playlistId>` may be a bare id, a `spotify:playlist:…` URI, or an
`open.spotify.com/playlist/…` URL.

### 3.1 `spit init <playlistId>` — commit #1

```sh
spit init <playlistId>
```

Expected:

```
Initialized spit repo for "<playlist name>"
  path:   <repoDir>
  tracks: <N>
  commit: <hash>
```

`cd` into `<repoDir>` for the remaining commands (or pass the repo dir as the trailing
argument to each).

> **⚠ Ordering trap A — no redundant commit.** Do **not** run `spit commit` right after
> `init`. With no Spotify-side edit yet, there is nothing new to snapshot and you will
> get `No changes since last snapshot.` — which reads like a failure but is correct.

### 3.2 Edit the playlist in the Spotify app — commit #2

There is **no local edit command**. `spit commit` re-reads the *live* playlist from
Spotify. So make a real change first in the Spotify desktop/web UI (add, remove, or
reorder a track), then:

```sh
spit commit -m "second snapshot: <what you changed>"
```

Expected:

```
Committed new snapshot for "<playlist name>"
  path:   <repoDir>
  tracks: <N>
  commit: <hash>
```

### 3.3 `spit diff` — now meaningful

```sh
spit diff
```

`diff` compares `HEAD~1..HEAD`, so it is only meaningful **after** the second commit
(this is the second ordering trap in the roadmap shorthand — a `diff` right after `init`
has no prior snapshot to compare). Expected output uses the canonical diff lines:

```
- <old track name>
+ <new track name>
~ <moved track name> (i→j)
```

(`-` removed, `+` added, `~` moved from index *i* to index *j*.)

### 3.4 `spit log` — two entries

```sh
spit log
```

Expected (most-recent first), one `<hash>  <message>` line per commit:

```
<hash2>  second snapshot: <what you changed>
<hash1>  Initialized …
```

---

## 4. Branch / merge choreography (clean merge)

This is the **exact command order** that `test/e2e-smoke.test.ts` proves yields a clean
merge. The key to a deterministic clean merge is that the two divergent edits touch
**non-overlapping track regions** (e.g. the branch edits the *last* track, the main line
edits the *first* track, and a middle track stays untouched between them).

```sh
spit branch experiment
```
→ `Created branch "experiment" in "<playlist name>"`. This creates a pointer only; it
does **not** check the branch out.

```sh
spit checkout experiment
```
→ `Checked out experiment (<commit>)` plus `playlist:` / `tracks:` lines. Checking out a
**branch name** keeps HEAD **attached** (no "detached" warning).

> **⚠ Note — bare commit checkout detaches HEAD.** `spit checkout <bare-commit-hash>`
> instead prints `warning:  HEAD is detached at <commit>`. Use a **branch name** here so
> the subsequent commit lands on the branch.

Now, on `experiment`, edit the playlist in Spotify in **one region** (e.g. change the
last track), then:

```sh
spit commit -m "experiment: change last track"
```

Switch back to your main branch (whatever `git init` produced — `main` on modern git;
confirm with `git -C <repoDir> branch --show-current`):

```sh
spit checkout main
```

On `main`, edit the playlist in a **non-overlapping** region (e.g. change the first
track), then:

```sh
spit commit -m "main: change first track"
```

Merge the branch:

```sh
spit merge experiment
```

Expected (the acceptance's headline signal):

```
Merged experiment cleanly.
```

If the two edits *did* overlap, `merge` instead exits non-zero and prints
`Merge produced conflicts — resolve playlist.jsonl, then git add + git commit:` with
`<<< ours … | theirs … >>>` lines. That is correct conflict behavior, not a bug — but for
a clean acceptance keep the edits in separate regions as above.

---

## 5. Push (opt-in write-back)

By default a repo is **display-only**: nothing is written to Spotify. Attempting a push
without opting in exits non-zero with:

```
Write-back is disabled for this repo (display-only). Enable it once with: spit push --enable-writes
```

Perform the one-time, per-repo opt-in and push:

```sh
spit push --enable-writes
```

Expected: a pre-warning names the target playlist and the exact change counts, then a
`[y/N]` prompt gates the write:

```
This push will change <N> tracks: +<A> added, -<R> removed, ~<M> moved to "<playlist name>". Continue? [y/N]
```

Type `y` to write. Only an exact `y`/`Y` proceeds; anything else aborts with `Aborted.`
and **nothing is written**. Use `--yes` **only** to skip the prompt (e.g. scripted runs);
`--enable-writes` is still required to leave display-only mode. On success:

```
Pushed <N> tracks to "<playlist name>" (<B> batch(es)).
```

Verify in the Spotify app that the live playlist now matches the committed snapshot.

---

## 6. UAT evidence to record

For milestone validation, capture:

- Terminal transcripts of each step above (redact nothing except the token path if you
  wish).
- The commit hashes from `spit log`.
- The `snapshot_id` / success line from the final `spit push`.
- Confirmation in the Spotify UI that the playlist reflects the pushed snapshot.

These human-attested transcripts are attached at milestone validation via
`gsd_uat_result_save`, and they cite T01's offline smoke evidence-ID for the
automatable git-side subset. The live legs (`login`/`init`/`commit`/`push`) are the
human-only remainder that this runbook exists to make reproducible.

---

## Appendix — failure signal quick reference

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_client` / `INVALID_CLIENT` at login | redirect URI is `localhost` (or otherwise mismatched) | register **exactly** `http://127.0.0.1:8888/callback` |
| push 403 `missing write scopes` | token cached before S05 write scopes, **or** you don't own the playlist | re-run `spit login` (fresh, write-scoped token); use a playlist you own |
| `No changes since last snapshot.` after `init` | redundant `commit` with no Spotify edit | edit the playlist in Spotify first, then `commit` |
| empty / unexpected `diff` | ran `diff` before the 2nd commit exists (`HEAD~1..HEAD`) | commit twice before `diff` |
| `Merge produced conflicts …` | branch and main edited the **same** track region | keep the two edits in non-overlapping regions |
| `Write-back is disabled …` | repo never opted into write-back | `spit push --enable-writes` (one-time per repo) |
| push rejected: local/episode track | a track has a null URI | remove local files / episodes from the playlist |
