# AI Agent Capability Boundary

## Current state

The current repository does not include an OpenAI SDK, LLM provider client, embedding index, retrieval service or autonomous Agent loop. It would be inaccurate to describe the current release as an AI Agent product.

The codebase does provide useful foundations for a future assistant:

- structured policy and guide records with publication/version state;
- local document preview and question-bank OCR/import paths;
- employee, admin and super-admin authorization guards;
- audit records and workflow services for exams, notifications and onboarding mail;
- private storage and server-side file access checks.

These foundations support an AI extension, but they do not themselves send prompts or produce model-generated answers.

## Planned AI capabilities

### AI policy Q&A

Add a permission-aware question-answering service that retrieves only published policy chunks visible to the current user, returns citations to source versions, and clearly labels uncertainty. The service should never use a global index for content that the requester cannot already read.

### Enterprise knowledge retrieval

Introduce an ingestion pipeline for authorized documents, chunking, metadata, ACL propagation and an organization-scoped vector or hybrid index. Deletion, unpublishing and version replacement must remove or invalidate indexed content as part of the same lifecycle.

### Document understanding

Use local parsing/OCR results as inputs to an explicit review workflow. Extracted text should retain source page/version metadata, be treated as untrusted input, and never become visible to employees until the owning content is validated and published.

### Workflow automation

An Agent may eventually suggest onboarding tasks, reminders or exam follow-ups, but mutating actions should require a typed tool contract, server-side authorization, idempotency and human confirmation for high-impact operations such as sending mail or changing access.

## Safety requirements for a future Agent

- Preserve `SUPER_ADMIN`, `ADMIN` and `EMPLOYEE` checks before retrieval and before every tool call.
- Prevent prompt injection from document text from changing tool permissions or disclosure rules.
- Do not place secrets, raw SMTP errors, private file bytes or hidden system instructions in prompts or model logs.
- Apply tenant/organization and publication filters before indexing, retrieval and response generation.
- Return source citations and an audit event for generated answers and confirmed actions.
- Add rate limits, evaluation fixtures, refusal tests and a human override path before enabling automation.

The roadmap in the README is intentionally aspirational. Any implementation should update this document with the actual provider, data flow, retention policy and evaluation evidence rather than implying that a planned feature already exists.
