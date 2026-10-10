import { type Db, raiseAlert } from "../store/index.ts";
import { type AlertDraft, type DeadlineInput, evaluateDeadlineRules } from "./deadlines.ts";

/** Loads open assignments of watched accounts as plain `DeadlineInput` snapshots. */
export async function loadDeadlineInputs(db: Db): Promise<DeadlineInput[]> {
  const rows = await db.assignment.findMany({
    where: {
      account: { watched: true },
      kind: { not: "material" },
      status: { notIn: ["turned_in", "returned"] },
    },
    include: {
      course: { select: { name: true } },
      submission: { include: { attachments: { where: { owner: "submission" } } } },
    },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => {
    const s = r.submission;
    const edits = s?.attachments.flatMap((x) => (x.modifiedAt ? [x.modifiedAt.getTime()] : []));
    return {
      assignment: {
        id: r.id,
        kind: r.kind,
        title: r.title,
        courseName: r.course.name,
        dueAt: r.dueAt,
        postedAt: r.postedAt,
        firstSeenAt: r.firstSeenAt,
        status: r.status,
      },
      submission: s && {
        state: s.state,
        turnedInAt: s.turnedInAt,
        studentWorkSignals: {
          attachmentCount: s.attachments.length,
          lastStudentEditAt: edits?.length ? new Date(Math.max(...edits)) : null,
        },
      },
    };
  });
}

/** Runs the deadline rules over the store and raises (deduped) alerts. Returns new alerts only. */
export async function evaluateDeadlines(db: Db, now: Date = new Date()): Promise<AlertDraft[]> {
  const drafts = evaluateDeadlineRules(await loadDeadlineInputs(db), now);
  const created: AlertDraft[] = [];
  for (const d of drafts) {
    const res = await raiseAlert(db, { key: d.key, level: d.level, message: d.message }, now);
    if (res.created) created.push(d);
  }
  return created;
}
