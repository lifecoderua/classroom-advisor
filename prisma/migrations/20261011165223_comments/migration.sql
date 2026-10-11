-- CreateTable
CREATE TABLE "Comment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "assignmentId" INTEGER NOT NULL,
    "classroomId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "authorId" TEXT,
    "text" TEXT NOT NULL,
    "postedAt" DATETIME NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Comment_assignmentId_postedAt_idx" ON "Comment"("assignmentId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_assignmentId_classroomId_key" ON "Comment"("assignmentId", "classroomId");
