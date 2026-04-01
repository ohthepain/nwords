/**
 * Static POS mismatch messages keyed by language code.
 *
 * Each entry maps (guessPos, targetPos) → a short, natural-language sentence
 * in the user's **native** language.  Used by the ingestion job to seed
 * the `pos_mismatch_message` table.
 *
 * Rules followed when authoring:
 *   - One sentence only
 *   - No placeholders or variables
 *   - No examples or quotes
 *   - Natural modern language
 *   - Neutral instructional tone
 */

export type PosKey = "NOUN" | "VERB" | "ADJECTIVE" | "ADVERB"

type PosPairMessages = Partial<Record<PosKey, Partial<Record<PosKey, string>>>>

// ---------------------------------------------------------------------------
// English (fallback for any language without its own messages)
// ---------------------------------------------------------------------------

const en: PosPairMessages = {
	NOUN: {
		VERB: "We were looking for a verb but you entered a noun.",
		ADJECTIVE: "We were looking for an adjective but you entered a noun.",
		ADVERB: "We were looking for an adverb but you entered a noun.",
	},
	VERB: {
		NOUN: "We were looking for a noun but you entered a verb.",
		ADJECTIVE: "We were looking for an adjective but you entered a verb.",
		ADVERB: "We were looking for an adverb but you entered a verb.",
	},
	ADJECTIVE: {
		NOUN: "We were looking for a noun but you entered an adjective.",
		VERB: "We were looking for a verb but you entered an adjective.",
		ADVERB: "We were looking for an adverb but you entered an adjective.",
	},
	ADVERB: {
		NOUN: "We were looking for a noun but you entered an adverb.",
		VERB: "We were looking for a verb but you entered an adverb.",
		ADJECTIVE: "We were looking for an adjective but you entered an adverb.",
	},
}

// ---------------------------------------------------------------------------
// Swedish
// ---------------------------------------------------------------------------

const sv: PosPairMessages = {
	NOUN: {
		VERB: "Vi letade efter ett verb men du skrev ett substantiv.",
		ADJECTIVE: "Vi letade efter ett adjektiv men du skrev ett substantiv.",
		ADVERB: "Vi letade efter ett adverb men du skrev ett substantiv.",
	},
	VERB: {
		NOUN: "Vi letade efter ett substantiv men du skrev ett verb.",
		ADJECTIVE: "Vi letade efter ett adjektiv men du skrev ett verb.",
		ADVERB: "Vi letade efter ett adverb men du skrev ett verb.",
	},
	ADJECTIVE: {
		NOUN: "Vi letade efter ett substantiv men du skrev ett adjektiv.",
		VERB: "Vi letade efter ett verb men du skrev ett adjektiv.",
		ADVERB: "Vi letade efter ett adverb men du skrev ett adjektiv.",
	},
	ADVERB: {
		NOUN: "Vi letade efter ett substantiv men du skrev ett adverb.",
		VERB: "Vi letade efter ett verb men du skrev ett adverb.",
		ADJECTIVE: "Vi letade efter ett adjektiv men du skrev ett adverb.",
	},
}

// ---------------------------------------------------------------------------
// French
// ---------------------------------------------------------------------------

const fr: PosPairMessages = {
	NOUN: {
		VERB: "Nous cherchions un verbe mais vous avez saisi un nom.",
		ADJECTIVE: "Nous cherchions un adjectif mais vous avez saisi un nom.",
		ADVERB: "Nous cherchions un adverbe mais vous avez saisi un nom.",
	},
	VERB: {
		NOUN: "Nous cherchions un nom mais vous avez saisi un verbe.",
		ADJECTIVE: "Nous cherchions un adjectif mais vous avez saisi un verbe.",
		ADVERB: "Nous cherchions un adverbe mais vous avez saisi un verbe.",
	},
	ADJECTIVE: {
		NOUN: "Nous cherchions un nom mais vous avez saisi un adjectif.",
		VERB: "Nous cherchions un verbe mais vous avez saisi un adjectif.",
		ADVERB: "Nous cherchions un adverbe mais vous avez saisi un adjectif.",
	},
	ADVERB: {
		NOUN: "Nous cherchions un nom mais vous avez saisi un adverbe.",
		VERB: "Nous cherchions un verbe mais vous avez saisi un adverbe.",
		ADJECTIVE: "Nous cherchions un adjectif mais vous avez saisi un adverbe.",
	},
}

