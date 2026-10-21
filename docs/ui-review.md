# Requirement and interface review

The newly supplied assignment and the retained original have identical document XML. The original remains the source of truth. [requirements.md](requirements.md) maps all 49 checklist rows to source paragraphs, implementation and actual tests. Required local workflows and submission deliverables are implemented. Q01 is explicitly a documented external constraint: receipt/submission timing and human effort cannot be independently verified.

The preceding UI covered the workflow but had two real interaction defects: background revalidation removed successful data, remounting rows/forms, and action outcomes could disappear with their component. Functional requirement coverage did not establish an adequate visual or interaction standard. This refinement addresses both behavior and presentation.

## Changes and reasons

| Change                                                                  | Practical reason                                                                                   | Code / verification                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Keep successful read snapshots while fetching                           | Prevent a table or rider edit from blinking/unmounting every five seconds or after a command       | desk/api.ts; api.test.tsx snapshot, failure and scope cases              |
| Distinguish collection scope from query path                            | Retain context across filters without displaying jobs as riders                                    | api.ts explicit scope/stale state; hook regression                       |
| Ignore pre-mutation GET results after a successful command              | Avoid briefly reverting an accepted/delivered job to an obsolete state                             | api.ts write epoch; deferred-response regression                         |
| Persistent read errors with explicit retry                              | Avoid flashing an error away on every poll before recovery is known                                | api.test.tsx retry/error regression                                      |
| Per-action pending labels and disabled controls                         | Explain which operation is running and prevent accidental repeated submission                      | forms.tsx, JobDetail.tsx; deferred mutation RTL case                     |
| Persistent inline outcomes and bounded global notifications             | Show success/failure after form replacement and while scrolled away from the action                | feedback.tsx; creation and failed-form RTL cases                         |
| Portal notifications into the active modal                              | Keep messages above the browser's native modal backdrop and available to keyboard users            | feedback.tsx + Sheet.tsx; real browser save/conflict checks              |
| Native dialog with explicit opener restoration                          | Use browser focus containment/background inertness; React unmount must still return focus reliably | Sheet.tsx; focus restoration RTL + Chromium keyboard/Escape              |
| Sidebar, consistent spacing/type, status colors and focused side panels | Keep the operational desk readable while inspecting one job or rider                               | App.tsx, QueueTable.tsx, JobDetail.tsx, RiderDetail.tsx, styles.css      |
| Explainable candidate cards and chronological audit timeline            | Make the next action and the reason behind dispatch decisions easier to inspect                    | JobDetail.tsx, JobHistory.tsx; existing score/history contracts retained |
| Responsive internal table scrolling and reduced motion                  | Keep narrow screens usable and respect motion preferences                                          | styles.css; 390px Chromium viewport and media emulation                  |

No new production dependencies were introduced. Native dialog, React portals/state, fetch, local SVG icons and CSS cover this small interface. Another component framework would add migration and styling work without solving the data-lifetime defect. The design leaves server transactions, validation, lifecycle predicates and scoring authoritative. Existing comments explain the non-obvious race/retry/focus boundaries; straightforward markup is not annotated line by line.

## Review boundaries

The successful-data retention is in-memory. A full browser reload still fetches initial data and shows a skeleton. Unsaved local drafts survive polling, not closing/reloading the panel. Read results are not stored in localStorage; only uncertain assignment commands retain their original retry receipt. The UI does not optimistically claim a server mutation succeeded.

Polling remains five seconds, and real timeout visibility includes worker and polling delay. Native dialogs are intended for current browsers; no legacy dialog polyfill was added. Notifications are transient, while important form/action errors remain inline until corrected or the panel closes. No authenticated account, real map/travel feed, production deployment or push-notification integration is implied.

The user's Windows MongoDB replica set was confirmed writable in the conversation, but the subsequent local seed failure was not diagnosed from its underlying error. This revision includes the earlier stage-specific seed diagnostics and clearer PowerShell/root-folder instructions. Successful tests against disposable real MongoDB do not claim to have repaired that separate local environment.

See [verification.md](verification.md) for exact automated and browser results. Older phase reports/screenshots describe the version at that point in history; the README no longer presents the earlier capture as the current interface.

## Search and page navigation follow-up

The follow-up addresses the reported duplicate screens, ineffective search, blinking refresh, missing favicon and lost page after reload. Overview now contains summary-only status/fleet panels; Deliveries remains the complete working queue. React Router provides four real paths with active navigation links and unknown-page recovery. URL query filters survive reload and browser history. The shared desk component composes the pages without adding duplicate business state.

Search debounces for 350 ms and sends the server a validated literal substring filter; rider search includes name and code. Existing exact API filters keep their semantics. Pagination resets when filters change. Manual refresh retains mounted, fully opaque rows, shows at least one second of progress, and waits longer for real responses. Failures retain successful rows and offer retry. No generated data or artificial response is introduced.

The production dependency addition is React Router 7.18.4. A registry download for an earlier install attempt was denied; the final supported installation succeeded and the production dependency audit reports zero vulnerabilities. Temporary browser tools are outside the project dependency tree.
