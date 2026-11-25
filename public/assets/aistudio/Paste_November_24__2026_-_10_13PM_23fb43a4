Wholesale Water Billing System: Master Specification

Build and refine a complete offline wholesale water billing web app for a shop in Sri Lanka. The seller runs it on one Windows laptop using one desktop shortcut. Deliver working, persistent workflows and repeatable tests, not a mockup, a plan, or screenshots presented as proof.

This file is the master specification for all phases. It must live in the repository at docs/SPEC.md. Each session, the person starting you will add a line such as This session: do ONLY Phase 1A. Do only the phase named. If no phase is named, do only the next incomplete phase in the order below. Never start a later phase in the same session.

PROJECT SETUP AND RULES: APPLY IN EVERY SESSION
Repository and branch. The repository must be attached to your workspace before you begin. Use that checkout as the source of truth; do not depend on cloning a private URL or knowing any prior commit. Work only on arena/3949081c-wholesale-billing-system. Verify the branch and working tree before editing. Do not overwrite someone else's changes, merge into dev/main, deploy, or push to another branch.
Specification file. Read docs/SPEC.md before editing. If it does not exist and you were given this text directly, save this exact text to docs/SPEC.md and commit it as the first commit of the session, before any other change. If it exists, treat it as authoritative and report any difference from the text you were given. Do not assume earlier chat prompts are available.
Stack. React/Vite → FastAPI → PostgreSQL. The browser never connects directly to PostgreSQL. Target Windows 11 25H2 x64, PostgreSQL 16, Python 3.11, and Node.js 22 LTS for the frontend build only. Use supported patches within those versions and record the exact versions tested. This is a single-laptop system: the browser, API, and database all run locally. Bind packaged services to loopback. No internet, CDN, or Node at runtime. It is not a public website or a mobile application.
Time and money. Use Asia/Colombo for business dates, report cutoffs, and displayed timestamps. Format money as Rs.  in both languages, including receipts and PDFs. Never prefix units or cans with currency.
Data safety. Inspect the schema and reuse working code. If database modules 00–19 exist, leave them intact and add migrations. Preserve historical records, IDs, and costs. Never test on, migrate, or restore over a live shop database. Use disposable UTF-8 PostgreSQL databases and synthetic fixtures. Exclude credentials, test accounts, test data, screenshots, and dumps from the release.
Order of work. 1A → 1B → 2 → 3 → 3.5 → 4. One checkpoint per session. At the start of each session, confirm the last completed commit and rerun its relevant smoke tests. At the end, run the current acceptance tests, record the results, and commit. Fix core failures before advancing. If time runs out, leave the last passing checkpoint intact and list what remains.
Earlier tests must exist. If browser or integration tests required by an earlier phase are missing from the repository, report that as a failure of that earlier checkpoint. Do not claim a regression pass without them.
Unresolved policies. Proceed using the safe defaults below if a shop policy is unresolved. List open decisions at handover. Do not invent prices, physical counts, shop details, or refund policies.
Windows verification rule. If Windows, Task Scheduler, external drives, or printers are unavailable, mark those checks pending and give exact steps for the technician. Linux or mocked tests do not count as Windows hardware verification. Never claim Windows-specific checks passed when they were only run on Linux or in a mocked environment.
PHASE 1A: STOCK, LOGIN, ROLES, AUDIT, AND HOME
Stock

The main Stock view shows exactly these six starter cards in this order:

