-- AlterTable
ALTER TABLE "Account" ADD COLUMN "baselineAt" DATETIME;

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accountId" INTEGER NOT NULL,
    "assignmentId" INTEGER,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "stats" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    CONSTRAINT "SyncRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Assignment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "courseId" INTEGER NOT NULL,
    "classroomId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" DATETIME,
    "postedAt" DATETIME,
    "status" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,
    "summaryHash" TEXT,
    "detailFetchedAt" DATETIME,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Assignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Assignment" ("accountId", "classroomId", "courseId", "currentHash", "dueAt", "firstSeenAt", "id", "kind", "lastSeenAt", "postedAt", "status", "title") SELECT "accountId", "classroomId", "courseId", "currentHash", "dueAt", "firstSeenAt", "id", "kind", "lastSeenAt", "postedAt", "status", "title" FROM "Assignment";
DROP TABLE "Assignment";
ALTER TABLE "new_Assignment" RENAME TO "Assignment";
CREATE INDEX "Assignment_dueAt_idx" ON "Assignment"("dueAt");
CREATE UNIQUE INDEX "Assignment_accountId_classroomId_key" ON "Assignment"("accountId", "classroomId");
CREATE TABLE "new_Attachment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "assignmentId" INTEGER NOT NULL,
    "submissionId" INTEGER,
    "owner" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "driveFileId" TEXT,
    "mime" TEXT,
    "modifiedAt" DATETIME,
    "contentPath" TEXT,
    "contentHash" TEXT,
    "fetchedAt" DATETIME,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "templateSourceId" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attachment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attachment" ("assignmentId", "contentHash", "contentPath", "driveFileId", "fetchedAt", "firstSeenAt", "id", "lastSeenAt", "mime", "modifiedAt", "owner", "submissionId", "title", "url") SELECT "assignmentId", "contentHash", "contentPath", "driveFileId", "fetchedAt", "firstSeenAt", "id", "lastSeenAt", "mime", "modifiedAt", "owner", "submissionId", "title", "url" FROM "Attachment";
DROP TABLE "Attachment";
ALTER TABLE "new_Attachment" RENAME TO "Attachment";
CREATE INDEX "Attachment_driveFileId_idx" ON "Attachment"("driveFileId");
CREATE UNIQUE INDEX "Attachment_assignmentId_owner_url_key" ON "Attachment"("assignmentId", "owner", "url");
CREATE TABLE "new_SubmissionVersion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submissionId" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubmissionVersion_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SubmissionVersion" ("hash", "id", "payload", "seenAt", "state", "submissionId") SELECT "hash", "id", "payload", "seenAt", "state", "submissionId" FROM "SubmissionVersion";
DROP TABLE "SubmissionVersion";
ALTER TABLE "new_SubmissionVersion" RENAME TO "SubmissionVersion";
CREATE INDEX "SubmissionVersion_submissionId_seenAt_idx" ON "SubmissionVersion"("submissionId", "seenAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Event_key_key" ON "Event"("key");

-- CreateIndex
CREATE INDEX "Event_type_createdAt_idx" ON "Event"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SyncRun_accountId_startedAt_idx" ON "SyncRun"("accountId", "startedAt");
