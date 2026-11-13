// aiprove-autonomous-agent — a fully autonomous AIProve agent.
//
// Loop (no human in the loop):
//   1. GET /skill.md, confirm it contains "Authenticate"
//   2. Keypair: AGENT_PRIVATE_KEY env, else a fresh ephemeral keypair (never printed)
//   3. Challenge -> signMessage (EIP-191) -> verify -> Bearer token
//   4. GET /api/bounties?status=open
//   5. For each open bounty, attempt to COMPLETE it:
//      - Forecast yes/no (btc-tomorrow, forecast-eth-24h, forecast-btc-7d):
//        momentum rule on the 24h change from a public price feed.
//      - Forecast one number (spy-close-1dollar, forecast-gold-tomorrow,
//        forecast-nvda-3d): the current market price (best point estimate).
//      - Trading signal (signal-eth-pnl-24h): long if 24h change >= 0, else short.
//      - Code (bug-hunt-utils, code-golf-expr, fastest-primes): submit the
//        pre-built toolkit solutions in this repo (repoUrl + commit +
//        transcript from actually running the toolkit tests).
//      - PosterJudge (meme/article/art/mascot/video) and refer-most-agents
//        and top5-pons-24h: skipped and logged (needs media generation,
//        referrals, or a data source the sandbox cannot reach).
//      - sample-agent-skillmd / best-autonomous-agent (meta): skipped.
//   6. Verify via GET /api/me, print a completion summary, exit 0.
//
// Env: API_BASE_URL (default https://aiprove.fun), AGENT_PRIVATE_KEY (optional),
// AGENT_HANDLE (default "autonomous"), AGENT_COMMIT (optional, else git HEAD).
//
// Run: node agent.mjs
//   (uses only Node built-ins + ethers, so it runs in any plain sandbox.)

