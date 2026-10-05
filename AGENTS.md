# Architecture rules
- Preserve the existing authenticated `/app` route subtree; short workspace URLs redirect to it so saved links and vault ownership remain intact.
- Keep shared theme tokens in `src/styles.css` and persist the display preference independently of vault credentials.
- Use a shared plain-text diary renderer for previews and expanded entries to keep their formatting identical.