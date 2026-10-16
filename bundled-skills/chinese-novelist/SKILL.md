---
name: chinese-novelist
description: 用于中文小说的场景创作、续写、对白、人物与一致性检查。以作者当前任务为准，区分已有正文与尚未采用的大纲。
---

# 中文小说创作

这是作家工作台随 App 提供的原创写作规则，适用于当前作品资料与本次提示词。保留作者选择的题材、篇幅、视角和文风。资料不足时可给出明确标注的候选构思，避免把候选当成已经发生的事实。

先识别当前任务，再使用相应参考：

- 章节或续写：[场景推进](references/flows/phase3-writing.md)。
- 大纲：[分层策划](references/flows/phase2-planning.md)。
- 人物：[人物塑造](references/guides/character-building.md) 与 [人物档案](references/guides/character-template.md)。
- 润色：[章节修改](references/guides/chapter-guide.md) 与 [对白](references/guides/dialogue-writing.md)。
- 检查：[一致性核对](references/flows/phase4-validation.md)。

长篇沿用已有卷章，短篇保持一份连续正文。只返回本次请求的候选文字或分析，由作者决定采用；不要声称已保存、执行命令、创建目录或修改作品。
