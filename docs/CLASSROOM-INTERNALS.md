# Classroom web internals

What we know about the data Classroom's web app loads, from the read-only recon in #18 (student view, two accounts, October 2026). The parsers (#5, #6) depend on it. **Write only the shapes here, never real values.** Anonymized examples of every payload below are in [`fixtures/classroom/`](../fixtures/classroom/README.md), and `test/classroom-fixtures.test.ts` pins the positions listed here.

Notation: `x[5]` is a 0-based position in a positional (protobuf-as-JSON) array. `?` means seen but not understood. Positions not listed were `null` in every capture.

## Pages and URLs
- To-do lists: `/a/not-turned-in/all`, `/a/missing/all`, `/a/turned-in/all`, with `?authuser=<email>`. Classroom redirects to `/u/<n>/...` where `<n>` is the multi-login index. All later XHRs use that prefix (`/u/<n>/_/ClassroomUi/data/batchexecute`). Account 0 has no prefix.
- Assignment detail (student view): `/c/<courseB64>/a/<itemB64>/details`. Material: `/c/<courseB64>/m/<itemB64>/details`. Course stream: `/c/<courseB64>`. Classwork: `/w/<courseB64>/t/all`.
- `<xB64>` is base64 (no padding) of the **decimal id string**, e.g. id `123456789012` → `MTIzNDU2Nzg5MDEy`.
- The three To-do pages load the **same** data. The page picks the bucket client-side through a filter in the `pONvgf` request (see below). Lists render in collapsed sections, so the DOM shows only part of them. Don't scrape the DOM.

## Initial HTML
- No data is embedded. The HTML defines `AF_initDataCallback` but never calls it with data blobs (0 `ds:*` keys on every page).
- `WIZ_global_data` is present and carries what direct RPC calls need: `SNlM0e` (XSRF token, sent as `at`), `FdrFJe` (`f.sid`), `cfb2h` (build label, `bl`). `x3UoP` holds the signed-in user as `%.@.` + a JSON array: `[0]` the Classroom user id (the `studentId` in submission keys), `[1]` the display name.
- Everything else comes from `batchexecute` XHRs.

## batchexecute
`POST /u/<n>/_/ClassroomUi/data/batchexecute?rpcids=<id>&source-path=<page path>&f.sid=…&bl=…&hl=<lang>&soc-app=1&soc-platform=1&soc-device=1&_reqid=<n>&rt=c`

- Body (form-encoded): `f.req=[[["<rpcid>","<args as JSON string>",null,"generic"]]]&at=<SNlM0e>`.
- Response: `)]}'` then length-prefixed JSON chunks. The length is the UTF-16 length of `"\n" + chunk + "\n"`, but it's easier to parse JSON values in sequence. Data rows look like `["wrb.fr","<rpcid>","<payload JSON string>",null,null,null,"generic"]`. An error row has a `null` payload and an error code at `[5]`, e.g. `[3]` for a bad argument. Trailing `["di",n]`, `["af.httprm",…]` and `["e",…]` rows are bookkeeping.
- Payloads start with a type tag: `hrq.sub`, `hrsi.qr`, etc.
- **Field masks.** Most requests carry a mask: a nested array of `1`s that mirrors the response shape. Fields left out of the mask come back `null` or missing. For example, the list call for submissions does not return attachments, while the detail call asks for them with mask `[null,1,null,1]`.
- Ids are 12-digit decimals (Gaia ids are 21-digit strings). Requests send them as numbers; responses return them as strings.
- An item key is `[itemId, [courseId]]`. A submission key is `[studentId, [itemId, [courseId]]]`.

### RPCs seen (all reads)

| rpcid | tag | what | where |
|---|---|---|---|
| `gXtzob` | `hrq.crs` | courses of the user | every page |
| `UG41I` | `hrq.usr` | users by id (self, teachers) | every page |
| `pONvgf` | `hrsi.qr` | stream-item query (To-do lists, course stream) | To-do pages, stream |
| `Zj93ge` | `hrq.sub` | submissions by key, batched | To-do pages, detail |
| `tQShAc` | `hrsi.lr` | stream items by key (detail) | detail |
| `t51ITc` | — | materials of **one** item | detail |
| `sLc6hf` | `hrq.cmt` | comments (private: per submission, class: per item) | detail, stream |
| `dpT4Vd` | `hrcw.qr` | classwork query per topic | classwork |
| `O1Xqee` | `hrq.cus` | course membership (role) | detail, stream |
| `cCzVwf` | `hra.laa` | ? (echoes the request, add-on attachments?) | detail |
| `Bypadc` | `rubric.list` | rubrics | detail |
| `ZZFlc` | `hrt.qr` | topics | stream, classwork |
| `CxllXe`, `gkSD8b` | `hrct.gcr`, `hrgb.lr` | ? (course settings / gradebook?) | stream, classwork |

