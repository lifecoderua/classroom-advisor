import type { Db } from "./db.ts";
import type { Account, Course } from "./generated/client.ts";

export interface AccountInput {
  email: string;
  displayName?: string | null;
  authuser?: string | null;
}

/** Creates or refreshes an account seen in the session. Leaves `watched` alone. */
export function upsertAccount(db: Db, input: AccountInput): Promise<Account> {
  const data = { displayName: input.displayName ?? null, authuser: input.authuser ?? null };
  return db.account.upsert({
    where: { email: input.email },
    create: { email: input.email, ...data },
    update: data,
  });
}

/** Makes `emails` the watch list: listed accounts become watched (created if new), others not. */
export async function setWatchedAccounts(db: Db, emails: readonly string[]): Promise<void> {
  await db.$transaction([
    db.account.updateMany({ where: { email: { notIn: [...emails] } }, data: { watched: false } }),
    ...emails.map((email) =>
      db.account.upsert({
        where: { email },
        create: { email, watched: true },
        update: { watched: true },
      }),
    ),
  ]);
}

export function listAccounts(db: Db, filter: { watched?: boolean } = {}): Promise<Account[]> {
  return db.account.findMany({
    ...(filter.watched === undefined ? {} : { where: { watched: filter.watched } }),
    orderBy: { email: "asc" },
  });
}

export interface CourseInput {
  accountId: number;
  classroomId: string;
  name: string;
}

export function upsertCourse(db: Db, input: CourseInput, now: Date = new Date()): Promise<Course> {
  const { accountId, classroomId, name } = input;
  return db.course.upsert({
    where: { accountId_classroomId: { accountId, classroomId } },
    create: { accountId, classroomId, name, firstSeenAt: now, lastSeenAt: now },
    update: { name, lastSeenAt: now },
  });
}
