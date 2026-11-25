// Vercel Function: the visitor's country from the edge header, checked by the app against
// geo.json (written at deploy time). Nothing about the visitor is stored.
export default function handler(req, res) {
  const country = req.headers["x-vercel-ip-country"] ?? null;
  res.setHeader("cache-control", "private, no-store");
  res.status(200).json({ country: typeof country === "string" ? country.toUpperCase() : null });
}
