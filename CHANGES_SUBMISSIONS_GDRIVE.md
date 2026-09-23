# EduVault: Submission Requests + Google Drive (v3)

## Database transaction fix (v3)

`db.createSubmissionWithFiles()` wraps in a single PostgreSQL transaction:

```
BEGIN
  INSERT submission_records
  INSERT submission_files (for each file)
COMMIT
```

On any failure: `ROLLBACK` (no orphan submission row), then delete newly uploaded Drive files, clean temps, return error.

### Replace flow
1. Old submission untouched
2. Upload new files to Drive
3. Transaction creates new record + all file rows
4. After COMMIT: delete old DB row + old Drive files
5. On failure before COMMIT: rollback DB, delete only new Drive files, keep old submission

## Prior fixes retained
- Backend streaming of teacher materials (no Drive links to students)
- No silent local/S3 fallback
- Drive upload rollback on failure
