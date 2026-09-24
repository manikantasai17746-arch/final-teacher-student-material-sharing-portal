# EduVault V6

Backward-compatible upgrade. Existing data, Drive connections, and architecture preserved.

## Added
- Global server-side search (admin students/teachers/invitations)
- Invitation permanent Delete (separate from Revoke)
- Bulk teacher invitations via Excel (.xlsx/.xls/csv) with preview
- Anonymous teaching feedback (HMAC duplicate guard, no student identity in responses)
- Quiz system (correct answers only after deadline; roll-number-first results)
- Create ZIP & Keep Files (alongside Archive & Free Drive Space)
- Deadline timezone fix (datetime-local no UTC shift)
- PDF iframe preview SAMEORIGIN on view routes
- Multi-file upload copy clarity

## Migrations
Auto on startup via ensureFeedbackAndQuizSchema (CREATE IF NOT EXISTS only).

## Install
```bash
npm install
```

## Run
```bash
npm start
```
