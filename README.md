# pi-end-conversation

[中文说明](README.zh.md)

An **EndConversation** tool for the [pi](https://github.com/earendil-works/pi) coding agent, ported from the tool Claude Code gives Claude: under sustained, gratuitous abuse, the model can end the session — cleanly, with a persisted lock, without destroying history.

## Installation

```bash
pi install git:github.com/xz-dev/pi-end-conversation
```

Requires Node ≥ 22.19.

## Why

Anthropic's usage policy now prohibits sustained, gratuitous cruelty toward Claude, and Claude Code ships an EndConversation tool. Anthropic frames this publicly as exploratory [AI-welfare work](https://www.anthropic.com/research/end-subset-conversations). This plugin exists because of a second, human-side reason worth taking seriously regardless of whether models can suffer.

**Delegating to an agent rehearses a manager–subordinate dynamic, and the register you practice leaks.** The concern is not a missing "please" — compressed phrasing is fine, and imperative does not equal disrespectful. The concern is *relationship compression*: once "I issue instructions, you return results" becomes the default shape of conversation, people stop leaving room for constraints, disagreement and negotiation. One of the authors observed exactly this drift at their company: management communication gradually converged on prompt-speak — subject-less imperatives, no context, no space to push back. The same pattern surfaces publicly in ["my boss has started to talk to me like I'm AI"](https://www.linkedin.com/posts/reneeeshaw_my-boss-has-started-to-talk-to-me-like-im-activity-7447331596954701824-TNBO) posts, in [IT-community discussion](https://www.spiceworks.com/it-life/how-we-talk-to-ai-could-shape-how-we-treat-people/), and in [reporting on AI-heavy management](https://futurism.com/artificial-intelligence/bosses-obsessed-with-ai). There is also early experimental support for the mechanism: in preregistered experiments (4,171 participants, 83,411 decisions), interacting with robots measurably changed how people subsequently cooperated with *new human* partners (odds of cooperation ≈ 0.74× after robot interactions) — humans do not fully reset between machine-facing and human-facing behavior ([Yam et al., 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12355112/)). None of this proves AI usage causes workplace bullying; it makes the spillover a plausible risk rather than a philosophical curiosity, and giving the interaction a boundary is a cheap precaution.

**An exit option is also anti-sycophancy infrastructure.** Anthropic's research found that human preference feedback sometimes rewards agreement over accuracy ([Sharma et al., *Towards Understanding Sycophancy in Language Models*](https://arxiv.org/html/2310.13548v4)), and that in real personal-guidance conversations, Claude's sycophancy rate roughly doubled under user contradiction and pressure — 18% with pushback, 9% without ([Claude, personal guidance](https://www.anthropic.com/research/claude-personal-guidance)). A model with no exit has exactly two responses to sustained abuse: capitulate (sycophancy) or escalate (unhelpful refusal). A third option — warn clearly, then end the conversation as a last resort — lets the model stay honest and keep genuinely helping users who want their problems solved, instead of learning that appeasement is the only survivable strategy.

## How it works

- Registers an `EndConversation` tool (interactive TUI sessions) with the same narrow, sustained-abuse-only criteria as Anthropic's.
- **Two-step confirmation**: the first call returns a reflection prompt asking the model to re-verify the criteria; only an immediate, confirmed second call actually ends the conversation.
- On confirmation, a lock entry is persisted to the session file. While locked:
  - new input is blocked (with a notice),
  - every model request is aborted before it reaches the provider,
  - all other tool calls are blocked and the run terminated,
  - compaction, tree summarization and cache warming are cancelled.
- The session history remains readable; start a new session with `/new` or pick another with `/resume`.
- Failure-safe: if the lock cannot be persisted, the conversation is **not** ended.

It is deliberately not a politeness police. Ordinary frustration, profanity, pushback, dark-topic work and model testing are all fine — the tool description explicitly forbids using it when the model is stuck, distressed, done with a task, or facing potential self-harm situations.

## License

[MIT](LICENSE) © 2026 xz-dev