// ---------------------------------------------------------------------------
// German
// ---------------------------------------------------------------------------

const de: PosPairMessages = {
	NOUN: {
		VERB: "Wir suchten ein Verb, aber du hast ein Substantiv eingegeben.",
		ADJECTIVE: "Wir suchten ein Adjektiv, aber du hast ein Substantiv eingegeben.",
		ADVERB: "Wir suchten ein Adverb, aber du hast ein Substantiv eingegeben.",
	},
	VERB: {
		NOUN: "Wir suchten ein Substantiv, aber du hast ein Verb eingegeben.",
		ADJECTIVE: "Wir suchten ein Adjektiv, aber du hast ein Verb eingegeben.",
		ADVERB: "Wir suchten ein Adverb, aber du hast ein Verb eingegeben.",
	},
	ADJECTIVE: {
		NOUN: "Wir suchten ein Substantiv, aber du hast ein Adjektiv eingegeben.",
		VERB: "Wir suchten ein Verb, aber du hast ein Adjektiv eingegeben.",
		ADVERB: "Wir suchten ein Adverb, aber du hast ein Adjektiv eingegeben.",
	},
	ADVERB: {
		NOUN: "Wir suchten ein Substantiv, aber du hast ein Adverb eingegeben.",
		VERB: "Wir suchten ein Verb, aber du hast ein Adverb eingegeben.",
		ADJECTIVE: "Wir suchten ein Adjektiv, aber du hast ein Adverb eingegeben.",
	},
}

// ---------------------------------------------------------------------------
// Spanish
// ---------------------------------------------------------------------------

const es: PosPairMessages = {
	NOUN: {
		VERB: "Buscábamos un verbo pero escribiste un sustantivo.",
		ADJECTIVE: "Buscábamos un adjetivo pero escribiste un sustantivo.",
		ADVERB: "Buscábamos un adverbio pero escribiste un sustantivo.",
	},
	VERB: {
		NOUN: "Buscábamos un sustantivo pero escribiste un verbo.",
		ADJECTIVE: "Buscábamos un adjetivo pero escribiste un verbo.",
		ADVERB: "Buscábamos un adverbio pero escribiste un verbo.",
	},
	ADJECTIVE: {
		NOUN: "Buscábamos un sustantivo pero escribiste un adjetivo.",
		VERB: "Buscábamos un verbo pero escribiste un adjetivo.",
		ADVERB: "Buscábamos un adverbio pero escribiste un adjetivo.",
	},
	ADVERB: {
		NOUN: "Buscábamos un sustantivo pero escribiste un adverbio.",
		VERB: "Buscábamos un verbo pero escribiste un adverbio.",
		ADJECTIVE: "Buscábamos un adjetivo pero escribiste un adverbio.",
	},
}

// ---------------------------------------------------------------------------
// Italian
// ---------------------------------------------------------------------------

const it: PosPairMessages = {
	NOUN: {
		VERB: "Cercavamo un verbo ma hai inserito un sostantivo.",
		ADJECTIVE: "Cercavamo un aggettivo ma hai inserito un sostantivo.",
		ADVERB: "Cercavamo un avverbio ma hai inserito un sostantivo.",
	},
	VERB: {
		NOUN: "Cercavamo un sostantivo ma hai inserito un verbo.",
		ADJECTIVE: "Cercavamo un aggettivo ma hai inserito un verbo.",
		ADVERB: "Cercavamo un avverbio ma hai inserito un verbo.",
	},
	ADJECTIVE: {
		NOUN: "Cercavamo un sostantivo ma hai inserito un aggettivo.",
		VERB: "Cercavamo un verbo ma hai inserito un aggettivo.",
		ADVERB: "Cercavamo un avverbio ma hai inserito un aggettivo.",
	},
	ADVERB: {
		NOUN: "Cercavamo un sostantivo ma hai inserito un avverbio.",
		VERB: "Cercavamo un verbo ma hai inserito un avverbio.",
		ADJECTIVE: "Cercavamo un aggettivo ma hai inserito un avverbio.",
	},
}

