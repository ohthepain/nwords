/**
 * Future: hydrate `Sentence.hasAudio` + upload clips to S3 using Tatoeba’s
 * `sentences_with_audio` export and `https://tatoeba.org/audio/download/:id`.
 *
 * Set `S3_BUCKET`, `AWS_REGION`, and AWS credentials (or instance role) before enabling.
 */
export async function hydrateSentenceAudioFromTatoeba(_languageId: string): Promise<void> {
	if (!process.env.S3_BUCKET) {
		return
	}
	// Intentionally unimplemented — large export + licensing review per clip.
}