Card	Canonical SKU	Legacy SKU aliases, in priority order	Accepted exact English names	Sold by
500 ml	SKU-500ML	500ML, SKU-500, SKU-WAT-500	500 ml Water; 500ml Water; 500 ml; 500ml	bottle
1 L	SKU-1L	1L, SKU-WAT-1L	1 L Water; 1L Water; 1 L; 1L	bottle
1.5 L	SKU-1.5L	1.5L, SKU-WAT-1.5L	1.5 L Water; 1.5L Water; 1.5 L; 1.5L	bottle
5 L	SKU-5L	5L, SKU-WAT-5L	5 L Water; 5L Water; 5 L; 5L	can
19 L Filled	SKU-19L	19L, SKU-19L-FILLED, SKU-WAT-19L	19 L Filled; 19 L Water (filled); 19L Water (filled); 19 L Water; 19L Water; 19 L; 19L	can
19 L Empty Can	SKU-19L-EMPTY	None	19 L Empty Can; 19 L Bottle (empty/new)	can
Trim whitespace and compare case-insensitively. Match canonical SKU first, then listed SKU aliases, then an exact name only if it identifies one active variant. Never match by substring, size alone, sort order, or array position. For a SKU match, an English name outside the row's accepted names or a different sold-by unit is a catalog conflict. Check the unit for a name-only match too. Do not silently bind a conflict, fall through to another record, or create a duplicate.
Review product lets an owner/manager confirm and bind the existing record by type_id, correct its name or unit, or leave it under Other Products. Persist and audit the choice. Do not rewrite old invoices, stock quantities, or batch costs. Do not allow a known 20 L product to bind to a 19 L slot. Premium 20L Can (New), SKU-TEST-CAN-20L, CAN-20L, and SKU-CAN-20L are NOT 19 L aliases.
Missing cards are working Set up buttons for owner/manager. Prefill the correct name, canonical SKU, unit, and returnable status. Only 19 L Filled is returnable by default. Prices, costs, and opening quantity must be entered deliberately; unpriced stock is not free. Save the real variant, select it in its slot, and verify after reload. If the matching variant is archived, offer Restore. If ambiguous, show the matching records for review. Employees see "Ask a manager to set up."
Put Add New Product straight below the six cards; put extras behind collapsed Other Products. Do not auto-delete, auto-archive, or exclude extras from Billing because of their names. Deliberate archive/restore is allowed; archived view shows archived records only.
Share stable type_id across Stock and Billing. A bottle, case, and special SKU of the same size are separate. Receiving, selling, adjusting, archiving, or restoring one never changes another. Preserve selection after refresh if that variant still exists; otherwise clear it. Add/Edit Product supports English/Tamil names, sold-by unit, selling price, future default buying cost, and an explicit returnable flag. Selecting "can" must not automatically make it returnable. Editing default buying cost never rewrites past batches or margins. Show real batch history and readable stock counts.
Login, permissions, audit, and Home
Owner: full access, staff administration, PIN resets, Shop Details, and backup configuration. Manager: stock/customer management, billing, collections, financial reports, and authorized returns, cancellations, payment corrections, and voids. Employee: billing, customer creation, collections, and active stock viewing; only their own invoices in history/reprint. Employees never see buying costs, profit, or financial reports and cannot mutate stock or perform reversals. Enforce permissions in the API.
Large PIN keypad and clear staff identity. Salt and hash PINs. Five consecutive failures trigger a five-minute server-side lockout that survives restart. Use generic failure messages. Owners can reset staff PINs; owner recovery is a documented local technician procedure, never a master PIN. Reset or role change revokes affected sessions. Auto-lock after 10 minutes of inactivity; reauthentication must preserve an unconfirmed transaction without reposting it.
Install a durable audit log now. Record actor, timestamp, action, affected IDs, and relevant before/after values or reason. Use it for sign-ins, lockouts, resets, role changes, and stock mutations immediately. Later phases use the same log. Never log PINs or secrets. The app must not allow audit records to be edited or deleted.
Home has four equal cards: Invoice top-left, Stock top-right, Pay / Return bottom-left, Reports bottom-right. Until implemented, keep cards visible with an honest "Coming next" or phase label. No fake workflows or numbers. Today's Analysis is below the cards; Needs Attention Today is compact on the right, out-of-stock before low-stock. No Last Invoice, Reprint, Money to Collect, duplicate top-right actions, or duplicate total.
For a low-literacy seller: short labels, clear icons with text, large touch targets, prominent EN/TA toggle, bundled fonts, local voice or chime. Green for paid/received, amber for debt/due, blue for cans, neutral for totals, red for errors or confirmed overdue status. Show a floating five-second success toast without layout shift. Distinguish loading, empty, error, and unavailable. Check 1366×768 in both languages.
1A gate

Run a clean install, type-check, build, and real PostgreSQL/API and browser tests. Reproduce missing 1.5 L and 5 L, a Premium 20 L can, and extra products. Verify setup after reload, conflict resolution, archive/restore, collapsed extras, and isolated stock changes for a same-size bottle/case/special. Test role guards, lockout, idle lock, and durable audit records. Commit.

