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

- **自动注入(核心)**:复用 DSH 的 `systemPrompt.context` 动态运行时上下文机制(和沙箱权限 `dsh-sandbox-policy` 同一套)。
  `text` 按 `context.agent.session.header.cwd` 求值,每次模型步骤都重算——
  所以**每次在该工作区打开新会话都会自动注入**,无需任何手动操作。
- **判定「项目工作区」**:会话有真实 cwd(DSH 本身就是按会话 cwd 归组工作区)即视为被跟踪的项目;
  无 cwd 的系统/后台会话不注入。
- **每会话独立开关**:**默认开启**。关闭的会话(按 sessionId 记忆在 `~/.dsh/storages/project-context.json`)不再注入。
- **客户端 UI**:`conversation.input.right`(输入框右侧、发送键旁)的「项目」开关,
  list/session 级、低替换风险、只读当前会话;开关状态即时生效、跟随界面语言(中/英)。

注入的上下文(内容可改 `lib/index.js` 里的 `projectContextText()`,已刻意精简以控制污染):

```
【项目工作区约定】本会话工作目录“<cwd>”是一个项目工作区：本项目所有文件都应放在此目录下。
开工前先读代码建立心智模型，不要一上来全量通读：
1) 先探测再读内容：用 ls/find 看结构与规模、wc -l 量行数；先读 README/入口/数据格式；按需用 grep 沿调用链精准定位，不整包通读大项目。
2) 文档会撒谎，代码不会：读到的事实与其矛盾时，以实际代码为准并回头核实。
3) 若目录为空 → 这是待新建项目：直接在此目录创建，本项目所有文件放这里。
动手前先向用户汇报你的理解与改动计划，确认后再改。不要把本约定当作最终事实，随时以实际文件为准。
```

## 目录结构

```
dsh-project-context/
├── package.json        # bundle 声明（dsh.bundle / dsh.client）
├── cordis.patch.yml    # bundle 激活插入行（id: project-context）
└── lib/
    ├── index.js        # Host 侧：systemPrompt.context 注入 + webServer 状态端点
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
2. 看模型系统提示/动态上下文里出现「【项目工作区约定】…」即注入成功。
3. 输入框右侧会出现「○ 项目」按钮;点击后在「● 项目 / ○ 项目」间切换,对应本会话注入的开/关。

## 备注 / 已知事项

- 开关状态以 **sessionId** 记忆(`~/.dsh/storages/project-context.json`),默认开启;只记录被显式关闭的会话。
- 只交付源码,不改动你的 profile。若 profile 里还留着已报废的旧引用,建议顺手从 `dependencies` 和 `dsh.profile.bundles` 里移除。
- 想改注入内容/顺序/是否默认开启:编辑 `lib/index.js` 的 `projectContextText()`、`order: 120`、`isDisabled()` 逻辑即可(host 与 client 共享同一开关状态文件)。

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
> A per-session **「Project」** toggle sits beside the composer (ON by default) so you can
> silence the injected context for any single conversation, the way you'd grab the hand-brake.

- Auto-injects via `systemPrompt.context` (same runtime mechanism as `dsh-sandbox-policy`), evaluated per session.
- Only sessions with a real `cwd` are treated as projects; system/background sessions stay untouched.
- Per-session state persisted at `~/.dsh/storages/project-context.json`.

## License

MIT