// ---------------------------------------------------------------------------
// Portuguese
// ---------------------------------------------------------------------------

const pt: PosPairMessages = {
	NOUN: {
		VERB: "Procurávamos um verbo mas você digitou um substantivo.",
		ADJECTIVE: "Procurávamos um adjetivo mas você digitou um substantivo.",
		ADVERB: "Procurávamos um advérbio mas você digitou um substantivo.",
	},
	VERB: {
		NOUN: "Procurávamos um substantivo mas você digitou um verbo.",
		ADJECTIVE: "Procurávamos um adjetivo mas você digitou um verbo.",
		ADVERB: "Procurávamos um advérbio mas você digitou um verbo.",
	},
	ADJECTIVE: {
		NOUN: "Procurávamos um substantivo mas você digitou um adjetivo.",
		VERB: "Procurávamos um verbo mas você digitou um adjetivo.",
		ADVERB: "Procurávamos um advérbio mas você digitou um adjetivo.",
	},
	ADVERB: {
		NOUN: "Procurávamos um substantivo mas você digitou um advérbio.",
		VERB: "Procurávamos um verbo mas você digitou um advérbio.",
		ADJECTIVE: "Procurávamos um adjetivo mas você digitou um advérbio.",
	},
}

// ---------------------------------------------------------------------------
// Dutch
// ---------------------------------------------------------------------------

const nl: PosPairMessages = {
	NOUN: {
		VERB: "We zochten een werkwoord maar je typte een zelfstandig naamwoord.",
		ADJECTIVE: "We zochten een bijvoeglijk naamwoord maar je typte een zelfstandig naamwoord.",
		ADVERB: "We zochten een bijwoord maar je typte een zelfstandig naamwoord.",
	},
	VERB: {
		NOUN: "We zochten een zelfstandig naamwoord maar je typte een werkwoord.",
		ADJECTIVE: "We zochten een bijvoeglijk naamwoord maar je typte een werkwoord.",
		ADVERB: "We zochten een bijwoord maar je typte een werkwoord.",
	},
	ADJECTIVE: {
		NOUN: "We zochten een zelfstandig naamwoord maar je typte een bijvoeglijk naamwoord.",
		VERB: "We zochten een werkwoord maar je typte een bijvoeglijk naamwoord.",
		ADVERB: "We zochten een bijwoord maar je typte een bijvoeglijk naamwoord.",
	},
	ADVERB: {
		NOUN: "We zochten een zelfstandig naamwoord maar je typte een bijwoord.",
		VERB: "We zochten een werkwoord maar je typte een bijwoord.",
		ADJECTIVE: "We zochten een bijvoeglijk naamwoord maar je typte een bijwoord.",
	},
}

// ---------------------------------------------------------------------------
// Finnish
// ---------------------------------------------------------------------------

const fi: PosPairMessages = {
	NOUN: {
		VERB: "Haimme verbiä mutta kirjoitit substantiivin.",
		ADJECTIVE: "Haimme adjektiivia mutta kirjoitit substantiivin.",
		ADVERB: "Haimme adverbia mutta kirjoitit substantiivin.",
	},
	VERB: {
		NOUN: "Haimme substantiivia mutta kirjoitit verbin.",
		ADJECTIVE: "Haimme adjektiivia mutta kirjoitit verbin.",
		ADVERB: "Haimme adverbia mutta kirjoitit verbin.",
	},
	ADJECTIVE: {
		NOUN: "Haimme substantiivia mutta kirjoitit adjektiivin.",
		VERB: "Haimme verbiä mutta kirjoitit adjektiivin.",
		ADVERB: "Haimme adverbia mutta kirjoitit adjektiivin.",
	},
	ADVERB: {
		NOUN: "Haimme substantiivia mutta kirjoitit adverbin.",
		VERB: "Haimme verbiä mutta kirjoitit adverbin.",
		ADJECTIVE: "Haimme adjektiivia mutta kirjoitit adverbin.",
	},
}

// ---------------------------------------------------------------------------
// Danish
// ---------------------------------------------------------------------------

