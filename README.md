# Field Service Assistant (demo)

Hosted version of the ZapSight PoC demo for Fresenius field service. The page searches public FMCNA
2008T / 2008K2 technical documentation and asks Claude for ranked probable causes, each backed by an
exact quote from the current revision. Quotes that can't be found in the source text are dropped.

- `index.html`: the page (search runs in the browser).
- `api/ask.js`: Vercel function that calls Claude. It rebuilds the prompt from `corpus.json`, so it
  only answers questions about this library.
- `corpus.json`, `scenarios.json`: built by `ingest.py` in the demo source folder.

## Settings (Vercel → Project → Environment Variables)
- `ANTHROPIC_API_KEY`: the Claude API key that pays for answers. Set a monthly spend limit in the Anthropic Console.
- `DEMO_ACCESS_CODE`: viewers enter this once (or open `/?key=<code>`) to turn on Claude. Without it the page is search-only.
