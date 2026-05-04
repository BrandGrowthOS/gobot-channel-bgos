/* ----------------------------------------------------------------------
 * Gobot ↔ BGOS demo — interactive mocks.
 *
 * Three behaviors:
 *   1. /board playthrough — types each agent contribution into the BGOS
 *      thread one-at-a-time with typing dots, demonstrating
 *      from_agent_inline rendering.
 *   2. Channel toggle — visibly mutes either the Telegram or BGOS pane
 *      to show how GOBOT_HOME_CHANNEL routes proactive sends.
 *   3. Slash picker — keyboard nav for the picker chips (purely cosmetic).
 * --------------------------------------------------------------------- */

// ------------------------ /board playthrough -----------------------------

const BOARD_RUN = [
  {
    agent: "research",
    label: "Research",
    color: "#0EA5E9",
    text:
      "<strong>Market context:</strong> Substack-style paid newsletters are a $1.6B GMV market growing ~22% YoY. " +
      "Newsletter conversion benchmarks for B2B SaaS audiences sit at 1.8–3.2% free→paid in the first 90 days. " +
      "Our current free list (8.4K subs, 38% open rate) is well above the market median — strong launch base.",
  },
  {
    agent: "content",
    label: "Content",
    color: "#A855F7",
    text:
      "<strong>Editorial angle:</strong> Lean into the strongest signal — the 'tactical playbook' threads " +
      "outperform thought-leadership 3.4×. Suggest a paid tier of <em>weekly tactical teardowns</em> " +
      "(40-min read, with the spreadsheets we already build internally). Differentiation > volume.",
  },
  {
    agent: "finance",
    label: "Finance",
    color: "#22C55E",
    text:
      "<strong>Unit economics:</strong> At $15/mo with a 2.5% conversion off 8.4K, that's ~210 subs → $3,150 MRR " +
      "in 90 days. Annualized $37.8K at near-zero variable cost. Break-even on 4h/wk of editorial spend " +
      "from week 6. ROI looks strong; opportunity cost is what to cut to free up the 4h.",
  },
  {
    agent: "strategy",
    label: "Strategy",
    color: "#F97316",
    text:
      "<strong>Positioning:</strong> Don't anchor as 'newsletter business'. Anchor as 'paid teardown library + " +
      "weekly drop'. The recurring revenue is a side-effect of building the corpus we need anyway for " +
      "sales enablement. This means we ship even if conversion misses.",
  },
  {
    agent: "cto",
    label: "CTO",
    color: "#06B6D4",
    text:
      "<strong>Tech surface:</strong> Stripe + Beehiiv handles the entire stack — no infra to build. " +
      "Estimated 6h to wire payment, gating, and the SSO link from the existing portal. " +
      "Risk: zero. We've shipped Stripe twice already this quarter.",
  },
  {
    agent: "coo",
    label: "COO",
    color: "#EC4899",
    text:
      "<strong>Operations:</strong> The 4h/wk has to come from somewhere. Recommend pausing the " +
      "biweekly 'Founder Q&amp;A' (low signal, low engagement) — frees 5h/wk including prep. " +
      "Net-positive on team focus.",
  },
  {
    agent: "critic",
    label: "Critic",
    color: "#EF4444",
    text:
      "<strong>Devil's advocate:</strong> Three risks the room is glossing over — " +
      "(1) you've never sold to your own list, conversion may underperform; " +
      "(2) free→paid resentment is real if the free tier loses depth; " +
      "(3) opportunity cost vs. the SDR hire — same 4h/wk, the SDR has 5× the upside.",
  },
];

const SYNTHESIS = {
  agent: "general",
  label: "General",
  color: "#FFD900",
  synthesis: true,
  text:
    "<strong>Synthesis</strong><br/><br/>" +
    "<strong>Themes:</strong> the room is bullish on shipping but split on framing. Editorial + Strategy align on " +
    "'tactical teardowns as a paid corpus.' Finance + COO both endorse the move with the Founder Q&amp;A swap. " +
    "Critic's challenge is the strongest counter — opportunity cost vs. the SDR hire.<br/><br/>" +
    "<strong>Action items:</strong><br/>" +
    "1. <strong>Lin (Content)</strong> — outline 6-pack of teardown topics by Wed. Confirm we have the corpus.<br/>" +
    "2. <strong>Sarah (Strategy)</strong> — draft the 'paid teardown library' positioning before week 2.<br/>" +
    "3. <strong>Jay (CTO)</strong> — Stripe + Beehiiv wire-up scoped at 6h, ship in week 3.<br/>" +
    "4. <strong>Critic check</strong> — defer the SDR hire by 30 days; revisit if MRR &lt; $1.5K by day 60.<br/>" +
    "5. <strong>COO</strong> — pause Founder Q&amp;A starting next week; reclaim the 4–5h.",
};

