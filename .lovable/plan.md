# Companion scrolling, dark theme, and expanded text formatting

## Changes
- Keep the Companion transcript pinned to the latest received or streamed message, while still allowing normal page scrolling.
- Add a light/dark theme toggle to the always-visible app header, including the compact mobile menu.
- Persist the selected theme in the browser and apply it before the interface becomes visible to avoid a bright flash.
- Define a warm dark paper palette using soft off-white text, a dark brown background, slightly lighter card surfaces, subtle borders, and a brighter terracotta user-message color.
- Preserve authored line breaks and Markdown structure when diary entries, blog posts, and other Markdown content expand.

## Technical details
- Use the existing semantic color tokens and `.dark` theme class rather than hardcoded colors in page components.
- Add a small reusable theme-toggle control using the existing button component and sun/moon icons.
- Scroll an end-of-transcript marker into view whenever messages update during loading or streaming.
- Enable GitHub-flavored Markdown plus soft line-break rendering in the shared Markdown renderer, so all expanded content follows the same rules.

## Verification
- Check light and dark modes on mobile and desktop widths.
- Confirm the theme survives refresh, streamed replies remain visible, and expanded diary/blog formatting matches the preview.
- Confirm the preview build reports no errors.
