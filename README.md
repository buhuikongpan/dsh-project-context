# dsh-project-context · 给 DSH 一个「临时会话」

> 包名和仓库名是历史标识（它最早只做「项目上下文」）。**如今它做的是临时会话**：
> 每个临时会话有自己的目录，产出文件各写各的；项目工作区照旧拿到精简的项目约定，
> 临时会话什么提示词都不注入。

DSH 原生只有**工作区**（workspace），没有**临时会话**：每个目录都被当成项目，
而"随手问一句、试一段一次性代码"这类事没有落脚点。这个插件补上它：

- **侧边栏多一个「临时会话」入口**：点它在官方工作区树上方展开一个浮层，列出所有临时会话（可搜索、可重命名、可归档），点一行就打开——不用去官方的「未分组」里翻；
- **侧边栏底部多一颗「临时会话」按钮**：点它在 `$DSH_HOME/workspace/default/` 下建一个专属子目录，并以它为 cwd 开一个新会话；
- **每个临时会话一个目录**：产出文件各写各的，不会堆在一起；
- **插件不动你的权限配置**：临时会话常被用来清盘、整理文件，把它钉进沙箱会让这些事做不了——告诉模型它在哪个目录就够了；
- **会话头出现「临时会话」徽标**：一眼看出当前会话是不是临时会话；
- **临时会话不注入任何提示词**：它有自己的目录，不需要被"告诉"什么。

---

## 它做了什么

### 1. 用途判定是一个纯路径问题

```
cwd 在 $DSH_HOME/workspace/default 之下（含等于）→ conversation
其余                                            → project
```

没有状态文件、没有 registry 查询、没有会话级开关。用途是**目录结构本身**，不是
一份需要维护的映射——所以它不会陈旧、不会和实际状态打架。

> 判定含"等于根目录"是为了兼容子目录方案之前的旧临时会话：它们的 cwd 就是根目录
> 本身，不算进来的话会突然被当成项目、吃上 `<project_context>`。

### 2. 隔离靠目录结构，不靠提示词，也不靠锁权限

每个临时会话的 cwd 是它自己的子目录，工具的相对路径都基于 cwd，所以产出文件天然
各写各的——这正是官方 stray 会话本来的样子（各自的 cwd 由创建者指定），插件只是把它
自动化了：自动建目录 + 自动以它为 cwd 创建会话。

**插件不改会话的沙箱模式或审批策略。** 两个理由：

1. 临时会话经常被用来清盘、删文件、整理磁盘，钉死 `workspace-write` 会让这些事做不了；
2. `permission.defaultPreset` 是用户的显式配置，插件不该覆盖它。

告诉模型自己在哪个目录，它就有足够的倾向留在那儿。

代价说清楚：这是**惯例，不是物理保证**——模型用绝对路径仍然能写到别处。要真正锁死，
手动把那个会话的权限切到 `workspace-write` 即可，可写边界正好是它自己的目录。

### 3. 注入只发生在项目侧（`agent/pre-step`）

与技能目录（`dsh-tool-skill`）同款机制：一条带 `source.kind = 'workspace-purpose'` 的
**独立 user 消息**，不参与系统提示词拼接。

```
<project_context>
Working directory "<cwd>" is a project workspace: files for this work belong here.
Build a mental model before changing: inspect structure and entry points, follow the call chain.
Code is ground truth; docs are reference.
An empty directory is a new project — files still live here.
Report your understanding and plan before making changes.
</project_context>
```

- **临时会话不注入任何东西**（空串 = 不注入），并且会清掉本轮批次里可能自带的旧块；
- **幂等**：扫会话历史里 `surface` 可见的那条同来源消息，内容不变不重发；变化时**原位替换**（不是追加）；
- **无 cwd 的会话**（系统/后台）不注入、不判定。

### 4. 侧边栏浮层

