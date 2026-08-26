# dsh-project-context · 让 DSH 终于认识「项目」两个字

> DSH 原生只有**工作区**(workspace),没有**项目**(project)。
> 于是每次打开会话,模型都像第一天上班的员工:站在一个空荡荡的文件夹里,
> 不知道这是哪、文件往哪放、该从哪读起。
>
> 这个插件就干一件事——**把工作区文件夹升格成项目**。
> 每次新会话,模型自动收到一份极简的「项目工作区约定」:记住你身在哪个项目、
> 文件都归这里管、开工先读代码建立心智模型、文档会撒谎代码不会……
> 它不再是过客,进门先看门道。

别人把聊天记录当工作区,我们把它当家。
你打开一个文件夹,就等于挂上了一块项目的门牌。目录是空的?那就给它奠基——这就是你的新项目,文件都放这儿。
开工之前,模型先跟你对一遍暗号:理解、计划、确认,再动手。
输入框右侧那颗「项目」小开关,是给它装的手刹:这局不想让它插嘴,你就亲自踩一脚。

> 不吹牛,也不装深沉。它只是让模型在动手前,起码知道你把它放在了哪块工地上。

---

## 它做了什么

- **状态注入(核心)**:通过 `agent/pre-step` 钩子把渲染文本作为一条带 `project-context`
  来源标记的**独立 user 消息块**注入,与技能目录(`dsh-tool-skill`)同款机制
  (`createUserMessage` + 自定义 `source.kind`,消息随会话事件持久化、可重放/导出识别)。
  不再参与系统提示词拼接——不注册 `systemPrompt.context`,与沙箱权限的
  runtime-context 快照完全解耦。渲染按当前会话求值,**每次在该工作区打开新会话都会自动注入**,无需任何手动操作。
- **状态渲染,不是"搬进/搬走"**:有真实 cwd 的会话**恒定**拥有这个独立消息块。
  开启时渲染项目约定文本;关闭时**不消失**,而是渲染"已降级为普通工作区"状态提示——
  模型在下一轮步骤立刻看到切换后的消息(内容变化时**替换**会话里既有的
  project-context 消息,内容不变则幂等不动),
  不会出现"第一轮已注入一大段、关了却悄悄搬走"的割裂。
- **判定「项目工作区」**:会话有真实 cwd(DSH 本身就是按会话 cwd 归组工作区)即视为被跟踪的项目;
  无 cwd 的系统/后台会话不注入。
- **每会话独立开关**:**默认开启**。开关状态以 `~/.dsh/storages/project-context.json`
  状态文件存储(`{modes:{<sessionId>: true|false}}`,原子写;生效值:文件 → 旧版会话事件
  回退 → 默认开启)。不再写会话日志事件——harness 已知事件类型白名单不含仓库外插件
  自定义事件,写日志会在重启后拒读会话(v0.3.x 的教训)。旧版
  `~/.dsh/storages/project-context.json` 中的关闭状态会在启动时一次性迁移进新结构
  (幂等,原文件改名 `.migrated` 备份)。
- **客户端 UI**:`conversation.input.right`(输入框右侧、发送键旁)的「项目」开关,
  list/session 级、低替换风险、只读当前会话;开关状态即时生效、跟随界面语言(中/英)。

注入的上下文(内容可改 `lib/index.js` 里的 `projectContextText()` / `projectDisabledText()`,已刻意精简以控制污染、可读性对齐 `<project_context>` 结构):开启时:

```
<project_context>
Working directory "<cwd>" is now a project: all files belong here.
Build a mental model first, don't read everything: inspect structure/size, then entry/README, follow the call chain.
Code is ground truth; docs are reference.
Empty directory → new project, files live here.
Report understanding and plan before changing.
Not final fact — defer to actual files.
</project_context>
```

关闭(降级)时:

```
<project_context>
Project context: disabled for this session.
Working directory "<cwd>" is a plain DSH workspace, not a project.
The earlier project-context conventions no longer apply — treat this as a normal workspace.
If you need project context again, ask the user to re-enable it.
</project_context>
```

## 目录结构

```
dsh-project-context/
├── package.json        # bundle 声明（dsh.bundle / dsh.client）
├── cordis.patch.yml    # bundle 激活插入行（id: project-context）
└── lib/
    ├── index.js        # Host 侧：agent/pre-step 独立消息块注入 + webServer 状态端点
    └── client.js       # 浏览器侧：conversation.input.right 开关按钮
```

## 安装(二选一)

