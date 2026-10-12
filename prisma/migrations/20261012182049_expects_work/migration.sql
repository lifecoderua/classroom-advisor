-- AlterTable
ALTER TABLE "AssignmentVersion" ADD COLUMN "expectsWork" TEXT;
ALTER TABLE "AssignmentVersion" ADD COLUMN "expectsWorkAt" DATETIME;
ALTER TABLE "AssignmentVersion" ADD COLUMN "expectsWorkReason" TEXT;
ALTER TABLE "AssignmentVersion" ADD COLUMN "expectsWorkSource" TEXT;
ALTER TABLE "AssignmentVersion" ADD COLUMN "skeletonHash" TEXT;

-- CreateIndex
CREATE INDEX "AssignmentVersion_skeletonHash_idx" ON "AssignmentVersion"("skeletonHash");