| 位置 | 插槽（kind） | 内容 |
| --- | --- | --- |
| 侧边栏入口 | `sidebar.panellist`（list / root） | 一个「临时会话」图标。entry 里铺一层覆盖图标区的透明点击层并 `stopPropagation`，拦住外层官方按钮的 `selectPanel`——所以点图标只开关浮层，**中间区域不受影响** |
| 浮层本体 | `shell.overlay`（list / root） | 官方**为浮层预留的 additive 座位**：`kind: list`，新 id 是"新增一座位"而非"替换"，所以官方的工作区树与它的全部功能继续由官方渲染与维护。该层本身点击穿透，entry 自己 opt in 指针事件 |
| main 占位 | `main`（keyed / root） | `layout.selectPanel(id)` 会校验 `hasMainPanel`，不注册会抛错；真正内容在浮层里，所以这里只给一句提示和返回入口，不重复渲染列表 |
| 侧边栏底部 | `sidebar.footer.action`（list / root） | 快捷新建按钮：`POST /__workspace-purpose/new-conversation` 让宿主建好子目录，再 `sessions.create({sessionId, cwd})` + `sessions.open(...)`；**当前已是空白会话时不重复新建** |
| 会话头 | `conversation.session.header.actions`（list / session） | 不可点的「临时会话」Pill，仅在会话 cwd 落在临时根目录之下时渲染 |

**浮层里有什么**（形态对齐官方浏览区）：

- 标题 + 会话计数 + 收起键（✕ / 点遮罩 / `Esc` 都能收起）
- 搜索框：走 `sessions.search(query, signal)`（宿主内容搜索，250ms debounce + abort），结果再按 cwd 前缀过滤，只留临时会话
- 按时间分组的列表：今天 / 昨天 / 更早
- 会话行：运行状态点 + 标题 + 相对时间；hover 显示「重命名 / 归档」，右键出同样的菜单，双击标题就地改名（`sessions.binding(id).session.rename`），归档走 `uiWorkspace.archiveSession`
- 底部「新建临时会话」

列出哪些会话：cwd 在临时根目录之下的、非 subagent 的、非归档的、非空白占位的会话。
入口标签走 `label` 的 **thunk 形式**（契约支持 `string | (() => string)`，每次投影重新求值），
所以切换界面语言时标签跟着变，不需要重新注册。

**两条刻意的边界**（不是没做完）：

- **是列表，不是树**：临时会话之间没有层级关系（每个会话是一个独立目录当 cwd），所以浮层是"平铺列表 + 时间分组"，不是"工作区 › 会话"的两级树。
- **拖拽排序做不了**：官方用 `workspaces.insertSessionBefore(workspaceId, …)`，而临时会话不属于任何工作区，没有 workspaceId 可传。

判定口径：会话 cwd 与宿主给的 root 做**前缀比较**（分隔符统一 + 大小写归一）。
cwd 是宿主自己生成的路径，字符串前缀足够，不碰 Windows 短名。

宿主暴露两个端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/__workspace-purpose/state` | `{ok, root, ready}` |
| `POST` | `/__workspace-purpose/new-conversation` | 建子目录，返回 `{ok, sessionId, cwd}` |

---

## 安装 / 更新

```bash
# 安装（或更新到最新 commit；GitHub 依赖会解析到默认分支最新提交）
dsh plugin --profile web add "github:buhuikongpan/dsh-project-context"

