// Route Instagram/Facebook CDN images through our server proxy (/api/img).
// The IG CDN blocks cross-origin hotlinking (CORP/ORB) and signs its URLs, so a
// direct client <img src> to *.cdninstagram.com / *.fbcdn.net frequently fails
// to load — most visibly for avatars. Non-CDN or local URLs pass through
// untouched. Empty input falls back to the local placeholder.
export function proxiedImage(url?: string): string {
  if (!url) return "/placeholder.svg"
  if (/^https?:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)/i.test(url)) {
    return `/api/img?url=${encodeURIComponent(url)}`
  }
  return url
}
