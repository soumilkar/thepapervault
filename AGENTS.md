# Architecture rules
- Use EntryContent for user entry previews and expanded bodies, preserving the written text layout and parsing only image references; this prevents formatting changes when expanding.
- Use ImageLinkButton for image-URL insertion into existing content fields; references follow the same storage and draft lifecycle as their parent text.
- Use pageMeta for leaf-page social metadata; each content page needs its own app-specific title and description.