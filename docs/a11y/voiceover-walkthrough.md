# VoiceOver walkthrough

A manual check of Papertie with VoiceOver on macOS. It follows the keyboard-only journey that
`e2e/app/keyboard.spec.ts` runs, then the shelf, the writer and the split view.

What the tests assert, and what they do not:

- **Bold** words are asserted by `keyboard.spec.ts` (or `a11y.spec.ts`), as live-region text,
  accessible names, descriptions, group names, counts or positions. If you hear something
  else there, that is a bug.
- Plain words are VoiceOver's own: role words ("edit text", "button", "article", "dialog"),
  "selected", "expanded" and "collapsed", and the pauses. They are **not test-asserted**. This
  is the expected wording, which differs a little between VoiceOver versions.

## Before you start

- Turn VoiceOver on with ⌘F5. VO means Control+Option.
- Turn Quick Nav off (press ← and → together until VoiceOver says "Quick Nav off"), so the
  arrow keys and Option+arrows reach the app.
- Start Papertie on a fresh data folder, so the board holds only the welcome note. Launching
  it with the environment variable `PAPERTIE_USER_DATA` set to an empty folder does that
  without touching your own board.
- VoiceOver reads a description (for example "Tied to …") after a short pause, once the name
  and role have been read. Wait for it, or press VO+Shift+H to hear it again.
- Live-region lines are read politely, after whatever VoiceOver was saying.

## The walkthrough