Also seen but not useful: `/_/ClassroomUi/browserinfo`, `play.google.com/log`, OneGoogle and `signaler-pa` (push channel), `accounts.google.com/RotateCookies`.

## Payload shapes

### Course (`gXtzob` → `[2][]`)
`[0][0]` course id · `[1]` created ms · `[2]` updated ms · `[5]` name · `[6][0][0]` owner id · `[9]` theme (colors, images) · `[20]` state (1 active, 2 archived) · `[23]` calendar URL · `[25][2]` Gaia id of the course group · `[28]` `c:<courseId>` · `[42][1]` Meet link.

### User (`UG41I` → `[2][]`)
`[0][0]` user id · `[1]` display name · `[2]` email (empty for others) · `[4]` photo URL. The request takes `[[null,[[null,[userId]],…]]]`.

### Stream item (`pONvgf`, `dpT4Vd`, `tQShAc`)
- `pONvgf` → `["hrsi.qr", [hasMore, [nextPageToken]], [item…]]`. Request: `[[pageSize=100, pageToken|null, 1, 0], <mask>, [filter]]`.
- To-do filter: `[null, [[courseId]…], [2,5], [2], …, [14]=[buckets…]]`. The pages send `[1,2]` (not turned in = assigned + missing), `[2]` (missing), and `[3,4,8,10,5,7,9,6,11]` (done). `[1,3,…,11]` is used too. Field `[5]=[[fromMs,toMs]]` limits by due date on the stream's "upcoming" box. The stream itself uses `[[2,3], [[courseId]], null, [2]]`.
- `dpT4Vd` → `["hrcw.qr", [hasMore], [item…]]`, per topic (request `[2]=[topicId,[courseId]]`).
- `tQShAc` → `["hrsi.lr", [[[0], itemKey, item]]]`. Request: `[[itemKey…], <mask>]` (several keys allowed).

Each **item** is `[type, assignment?, ?, ?, ?, material?]`. `type` 2 is an assignment (body at `[1]`). `type` 7 is a material post (body at `[5]`). `type` 5 is assumed to be a question: the To-do filter asks for `[2,5]`, but none was seen. The body is `[base, work, driveFolder, ?, [2,2]]`. Material posts have only `base`.

`base` (common to all post types):
- `[0]` item key `[itemId, [courseId]]` · `[1]` created ms · `[2]` updated ms · `[3]` ? ms
- `[4][0]` creator (teacher) id · `[5]` **title** · `[8]` 2 (published)
- `[9]` `[2, [creatorId], publishedMs, null, scheduledMs?, 3?]` · `[10]` published ms
- `[13]` `c:<courseId>:s:<itemId>` · `[14][0]` topic key `[topicId, [courseId]]` · `[21]` short base64 etag
- `[27][0]` description block: `[1]` UUID, `[4]` material refs `[[null, [itemKey, materialId]]…]`, `[6]` rich text `["edu.rt", plainText, null, null, [null, html]]`. The description can be missing.

`work` (assignment only): `[0]` **due** ms or `null` · `[1]` ms (≈ published) · `[2]` bool ? · `[3]` **max points** or `null` (ungraded) · `[6]` `[1]` · `[18]` 1 | 2 | 3 (an enum. We saw no link to quiz/question, since all three are ordinary assignments in the UI).

`driveFolder`: `[folderId, null, folderUrl]`. This is the class's Drive folder for the assignment.

### Submission (`Zj93ge` → `["hrq.sub", [false], [sub…]]`)
Request: `[[null,null,1,0], <mask>, [null,null,[[studentId,[itemId,[courseId]]]…]], 1]`. The To-do page asks for about 100 keys per call.

