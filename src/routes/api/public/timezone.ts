import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/timezone")({
  server: { handlers: { GET: ({ request }) => {
    // Only edge-provided geolocation is trusted; do not retain or return IP addresses.
    const timezone = (request as Request & { cf?: { timezone?: string } }).cf?.timezone;
    return Response.json({ timezone: timezone ?? null }, { headers: { "Cache-Control": "private, no-store" } });
  } } },
});