# Repository Guidelines

## Project Structure & Module Organization
- Worker source and tests live in `src/`. Keep handlers, verification logic, and shared types close together instead of creating deep folder nesting prematurely.
- Product and rollout context lives in `PRD.md` and `docs/`.
- Project configuration lives in `package.json`, `tsconfig.json`, `vitest.config.ts`, and `wrangler.toml`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start the Cloudflare Worker locally with Wrangler.
- `npm test`: run the interactive Vitest suite.
- `npm run test:once`: run the test suite in CI mode.
- Deploy with `npm run deploy`.

## Coding Style & Naming Conventions
- Use TypeScript throughout. Keep verification logic explicit about request, response, and error shapes.
- Prefer focused modules and user-facing tests over large shared utility buckets.
- Keep PRs tightly scoped. Do not mix unrelated cleanup, formatting churn, or speculative refactors into task-focused changes.
- Temporary or transitional code must include `TODO(#issue):` with the tracking issue for removal.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it afterward.
- If a PR title changes after opening, verify that the semantic PR title check reruns successfully.
- PR descriptions must include a short summary, motivation, linked issue, and manual test plan.
- Behavior changes to verification logic should include representative request or response examples when that helps reviewers validate the change.

## Security & Sensitive Information
- Do not commit secrets, API tokens, platform credentials, or private user data. Use Wrangler secrets or environment configuration for anything sensitive.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
