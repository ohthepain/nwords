import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select"
import { languageCodeToFlagEmoji } from "~/lib/language-flag"
import { cn } from "~/lib/utils"

/** Display row for flag + name in settings-style language pickers. */
export type LanguageSelectOption = {
	id: string
	code: string
	name: string
}

/** Matches the uppercase mono label used on the logged-in settings “Languages” card. */
export const LANGUAGE_FIELD_LABEL_CLASS =
	"text-xs font-mono text-muted-foreground uppercase tracking-wider"

const EMPTY_LIST_VALUE = "__language_select_empty__"

type LanguageSelectProps = {
	languages: LanguageSelectOption[]
	value: string
	onValueChange: (languageId: string) => void
	placeholder?: string
	/** Label for the single disabled row when `languages` is empty (defaults to “No languages available”). */
	emptyListMessage?: string
	id?: string
	triggerClassName?: string
	disabled?: boolean
}

export function LanguageSelect({
	languages,
	value,
	onValueChange,
	placeholder = "Select language",
	emptyListMessage = "No languages available",
	id,
	triggerClassName,
	disabled,
}: LanguageSelectProps) {
	const listEmpty = languages.length === 0

	return (
		<Select
			value={listEmpty ? EMPTY_LIST_VALUE : value || undefined}
			onValueChange={onValueChange}
			disabled={disabled}
		>
			<SelectTrigger id={id} className={cn("h-10", triggerClassName)}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{listEmpty ? (
					<SelectItem value={EMPTY_LIST_VALUE} disabled>
						{emptyListMessage}
					</SelectItem>
				) : (
					languages.map((lang) => (
						<SelectItem key={lang.id} value={lang.id}>
							<span
								aria-hidden
								className="text-base leading-none w-6 text-center select-none inline-block"
							>
								{languageCodeToFlagEmoji(lang.code)}
							</span>
							{lang.name}
						</SelectItem>
					))
				)}
			</SelectContent>
		</Select>
	)
}
