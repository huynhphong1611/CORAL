# Specification Quality Checklist: Phase 3 — Brain layer, Explorer, Test writer

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-30
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [ ] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Iteration 1 (2026-09-30): two open markers, asked to Huynh:
  - Q1 (Assumptions): where and with which keys the DoD runs against real AI providers.
  - Q2 (FR-041): web screens for prompt, import and project knowledge, or API only.
- Terms kept from SPEC on purpose, as names of existing domain concepts, not implementation choices:
  `brains.yaml` (§14.3), `mcp.yaml` (§14.5), `AGENTS.md` / `SKILL.md` (§13, P4),
  `coral/manualcase@1` (§11.3), lease `exploration` (D16), `${secret:NAME}` (D19),
  `coral validate`, `never_tap` (§9.4), run type `validation` (§6).
- Provider names (Claude, Gemini, GitHub Copilot) are part of the product scope (SPEC §1.2, §14.2),
  not a technology choice of this feature. SDKs, the MCP client library and the fingerprint
  algorithm are left to `/speckit-plan`.
- Scope checks against ROADMAP Phase 3: every bullet maps to a story or FR:
  - brain interface and adapters: US1, FR-001–FR-010;
  - router, fallback and limits: FR-004–FR-007;
  - MCP client: US7, FR-016–FR-019;
  - screen serializer: FR-011;
  - prompt builder: US4, FR-012–FR-015;
  - Explorer: US2, FR-020–FR-027;
  - Test writer and validation: US3, FR-028–FR-032;
  - prompt: US5, FR-033;
  - import: US6, FR-034–FR-038;
  - web: FR-039–FR-041.
- Every DoD item maps to a criterion: SC-001 to SC-004.