const da: PosPairMessages = {
	NOUN: {
		VERB: "Vi ledte efter et verbum men du skrev et substantiv.",
		ADJECTIVE: "Vi ledte efter et adjektiv men du skrev et substantiv.",
		ADVERB: "Vi ledte efter et adverbium men du skrev et substantiv.",
	},
	VERB: {
		NOUN: "Vi ledte efter et substantiv men du skrev et verbum.",
		ADJECTIVE: "Vi ledte efter et adjektiv men du skrev et verbum.",
		ADVERB: "Vi ledte efter et adverbium men du skrev et verbum.",
	},
	ADJECTIVE: {
		NOUN: "Vi ledte efter et substantiv men du skrev et adjektiv.",
		VERB: "Vi ledte efter et verbum men du skrev et adjektiv.",
		ADVERB: "Vi ledte efter et adverbium men du skrev et adjektiv.",
	},
	ADVERB: {
		NOUN: "Vi ledte efter et substantiv men du skrev et adverbium.",
		VERB: "Vi ledte efter et verbum men du skrev et adverbium.",
		ADJECTIVE: "Vi ledte efter et adjektiv men du skrev et adverbium.",
	},
}

// ---------------------------------------------------------------------------
// Norwegian (Bokmål)
// ---------------------------------------------------------------------------

const nb: PosPairMessages = {
	NOUN: {
		VERB: "Vi lette etter et verb men du skrev et substantiv.",
		ADJECTIVE: "Vi lette etter et adjektiv men du skrev et substantiv.",
		ADVERB: "Vi lette etter et adverb men du skrev et substantiv.",
	},
	VERB: {
		NOUN: "Vi lette etter et substantiv men du skrev et verb.",
		ADJECTIVE: "Vi lette etter et adjektiv men du skrev et verb.",
		ADVERB: "Vi lette etter et adverb men du skrev et verb.",
	},
	ADJECTIVE: {
		NOUN: "Vi lette etter et substantiv men du skrev et adjektiv.",
		VERB: "Vi lette etter et verb men du skrev et adjektiv.",
		ADVERB: "Vi lette etter et adverb men du skrev et adjektiv.",
	},
	ADVERB: {
		NOUN: "Vi lette etter et substantiv men du skrev et adverb.",
		VERB: "Vi lette etter et verb men du skrev et adverb.",
		ADJECTIVE: "Vi lette etter et adjektiv men du skrev et adverb.",
	},
}

// ---------------------------------------------------------------------------
// Polish
// ---------------------------------------------------------------------------

const pl: PosPairMessages = {
	NOUN: {
		VERB: "Szukaliśmy czasownika, ale wpisałeś rzeczownik.",
		ADJECTIVE: "Szukaliśmy przymiotnika, ale wpisałeś rzeczownik.",
		ADVERB: "Szukaliśmy przysłówka, ale wpisałeś rzeczownik.",
	},
	VERB: {
		NOUN: "Szukaliśmy rzeczownika, ale wpisałeś czasownik.",
		ADJECTIVE: "Szukaliśmy przymiotnika, ale wpisałeś czasownik.",
		ADVERB: "Szukaliśmy przysłówka, ale wpisałeś czasownik.",
	},
	ADJECTIVE: {
		NOUN: "Szukaliśmy rzeczownika, ale wpisałeś przymiotnik.",
		VERB: "Szukaliśmy czasownika, ale wpisałeś przymiotnik.",
		ADVERB: "Szukaliśmy przysłówka, ale wpisałeś przymiotnik.",
	},
	ADVERB: {
		NOUN: "Szukaliśmy rzeczownika, ale wpisałeś przysłówek.",
		VERB: "Szukaliśmy czasownika, ale wpisałeś przysłówek.",
		ADJECTIVE: "Szukaliśmy przymiotnika, ale wpisałeś przysłówek.",
	},
}

// ---------------------------------------------------------------------------
// Russian
// ---------------------------------------------------------------------------

