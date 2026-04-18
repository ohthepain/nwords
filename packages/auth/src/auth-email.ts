import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2"

const PRODUCT_NAME = "nwords"

function getRegion(): string {
	return process.env.AWS_REGION ?? "eu-central-1"
}

function getFromEmail(): string {
	return process.env.SES_FROM_EMAIL?.trim() ?? ""
}

function getConfigurationSet(): string {
	return process.env.SES_CONFIGURATION_SET?.trim() ?? ""
}

let sesClient: SESv2Client | null = null
let sesClientRegion: string | null = null

function getSesClient(): SESv2Client {
	const region = getRegion()
	if (!sesClient || sesClientRegion !== region) {
		sesClient = new SESv2Client({ region })
		sesClientRegion = region
	}
	return sesClient
}

/** Reads env at call time so dev servers pick up .env after imports. */
export function isSesConfigured(): boolean {
	return getFromEmail().length > 0
}

export type AuthEmailTemplate = {
	heading: string
	intro: string
	actionLabel: string
	actionUrl: string
	outro: string
}

/**
 * Table-based HTML + plain-text twin (OctaCard-style): CTA button and copy-paste fallback.
 */
export function renderAuthEmailTemplate(t: AuthEmailTemplate): { html: string; text: string } {
	const text = [
		t.heading,
		"",
		t.intro,
		"",
		`${t.actionLabel}: ${t.actionUrl}`,
		"",
		t.outro,
		"",
		`— ${PRODUCT_NAME}`,
	].join("\n")

	const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px 24px;">
          <tr><td style="font-size:20px;font-weight:700;color:#18181b;">${escapeHtml(t.heading)}</td></tr>
          <tr><td style="height:16px;"></td></tr>
          <tr><td style="font-size:15px;line-height:1.55;color:#3f3f46;">${escapeHtml(t.intro).replace(/\n/g, "<br/>")}</td></tr>
          <tr><td style="height:24px;"></td></tr>
          <tr>
            <td align="center">
              <a href="${escapeAttr(t.actionUrl)}" style="display:inline-block;background:#18181b;color:#fafafa;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">${escapeHtml(t.actionLabel)}</a>
            </td>
          </tr>
          <tr><td style="height:20px;"></td></tr>
          <tr><td style="font-size:13px;line-height:1.5;color:#71717a;">If the button does not work, copy and paste this link into your browser:<br/><span style="word-break:break-all;color:#3f3f46;">${escapeHtml(t.actionUrl)}</span></td></tr>
          <tr><td style="height:20px;"></td></tr>
          <tr><td style="font-size:14px;line-height:1.55;color:#3f3f46;">${escapeHtml(t.outro).replace(/\n/g, "<br/>")}</td></tr>
          <tr><td style="height:24px;"></td></tr>
          <tr><td style="font-size:12px;color:#a1a1aa;">${escapeHtml(PRODUCT_NAME)}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

	return { html, text }
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/'/g, "&#39;")
}

export async function sendAuthEmail(args: {
	to: string
	subject: string
	html: string
	text: string
}): Promise<void> {
	const fromEmail = getFromEmail()
	if (!fromEmail) {
		console.warn(
			"[auth-email] SES_FROM_EMAIL is unset; not sending email.",
			JSON.stringify({ to: args.to, subject: args.subject, text: args.text }),
		)
		return
	}

	const configurationSet = getConfigurationSet()

	const cmd = new SendEmailCommand({
		FromEmailAddress: fromEmail,
		Destination: { ToAddresses: [args.to] },
		Content: {
			Simple: {
				Subject: { Data: args.subject, Charset: "UTF-8" },
				Body: {
					Text: { Data: args.text, Charset: "UTF-8" },
					Html: { Data: args.html, Charset: "UTF-8" },
				},
			},
		},
		...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
	})

	try {
		await getSesClient().send(cmd)
	} catch (err) {
		const e = err as { name?: string; message?: string; $metadata?: { requestId?: string } }
		console.error(
			"[auth-email] SES SendEmail failed:",
			e.name,
			e.message,
			"requestId=",
			e.$metadata?.requestId,
			{
				region: getRegion(),
				from: fromEmail,
				to: args.to,
				configurationSet: configurationSet || "(none)",
			},
		)
		if (
			e.name === "UnrecognizedClientException" ||
			e.message?.includes("security token included in the request is invalid")
		) {
			console.error(
				"[auth-email] Invalid AWS credentials for this process. The SDK uses env vars first: remove or fix " +
					"AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN in .env if they are expired or placeholders " +
					"(Vite dev merges repo .env into process.env). Use the same identity as `aws sts get-caller-identity` / your working CLI profile.",
			)
		}
		throw err
	}
}