PHASE 1B: BILLING, RETURNABLE ISSUANCE, SNAPSHOTS, AND RETRIES
Three steps: Select Customer → Add Items → Pay & Save. Wait for Start adding items after customer selection. Back/Next preserves cart, discount, and manual tender. Quantities have +/− and direct entry. The full-width Pay & Save action defaults tender to the discounted new invoice total, not old debt plus the invoice.
Support exact, credit, partial, and manual tender. Checkout methods are Cash and Bank Transfer from day one. Record the actual method; never count bank transfers as cash in the drawer. For cash excess, let the cashier choose whether to apply it to old debt or give change. Do not invent a cash payout for excess bank tender; require an explicit valid allocation or a corrected bank amount. Show invoice paid, old debt applied, change, and resulting account balance separately.
Validate stable IDs, active customer/products, current prices, balance, quantities, stock, and decimal amounts in the API. Post one atomic sale. Issuing a returnable filled can reduces filled stock and increments the customer-held count for that type in the same transaction. Audit both. Do not offer checkout empty returns until the Phase 2 movement is implemented and tested.
Persist an immutable financial snapshot at checkout: item descriptions in available languages, unit, quantities, prices, internal historical costs, discount, tender and method, old-debt allocation, change, invoice due and customer balance, staff, date, and actual configured shop details. Omit unconfigured shop details; never fabricate them. Phase 3 renders receipts from these snapshots, not from current product prices or mutable catalog names.
Strip cost and profit from all employee checkout, retry, receipt, and history responses. Never include cost or profit in any customer-facing receipt, printout, or PDF, regardless of who generates it. Keep internal costs available only for authorized reporting.
Generate operation IDs client-side. Persist the ID and original submission in IndexedDB before sending, scoped by shop and staff identity. Reuse that ID and payload after reload. Clear only after confirmed success or a definitive rejection proving nothing posted. Never store PINs, credentials, or auth tokens in retry records. The server persists the operation outcome in the same transaction as the write, serializes concurrent retries, and rejects the same ID with a different payload. Give a clear retry button; never ask the cashier to re-enter an unconfirmed bill.
1B gate

Verify Back/Next, saved snapshots, exact variant stock changes, returnable issuance, permissions, concurrent submission, and recovery after the server commits but the browser loses the response. For a Rs. 1,700 bill and Rs. 2,000 cash tender:

Rs. 500 prior debt → Rs. 1,700 invoice paid, Rs. 300 old debt applied, no change, Rs. 200 remaining.
Rs. 100 prior debt → Rs. 1,700 invoice paid, Rs. 100 old debt applied, Rs. 200 change.

Verify bank tender does not enter cash totals and that employee responses and retry payloads returned by the server do not expose costs. Commit before Phase 2.

PHASE 2: PAY / RETURN, PHYSICAL CANS, CUSTOMER LEDGER, AND CORRECTIONS
Track separately: 19 L Filled is sellable filled stock; 19 L Empty Can is a sellable product for new empties; Used Empties in Shop and Damaged Empties are separate non-sellable inventory quantities by type; Cans Held by Customer is the customer's obligation by type. None is a monetary balance.
A returned empty atomically decreases held count and increases the appropriate used or damaged quantity. Require the cashier to choose the type when multiple types are held; reject excessive returns. Never add a returned used can to new empty sellable stock or filled stock. Do not infer old physical stock: require an opening count or show "Not counted." Do not automate refilling, disposal, or resale without approved shop policy.
One Pay / Return form handles money only, cans only, or both without horizontal scrolling. New payment methods are Cash and Bank Transfer; preserve historical labels. Show confirmed balances immediately. If a combined submission partially saves, show which part saved and retry only the unsaved or unconfirmed part using its original ID. Never charge the saved part again.
Real customer detail and ledger, labels above values, wrapped archived-only view with Restore. Owner/manager can edit/archive/restore. Block archive when money or held cans remain unresolved.
Owner/manager only for payment correction and void, with a reason. Preserve the original and post one auditable reversal or reversal/replacement. Goods returns credit the correct portion of the original discounted bill; restock only explicitly sellable goods. State account credit, not cash refund on screen. Block simple cancellation of paid or can-linked invoices until an approved reconciliation workflow exists. Extend the audit log to all of these actions.
Phase 2 gate