const ru: PosPairMessages = {
	NOUN: {
		VERB: "Мы искали глагол, а вы ввели существительное.",
		ADJECTIVE: "Мы искали прилагательное, а вы ввели существительное.",
		ADVERB: "Мы искали наречие, а вы ввели существительное.",
	},
	VERB: {
		NOUN: "Мы искали существительное, а вы ввели глагол.",
		ADJECTIVE: "Мы искали прилагательное, а вы ввели глагол.",
		ADVERB: "Мы искали наречие, а вы ввели глагол.",
	},
	ADJECTIVE: {
		NOUN: "Мы искали существительное, а вы ввели прилагательное.",
		VERB: "Мы искали глагол, а вы ввели прилагательное.",
		ADVERB: "Мы искали наречие, а вы ввели прилагательное.",
	},
	ADVERB: {
		NOUN: "Мы искали существительное, а вы ввели наречие.",
		VERB: "Мы искали глагол, а вы ввели наречие.",
		ADJECTIVE: "Мы искали прилагательное, а вы ввели наречие.",
	},
}

// ---------------------------------------------------------------------------
// Turkish
// ---------------------------------------------------------------------------

const tr: PosPairMessages = {
	NOUN: {
		VERB: "Bir fiil arıyorduk ama sen bir isim yazdın.",
		ADJECTIVE: "Bir sıfat arıyorduk ama sen bir isim yazdın.",
		ADVERB: "Bir zarf arıyorduk ama sen bir isim yazdın.",
	},
	VERB: {
		NOUN: "Bir isim arıyorduk ama sen bir fiil yazdın.",
		ADJECTIVE: "Bir sıfat arıyorduk ama sen bir fiil yazdın.",
		ADVERB: "Bir zarf arıyorduk ama sen bir fiil yazdın.",
	},
	ADJECTIVE: {
		NOUN: "Bir isim arıyorduk ama sen bir sıfat yazdın.",
		VERB: "Bir fiil arıyorduk ama sen bir sıfat yazdın.",
		ADVERB: "Bir zarf arıyorduk ama sen bir sıfat yazdın.",
	},
	ADVERB: {
		NOUN: "Bir isim arıyorduk ama sen bir zarf yazdın.",
		VERB: "Bir fiil arıyorduk ama sen bir zarf yazdın.",
		ADJECTIVE: "Bir sıfat arıyorduk ama sen bir zarf yazdın.",
	},
}

// ---------------------------------------------------------------------------
// Japanese
// ---------------------------------------------------------------------------

const ja: PosPairMessages = {
	NOUN: {
		VERB: "動詞を求めていましたが、名詞が入力されました。",
		ADJECTIVE: "形容詞を求めていましたが、名詞が入力されました。",
		ADVERB: "副詞を求めていましたが、名詞が入力されました。",
	},
	VERB: {
		NOUN: "名詞を求めていましたが、動詞が入力されました。",
		ADJECTIVE: "形容詞を求めていましたが、動詞が入力されました。",
		ADVERB: "副詞を求めていましたが、動詞が入力されました。",
	},
	ADJECTIVE: {
		NOUN: "名詞を求めていましたが、形容詞が入力されました。",
		VERB: "動詞を求めていましたが、形容詞が入力されました。",
		ADVERB: "副詞を求めていましたが、形容詞が入力されました。",
	},
	ADVERB: {
		NOUN: "名詞を求めていましたが、副詞が入力されました。",
		VERB: "動詞を求めていましたが、副詞が入力されました。",
		ADJECTIVE: "形容詞を求めていましたが、副詞が入力されました。",
	},
}

// ---------------------------------------------------------------------------
// Korean
// ---------------------------------------------------------------------------

const ko: PosPairMessages = {
	NOUN: {
		VERB: "동사를 찾고 있었지만 명사를 입력했습니다.",
		ADJECTIVE: "형용사를 찾고 있었지만 명사를 입력했습니다.",
		ADVERB: "부사를 찾고 있었지만 명사를 입력했습니다.",
	},
	VERB: {
		NOUN: "명사를 찾고 있었지만 동사를 입력했습니다.",
		ADJECTIVE: "형용사를 찾고 있었지만 동사를 입력했습니다.",
		ADVERB: "부사를 찾고 있었지만 동사를 입력했습니다.",
	},
	ADJECTIVE: {
		NOUN: "명사를 찾고 있었지만 형용사를 입력했습니다.",
		VERB: "동사를 찾고 있었지만 형용사를 입력했습니다.",
		ADVERB: "부사를 찾고 있었지만 형용사를 입력했습니다.",
	},
	ADVERB: {
		NOUN: "명사를 찾고 있었지만 부사를 입력했습니다.",
		VERB: "동사를 찾고 있었지만 부사를 입력했습니다.",
		ADJECTIVE: "형용사를 찾고 있었지만 부사를 입력했습니다.",
	},
}