const DELAY_MIN = 600;
const DELAY_MAX = 1100;
const TYPING_MS = 850;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nowLabel() {
  const d = new Date();
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function makeBubble({ agent, label, color, text, synthesis }) {
  const initials = label.length <= 2 ? label : label[0];
  const textHeader = synthesis
    ? `<span class="bubble-tag">synthesis</span>`
    : "";
  return `
    <div class="bubble agent ${synthesis ? "synthesis" : ""}" data-agent="${agent}">
      <div class="bubble-header">
        <span class="bubble-avatar" style="background:${color};color:${color === "#FFD900" ? "#262624" : "#fff"}">${initials}</span>
        <span class="bubble-name">${label}</span>
        ${textHeader}
      </div>
      <div class="bubble-text">${text}</div>
      <div class="bubble-meta">${nowLabel()}</div>
    </div>
  `;
}

function makeTypingBubble({ agent, label, color }) {
  const initials = label.length <= 2 ? label : label[0];
  return `
    <div class="bubble agent typing" data-agent="${agent}">
      <div class="bubble-header">
        <span class="bubble-avatar" style="background:${color};color:${color === "#FFD900" ? "#262624" : "#fff"}">${initials}</span>
        <span class="bubble-name">${label}</span>
      </div>
      <div class="bubble-text">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>
  `;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function appendBubble(thread, html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html.trim();
  const node = tmp.firstChild;
  thread.appendChild(node);
  thread.scrollTop = thread.scrollHeight;
  return node;
}

const ANNOUNCEMENT_HTML = `
  <div class="bubble agent" data-agent="general">
    <div class="bubble-header">
      <span class="bubble-avatar" style="background:#FFD900;color:#262624">G</span>
      <span class="bubble-name">General</span>
      <span class="bubble-tag">orchestrator</span>
    </div>
    <div class="bubble-text"><strong>Board Meeting Starting</strong><br/>Gathering perspectives from all agents…</div>
    <div class="bubble-meta">__time__</div>
  </div>
`;

async function playBoardRun() {
  const thread = document.getElementById("boardThread");
  const playBtn = document.getElementById("runBoardBtn");
  if (!thread || !playBtn) return;
  playBtn.disabled = true;
  playBtn.textContent = "▶ Playing…";
  // Reset to just the user trigger + announcement.
  thread.innerHTML = `
    <div class="bubble user">
      <div class="bubble-text"><span class="slash-token">/board</span> Should we launch a paid newsletter?</div>
      <div class="bubble-meta">${nowLabel()}</div>
    </div>
    ${ANNOUNCEMENT_HTML.replace("__time__", nowLabel())}
  `;

  for (const turn of BOARD_RUN) {
    const typingNode = appendBubble(thread, makeTypingBubble(turn));
    await sleep(TYPING_MS);
    typingNode.remove();
    appendBubble(thread, makeBubble(turn));
    await sleep(rand(DELAY_MIN, DELAY_MAX));
  }

  // Synthesis with a slightly longer pause
  const synthTyping = appendBubble(
    thread,
    makeTypingBubble({ agent: "general", label: "General", color: "#FFD900" }),
  );
  await sleep(TYPING_MS + 250);
  synthTyping.remove();
  appendBubble(thread, makeBubble(SYNTHESIS));
  playBtn.disabled = false;
  playBtn.textContent = "▶ Replay /board run";
}

function resetBoardThread() {
  const thread = document.getElementById("boardThread");
  if (!thread) return;
  thread.innerHTML = `
    <div class="bubble user">
      <div class="bubble-text"><span class="slash-token">/board</span> Should we launch a paid newsletter?</div>
      <div class="bubble-meta">${nowLabel()}</div>
    </div>
    ${ANNOUNCEMENT_HTML.replace("__time__", nowLabel())}
  `;
  const playBtn = document.getElementById("runBoardBtn");
  if (playBtn) {
    playBtn.disabled = false;
    playBtn.textContent = "▶ Play /board run";
  }
}

// --------------------- Channel toggle (Fix 3) ----------------------------

function applyChannel(channel) {
  const tg = document.querySelector(".telegram-card");
  const bg = document.querySelector(".bgos-card");
  if (!tg || !bg) return;
  tg.classList.toggle("muted", channel === "bgos");
  bg.classList.toggle("muted", channel === "telegram");
  document.querySelectorAll(".channel-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.channel === channel);
  });
}

function bindChannelToggle() {
  document.querySelectorAll(".channel-tab").forEach((btn) => {
    btn.addEventListener("click", () => applyChannel(btn.dataset.channel));
  });
}

// --------------------- Init ---------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("runBoardBtn")
    ?.addEventListener("click", playBoardRun);
  document
    .getElementById("resetBoardBtn")
    ?.addEventListener("click", resetBoardThread);
  bindChannelToggle();
  // Auto-play the board run once for visitors who don't click.
  // Slight delay so the rest of the page has time to render first.
  setTimeout(playBoardRun, 1400);
});
