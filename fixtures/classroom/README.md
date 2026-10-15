# Classroom RPC fixtures (anonymized)

These are real `batchexecute` exchanges from the #18 recon, put through `scripts/anonymize.ts`. Structure is preserved exactly: array shapes, positions, types, enums, mime types and encodings. Everything that could identify anyone is replaced:
- ids get random values of the same shape. They stay consistent across files, so joins still work.
- timestamps are shifted by whole weeks.
- names, titles and text become lorem words, and emails become `userN@school.example`.
- non-Google hosts become `example.com`.

Field meanings are in [`docs/CLASSROOM-INTERNALS.md`](../../docs/CLASSROOM-INTERNALS.md), and `test/classroom-fixtures.test.ts` pins them.

Each `*.json` file is `{ rpcid, sourcePath, request, response }`, where `request` is the decoded `f.req` args and `response` is the decoded `wrb.fr` payload.

| file | rpc | content |
|---|---|---|
| `envelope.Zj93ge.txt` | — | raw response body (`)]}'` + length-prefixed chunks) |
| `courses.gXtzob.json` | `gXtzob` | 3 courses (1 active, 2 archived) |
| `self.UG41I.json`, `users.UG41I.json` | `UG41I` | the student; teachers |
| `todo.pONvgf.json` | `pONvgf` | To-do query page (with next-page token), 12 assignments covering every observed bucket and `work[18]` kind |
| `submissions.Zj93ge.json` | `Zj93ge` | the submissions for those 12 items (list mask): buckets 1, 2, 3, 4, 7, 8, 10, 11 |
| `detail.tQShAc.json`, `detail-lite.tQShAc.json` | `tQShAc` | one assignment by id (full and minimal mask) |
| `detail-submission.Zj93ge.json`, `detail-attachments.Zj93ge.json` | `Zj93ge` | its submission (state mask, attachments mask) |
| `detail-materials.t51ITc.json` | `t51ITc` | its materials: link + Drive video |
| `materials-youtube-link.t51ITc.json` | `t51ITc` | YouTube + link materials |
| `annotated-attachment.Zj93ge.json` | `Zj93ge` | student file + teacher-annotated copy (`[15]` = 3) |
| `private-comments.sLc6hf.json`, `class-comments-empty.sLc6hf.json` | `sLc6hf` | private comments on a submission; empty class comments |
| `private-comments-batch.sLc6hf.json` | `sLc6hf` | **synthetic**: one request over three submission keys (teacher + student comments on two of them), the shape the sync sends |
| `material-ref-signed.pONvgf.json`, `material-ref-signed.t51ITc.json` | `pONvgf`, `t51ITc` | one To-do item (trimmed page) whose description refs one positive and one **negative** material id, and its materials (link + YouTube) (#68) |
| `classwork.dpT4Vd.json` | `dpT4Vd` | classwork topic page with a material post (type 7) and an assignment |
| `material-detail.tQShAc.json` | `tQShAc` | material post by id |
| `course-user.O1Xqee.json`, `detail.cCzVwf.json` | | membership; add-on attachments (?) |
| `synthetic-template-copy.json` | `t51ITc`, `Zj93ge` | **synthetic** (hand-written, never captured): a Google Doc template material and the student's copy, for the "make a copy for each student" guess |

To regenerate from local captures (real data stays in `.data/`):

```sh
pnpm tsx scripts/anonymize.ts --out fixtures/classroom .data/fixture-src/*.json .data/fixture-src/*.txt
```

Before committing, also grep the output for the watched emails, school domain and real ids. The script fails on any value it replaced that still shows up, but it can't know about values it never saw.
