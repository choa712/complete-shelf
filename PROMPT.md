# Build prompt

Use this prompt with Codex, Cursor, Claude Code, Aura Build, or another coding agent. It is intentionally implementation-aware but leaves room for a new visual identity.

```text
Create an original, premium Three.js experience called “The Complete Shelf.”

GOAL
Build a warm editorial 3D library where people browse a continuous shelf of seven hardcovers and inspect each volume in detail.

THE COLLECTION
Build a reading library rather than a product catalog. Group the volumes into sections - one shelf bay per section - and give every volume its own proportion, palette, abstract foil motif, binding specification, and editorial description.

Each volume carries two or three passages. A passage is a short quotation from a public-domain text. Facing it, on the recto, is a reading: original prose written for the edition.

THE READINGS
A reading does not explain its passage. Write it under these constraints:
- Put a concrete scene down first; let the meaning arrive a beat late.
- Prefer precise verbs to evaluative adjectives. "Grief rearranged the order of the day" over "the grief was deep."
- Let consecutive sentences qualify or contradict each other instead of agreeing.
- Hold one image per reading. Do not stack weather, light, waves, and seasons in the same passage.
- Leave the ending open. Close on an image or an unanswered question, never a moral.
- Vary the sentence endings. Mix noun-final, interrogative, connective, and elliptical forms.
- Store each reading as an array of lines. The line breaks are the pacing; the renderer must preserve them and only wrap when a line exceeds the measure.

Where a book is still in copyright, write a reader's note for the left page instead of quoting, and mark it as such in the attribution.

BROWSING
- Navigate the shelf with wheel, arrow keys, previous/next buttons, and position markers.
- Keep the center volume clearly selected.
- Use true single-click hit targets for the books. Do not make shelf navigation depend on drag gestures.
- Hide any visible wraparound jump when the continuous shelf loops.

DETAIL VIEW
- Move the selected book from its exact shelf pose into inspection without a discontinuity.
- Keep the book responsively positioned beside the editorial information panel.
- Support orbit, pan, and zoom on the background.
- Keep the book closed by default.
- On cover hover, crack the front board open slightly.
- On cover click or drag, open to the title page.
- Let readers drag pages in both directions. Use segmented page geometry so the active sheet bends, twists, and settles with a restrained cloth-like curve.
- At the beginning, let the user drag the cover closed.
- When returning to the shelf, close the pages and animate the book, camera, shelf, and view offset to exact deterministic endpoints before reparenting the model.

BOOK CRAFT
- Model separate front and back boards, a straight spine, hinges, shoulders, endpapers, page block, individual preview sheets, page-edge layering, headbands, bookmark, foil accents, and soft contact shadows.
- Keep the silhouette sharp and book-like. Avoid pill-shaped boards and an overly rounded spine.
- Use physically based materials with restrained roughness variation.
- Generate fine cloth weave, paper grain, page-edge lines, foil roughness, wood grain, and subtle normal maps procedurally.
- Give the front, spine, and back their own correctly oriented artwork. Back-cover text must never be mirrored.

ART DIRECTION
- Aim for warm editorial minimalism: confident typography, quiet negative space, controlled color, and soft studio lighting.
- Take inspiration from high-end contemporary book publishing without copying a real cover or publisher identity.
- Theme the background and information panel from the selected book while maintaining strong text contrast.
- Keep the shelf view minimal: no decorative frame and no large overlay copy.

PAGINATION
- Derive page count from content, not from a constant. A title page, one facing pair per passage, and a colophon.
- Author each page canvas at the aspect of the sheet it is mapped onto. Deriving both from one shared function is the only reliable way; a fixed canvas on a taller sheet stretches every glyph vertically, and the distortion reads as bad type rather than as a bug.
- Sign the readings and leave the passages unsigned. Quoted text has an author already; authored text needs one.
- Set the passage large with room around it, and step the type down a size when a quotation runs long rather than letting it overflow the leaf.
- Give wrapped prose lines a hanging indent so an authored line still reads as one unit.
- Label spreads from the passages themselves, and mirror the current passage into the detail panel as the reader turns pages.

ENGINEERING
- Deliver one self-contained index.html file with inline CSS and JavaScript.
- Use a pinned Three.js ES-module version and OrbitControls.
- Do not use Mint, Mint MCP, runtime MCP calls, trackers, or a backend.
- Make all interaction controls accessible by name and provide live status updates.
- Respect prefers-reduced-motion.
- Use a clear interaction state machine for shelf, opening, inspection, reading, and closing.
- Prefer time-based deterministic interpolation over frame-dependent lerp cutoffs. The first and final pose of every transition must match exactly.

VERIFICATION
- Run the page from a local HTTP server.
- Test shelf navigation with wheel, keys, buttons, and markers.
- Test a single click from the shelf into detail.
- Test hover, click, and drag opening.
- Drag forward and backward through multiple pages and confirm the committed page does not spring back.
- Drag the cover closed from the first page.
- Return to the shelf from both a closed and open book.
- Sample the first, middle, penultimate, and final animation frames to rule out jumps.
- Open a volume with three passages and one with two; confirm the spread count follows the content.
- Read the longest quotation in the collection on a real page and confirm it neither overflows nor collides with its attribution.
- Confirm the panel shows the passage facing the reader, and clears it on the title page and colophon.
- Check desktop and narrow layouts.
- Finish with zero console errors or warnings.
```

## Remix directions

Change only one or two systems at a time so the material craft remains coherent:

- Replace the philosophy sections with architecture, cinema, typography, or music volumes.
- Move from cloth and foil to translucent resin, recycled paper, or technical manuals.
- Keep the model but redesign the shelf as a reading table, archive drawer, or museum plinth.
- Replace the editorial palette while retaining the deterministic motion and page physics.
