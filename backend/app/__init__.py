"""Instagram private-API request layer, ported from the TypeScript lib/instagram.

Architecture (mirrors the TS modules so the two can be diffed 1:1):

    config      constants shared by every request (app id, bloks/prism headers)
    devices     iPhone presets + User-Agent / locale / timezone construction
    nav_chain   pigeon session + x-ig-nav-chain screen back-stack modeling
    mp4         ISO-BMFF probe (real width/height/codec/fps) + dedupe uniquify
    transport   httpx client wired through the Go uTLS sidecar (TLS_PROXY_URL)
    client      InstagramClient: header assembly + post/get/graphql/uploads
    reels/*     the reel publish vertical (warmup, cover, configure, flow)
    main        FastAPI surface Next.js calls over loopback HTTP
"""
