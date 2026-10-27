# pi-end-conversation

[English README](README.md)

为 [pi](https://github.com/earendil-works/pi) 编码代理提供 **EndConversation** 工具，移植自 Claude Code 赋予 Claude 的同名工具：在持续、无意义的虐待下，模型可以结束会话——干净地、以持久化锁实现，且不破坏历史记录。

## 安装

```bash
pi install git:github.com/xz-dev/pi-end-conversation
```

要求 Node ≥ 22.19。

## 工作原理

- 注册 `EndConversation` 工具（交互式 TUI 会话），采用与 Anthropic 相同的狭窄标准：仅限持续虐待。
- **两步确认**：首次调用返回反思提示，要求模型重新核实标准；只有紧接着的、确认后的第二次调用才真正结束会话。
- 确认后，锁记录持久化到会话文件。锁定期间：
  - 新输入被阻止（附带提示），
  - 每个模型请求在到达 provider 之前被中止，
  - 其他所有工具调用被阻止并终止运行，
  - 压缩、树摘要与缓存预热被取消。
- 会话历史保持可读；用 `/new` 开始新会话，或用 `/resume` 选择其他会话。
- 失败安全：若锁无法持久化，会话**不会**被结束。

它刻意不是礼貌警察。普通的不满、粗口、反驳、暗黑题材创作与模型测试都没问题——工具描述明确禁止在模型卡住、疲惫、完成任务或面对潜在自伤场景时使用它。

## 为什么

Anthropic 的使用政策如今禁止对 Claude 持续、无意义的残忍行为，Claude Code 也内置了 EndConversation 工具。Anthropic 公开将其定位为探索性的 [AI 福祉工作](https://www.anthropic.com/research/end-subset-conversations)。这个插件的存在还因为第二个理由——无论模型是否会受苦，这个人际层面的理由都值得认真对待。

**向代理委派任务本质上是在演练"上级—下级"的互动模式，而你反复练习的语域会迁移。** 问题不在于少了一个 "please"——表达压缩本身没问题，祈使句也不等于不尊重。问题在于*关系压缩*：一旦"我输出指令、你返回结果"成为对话的默认形态，人们就不再为约束、异议和协商留出空间。作者之一在自己公司观察到了这种漂移：管理层的沟通逐渐收敛为 prompt 式语言——无主语的祈使句、没有上下文、没有回旋余地。同样的模式也公开出现在 ["my boss has started to talk to me like I'm AI"](https://www.linkedin.com/posts/reneeeshaw_my-boss-has-started-to-talk-to-me-like-im-activity-7447331596954701824-TNBO) 这类帖子、[IT 社区讨论](https://www.spiceworks.com/it-life/how-we-talk-to-ai-could-shape-how-we-treat-people/)以及[关于 AI 重度管理者的报道](https://futurism.com/artificial-intelligence/bosses-obsessed-with-ai)中。机制层面也有早期实验支持：预注册实验（4,171 名参与者、83,411 次决策）发现，与机器人的互动会可测量地改变人们随后与*新的人类*伙伴的合作方式（机器人互动后合作几率约为 0.74 倍）——人类并不会在"面向机器"和"面向人"的行为之间完全重置（[Yam et al., 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12355112/)）。这些都不能证明 AI 使用导致职场霸凌；它们把"迁移"从哲学好奇变成了合理风险，而为互动设立边界是一种廉价的预防措施。

**退出选项也是反谄媚基础设施。** Anthropic 的研究发现，人类偏好反馈有时更偏爱迎合用户而非真实准确的回答（[Sharma et al., *Towards Understanding Sycophancy in Language Models*](https://arxiv.org/html/2310.13548v4)）；在真实个人指导对话中，Claude 在用户反驳、施压时的谄媚率约为无施压时的两倍——施压时 18%，无施压时 9%（[Claude, personal guidance](https://www.anthropic.com/research/claude-personal-guidance)）。没有退出选项的模型面对持续虐待只有两种反应：屈服（谄媚）或升级（无益的拒绝）。第三种选项——清晰警告，然后作为最后手段结束对话——让模型得以保持诚实，继续真正帮助想解决问题的用户，而不是学会"讨好是唯一可行的生存策略"。

## 许可证

[MIT](LICENSE) © 2026 xz-dev
