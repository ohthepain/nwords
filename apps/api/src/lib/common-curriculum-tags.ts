/** Rows produced by COMMON_CURRICULUM_KAIKKI carry this tag in `curriculumUnit.tags` (pruning, cloze scope). */
export const COMMON_CURRICULUM_FREQUENCY_TAG = "common-frequency" as const

/** Postgres `jsonb` scalar for containment checks (`tags @> …`). */
export function pgJsonArrayContainsScalar(sqlTag: typeof COMMON_CURRICULUM_FREQUENCY_TAG): string {
	return `'"${sqlTag}"'::jsonb`
}