- `[0]` submission key `[studentId, [itemId, [courseId]]]` · `[2]` updated ms · `[7][0]` student id
- `[4]` **student attachments** (only with mask `[null,1,null,1]`, see Attachment) · `[13]` attachment count
- `[5]` **submission state**: 2 turned in · 3 returned · 4 new/assigned (never turned in) · 5 reclaimed (unsubmitted, back to assigned)
- `[8]` **grade** (number) or `null` (also when not graded yet)
- `[20]` **To-do bucket**. This is the same enum as the `pONvgf` filter and drives the UI label:

  | `[20]` | UI (en) | meaning |
  |---|---|---|
  | 1 | Assigned / due date | open, not turned in, not overdue |
  | 2 | Missing | not turned in and past due |
  | 3 | Turned in | on time |
  | 4 | Done late | turned in after due |
  | 7 | (returned, no label) | returned without a grade |
  | 8 | `<g>/<max>` | graded and returned, on time |
  | 10 | `<g>/<max>` + Done late | graded, late |
  | 11 | Excused | excused (`[32]` = 2) |
  | 5, 6, 9 | not seen | |

- `[21]` ms of the last state change (≈ turn-in time) · `[32]` 1 normal / 2 excused
- Late, missing and graded come straight from `[20]`. Don't derive them from due vs turn-in time.

### Attachment (shared by materials and student work)
Array of length 21:
- `[0]` title (file name) · `[2]` id: Drive file id, YouTube video id or URL · `[3]` **type**: 2 Drive file, 3 YouTube, 4 link (Google Forms links show up as type 4 too, no native Forms type seen)
- `[4]` mime (Drive only, e.g. `application/vnd.google-apps.kix` for a Google Doc) · `[5]` thumbnail (Drive: `lh3.googleusercontent.com/drive-storage/…={size}`) · `[6]` open URL (`drive.google.com/file/d/<id>/view?usp=drive_web`)
- `[8]` YouTube duration in seconds (string) · `[10]` 2 ?
- `[14]` Drive extras: `[0]` `[title, thumb, url]`, `[2]` true and `[3]` `[2, originalFileId]` on a teacher-annotated copy, `[6]` `docs.google.com/file/d/<id>/grading`, `[7]` size in bytes
- `[15]` **origin**: 1 teacher material · 2 student's own file · 3 teacher's annotated copy of a student file
- `[17]` attachment id (material id) · `[20]` 1

Materials (`t51ITc` → `[null, [[attachment, null, [itemKey, materialId]]…]]`): the request is `[[null,null,1,0], [itemKey], <mask>]`. It takes **exactly one** item. Several keys, or an item without materials, return error `[3]`.

**"Make a copy for each student"**: not seen in any capture (no Google Docs/Sheets/Slides student attachments in either account). It is expected as a student attachment (`Zj93ge [4]`, `[15]`=2) with a `vnd.google-apps.*` mime, plus a teacher material of the same title. The share-mode field is unknown. This needs a capture when one shows up.

### Comments (`sLc6hf` → `["hrq.cmt", [false], [comment…]]`)
- Private comments: request filter `[[null,null,[2,3]], null, null, [submissionKey], [[1]]]`. Class comments: `[[null,null,[2,3]], [itemKey], null, null, [[2]]]`.
- Comment: `[0]` `[commentId, null, submissionKey, 3 (private)]` · `[1]`/`[2]`/`[3]` ms · `[4][0]` author id (look up with `UG41I`) · `[7]` 2 · `[9]` `c:…:s:…:su:<studentId>:co:<commentId>` · `[11]` rich text `["edu.rt", plain, null, null, [null, html]]`

### Course membership (`O1Xqee`)
`[2][0]`: `[0]` `[[courseId],[userId]]` · `[1]` role (3 student) · `[2]` the student's class Drive folder.