Test money-only, cans-only, both, partial failure and reload retry, two can types, excessive returns, damaged empties, one-time correction/void, discounted return/restock, cancellation guards, and role checks. Reconcile all affected money, stock, and can balances in PostgreSQL. Commit.

PHASE 3: RECEIPTS, PRINT/PDF, SHOP DETAILS, AND REPORTS
Immediate receipt, saved invoice history, Print, and Download PDF use the snapshot persisted since Phase 1B. Later product or settings edits do not change it. For legacy invoices, show only what stored data supports. Never show variant UUIDs, internal costs, profit, or fake shop details. Label canceled invoices. Employees may open and reprint only invoices they created; owner/manager can access all.
Add one owner-only Shop Details screen for real English/Tamil name, address, phone, and optional tax details, saved locally. Audit edits. New receipts use the new details; old snapshots remain unchanged.
A4 and 80 mm thermal in English and Tamil. Use bundled browser rendering or a server renderer with proven Tamil shaping and bundled fonts. Print opens the print dialog for the invoice only. Download PDF generates a file programmatically without a print dialog. Both work offline. Inspect actual Tamil output for glyph shaping, the full invoice number, wrapping, and long multi-page invoices; a valid PDF header is not proof.
Reconcile sales, cash, bank collections, balances, returns, reversals, historical costs, and signed profit. Old-debt payment is a collection, not a sale. Do not clamp negative profit. All report dates use Asia/Colombo. Restrict costs and profits to owner/manager and show clear load failures.
Phase 3 gate

Compare immediate and reopened receipt data with actual print/PDF in both languages and both formats. Verify a long bill, no checkout content in print, no print dialog for download, receipt access restrictions, and database-reconciled reports including losses, credits, and reversals. Commit. Mark actual printer tests pending if the device is unavailable.

PHASE 3.5: PROFESSIONAL UI DESIGN, VISUAL CONSISTENCY, AND USABILITY

This phase is strictly a frontend presentation and usability refinement phase. It adds visual and usability requirements. It does not replace, modify, weaken, or remove any functional, technical, security, database, business-logic, or acceptance requirement from Phases 1A, 1B, 2, or 3, which remain authoritative.

Do not make API, database, schema, or business-logic changes. Do not start Phase 4 in this session.

1. Objective

Refine the application's visual design and user experience to achieve the quality of a professionally designed commercial desktop application. The result should feel purpose-built for a real wholesale water business, not like a generic dashboard template.

Prioritise:

Fast everyday operation.
Clear information hierarchy.
Readability for staff with different levels of computer literacy.
Consistent visual language across all screens.
Accurate representation of business information.
Reliable English and Tamil presentation.
Practical usability on the actual Windows laptop environment.
2. Layout and supported screen sizes

This is a single-laptop application bound to loopback. A phone will not access it.

Support 1366×768 and larger desktop resolutions.
Also support a narrow application window or small tablet without horizontal scrolling.
No mobile-specific design or mobile navigation system is required.
Keep important actions visible without unnecessary scrolling.
Prevent tables, forms, dialogs, and navigation from overflowing their containers.
Use sensible minimum widths and responsive layout adjustments where necessary.
Avoid excessive whitespace that pushes frequently used information below the visible area.
3. Visual identity and design direction

Create a distinctive, restrained visual identity appropriate for a professional wholesale water business. The interface should feel clean and organised, dependable and business-focused, calm rather than visually noisy, practical for repeated daily use, and modern without relying on fashionable visual effects.

Use a consistent colour system across the application.

Preserve the existing semantic colour meanings:

Green: paid, received, or successful states.
Amber: outstanding balances, debt, or attention-required states.
Blue: cans and can-related information.
Red: errors, destructive actions, and critical warnings.

These semantic states keep their colours, always with supporting text or icons. Do not remove their colour meaning when simplifying badges or labels. If a semantic colour fails WCAG AA contrast (amber on white commonly does), darken the text colour or place it on a tinted background. Keep its hue and meaning.

Avoid:

Decorative gradients.
Glassmorphism.
Excessive shadows.
Unnecessary animations.
Oversized decorative illustrations.
Generic SaaS dashboard styling.
Repetitive cards used merely to fill space.
Decorative pill badges that do not communicate useful information.
Visual elements that imitate analytics or activity when no real data supports them.