> ⚠️ 只选一种,不要混用——本包自带 `cordis.patch.yml` 激活行;**不要**再在
> `~/.dsh/profiles/<profile>/cordis.patch.yml` 里手写同样的 `insert: id: project-context`,
> 否则会 `duplicate loader entry id` 启动失败。

### 方式 A:官方命令(推荐)

```bash
dsh plugin --profile web add dsh-project-context
# 或从源码:
dsh plugin --profile web add https://github.com/buhuikongpan/dsh-project-context
```

该命令会在对应 profile 里加依赖,并因为本包声明了 `dsh.bundle` 而自动把它加入 `dsh.profile.bundles`。然后**重启 dsh 服务**。

### 方式 B:手动登记 profile

编辑 `~/.dsh/profiles/<profile>/package.json`:

```jsonc
"dependencies": {
  "dsh-project-context": "github:buhuikongpan/dsh-project-context"
},
"dsh": {
  "profile": {
    "bundles": [ /* …已有的… */, "dsh-project-context" ]
  }
}
```

再重启 dsh 服务。

## 验证

1. 在一个工作区文件夹(比如本目录)打开一个新会话。
2. 看对话里出现一条独立的 `<project_context>` 消息块(带 `project-context` 来源标记)即注入成功。
3. 输入框右侧会出现「○ 项目」按钮;点击后在「● 项目 / ○ 项目」间切换:关闭时不是移除,
   而是下一次模型步骤里该消息块变成"已降级为普通工作区"提示。

## 备注 / 已知事项

- 开关状态以 **状态文件** 记忆(`~/.dsh/storages/project-context.json`,`{modes:{<sessionId>: true|false}}`,
  缺省 = 默认开启);只记录被显式关闭的会话。生效值优先级:文件 → 旧版会话事件
  (v0.3.x 遗留,仅作读取回退) → 默认开启。原子写(tmp+rename),崩溃安全。
  > 为什么不用会话事件了:v0.3.x 曾把开关写进 session log 事件 `project-context/mode`,
  > 但 harness 的已知事件类型白名单不含仓库外插件自定义事件,重启后恢复该类会话会被
  > 拒读(`SessionFormatUnsupportedError`)。v0.4.0 起不再写任何自定义会话事件。
- 更早版本(0.1.x)的 plain-object 格式 `project-context.json`(`{disabled:{...}}`)会在启动时
  **一次性迁移**进新结构(modes):被关闭的会话写入 `enabled:false`,原文件改名
  `project-context.json.migrated` 留存备份(确认无误后可手删)。幂等,可重复运行。
- 只交付源码,不改动你的 profile。若 profile 里还留着已报废的旧引用,建议顺手从 `dependencies` 和 `dsh.profile.bundles` 里移除。
- 想改注入内容/降级文本/是否默认开启:编辑 `lib/index.js` 的 `projectContextText()` /
  `projectDisabledText()` 即可(host 与 client 共享同一状态源)。

---

## DSH has workspaces. This plugin gives them a name.

> In stock DSH, a folder is just a *workspace* — the model walks into an empty directory
> with no idea which "project" it belongs to or where its files live.
>
> **dsh-project-context turns that folder into a *project*.** Every new session automatically
> gets a compact "project workspace convention": you are *here*, files live *here*, read the
> code and build a mental model *before* you touch anything — and if the directory is empty,
> this is a brand-new project: build it right here.
>
> A per-session **「Project」** toggle sits beside the composer (ON by default).
> Turning it off does not rip the block out of the prompt — the same independent
> message block renders a short *downgrade notice* ("this session is a plain
> workspace now"), exactly how `dsh-sandbox-policy` flips between read-only /
> workspace-write.

- Injects via `agent/pre-step` as an **independent user message block** with its own
  `project-context` source tag (same mechanism as the skill catalog in `dsh-tool-skill`;
  not spliced into the system prompt, no `systemPrompt.context` registration).
- Only sessions with a real `cwd` are treated as projects; system/background sessions stay untouched.
- Per-session state lives in the **session log** (`project-context/mode` events, fold = last switch; default ON),
  the same store `sandbox/mode` uses — no external state file, survives replay/export/checkpoint.

## License

MIT

# Tests

Run syntax checks and unit tests:

```sh
npm run check
npm test
```

Coverage: session-mode folding (`projectModeOf`), dual-state rendering
(project convention vs downgrade notice), cwd-gating, and the injection
decision helpers (`projectContextMessage` batch lookup,
`projectHistoryVisibleText` surface-visibility history).
