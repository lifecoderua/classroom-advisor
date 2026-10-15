-- expects-work.v3 (#69): reference videos no longer make a post `unclear`. Forget the stored
-- `unclear` verdicts so they are classified again (lazily, only where a reminder would fire).
UPDATE "AssignmentVersion"
SET "expectsWork" = NULL, "expectsWorkReason" = NULL, "expectsWorkSource" = NULL, "expectsWorkAt" = NULL
WHERE "expectsWork" = 'unclear';