Use solid surfaces, subtle borders, restrained shadows where useful, and clear visual grouping.

4. Typography and language support
Use a coherent Latin and Tamil font pairing. A Latin+Tamil pair counts as one font family for the design system.
Use a maximum of two UI font families, excluding the optional monospace font. All fonts are bundled.
Ensure the selected fonts render Tamil correctly without broken glyphs, clipping, or inconsistent line heights.
Use approximately 1.5 line-height for Tamil text, adjusting where necessary to prevent glyph clipping.
Use tabular numerals in the UI font for monetary values and other aligned numeric information.
Use monospace only for technical identifiers and invoice numbers. Do not use monospace for ordinary financial values.
Prefer readable over dense layouts. Minimum body text size: 16px.
Test Tamil text at actual display sizes, not only English text.
Ensure Tamil labels, headings, table rows, buttons, and dialogs do not clip or overlap.
Allow text containers to grow where Tamil translations need more space.
Use consistent currency formatting and right-align financial amounts in tables.
5. Navigation and home screen

Preserve the navigation structure and home-screen layout specified in Phase 1A.

The home screen must remain the specified 2×2 grid of four equal cards.

Invoice is top-left. Stock is top-right. Pay / Return is bottom-left. Reports is bottom-right.
Do not replace the grid with a sidebar dashboard, unequal card layout, or a different navigation concept.
Keep all four cards visually equal in importance and consistent in size.
Maintain the existing navigation destinations and workflows. Do not introduce new navigation items or remove existing ones.
Use clear labels and recognisable icons. Keep navigation predictable across screens.
Today's Analysis stays below the four cards.
Needs Attention Today stays compact on the right, with out-of-stock items before low-stock items.
Do not move, remove, or redesign these sections independently of the original layout.
6. Interaction design and usability
Large interaction targets apply everywhere, including mouse use. Do not reserve larger targets only for touch interfaces.
Minimum height for buttons and inputs: 48px.
Maintain at least 8px spacing between interactive targets.
Important actions have clear labels and are easy to tell apart from secondary actions.
Destructive actions are visually distinct and require appropriate confirmation.
Form labels remain visible and understandable. Validation messages explain what needs to be corrected.
Use sensible default focus, visible keyboard focus states, and keyboard navigation.
Respect reduced-motion preferences.
Keep common workflows short and avoid unnecessary confirmation steps.
Provide clear feedback after successful actions, failures, and pending operations.
Never make an action look clickable if it does not perform a real operation.
Buttons may grow in width for Tamil labels, but text must not wrap or clip.
Do not shrink font sizes or reduce target heights to force Tamil labels into narrow controls.
Do not rely on colour alone to communicate status. Use text labels or icons alongside semantic colours.
7. Tables, forms, cards, and data presentation

Accuracy and readability take priority over visual density.

Tables

Prefer readable over dense layouts. Minimum 16px body text.
Test English and Tamil table layouts.
Right-align monetary and numeric amounts and use tabular numerals.
Keep column headings clear and consistent. Use sufficient row height and spacing.
Avoid cramped rows, tiny text, and unnecessary columns.
Prevent long names and Tamil text from overlapping adjacent columns.
Use consistent alignment for dates, quantities, balances, and monetary values.

Forms

Group related fields logically. Keep labels above inputs and visually connected to them.
Use consistent field heights and spacing. Inputs have a minimum height of 48px.
Clearly distinguish required fields, optional fields, validation errors, and disabled fields.
Keep primary actions easy to locate.

Cards and summaries

Use cards only when they provide meaningful grouping or hierarchy.
Keep card spacing, border treatment, and typography consistent.
Do not turn every data point into a separate decorative card.
Give important operational information clear visual priority.
8. Spacing system

Use one spacing scale throughout the application: 4px, 8px, 12px, 16px, 24px, 32px.

Use these values for gaps, padding, margins, and component spacing.
The scale applies to gaps, padding, and margins. Control heights (48px minimum) are separate from it.
Avoid arbitrary one-off spacing values unless a genuine layout requirement justifies them.
Apply spacing consistently across buttons, forms, cards, tables, dialogs, and page sections.
Keep enough internal padding for Tamil text and large targets.
9. Screen-by-screen design review