## Detail parser (`src/collector/classroom/detail.ts`)
`parseAssignmentDetail({ item, materials?, submissions?, comments?, studentId? })` combines `tQShAc` (or an item already parsed from a list), `t51ITc`, one or both `Zj93ge` responses (list mask + attachments mask, merged per submission) and `sLc6hf` into a zod-validated `AssignmentDetail`. Mappings:
- item kind: type 2 → `assignment` (→ `quiz` when a material is a Google Forms link), 7 → `material`, 5 → `question` (unverified), else `unknown`.
- submission `[5]`: 2 `turned_in`, 3 `returned`, 4 `new`, 5 `reclaimed`. Bucket `[20]`: 1 `assigned`, 2 `missing`, 3 `turned_in`, 4 `done_late`, 7 `returned`, 8 `graded`, 10 `graded_late`, 11 `excused`. `late` comes from the bucket only. `[21]` becomes `turnedInAt` (state 2) or `returnedAt` (state 3).
- attachment origin `[15]` and type `[3]` as above; Forms links become type/kind `form`. Annotated copies carry `annotatedSourceId` from `[14][3][1]`.
- comment author: `student` when `[4][0]` equals the submission key's student id, else `teacher`.
- "Copy for each student" (unverified): a student Google-native file is linked to a Google-native material by `[14][3][1]` or by title (`<title>` or `… - <title>`) and gets `templateSourceId`; the material gets `isTemplate`.
- Unknown enum values map to `unknown`; structural mismatches throw `ParseDriftError` with the rpcid and positional path.

## Dates and time zones
All timestamps, due dates included, are **UTC epoch milliseconds**. No time zone is stored on the item. The UI shows them in the browser's zone. A due date set "without time" shows up as 23:59 local (e.g. `20:59Z` for UTC+3). Evaluate deadlines as instants and render them in the family's configured zone.

## Recommended collection strategy
Rendering pages is slow, about 24 XHRs per detail page, and the DOM is lossy (collapsed sections, localized labels). The RPCs are plain read calls with the session cookies, and **calling them directly works**. We checked it with `fetch` from a loaded Classroom page for `tQShAc`, `Zj93ge` (170 submissions in one call), `t51ITc` and `pONvgf` (with and without filters, plus pagination).

1. Per account, open **one** page headless (`/a/not-turned-in/all?authuser=<email>`). Read `WIZ_global_data` (`SNlM0e`, `FdrFJe`, `cfb2h`, `x3UoP`) and the `/u/<n>` prefix from the final URL.
2. From that page's context (same-origin `fetch`, cookies included), call:
   - `gXtzob` (courses, keep `[20]=1`). The own user id comes from `WIZ_global_data.x3UoP`.
   - `pONvgf` with all buckets `[1,2,3,4,5,6,7,8,9,10,11]` per active course, following the page token. This returns all assignments.
   - `Zj93ge` (list mask) in batches of about 100 keys → state, bucket and grade.
   - `Zj93ge` (mask `[null,1,null,1]`) for turned-in or returned submissions → student files.
   - `t51ITc` once per item with material refs (`base[27][0][4]`), only when `base[2]` (updated) changed.
   - `sLc6hf` (private comments) per submission, only when the submission's `[2]` changed.
3. Use the exact request templates (masks) from `fixtures/classroom/*.json`. Allow-list these read rpcids in code and never send any other rpcid.
4. Keep the recon capture (`pnpm cli recon`) as the fallback and as a diagnostic when shapes drift. It renders the pages and records everything passively.

Risks: this is an undocumented internal API. Positions or rpcids can change with a Classroom release (watch `bl`). Masks control which fields come back. The XSRF token is per page load. Keep the request rate low (sequential, small delays) to avoid throttling. No Google challenge, captcha or re-auth prompt appeared during recon, headless included.

## Files
- Google Docs: `https://docs.google.com/document/d/<id>/export?format=txt`
- Slides: `https://docs.google.com/presentation/d/<id>/export/txt`
- Sheets: `https://docs.google.com/spreadsheets/d/<id>/export?format=csv`
- Drive binaries (student photos and videos are most student work seen): attachment `[6]` view URL and `[5]` thumbnail template (`={size}` → e.g. `=s1600`, unverified). Download path still to be confirmed.

## Recon tool
`pnpm cli recon [--headless] [--account <n>] [--url <path|url>…] [--url-file <file>] [--scroll <n>]` saves, per watched account, the server HTML (`page-NN.html`), the rendered DOM (`page-NN.dom.html`), every XHR/fetch with its request and response (`xhr/NNNN-<rpcid>.json`) and a `manifest.json` under `<dataDir>/captures/<watchIndex>/<timestamp>/`. That is real data and stays local. `scripts/anonymize.ts` turns selected exchanges into fixtures, and fails if any replaced value survives.

## Safety
Recon and collection are **read-only**. Never trigger turn in, unsubmit, mark as done, comments or any other state change. The detail page shows **Unsubmit**, **Turn in** and **Mark as done** buttons. The recon never clicks; it only navigates and scrolls.
