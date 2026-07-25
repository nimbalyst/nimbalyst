# Tracker filters

Tracker filtering has one configurable surface: the **Filter** control in the tracker header.

The former left-sidebar presets are represented by ordinary field clauses instead:

- Mine: `Owner is current user`
- Unassigned: `Owner is empty`
- High Priority: `Priority is any of Critical, High`
- Favorites: `Favorite is True`
- Recently Viewed: `Viewed is in the last N days`
- Edited by Others: `Updated by is not current user`
- Recent: `Updated is in the last N days`
- Archived: `Archived is True`

Clauses appear as removable pills beside search and are persisted directly in saved views. They can be combined with the filter builder's AND/OR setting.

Collection-valued fields such as Tags and multi-value relationships use checkboxes in the value picker. Select any number of values and apply them as one `is any of` clause; reopening the field restores the current selection for editing.

Relative user clauses resolve against the signed-in user's current identity when the view is evaluated. Relative date clauses store a day count rather than a timestamp, so reopening a saved view recalculates its boundary from the current time.

`Viewed` and `Favorite` are personal fields. Their values come from the current user's workspace-scoped tracker state rather than the shared tracker row. `Viewed` is available as a column and supports empty/non-empty and relative-date predicates.

Persisted layouts and saved views that still contain the removed sidebar presets are migrated to the equivalent field clauses when applied.