Review every existing screen and workflow. Do not redesign only the home screen and assume the rest is consistent. Inspect and refine all applicable screens, including:

Login and PIN screen.
Home screen and its four navigation cards, including Today's Analysis and Needs Attention Today.
Invoice creation and billing (all three steps).
Product and stock management, including Set up, Review product, Other Products, and archived views.
Staff management and PIN reset.
Customer-related workflows and ledger.
Pay / Return and returnable can management.
Payments, outstanding balances, and debt information.
Invoice history and receipt views.
Reports and summaries.
Audit and activity information.
Shop Details and other existing operational screens.
Dialogs, confirmation windows, forms, empty states, loading states, and error states.

Use docs/SPEC.md as the authority for which screens and workflows must exist.

For each screen check: visual hierarchy; English and Tamil rendering; alignment and spacing; button size and clarity; table readability; form usability; correct semantic colours; overflow and clipping; loading, empty, success, and error states; consistency with the rest of the application.

Do not invent features or sample business data merely to make a screen look populated.

10. Objective visual quality checks

Do not use subjective claims such as "looks less AI-generated" as acceptance criteria. Verify these instead:

No CSS gradients are used in the interface.
Text and interactive elements meet WCAG AA contrast where applicable.
Use axe-core, bundled as a development dependency, through Playwright to test accessibility and contrast on every applicable screen.
Run the contrast checks in both English and Tamil.
Grep the project's CSS files for gradient. Investigate every match and fail this phase if an actual gradient is used in the interface. Do not ignore a match without verifying it.
Button labels stay on a single line at supported screen sizes. Buttons may grow in width for Tamil but must not wrap or clip.
Monetary amounts are right-aligned in tables and use tabular numerals.
The application follows the spacing scale in Section 8.
Body text is at least 16px.
Tamil text is tested at actual display sizes, uses approximately 1.5 line-height, and does not clip or overlap.
Buttons and inputs are at least 48px high everywhere, including mouse-operated screens.
Interactive targets have at least 8px spacing between them.
The home screen keeps its 2×2 equal-card layout with Invoice at top-left.
Today's Analysis and Needs Attention Today stay in their specified positions.
The application works at 1366×768 without unintended horizontal scrolling.
No buttons, links, or controls are decorative placeholders.
Existing semantic colours and their meanings remain intact.

Failure rule: If axe-core reports unresolved applicable contrast violations, or the CSS gradient check finds actual interface gradients, the phase fails. Fix the problems and rerun the checks. Do not report the phase as passed while either check has unresolved failures.

11. Screenshots and test data

Screenshots must show real application screens populated with controlled test data.

Use a disposable UTF-8 PostgreSQL database for screenshot generation. Never use the live shop database or real customer information.
Populate it with synthetic fixtures that represent realistic shop scenarios: invoices, stock, customers, payments, outstanding balances, and returnable cans, with realistic English and Tamil text lengths, monetary values, and numeric alignment.
Capture screenshots at exactly 1366×768, in both English (EN) and Tamil (TA), for every screen listed in Section 9.
Capture each screen as the role that can see it: owner for staff administration, Shop Details, and backup configuration; manager for financial reports; employee for the restricted Home and Reports (own invoice history only) views. Also capture the employee view of Stock to confirm "Ask a manager to set up" is clear.
Use Playwright for repeatable capture. Screenshots must show the actual application, not manually constructed mockups.
Save screenshots in a clearly named development or test-artifact location. Do not commit them to the release bundle. Do not ship fixtures, test accounts, or test data with the application.
Screenshots are not functional test evidence. All workflow and regression tests must still pass independently.
12. Functional preservation and regression gate

This phase must not change:

API endpoints or request/response contracts.
Database tables, columns, relationships, or migrations.
Business calculations or financial rules.
Authentication, staff roles, or permission logic.
Stock, billing, payment, returns, or can-management behaviour.
Existing application workflows.
Receipt content or print behaviour. Receipts and print output continue to follow the Phase 3 rules.

After the design work:

Confirm the repository is still on arena/3949081c-wholesale-billing-system.
Confirm no unrelated changes were overwritten or discarded.
Run a clean installation using the documented project setup.
Run frontend and backend type-checking or equivalent validation.
Run the production build.
Run axe-core through Playwright for contrast and accessibility.
Grep CSS files for gradient and investigate every match.
Rerun all earlier browser and integration tests from Phases 1A, 1B, 2, and 3.
Verify the application at 1366×768.
Verify English and Tamil rendering on every screen listed in Section 9.
Check for horizontal overflow, clipped text, broken layouts, and unusable controls.
Confirm all existing business workflows behave exactly as before.
Generate EN and TA screenshots for every screen in Section 9, per role, using a disposable database with synthetic fixtures.
Confirm screenshots and fixtures are excluded from the release bundle.
Confirm no API, database, schema, or business-logic changes were introduced.
Commit with a descriptive message.

If these checks run on Linux, report them as Linux checks. Windows 11 packaging, startup, Task Scheduler, printer, and hardware checks remain pending until run on the actual Windows environment.

Completion gate: Do not proceed to Phase 4 until the visual review, regression tests, role and language screenshots, axe-core checks, CSS gradient check, and build checks have all passed. If an existing requirement conflicts with a proposed visual change, preserve the existing requirement and adjust the design.

13. Final acceptance criteria

Phase 3.5 is complete only when:

Every existing screen has had a consistent visual review.
The home screen keeps four equal cards in a 2×2 grid, Invoice top-left, with Today's Analysis and Needs Attention Today in their specified positions.
The interface works at 1366×768 and larger; narrow windows and small tablets do not introduce horizontal scrolling.
English and Tamil are both readable and correctly rendered, with appropriate Tamil line-height and no clipping.
Body text is at least 16px; buttons and inputs are at least 48px high; interactive targets have at least 8px spacing.
Monetary values are right-aligned with tabular numerals; buttons can expand for Tamil without wrapping or clipping.
Semantic status colours keep their meanings and meet contrast.
The spacing scale is followed. No interface gradients are present. axe-core reports no unresolved applicable violations.
All earlier browser and integration tests pass. The clean install and production build succeed.
EN and TA screenshots exist for every screen in Section 9, per role, and are excluded from the release along with fixtures.
No API, database, schema, or business-logic changes were introduced.
The work is committed to Git.

Only then may the project proceed to Phase 4.

PHASE 4: OFFLINE WINDOWS PACKAGE, EXTERNAL BACKUPS, AND HANDOVER
PostgreSQL runs as an Automatic Windows service. Ship the built frontend, fonts, PDF renderer, and pinned Python runtime or a technician-installed venv from an offline wheelhouse. The Wholesale Billing desktop shortcut starts FastAPI using that runtime or reuses the healthy running instance, prevents duplicate startup, waits for application and database readiness, then opens the local browser. Fail with a plain recovery message. The launcher never creates, seeds, migrates, or restores the database.
Provision a fresh client database, limited app role, and real owner with a private PIN. Optionally install the six unpriced, zero-stock starter items. No demo records or credentials. Provide technician setup, upgrade, and rollback instructions. Test upgrades on a restored copy, never the live shop DB.
Configure automatic daily Windows Task Scheduler backups to an external drive. Identify the expected drive by volume identifier or marker, not just drive letter. Use a restricted task account and protected credentials, not plaintext passwords in scripts. Write a timestamped PostgreSQL custom-format dump to a temporary file and publish only after a successful dump and verification. Retain prior good backups under an explicit retention policy; never delete the last good backup on failure. Missing, wrong, full, or unwritable drive must show failed status and the last successful external backup time. Never label a local fallback as an external backup. Protect backups as business data and document off-PC storage and restore steps.
Test a real restore into a separate empty database. Compare inventory, money, can balances, and receipt snapshots, then reopen a saved invoice in the restored app. A dump listing alone is not a restore test. On the actual Windows laptop verify disconnected cold boot, shortcut launch/relaunch, reboot persistence, PIN recovery, scheduled external backup, missing-drive failure and recovery, and A4/thermal printers. If you cannot access the laptop or printer, provide the exact technician test checklist and leave those checks pending. Do not claim shop handover readiness until they pass.
FINAL REPORT (END OF EVERY SESSION)

List the exact commit for each completed checkpoint, the tests actually run and their results, failed or pending checks, and unresolved shop policies such as cash refunds or used-can refill/disposal. State whether the build is ready for code review, a disposable trial, or shop handover. Do not promise "no errors"; provide evidence for the workflows that matter and make remaining risks visible.