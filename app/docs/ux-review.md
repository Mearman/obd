# Interface conventions and review checklist

The app's screens share one kit in `app/src/ui` and one set of theme tokens in `app/src/theme`. A screen that needs something the kit lacks adds it to the kit first, so every screen gets it.

## Conventions

- **Touch targets.** Every control is at least 44 px in both directions. The end-to-end suite measures the control itself, so a small visible box inside a large control is drawn with the control's own styling, never by shrinking the control (`app/src/library/library.css.ts`).
- **Badges** stay on one line. Only a long sentence, such as the note on a shared link, opts into `wrap`. A badge appears only when it says something the default would not: a run is recorded unless it is simulated, so only "Simulated" is shown.
- **Actions.** A row or card has at most a few visible actions; related secondary actions share one `Menu` (for example the run export formats). A destructive action is a separate, plainly worded button.
- **Buttons.** `block` buttons are full width on a phone and natural width from 640 px, so a single action does not stretch across a desktop.
- **Tables.** `DataTable` is a table from 640 px and one card per row below it. A column can be `nowrap` (kept on one line on a wide screen) or `bare` (a control that needs no heading on a card). A cell with no value is not shown on a card.
- **Long reference text** that most visits do not need, such as the list of bundled profiles, sits in a disclosure with a 44 px summary.
- **Graphs** fill the width when there is one and share it when there are several.
- **Theme.** Colours come from tokens only, with a light and a dark value for each.

## Checking a view

The end-to-end suite visits Session, Library, Settings, Guide, graphs and live collection at phone, tablet and desktop widths in light and dark, fails on any horizontal page scroll or any control under 44 px, and saves a screenshot of each to `app/screenshots` (not committed). Review those screenshots for what the suite cannot decide:

1. Is there one clear primary action per card, row or screen?
2. Does any badge, label or button wrap mid-word or onto a second line when there is room?
3. Does any card label a control or value with a heading that adds nothing?
4. Is every empty, loading and error state present and worded in the same way as the others?
5. Does the view read the same way in both themes?