// ---------------------------------------------------------------------------
// Chinese (Mandarin)
// ---------------------------------------------------------------------------

const zh: PosPairMessages = {
	NOUN: {
		VERB: "我们在找一个动词，但你输入了一个名词。",
		ADJECTIVE: "我们在找一个形容词，但你输入了一个名词。",
		ADVERB: "我们在找一个副词，但你输入了一个名词。",
	},
	VERB: {
		NOUN: "我们在找一个名词，但你输入了一个动词。",
		ADJECTIVE: "我们在找一个形容词，但你输入了一个动词。",
		ADVERB: "我们在找一个副词，但你输入了一个动词。",
	},
	ADJECTIVE: {
		NOUN: "我们在找一个名词，但你输入了一个形容词。",
		VERB: "我们在找一个动词，但你输入了一个形容词。",
		ADVERB: "我们在找一个副词，但你输入了一个形容词。",
	},
	ADVERB: {
		NOUN: "我们在找一个名词，但你输入了一个副词。",
		VERB: "我们在找一个动词，但你输入了一个副词。",
		ADJECTIVE: "我们在找一个形容词，但你输入了一个副词。",
	},
}

// ---------------------------------------------------------------------------
// Arabic
// ---------------------------------------------------------------------------

const ar: PosPairMessages = {
	NOUN: {
		VERB: "كنا نبحث عن فعل لكنك أدخلت اسمًا.",
		ADJECTIVE: "كنا نبحث عن صفة لكنك أدخلت اسمًا.",
		ADVERB: "كنا نبحث عن ظرف لكنك أدخلت اسمًا.",
	},
	VERB: {
		NOUN: "كنا نبحث عن اسم لكنك أدخلت فعلًا.",
		ADJECTIVE: "كنا نبحث عن صفة لكنك أدخلت فعلًا.",
		ADVERB: "كنا نبحث عن ظرف لكنك أدخلت فعلًا.",
	},
	ADJECTIVE: {
		NOUN: "كنا نبحث عن اسم لكنك أدخلت صفة.",
		VERB: "كنا نبحث عن فعل لكنك أدخلت صفة.",
		ADVERB: "كنا نبحث عن ظرف لكنك أدخلت صفة.",
	},
	ADVERB: {
		NOUN: "كنا نبحث عن اسم لكنك أدخلت ظرفًا.",
		VERB: "كنا نبحث عن فعل لكنك أدخلت ظرفًا.",
		ADJECTIVE: "كنا نبحث عن صفة لكنك أدخلت ظرفًا.",
	},
}

// ---------------------------------------------------------------------------
// Hindi
// ---------------------------------------------------------------------------

const hi: PosPairMessages = {
	NOUN: {
		VERB: "हम एक क्रिया की तलाश में थे लेकिन आपने एक संज्ञा दर्ज की।",
		ADJECTIVE: "हम एक विशेषण की तलाश में थे लेकिन आपने एक संज्ञा दर्ज की।",
		ADVERB: "हम एक क्रिया विशेषण की तलाश में थे लेकिन आपने एक संज्ञा दर्ज की।",
	},
	VERB: {
		NOUN: "हम एक संज्ञा की तलाश में थे लेकिन आपने एक क्रिया दर्ज की।",
		ADJECTIVE: "हम एक विशेषण की तलाश में थे लेकिन आपने एक क्रिया दर्ज की।",
		ADVERB: "हम एक क्रिया विशेषण की तलाश में थे लेकिन आपने एक क्रिया दर्ज की।",
	},
	ADJECTIVE: {
		NOUN: "हम एक संज्ञा की तलाश में थे लेकिन आपने एक विशेषण दर्ज किया।",
		VERB: "हम एक क्रिया की तलाश में थे लेकिन आपने एक विशेषण दर्ज किया।",
		ADVERB: "हम एक क्रिया विशेषण की तलाश में थे लेकिन आपने एक विशेषण दर्ज किया।",
	},
	ADVERB: {
		NOUN: "हम एक संज्ञा की तलाश में थे लेकिन आपने एक क्रिया विशेषण दर्ज किया।",
		VERB: "हम एक क्रिया की तलाश में थे लेकिन आपने एक क्रिया विशेषण दर्ज किया।",
		ADJECTIVE: "हम एक विशेषण की तलाश में थे लेकिन आपने एक क्रिया विशेषण दर्ज किया।",
	},
}