# 更新
dsh plugin --profile web update dsh-project-context
```

装完**必须重启** `dsh web` 才生效。确认 bundle 已进 profile 清单：

```bash
dsh --profile web --dump-config | grep -i project-context   # 只应出现一次
```

> ⚠️ **0.6.0 是架构变动版**：临时会话从"一个共享工作区"改成"每会话一个子目录 + 沙箱边界"。
> - 旧状态文件 `~/.dsh/storages/workspace-purpose.json` 已不再读写，可以手工删除；
> - 更早的 `~/.dsh/storages/project-context.json`（每会话开关时代）同样可以删；
> - 旧会话的 cwd 是根目录本身，判定仍然认（见上一节），但它们历史里已有的
>   `<workspace_purpose>` 消息不会被改写——插件不删别人的历史。
>
> **0.6.1** 加了侧边栏的「临时会话」面板；**0.7.0** 把它改成盖在官方工作区树**上方**的浮层
> （用官方预留的 `shell.overlay` 座位，不遮蔽官方 UI），并补上搜索、时间分组、重命名、归档。
> 目录布局、判定口径与注入行为全程未变，直接更新即可。

---

## 已知边界

- **官方工作区树里的「未分组」桶仍然会列出这些会话，插件移不走它们。** 原因有两层：
  会话归属由 `attachSession` 的硬校验决定（`cwd` 必须严格等于工作区路径），而临时会话
  各有自己的 cwd，所以它们不属于任何工作区；那个桶的分组名也改不了（`group.ungrouped`
  属于官方 `ui-workspace` 命名空间，locale 是单占位，重复注册直接抛错）。
  插件给出的解法是**自己提供入口**：侧边栏的「临时会话」浮层把同一批会话列出来，点开即可。
  所以两处会看到同一批会话——插件能做的到此为止。唯一的隐藏手段是归档
  （`archived` 是 `sessionVisible` 里唯一的过滤器），那会让会话从**所有**官方界面消失，
  等于劫持，本插件不做。
- **浮层是"盖上去"，不是"常驻并列"。** 它打开时遮住官方树、收起后完全复原。要在侧边栏里
  常驻一个和官方树并列的区，就得注册 `sidebar.workspaces`（single 槽）遮蔽官方渲染，
  而官方 `WorkspaceBrowser` 没有导出、无法复用——那意味着把官方整棵树的维护责任接过来，
  本插件不做。
- **每个临时会话的目录会累积**，插件不做自动清理。手工清理就是删
  `$DSH_HOME/workspace/default/` 下的子目录（目录名 = 会话 id 去掉 `session-` 前缀），
  建议先确认对应会话已不再需要。
- **`$DSH_HOME/AGENTS.md` 仍会注入临时会话**：它是 DSH 明确识别的**用户级全局指令**
  （`dsh-agent-instructions`），不属于项目级作用域，本插件不去改变这一点。项目级的
  `AGENTS.md` 因为临时目录是空的而天然不生效。
- **目录隔离不等于沙箱**：临时会话各自有目录，但插件不限制文件访问，模型仍然可以用
  绝对路径写到别处（这往往正是你要的——临时会话常用来清盘、整文件）。要真正锁死就
  手动把该会话的权限切到 `workspace-write`，可写边界恰好是它自己的目录。
- **官方没有 workspace purpose / 临时会话的任何概念**（全量 grep 0 命中），所以用途只
  存在于本插件的路径约定里；官方的 `workspaceRecord` schema 是 `z.core.$strip`（未知键
  会被剥掉），本插件也不去给它加字段。

---

## 开发与验证

```bash
npm run check   # 三个文件的语法 + 浏览器半边的 classic-script 语法
npm test        # node --test
```

测试覆盖：

- `test/state.test.js` —— 根目录/会话目录路径、前缀判定（含相似前缀 `default-other`
  不算、`.`/`..` 拒绝）、路径规范化
- `test/inject.test.js` —— 用途判定、渲染（临时会话不注入）、历史幂等与可见性、
  会话目录准备

人工端到端观察点：

1. 点侧边栏的「临时会话」图标 → 官方工作区树**上方**展开浮层；官方树仍在，中间对话区域**不变**；再点图标、或按 ✕ / 点遮罩 / 按 `Esc` 都能收起；
2. 浮层里「新建临时会话」→ 新会话、会话头出现 Pill、浮层里多出一行；底部那颗快捷按钮同样能新建；
3. 该会话首轮确认**只有**系统提示词、**没有** `<project_context>`；
4. 在临时会话里让模型写文件 → 落在 `$DSH_HOME/workspace/default/<会话 id>/`；
5. 开第二个临时会话 → 目录不同，看不到上一个会话的文件；浮层里两行都在，点一行能打开并自动收起浮层；
6. 搜索框输入关键词 → 只列出临时会话的命中；重命名（双击标题或 hover 的 ✎）、归档在会话行上可用；
7. 在真实项目工作区开会话 → `<project_context>` 仍在、无 Pill，且**不出现在**浮层里；
8. 官方工作区树的功能（搜索、分组、折叠、拖拽、右键菜单）**完全不受影响**；
9. 临时会话的权限与你其他会话一致（插件没动过它）。

---

## 结构

```
lib/index.js     宿主半边：路径判定 / 建会话目录 / pre-step 注入 / 两个端点
lib/state.js     路径层：根目录、会话目录、前缀判定、规范化
lib/client.js    浏览器半边：侧边栏入口（点击劫持）+ shell.overlay 浮层 + main 占位
                 + footer 快捷按钮 + 会话头 Pill（classic script，无 JSX，纯 createElement）
cordis.patch.yml profile 层激活行（id 稳定，勿与 profile 里的手写行重复）
test/            node --test
```

License: MIT
