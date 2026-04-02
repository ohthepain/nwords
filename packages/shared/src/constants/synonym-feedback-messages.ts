/**
 * User-facing synonym feedback in the learner's **native** language.
 * `good` uses {guess} only (never reveal the exercise’s expected lemma).
 * `bad` uses {guess} and {target}.
 */

type SynonymTemplates = { good: string; bad: string }

const en: SynonymTemplates = {
	good: "“{guess}” is an acceptable synonym here, but enter the word this exercise expects for it to count as correct.",
	bad: "“{guess}” isn’t the right word in this context — try “{target}”.",
}

const sv: SynonymTemplates = {
	good: "“{guess}” är en bra synonym här, men skriv det ord som övningen förväntar sig för att få rätt.",
	bad: "“{guess}” passar inte här — prova “{target}”.",
}

const fr: SynonymTemplates = {
	good: "« {guess} » est un synonyme acceptable ici, mais saisissez le mot attendu par cet exercice pour que ce soit compté comme juste.",
	bad: "« {guess} » n’est pas le bon mot dans ce contexte — essayez « {target} ».",
}

const de: SynonymTemplates = {
	good: "„{guess}“ ist hier ein akzeptables Synonym, aber gib das Wort ein, das diese Übung erwartet, damit es als richtig zählt.",
	bad: "„{guess}“ ist in diesem Kontext nicht das passende Wort — versuch „{target}“.",
}

const es: SynonymTemplates = {
	good: "«{guess}» es un sinónimo aceptable aquí, pero escribe la palabra que este ejercicio espera para que cuente como correcta.",
	bad: "«{guess}» no es la palabra adecuada en este contexto — prueba «{target}».",
}

const fi: SynonymTemplates = {
	good: "“{guess}” on hyväksyttävä synonyymi tässä, mutta kirjoita tämän harjoituksen odottama sana, jotta vastaus lasketaan oikein.",
	bad: "“{guess}” ei sovi tähän yhteyteen — kokeile “{target}”.",
}

const MESSAGES: Record<string, SynonymTemplates> = {
	en,
	sv,
	fr,
	de,
	es,
	fi,
}

function fill(template: string, guess: string, target: string): string {
	return template.replaceAll("{guess}", guess).replaceAll("{target}", target)
}

export function getAcceptableSynonymMessage(
	nativeLanguageCode: string,
	guessLemma: string,
): string {
	const t = MESSAGES[nativeLanguageCode] ?? MESSAGES.en
	return t.good.replaceAll("{guess}", guessLemma)
}

export function getUnacceptableSynonymMessage(
	nativeLanguageCode: string,
	guessLemma: string,
	targetLemma: string,
): string {
	const t = MESSAGES[nativeLanguageCode] ?? MESSAGES.en
	return fill(t.bad, guessLemma, targetLemma)
}
