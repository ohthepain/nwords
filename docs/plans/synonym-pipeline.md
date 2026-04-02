# Synonym Pipeline

There are exact and inexact synonyms.
It's frustrating for the to be told that an exact synonym is incorrect (innan instead of före, for example).

## Report word component

Users can report sentences (model ClozeIssueReport) for which they feel there is a problem. Sometimes this can be an issue of synonyms.

Ad admin can review the ClozeIssueReport records for synonyms. The options are

### good synonym

The synonym record is added to the database for the word going in both directions. The synonym is marked as 'good'.

### bad synonym

The synonym record is added to the database for the word going in both directions. The synonym is marked as 'bad'.

this can be done by an admin in response to a ClozeIssueReport. When we show a ClozeIssueReport in admin/@apps/web/src/routes/\_authed/\_admin/admin/cloze-reports.tsx we shoudl show the user's guess. then there can be a button for 'bad synonym' and 'good synonym' next to the user's guess. then we should save the synonyms in the database going both ways. then when the user makes a guess we should check the user's guess against known synonyms. we should do this in the same place that we check for bad POS matches, but BEFORE we check for bad POS matches. then if the user guessed a bad synonym we tell them. if they guess a good synonym then we tell them but notify them that they actually have to guess the correct word to pass the word.
