#!/bin/bash
#
# Remove syncId fields from YAML frontmatter in markdown files.
# Preserves all other frontmatter fields. If syncId was the only field,
# removes the entire frontmatter block.
#
# Usage: ./scripts/remove-syncid-frontmatter.sh [directory]
#   directory: path to scan (defaults to current directory)
#
# Dry run first:
#   DRY_RUN=1 ./scripts/remove-syncid-frontmatter.sh ~/my-project

DIR="${1:-.}"
DRY_RUN="${DRY_RUN:-0}"
MODIFIED=0
SKIPPED=0

while IFS= read -r -d '' file; do
  # Check if file starts with ---
  head_line=$(head -1 "$file")
  if [[ "$head_line" != "---" ]]; then
    continue
  fi

  # Check if file contains syncId in frontmatter
  if ! grep -q 'syncId:' "$file"; then
    continue
  fi

  # Find the closing --- line number (skip line 1)
  closing_line=$(awk 'NR > 1 && /^---$/ { print NR; exit }' "$file")
  if [[ -z "$closing_line" ]]; then
    continue
  fi

  # Extract frontmatter content (between the --- markers)
  frontmatter=$(sed -n "2,$((closing_line - 1))p" "$file")

  # Remove syncId line(s)
  cleaned=$(echo "$frontmatter" | grep -v '^syncId:')

  # Check if any frontmatter fields remain
  remaining=$(echo "$cleaned" | sed '/^[[:space:]]*$/d')

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ -z "$remaining" ]]; then
      echo "[dry-run] Would remove entire frontmatter block: $file"
    else
      echo "[dry-run] Would remove syncId field: $file"
    fi
    MODIFIED=$((MODIFIED + 1))
    continue
  fi

  if [[ -z "$remaining" ]]; then
    # syncId was the only field -- remove entire frontmatter block
    tail -n +"$((closing_line + 1))" "$file" > "$file.tmp"
    # Remove leading blank line if present
    sed -i '' '1{/^$/d;}' "$file.tmp"
    mv "$file.tmp" "$file"
    echo "Removed entire frontmatter block: $file"
  else
    # Remove just the syncId line, keep other frontmatter
    {
      echo "---"
      echo "$remaining"
      sed -n "${closing_line},\$p" "$file"
    } > "$file.tmp"
    mv "$file.tmp" "$file"
    echo "Removed syncId field: $file"
  fi
  MODIFIED=$((MODIFIED + 1))

done < <(find "$DIR" -name '*.md' -not -path '*/node_modules/*' -not -path '*/.git/*' -print0)

echo ""
echo "Done. Modified: $MODIFIED files."
