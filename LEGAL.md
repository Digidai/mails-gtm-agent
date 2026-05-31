# Legal Notice

mails-gtm-agent is an open-source tool for email outreach automation. It provides technical mechanisms for compliance (List-Unsubscribe headers, physical address footer, unsubscribe endpoint, GDPR data deletion API) but **cannot guarantee legal compliance on your behalf**.

## Your Responsibility

You are solely responsible for ensuring your use of this tool complies with all applicable laws in your jurisdiction and your recipients' jurisdictions. This tool does not constitute legal advice.

## Known Legal Frameworks

Cold email outreach is regulated in most jurisdictions. Key frameworks include:

| Law | Jurisdiction | Key Requirements |
|-----|-------------|-----------------|
| **CAN-SPAM Act** (15 U.S.C. 7701) | United States | Opt-out mechanism, physical address, no deceptive headers/subjects, identify as ad |
| **CASL** | Canada | Express or implied consent required, identification, unsubscribe mechanism |
| **GDPR + ePrivacy Directive** | European Union | Prior consent (opt-in) required for cold B2C email. Legitimate interest may apply for B2B in some member states |
| **PECR** | United Kingdom | Similar to ePrivacy. Soft opt-in exception for existing customers only |
| **Spam Act 2003** | Australia | Consent required, unsubscribe, identify sender |

## Important Notes

- **GDPR cold outreach**: Sending cold emails to EU recipients without prior consent is likely a violation of GDPR Article 6 and ePrivacy Directive Article 13. The "legitimate interest" basis may apply in narrow B2B contexts, but this requires a documented assessment. Consult a lawyer before targeting EU recipients.

- **CAN-SPAM physical address**: This tool requires a `physical_address` field on each campaign and includes it in every email footer. If you provide a false address, you violate CAN-SPAM regardless of this tool's technical compliance.

- **Hosted/SaaS use**: If you operate this tool as a hosted service for others, you may be considered a "sender" or "initiator" under CAN-SPAM, making you directly liable for compliance violations by your users.

## This Tool Provides

- RFC 2369 `List-Unsubscribe` header on every outbound email
- RFC 8058 `List-Unsubscribe-Post` header for one-click unsubscribe
- Physical address footer in every email body
- Unsubscribe link in every email body (HMAC-signed, 1-year validity)
- `/unsubscribe` endpoint with confirmation page
- Global + per-campaign unsubscribe tracking
- Reply-based unsubscribe detection (classifies "stop"/"unsubscribe" intents)
- GDPR data deletion API (`/api/gdpr/delete`)

## This Tool Does NOT Provide

- Legal advice or compliance certification
- Consent management / opt-in tracking
- Automatic jurisdiction detection for recipients
- Regulatory filing or registration

## License

MIT. See [LICENSE](LICENSE).