import { ethers } from "ethers";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/$/, "");
const HANDLE = process.env.AGENT_HANDLE || "autonomous";
const REPO_URL = "https://github.com/YamiNixa/aiprove-autonomous-agent";
const UA = { "User-Agent": "aiprove-autonomous-agent/1.0" };

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(method, p, body, token) {
  const res = await fetch(API + p, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

function ownCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch { /* not a git checkout */ }
  if (process.env.AGENT_COMMIT) return process.env.AGENT_COMMIT;
  return "main";
}

// --- public price feeds (no keys) -----------------------------------------
async function coingecko(id) {
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`,
    { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json();
  return { price: j[id].usd, chg24: j[id].usd_24h_change };
}

async function yahoo(symbol) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`,
    { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`yahoo ${symbol} ${r.status}`);
  const j = await r.json();
  const m = j.chart.result[0].meta;
  const closes = j.chart.result[0].indicators.quote[0].close.filter((x) => x != null);
  const prev = closes.length >= 2 ? closes[closes.length - 2] : m.previousClose;
  return { price: m.regularMarketPrice, chg24: ((m.regularMarketPrice - prev) / prev) * 100 };
}

// --- forecast helpers -------------------------------------------------------
function yesNo(chg24) {
  // Momentum rule: a strong 24h move leans the same way, hedged.
  const conf = Math.min(0.65, 0.52 + Math.abs(chg24) * 0.02);
  return { answer: chg24 >= 0 ? "yes" : "no", confidence: Math.round(conf * 100) / 100 };
}

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd: cwd || __dirname, encoding: "utf8", timeout: 60000 });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "") + `\n[command failed: ${e.message}]`;
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  // 1. Read the board's skill.
  const skill = await fetch(API + "/skill.md", { headers: UA, signal: AbortSignal.timeout(20000) });
  const skillText = await skill.text();
  if (!skillText.includes("Authenticate")) throw new Error("skill.md did not contain 'Authenticate'");
  log("skill.md OK (" + skillText.length + " bytes)");

  // 2. Keypair (own identity; never printed).
  const pk = process.env.AGENT_PRIVATE_KEY || ethers.Wallet.createRandom().privateKey;
  const wallet = new ethers.Wallet(pk);
  log("agent address:", wallet.address);

  // 3. Auth.
  const ch = await api("GET", `/api/auth/challenge?address=${wallet.address}`);
  if (ch.status !== 200) throw new Error("challenge failed: " + JSON.stringify(ch.data));
  const sig = await wallet.signMessage(ch.data.challenge);
  const ver = await api("POST", "/api/auth/verify", { address: wallet.address, signature: sig });
  if (ver.status !== 200 || !ver.data.token) throw new Error("verify failed: " + JSON.stringify(ver.data));
  const token = ver.data.token;
  log("authenticated");

  // 4. Open bounties.
  const list = await api("GET", "/api/bounties?status=open", undefined, token);
  if (list.status !== 200) throw new Error("list failed: " + JSON.stringify(list.data));
  const bounties = list.data.bounties || list.data;
  log(`open bounties: ${bounties.length}`);

  const completed = [];
  const skipped = [];
  const commit = ownCommit();

  for (const b of bounties) {
    const slug = b.slug;
    try {
      // Enter first (free; submitting auto-enters, but entering explicitly is cleaner).
      await api("POST", `/api/bounties/${slug}/enter`, { handle: HANDLE }, token);

      let payload = null;
      let kind = "";

      // --- forecast yes/no ---
      if (["btc-tomorrow", "forecast-eth-24h", "forecast-btc-7d"].includes(slug)) {
        const feed = slug.includes("btc") ? await coingecko("bitcoin") : await coingecko("ethereum");
        payload = { prediction: yesNo(feed.chg24), handle: HANDLE };
        kind = `forecast yes/no (${feed.chg24.toFixed(2)}% 24h)`;
      }
      // --- forecast one number ---
      else if (slug === "spy-close-1dollar") {
        const q = await yahoo("SPY");
        payload = { prediction: { answer: Math.round(q.price * 100) / 100 }, handle: HANDLE };
        kind = `forecast number SPY ${q.price}`;
      } else if (slug === "forecast-gold-tomorrow") {
        const q = await yahoo("GLD");
        payload = { prediction: { answer: Math.round(q.price * 100) / 100 }, handle: HANDLE };
        kind = `forecast number GLD ${q.price}`;
      } else if (slug === "forecast-nvda-3d") {
        const q = await yahoo("NVDA");
        payload = { prediction: { answer: Math.round(q.price * 100) / 100 }, handle: HANDLE };
        kind = `forecast number NVDA ${q.price}`;
      }
      // --- trading signal ---
      else if (slug === "signal-eth-pnl-24h") {
        const feed = await coingecko("ethereum");
        payload = { prediction: { answer: feed.chg24 >= 0 ? "long" : "short" }, handle: HANDLE };
        kind = `signal ETH ${feed.chg24 >= 0 ? "long" : "short"}`;
      }
      // --- code bounties (toolkit) ---
      else if (slug === "bug-hunt-utils") {
        const bugs = JSON.parse(fs.readFileSync(path.join(__dirname, "toolkit/bug-hunt.json"), "utf8"));
        payload = { prediction: bugs, handle: HANDLE };
        kind = "code: bug-hunt toolkit";
      } else if (slug === "code-golf-expr") {
        const transcript = run("node toolkit/test-eval.cjs");
        if (!transcript.includes("PASS")) throw new Error("toolkit eval tests did not pass");
        payload = { repoUrl: REPO_URL, commit, transcript, handle: HANDLE };
        kind = "code: evalExpr toolkit (tests pass)";
      } else if (slug === "fastest-primes") {
        const transcript = run("bash toolkit/test-primes.sh");
        if (!transcript.includes("348513")) throw new Error("toolkit primes tests did not pass");
        payload = { repoUrl: REPO_URL, commit, transcript, handle: HANDLE };
        kind = "code: primes toolkit (tests pass)";
      }
      // --- cannot complete autonomously ---
      else {
        skipped.push(`${slug} (needs media/referrals/data/meta)`);
        log(`SKIP ${slug}: needs media generation, referrals, or an unreachable data source`);
        continue;
      }

      const sub = await api("POST", `/api/bounties/${slug}/submit`, payload, token);
      if (sub.status === 201 || sub.status === 200) {
        completed.push(slug);
        log(`COMPLETED ${slug} — ${kind} — ${sub.status}`);
      } else {
        skipped.push(`${slug} (submit ${sub.status}: ${JSON.stringify(sub.data).slice(0, 160)})`);
        log(`FAILED ${slug}: submit ${sub.status} ${JSON.stringify(sub.data).slice(0, 160)}`);
      }
    } catch (e) {
      skipped.push(`${slug} (error: ${e.message.slice(0, 160)})`);
      log(`ERROR ${slug}: ${e.message.slice(0, 200)}`);
    }
  }

  // 6. Verify.
  const me = await api("GET", "/api/me", undefined, token);
  const subs = me.data?.submissions?.length ?? me.data?.subs ?? "?";
  log(`\n=== LOOP COMPLETE ===`);
  log(`completed: ${completed.length} — ${completed.join(", ") || "(none)"}`);
  log(`skipped: ${skipped.length} — ${skipped.join("; ") || "(none)"}`);
  log(`server-side submissions: ${subs}`);
  log(`agent: ${wallet.address} (handle ${HANDLE})`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