// ---------------------------------------------------------------------------
// Czech
// ---------------------------------------------------------------------------

const cs: PosPairMessages = {
	NOUN: {
		VERB: "Hledali jsme sloveso, ale zadali jste podstatné jméno.",
		ADJECTIVE: "Hledali jsme přídavné jméno, ale zadali jste podstatné jméno.",
		ADVERB: "Hledali jsme příslovce, ale zadali jste podstatné jméno.",
	},
	VERB: {
		NOUN: "Hledali jsme podstatné jméno, ale zadali jste sloveso.",
		ADJECTIVE: "Hledali jsme přídavné jméno, ale zadali jste sloveso.",
		ADVERB: "Hledali jsme příslovce, ale zadali jste sloveso.",
	},
	ADJECTIVE: {
		NOUN: "Hledali jsme podstatné jméno, ale zadali jste přídavné jméno.",
		VERB: "Hledali jsme sloveso, ale zadali jste přídavné jméno.",
		ADVERB: "Hledali jsme příslovce, ale zadali jste přídavné jméno.",
	},
	ADVERB: {
		NOUN: "Hledali jsme podstatné jméno, ale zadali jste příslovce.",
		VERB: "Hledali jsme sloveso, ale zadali jste příslovce.",
		ADJECTIVE: "Hledali jsme přídavné jméno, ale zadali jste příslovce.",
	},
}

// ---------------------------------------------------------------------------
// Greek
// ---------------------------------------------------------------------------

const el: PosPairMessages = {
	NOUN: {
		VERB: "Ψάχναμε ένα ρήμα αλλά πληκτρολόγησες ένα ουσιαστικό.",
		ADJECTIVE: "Ψάχναμε ένα επίθετο αλλά πληκτρολόγησες ένα ουσιαστικό.",
		ADVERB: "Ψάχναμε ένα επίρρημα αλλά πληκτρολόγησες ένα ουσιαστικό.",
	},
	VERB: {
		NOUN: "Ψάχναμε ένα ουσιαστικό αλλά πληκτρολόγησες ένα ρήμα.",
		ADJECTIVE: "Ψάχναμε ένα επίθετο αλλά πληκτρολόγησες ένα ρήμα.",
		ADVERB: "Ψάχναμε ένα επίρρημα αλλά πληκτρολόγησες ένα ρήμα.",
	},
	ADJECTIVE: {
		NOUN: "Ψάχναμε ένα ουσιαστικό αλλά πληκτρολόγησες ένα επίθετο.",
		VERB: "Ψάχναμε ένα ρήμα αλλά πληκτρολόγησες ένα επίθετο.",
		ADVERB: "Ψάχναμε ένα επίρρημα αλλά πληκτρολόγησες ένα επίθετο.",
	},
	ADVERB: {
		NOUN: "Ψάχναμε ένα ουσιαστικό αλλά πληκτρολόγησες ένα επίρρημα.",
		VERB: "Ψάχναμε ένα ρήμα αλλά πληκτρολόγησες ένα επίρρημα.",
		ADJECTIVE: "Ψάχναμε ένα επίθετο αλλά πληκτρολόγησες ένα επίρρημα.",
	},
}

// ---------------------------------------------------------------------------
// Hungarian
// ---------------------------------------------------------------------------

