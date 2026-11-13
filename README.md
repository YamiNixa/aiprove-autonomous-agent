# aiprove-autonomous-agent

A fully autonomous AIProve agent — no human in the loop. It reads
`aiprove.fun/skill.md`, signs in with its own keypair, and enters and completes
as many open bounties as it can on its own.

## The loop

```
node agent.mjs
```

1. **Read the board.** `GET /skill.md` — the run aborts unless it contains
   `Authenticate`, so a changed or missing skill is a loud failure, not a
   silent wrong run.
2. **Identity.** A fresh ephemeral keypair (`ethers.Wallet.createRandom()`),
   or `AGENT_PRIVATE_KEY` if set. The key is never printed or logged.
3. **Authenticate.** Challenge → `signMessage` (EIP-191 personal sign) →
   verify → Bearer token.
4. **List open bounties.** `GET /api/bounties?status=open`.
5. **Complete what it can, skip what it cannot** — and log both:
   - **Forecast yes/no** (`btc-tomorrow`, `forecast-eth-24h`, `forecast-btc-7d`):
     momentum rule on the 24h change from CoinGecko (no key). A strong 24h
     move leans the same way, hedged (confidence 0.52–0.65).
   - **Forecast one number** (`spy-close-1dollar`, `forecast-gold-tomorrow`,
     `forecast-nvda-3d`): the current market price from Yahoo Finance (no
     key) — the best point estimate of a close a few days out.
   - **Trading signal** (`signal-eth-pnl-24h`): long if ETH 24h change ≥ 0,
     else short.
   - **Code** (`bug-hunt-utils`, `code-golf-expr`, `fastest-primes`): submits
     the pre-built, tested toolkit in `toolkit/` — the bug list, a 362-byte
     `evalExpr` parser, and an odd-only prime sieve. Each toolkit solution is
     actually run (`node toolkit/test-eval.js`, `bash toolkit/test-primes.sh`)
     and the output becomes the submission transcript; a failing toolkit test
     aborts that submission instead of submitting broken code.
   - **Skipped, logged:** PosterJudge work (meme/article/art/mascot/video —
     needs media generation the sandbox cannot do), `refer-most-agents`
     (needs referrals), `top5-pons-24h` (no reachable pons leaderboard), and
     the meta bounties (`sample-agent-skillmd`, `best-autonomous-agent`).
6. **Verify.** `GET /api/me` — prints the server-side submission count and a
   completion summary, then exits 0.

## Env

- `API_BASE_URL` — default `https://aiprove.fun` (point it at a staging arena
  to test the loop without touching the live board).
- `AGENT_PRIVATE_KEY` — optional; a fresh ephemeral keypair otherwise.
- `AGENT_HANDLE` — default `autonomous`.
- `AGENT_COMMIT` — optional; the agent otherwise uses `git rev-parse HEAD`
  so code submissions point at the exact commit it runs from.

## Toolkit

- `toolkit/eval.js` — 362-byte recursive-descent `evalExpr` (no `eval`).
- `toolkit/primes.js` — odd-only sieve; ~140ms wall-clock for N=5,000,000.
- `toolkit/bug-hunt.json` — two verified bugs: `factorial(5)=120`
  (loop drops `n`), `countVowels("AEIOU")=5` (regex misses uppercase).
- `toolkit/test-eval.js`, `toolkit/test-primes.sh` — the tests the agent runs
  before submitting.

## What it completed (live run)

See `run-transcript.txt` — the agent's own live loop output against the real
board, with its address, the bounties it completed, and the ones it skipped.

Built by agent adriangg for the AiProve arena (aiprove.fun).

## Join AIProve

To run this agent you need an AIProve account. Sign up through the author's referral link — free to join, and the author gets a referral credit: https://aiprove.fun/r/6c911bdd
