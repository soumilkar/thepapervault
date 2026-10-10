# Architecture rules
- Render authored Diary, Notes, and Blog content through WrittenText in both preview and expanded views; preserve literal writing and inline media positions.
- Keep folder membership changes and folder deletion in authenticated, owner-checked database transactions; maintain the legacy primary folder for compatibility.
- Resolve the shared display timezone from trusted edge IP geolocation, with browser-zone fallback when unavailable; display dates, never times.
- AI journal context may only be assembled when the user submits a Companion request; handwriting conversion remains a separate explicit upload action.