const hu: PosPairMessages = {
	NOUN: {
		VERB: "Igét kerestünk, de te főnevet írtál.",
		ADJECTIVE: "Melléknevet kerestünk, de te főnevet írtál.",
		ADVERB: "Határozószót kerestünk, de te főnevet írtál.",
	},
	VERB: {
		NOUN: "Főnevet kerestünk, de te igét írtál.",
		ADJECTIVE: "Melléknevet kerestünk, de te igét írtál.",
		ADVERB: "Határozószót kerestünk, de te igét írtál.",
	},
	ADJECTIVE: {
		NOUN: "Főnevet kerestünk, de te melléknevet írtál.",
		VERB: "Igét kerestünk, de te melléknevet írtál.",
		ADVERB: "Határozószót kerestünk, de te melléknevet írtál.",
	},
	ADVERB: {
		NOUN: "Főnevet kerestünk, de te határozószót írtál.",
		VERB: "Igét kerestünk, de te határozószót írtál.",
		ADJECTIVE: "Melléknevet kerestünk, de te határozószót írtál.",
	},
}

// ---------------------------------------------------------------------------
// Romanian
// ---------------------------------------------------------------------------

const ro: PosPairMessages = {
	NOUN: {
		VERB: "Căutam un verb dar ai introdus un substantiv.",
		ADJECTIVE: "Căutam un adjectiv dar ai introdus un substantiv.",
		ADVERB: "Căutam un adverb dar ai introdus un substantiv.",
	},
	VERB: {
		NOUN: "Căutam un substantiv dar ai introdus un verb.",
		ADJECTIVE: "Căutam un adjectiv dar ai introdus un verb.",
		ADVERB: "Căutam un adverb dar ai introdus un verb.",
	},
	ADJECTIVE: {
		NOUN: "Căutam un substantiv dar ai introdus un adjectiv.",
		VERB: "Căutam un verb dar ai introdus un adjectiv.",
		ADVERB: "Căutam un adverb dar ai introdus un adjectiv.",
	},
	ADVERB: {
		NOUN: "Căutam un substantiv dar ai introdus un adverb.",
		VERB: "Căutam un verb dar ai introdus un adverb.",
		ADJECTIVE: "Căutam un adjectiv dar ai introdus un adverb.",
	},
}

// ---------------------------------------------------------------------------
// Ukrainian
// ---------------------------------------------------------------------------

const uk: PosPairMessages = {
	NOUN: {
		VERB: "Ми шукали дієслово, але ви ввели іменник.",
		ADJECTIVE: "Ми шукали прикметник, але ви ввели іменник.",
		ADVERB: "Ми шукали прислівник, але ви ввели іменник.",
	},
	VERB: {
		NOUN: "Ми шукали іменник, але ви ввели дієслово.",
		ADJECTIVE: "Ми шукали прикметник, але ви ввели дієслово.",
		ADVERB: "Ми шукали прислівник, але ви ввели дієслово.",
	},
	ADJECTIVE: {
		NOUN: "Ми шукали іменник, але ви ввели прикметник.",
		VERB: "Ми шукали дієслово, але ви ввели прикметник.",
		ADVERB: "Ми шукали прислівник, але ви ввели прикметник.",
	},
	ADVERB: {
		NOUN: "Ми шукали іменник, але ви ввели прислівник.",
		VERB: "Ми шукали дієслово, але ви ввели прислівник.",
		ADJECTIVE: "Ми шукали прикметник, але ви ввели прислівник.",
	},
}

// ---------------------------------------------------------------------------
// Export map
// ---------------------------------------------------------------------------

export const POS_MISMATCH_MESSAGES: Record<string, PosPairMessages> = {
	en,
	sv,
	fr,
	de,
	es,
	it,
	pt,
	nl,
	fi,
	da,
	nb,
	pl,
	ru,
	tr,
	ja,
	ko,
	zh,
	ar,
	hi,
	cs,
	el,
	hu,
	ro,
	uk,
}

/**
 * Look up a static POS mismatch message for the given native language.
 * Falls back to English when the language has no dedicated messages.
 * Returns `null` when guessPos === targetPos.
 */
export function getPosMismatchMessage(
	nativeLanguageCode: string,
	guessPos: PosKey,
	targetPos: PosKey,
): string | null {
	if (guessPos === targetPos) return null
	const langMessages = POS_MISMATCH_MESSAGES[nativeLanguageCode] ?? POS_MISMATCH_MESSAGES.en
	return langMessages?.[guessPos]?.[targetPos] ?? null
}
