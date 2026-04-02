# Synonym Pipeline

There are exact and inexact synonyms.
It's frustrating for the to be told that an exact synonym is incorrect (innan instead of före, for example).

## Report word component

Users can report sentences (model ClozeIssueReport) for which they feel there is a problem. Sometimes this can be an issue of synonyms.

Ad admin can review the ClozeIssueReport records for synonyms. When we show a ClozeIssueReport in admin/@apps/web/src/routes/\_authed/\_admin/admin/cloze-reports.tsx we show the user's guess. then there can be a button for 'bad synonym' and 'good synonym' next to the user's guess. The options are

### good synonym

The synonym record is added to the database for the user's guess word going in both directions. The synonym is marked as 'good'.

### bad synonym

The synonym record is added to the database for the user's guess word going in both directions. The synonym is marked as 'bad'.

