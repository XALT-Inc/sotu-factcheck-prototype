# Architecture Audit — Implementation Tracker

## Phase 1: Extract shared code ✅
- [x] 1. Create `src/constants.ts` (magic numbers, default strings, text limits) — B3, A10
- [x] 2. Add `normalizeVerdict`, `normalizeClaimVersion`, `createEmitter` to `utils.ts` — A1, A5, A6
- [x] 3. Create `ClaimForOutput` in `types.ts`, export `GeminiCandidate` — A3, A8
- [x] 4. Create `src/claim-payload.ts` (single payload builder) — A4
- [x] 5. Export `VERDICT_STYLES` from `graphic-template.ts`, reuse in `render-service.ts` — A7
- [x] 6. Consolidate `buildClaimEventPayload` + `claimSnapshotEventFields` in `server.ts` — A2

## Phase 2: Split server.ts ✅
- [x] 7. Extract `src/server/sse.ts`
- [x] 8. Extract `src/server/auth.ts`
- [x] 9. Extract `src/server/claim-events.ts` with `mergeClaimFields()`
- [x] 10. Extract `src/server/routes.ts`
- [x] 11. Slim `src/server.ts` to bootstrap only

## Phase 3: Type safety
- [ ] 12. Define discriminated union event types in `types.ts`
- [ ] 13. Remove `as Record<string, unknown>` casts
- [ ] 14. Create `src/shared-types.ts` for client/server type sharing

## Phase 4: Ingest abstraction
- [ ] 15. Define `IngestSource` interface in `types.ts`
- [ ] 16. Extract `src/ingest/ytdlp-source.ts` from pipeline.ts
- [ ] 17. Refactor `pipeline.ts` to accept `IngestSource`
- [ ] 18. Update `PipelineConfig` to use `source: IngestSourceConfig`
- [ ] 19. Update `/api/start` to validate by source type

## Phase 5: Scalability fixes
- [ ] 20. Add `runIdIndex` to pipeline registry
- [ ] 21. Add `?runId=` SSE filtering
- [ ] 22. Replace event history array with ring buffer
- [ ] 23. Split activity store flush by entity kind

## Verification
After each phase: `npm run check`, `npm run build`, `npm test`