| # | Do | Expect to hear |
|---|----|----------------|
| 1 | Start Papertie. | Once the board is in: "**Your board is open: 1 note**". |
| 2 | Tab. | "**Papertie — hide tools**, expanded, button". |
| 3 | Tab, then press Enter on "**New note**". | "New note, button". Then "**New note**, dialog". The focus lands on the checked paper, for example "Cream, selected, radio button, 1 of **8**", in the group "**Paper**". |
| 4 | Press → three times. | "Rose", "Apricot", then "**Indigo**, selected, radio button, **4** of **8**". |
| 5 | Press Enter. | "**New Indigo note. Write, then Esc.**". The editor has the focus. |
| 6 | Type `Spring trip`, then press Esc. | The note keeps the focus: "**Spring trip**, article", then after a pause "**Selected**". |
| 7 | Shift+Tab back to "New note" and press Enter. Press → once, then Enter. Type `Packing list`, then Esc. | "**Sage**, selected, radio button, **5** of **8**". Then "**New Sage note. Write, then Esc.**". Then "**Packing list**, article". |
| 8 | Press Shift+Option+→ twelve times, then Option+↓ once. | After you stop: "**Moved 1 note**". |
| 9 | Press C. Type `Spring`. Press Enter. | "**Connect to…**", the search field. Then "**1 note**" (the result count). Then "**Tied "Packing list" to "Spring trip" with crimson yarn**". The focus is back on Packing list: "**Packing list**, article", then after a pause "**Tied to "Spring trip" by crimson yarn. Selected**". |
| 10 | Shift+Tab to "Spring trip". Press C. Type `pin a thought`. Press Enter. | "**Spring trip**, article … **Tied to "Packing list" by crimson yarn.**" Then "**Tied "Spring trip" to "Press + to pin a thought" with crimson yarn**". |
| 11 | Tab to "Packing list". Press F. | "**Focus, 1 step: 2 notes**". |
| 12 | Shift+Tab to "**More steps**" (a button on the Focus toolbar) and press Enter. Then press Esc. | "**More steps**, button". Then "**Focus, 2 steps: 3 notes**". After Esc: "**Showing the whole board**". |
| 13 | Press ⌘K. Type `Spring trip`. Press Enter. | "**Search notes**", the search field. Then "**1 note**". Then "**Showing Spring trip**". |
| 14 | Press ⌘Z. Then quit Papertie (⌘Q) and start it again. | "**Undid tie**" (the welcome note's thread is gone). After the restart: "**Your board is open: 3 notes**". Tab to Packing list: "**Packing list**, article … **Tied to "Spring trip" by crimson yarn.**" |

## The shelf

Run after the walkthrough, on the same board. Bold words are asserted by `a11y.spec.ts`,
`e2e/app/shelf.spec.ts` or `apps/web/test/book/shelf.test.tsx`.

| # | Do | Expect to hear |
|---|----|----------------|
| 15 | Tab through the panel to "**Books**" and press Enter. | "**Books**, toggle button, not pressed". Then "**Books**, dialog", and the button is now pressed. |
| 16 | Tab to "**New book**" and press Enter. | "**New book**, button". The book opens: its title field, "**Title**, edit text", is focused and empty ("**Untitled**" as its placeholder). |
| 17 | Type `Winter notes`, then press Esc. | Back on the shelf: "**Books**, dialog". |
| 18 | Tab to "**Winter notes**" (a book, a button). Press Option+←. | "**Winter notes**, button". Then "**Moved Winter notes to place 1 of 2**" (with one book before it). The focus stays on Winter notes. |
| 19 | Tab to "**Options for Winter notes**" and press Enter. | "**Winter notes**, dialog", then "**Rename**, button", "**New cover**", the group "**Language**" ("**English**, selected, radio button"), "**Delete**". |
| 20 | Press Enter on "**Delete**". | An alert: "**Delete “Winter notes”? You can put it back for 30 days.**", the focus on "**Keep**, button". Tab to "**Delete**", press Enter: the book leaves the shelf, and the focus goes to the book after it (or "New book"). |
| 21 | Press ⌘Z. | "**Undid Delete book**", and Winter notes is back where it stood. |
| 22 | Delete it again (steps 19–20), then Tab to "**Recently deleted**" and press Enter. | "**Recently deleted**, dialog". A list: "**Winter notes**", "**30 days left**", "**Put it back**, button". Press Enter on "Put it back": it is back on the shelf. |
| 23 | Press Esc twice. | The list closes, then the shelf: back on the board, "**Books**" not pressed. |

## The writer

Run after the shelf, on the same board, with Winter notes back on the shelf. Bold words are
asserted by `a11y.spec.ts`, `e2e/app/writer.spec.ts` or `apps/web/test/book/writer.test.tsx`.
The page's text is one edit field a paragraph: VoiceOver reads each as "edit text". These
steps describe the book at full width (a dialog over the board); beside the board it is a
region, as in the split view below.

| # | Do | Expect to hear |
|---|----|----------------|
| 24 | On the shelf, Tab to "**Winter notes**" and press Enter. | "**Winter notes**, dialog". Tab: "**Books**, button", then "**Title**, edit text, **Winter notes**". |
| 25 | In the title press Enter, then type `# On collecting`. | The focus goes into the text. As the space after `#` lands the paragraph becomes a heading: "**Chapter 1** On collecting, heading level 1" when you read it back (VO+A). |
| 26 | Press Enter and type `Who writes "thinks" twice -- once...` | A new paragraph. Read back: "Who writes “thinks” twice – once…" (the quotes and the dash corrected as typed). |
| 27 | Press Shift+Option+← to select "once…", then move to the sidebar's group "**Writing**" (VO+arrows). | "**Text style**, button", "**Bold**, toggle button", "**Italic**, toggle button", "**Footnote**", "**Pin to board**". Press Enter on "**Italic**": "**Italic**, toggle button, pressed". "Text style" opens the choices "**Paragraph**", "**Chapter**", "**Section**", "**Quote**", "**List**", "**Prompt**". |
| 28 | Press ⌘Z. | "**Undid writing**": the italic is gone. ⇧⌘Z puts it back ("**Redid writing**"). |
| 29 | Press Esc. | Back on the shelf: "**Books**, dialog". With a dead key pending (⌥E), Esc cancels the dead key only and the page stays. |

## The split view

Run on a window at least 1,024 px wide, after the writer, with Winter notes open. Bold words are
asserted by `a11y.spec.ts`, `e2e/app/split.spec.ts` or `apps/web/test/app/split.test.tsx`.

| # | Do | Expect to hear |
|---|----|----------------|
| 30 | Open Winter notes from the shelf. | The book opens beside the board: "**Winter notes**, region" (not a dialog). The board stays to its left and is read as before. |
| 31 | Shift+Tab from the book's Books until the seam. | "**Book width**, splitter" (or separator), "**Book takes 50% of the window**". |
| 32 | Press ← twice, then →. | "**Book takes 55% of the window**", "**Book takes 60% of the window**", then 55%. Home and End go to the book's least and most. |
| 33 | Tab into the book to "**Board**, toggle button, pressed" and press it (or ⌘\ in the text). | The book goes full width over the board; "**Board**, toggle button, not pressed". Press it again: the board is beside the book again. |
| 34 | Click a note on the board, then press Delete, F and ⌘Z there. | The board's own: they act on the note. Back in the book (click the text), the same keys write in the book only; the note stays selected and unchanged. |
| 35 | With the focus on the board, press ⌘\. | The book side closes: back on the board. ⌘\ again (the shortcut of "**Books**") opens the book beside it. |
| 36 | Narrow the window under 1,024 px. | The book fills the window over the board, as in step 24. "**Board**" goes to the board; Books comes back to the book. |

## What to note

For each step, write down:

- whether you heard the bold words (yes or no);
- the macOS and Papertie versions;
- anything VoiceOver read that the page does not show, or anything the page shows that
  VoiceOver never read.

Only the threads, the pins and the far-zoom note cards are drawn on a canvas. Their
DOM equivalents are each note's "Tied to …" description, the live region, and *Connect to…*
(C). `e2e/app/a11y-exceptions.ts` holds the justification. If a thread can be seen but not
heard, that is a finding.
