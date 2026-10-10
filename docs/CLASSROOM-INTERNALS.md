# Classroom web internals

What we know about the data Classroom's web app loads. The recon in #18 fills this in, and the parsers (#5, #6) depend on it. **Write only the shapes here, never real values.**

## Pages of interest
- `https://classroom.google.com/a/not-turned-in/all?authuser=<email>`: assigned and not yet turned in
- `https://classroom.google.com/a/missing/all?authuser=<email>`: missing
- `https://classroom.google.com/a/turned-in/all?authuser=<email>`: done / turned in
- Assignment detail (student view): URL pattern to be confirmed

## Endpoints / payloads
_TBD by recon: RPC endpoints (batchexecute rpcids?), whether the HTML embeds `AF_initDataCallback` data, field positions, ID formats, date and timezone encoding, turn-in state encoding, and how student attachments and "copy for each student" templates appear._

## Files
- Google Docs: `https://docs.google.com/document/d/<id>/export?format=txt`
- Slides: `https://docs.google.com/presentation/d/<id>/export/txt`
- Sheets: `https://docs.google.com/spreadsheets/d/<id>/export?format=csv`
- Drive binaries: to be confirmed

## Safety
Recon and collection are **read-only**. Never trigger turn in, unsubmit, mark as done, comments or any other state change.
