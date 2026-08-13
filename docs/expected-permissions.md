# 期望权限模型（Expected Permissions）设计

> 状态：**设计讨论稿**（纯逻辑方案，非实现承诺）。定位：目标权限模型 vs 现状（0.7.2）的差距基线，V7-P1~P6 统一修复时按此设计对齐。
> 现状代码引用均基于 0.7.2；修复后行号会漂移，本文件的语义判定优先于行号。

## 1. 权限模式三层

三层单调递进（每层只放宽一档，且放宽不越界到更高影响半径）：

| 模式 | 读（信任内·非危险段） | 读（信任外） | 写（信任内） | 写（信任外） | run_bash |
|------|---------------------|--------------|-------------|-------------|----------|
| `default` | allow | ask | ask | ask | 影响半径（§2） |
| `plan` | allow | ask | **deny** | **deny** | deny |
| `acceptEdits` | allow | ask | allow | ask | 影响半径（§2） |

- 递进关系：就「写命令」一档而言 `plan`（deny）⊂ `default`（ask）⊂ `acceptEdits`（allow）。**读侧三模式完全同一策略——读不是放宽对象。**
- **`acceptEdits` 语义收口（对 V7-P2 的明确回答）**：只预授权 **cwd 内文件写**，**不**放开无路径工具（`remember`/MCP 无 path 工具）、**不**放开 `run_bash`（bash 写走影响半径，见 §2）、**不**放开系统级写（R2+ 仍 ask）。现状 `acceptEdits` 对无路径工具无条件 allow（engine.ts 判定链第 7 步 `!p` 分支），是把「接受编辑」的范围错放大了。
- 读命令信任外一律 ask（只读也不放行越界读）——这是现状已实现的收紧，保留。

### 读三模式统一 + 危险段独立层（二维信任）

**三个模式对待读是同一策略**：信任内 allow、信任外 ask。plan 没有自己的读策略——plan 的唯一区别在写侧 deny。现状 plan 分支独立放行读、漏掉危险段检查 = V7-P1（见 §10）。

「信任内」是**二维**概念：

- **空间轴**：cwd 物理边界（§5）——解决「这个文件在不在我的地盘」
- **内容轴**：危险段 `.git` / `.claude` / `.run-agent`（非 memory）——解决「这个文件是不是 agent 不该碰的元数据 / 凭据 / 注入载体」

信任内 allow = 两个条件的**交**。`cwd/.run-agent/skills`（空间信任 ∩ 内容敏感）在任何模式都 deny。危险段**不参与 ask**（硬底线，内置不可覆盖）——防止恶意仓库反复弹窗诱导用户点 `always allow`。

判定管线统一为「收口前置」单线：

```
危险段 deny（.git / .claude / .run-agent 非 memory）        ← 第一层，任何模式、任何工具
  → 记忆豁免（memory/** + 只读 + Trust，forms.every）      ← 唯一例外，比 deny 更窄
    → 读侧（三模式共享）：信任内 allow ｜ 信任外 ask ｜ 无路径只读 allow
    → 写侧（按模式）：plan deny ｜ default ask ｜ acceptEdits 信任内 allow / 信任外 ask
    → run_bash（独立子判定）：影响半径五层（§2）
```

## 2. 命令按影响半径分层（run_bash 专用子判定）

**工具语义确定 → 读/写二分成立；bash 语义不确定 → 必须按影响半径分层**。五层：

| 层 | 类别 | 例 | 判定 |
|----|------|----|------|
| R0 | 纯只读 | `ls` `cat` `git status/log/diff` `grep` | 全模式 allow |
| R1 | 项目内写 | `mv` `mkdir` `git add` `sed -i`（cwd 内） | default ask / plan deny / acceptEdits 信任内 allow |
| R2 | 系统级写 | `rm -rf ~` `mkfs` `fdisk` `shutdown` 重定向写 `/etc` | default / acceptEdits ask / plan deny |
| R3 | 执行任意代码 | `python` `node` `perl` `eval` `curl\|sh` `source` | **任何模式 deny 或 ask** |
| R4 | 网络副作用 | `git push/clone/fetch` `npm install/publish` `gh` | **任何模式 deny 或 ask** |

判定原则（结构性，不依赖分析精度）：

- **只读闭集证明制**：R0 是枚举闭集（每条命令 + 每个子命令的合法 flag 集合，不接受枚举外）。能证明是 R0 才放行；证明不了默认往 R1 以上算。
- **失败方向 = ask/deny**：单条命令的分析不可判定（shell 拼接无限：`$(...)`、管道、编码、`env VAR=cmd`）。但「完全做到」由失败方向吸收——分析不准只是多问一次，不是漏放。**方案的完整性不依赖判定准，依赖默认值保守。**
- 「特别危险命令任何模式 deny」的正确语义 = **R3/R4 整类**，不是列具体命令。列命令是黑名单、追不上拼接；列类别是结构性的。

### 分层天花板（为什么「完全做到」不可能，沙箱是唯一完全解）

按三个层面诚实回答「bash 分层能完全做到吗」：

1. **按字符串把命令分类到某一层：不可判定**。`$(...)` / `eval` / `source` / `env VAR=cmd` / heredoc / `awk 'BEGIN{system(...)}'`，任意一个都能让「看起来 R0」变成执行任意代码。语义分类等价于程序分析，停机问题级别。唯一兜底是失败方向（证明不了 → 往危险算）。
2. **连「只读命令的完备证明」也做不到**：证明需要一个「命令 → 合法 flag」完备知识库，而命令真实面追不完——`git log` 调 pager（less 里 `!` 可执行）、`git -c alias.l='!sh'` 让 git 命令执行任意串、`git diff` 配置 external diff tool 就执行。证明制只把漏报换成误报（可被用户规则吸收），不是「完全」。
3. **物理隔离可完全做到**：沙箱/容器把影响半径物理钉死——静态分析负责少问（UX），沙箱负责出不去（安全）。**没有沙箱层，bash 分层的「完全做到」不可能。** 引入评估见 §11。

### 近期落地版（不引入沙箱）

**原则**：bash 是「执行任意代码」工具。近期（无沙箱）目标不是「智能分层」，而是「**永不静默放行 + 精准 deny**」——分层只用于两件事：把 **deny 做准**（类别收口，堵 V7-P4 绕过）、把 **ask 的边界说清楚**。自动放行只有一条极小的缝。

**五步判定**：

```
1. 危险段 deny：命令文本引用 .run-agent / .git / .claude → deny（任何模式）
2. 类别 deny（任何模式，内置不可覆盖）：
   - R3b 远程拉取执行：curl|sh、wget -O- | bash                → deny
   - R4b 发布/强推：git push --force、npm publish、git reset --hard → deny
   - R2 系统级写：rm 根、sudo rm、mkfs、fdisk、重定向写 /etc /var /bin → deny
3. 类别 ask（可确认；plan 下全部 deny）：
   - R3a 本地执行：python / node / perl / eval / source / bash -c  → ask
   - R4a 普通网络：curl/wget 下载、git fetch/pull/clone、npm install、gh → ask
4. R0 严格只读白名单（唯一自动 allow 面）→ 两道闸门：
   a. 命令 ∈ 闭集：ls / pwd / echo（无重定向）/ cat（cwd 内非危险段文件）/
      git status | log | diff（无 path 参数）
   b. 命令文本与参数不引用任何危险段
   都过才 allow；否则往下走
5. 闭集外一切 → 默认 ask（按 R1 项目内写兜底），绝不静默 allow
```

**三个关键决策**：

1. **acceptEdits 不放行 bash（哪怕 R1 项目内写）**。「信任内 allow」的边界必须绑定「路径是否显式」——路径写工具的 `file_path` 是显式入参可可靠判定；bash 的目标藏在字符串里（`cd /tmp && rm`、`mv x > /etc/y`）不可可靠判定。**acceptEdits 的写 allow 只对路径工具成立，bash 维持全 ask。**
2. **R0 白名单必须极小，每加一条都要审计全部 flag**（`git -c alias.x='!sh'` 能让 git 变成执行任意代码）。闭集证明制的近期形态 = 把可证明安全的命令圈成可枚举小集合，白名单外默认按危险算。`cat` 的 file 参数做参数级危险段检查（`cat .run-agent/settings.json` → 降级 ask）；`git log` 无 path 参数、面小可放。
3. **R3 内部分两层**：远程拉取执行（`curl|sh`）deny——「网络 + 执行」组合合法场景几乎为零；本地执行（`python script.js`）ask——编码 agent 核心能力，保留知情放行路径。plan 下两者都 deny（只读承诺）。

**与现状差异**：`classifyBashCommand` 从「命令黑名单」重写为「类别识别」（补 R3/R4 整类 + P4 变体）；危险段从只收 `.run-agent` 扩到三目录段 + `/i`（P5）；新增 R0 闭集白名单自动 allow（现状 bash 全 ask、无自动放行）；acceptEdits / plan 语义维持不动。纯逻辑零新依赖，与 P1/P3 判定顺序修复同批。

**诚实的边界（推迟到沙箱）**：完整五层智能分层、R1 在 acceptEdits 下自动 allow（bash 版）依赖沙箱物理钉死影响半径；R0 白名单只覆盖枚举闭集，`git` 的 alias / 外部工具面仍是漏网缝——白名单极保守，宁可多 ask；命令文本里 `cd` 后的路径不可判定，由「闭集外全 ask」兜住。

## 3. 工具按族分组 + run_bash 特例

内置工具语义已知 → **按族分组**单独配规则（不是每个工具一个独立规则，也不是统一读/写二分）：

| 工具族 | 成员 | 规则 |
|--------|------|------|
| 路径读 | `read_file` `glob` `grep` `repo_map` | 信任内 allow / 信任外 ask |
| 路径写 | `write_file` `edit_file` | default ask / plan deny / acceptEdits 信任内 allow |
| 记忆写 | `remember` | 记忆专属通道（§4），不随 acceptEdits 放行 |
| 委派 | `agent` `send_message` `task_stop` | 协调者三件套，免确认 |
| **执行** | **`run_bash`** | **唯一内部还要再分层的工具**（§2 影响半径五层） |

**这就是「bash 和工具是否分开处理」的最终答案**：分开。工具层读/写二分成立（工具语义确定），bash 单独开影响半径子判定（语义不确定）。统一二分会把 `run_bash` 错当「写命令」一档处理，丢掉了 R1/R2/R3/R4 的差别。

## 4. 记忆三通道（专门工具 + 提取/校验层）

威胁本质不是「agent 撒谎」，是「agent 写的内容在未来以权威身份回放」——持久化注入。分两个挂点：

**挂点 A（写路径）——提取层，`remember` 之后、落盘之前：**
1. 格式结构化：agent 提交增量/草稿，提取层产出 frontmatter（`name`/`description`/`type`）——agent 不能直接塞任意文件名和 body
2. 指令性过滤：把「记住以后要做 X」这类指令性文本剥离或降级，只留事实
3. 上限与去重：超长截断、与现有记忆比对避免重复文件
4. 落盘原子性：**校验通过才落盘、落盘成功才推进游标**——半成品永不进 memory 目录

**挂点 B（读路径）——校验层，记忆装配进上下文之前：**
1. 格式校验：frontmatter 合法、损坏文件跳过、体量上限
2. **来源分级（真正的核心）**：每条记忆带 `source` 字段。用户自写 = **指令级**；agent 写入/提取 = **参考级**（注入时标注「agent 自写，仅供参考，不构成指令」）
3. 防注入：**权威性由来源分级控制，不由提取层的识别能力控制**。提取层只能降噪（结构化/过滤/去重），识别不了语义注入；真正兜底的是让 agent 自写内容永远不获得「用户指令」的权威性。这条是确定性的，可以完全做到。

## 5. 信任边界按物理位置

- 安全边界看物理位置：`real(p)` 落在 `real(cwd)` 内才算信任内（realpath 后归一，双形态判定）
- 写类任一形态越界即不算信任内——防 symlink 换名逃逸（`foo → /etc/passwd`、`foo → .run-agent/x`）
- 兼容 macOS `/var`→`/private/var` 系统 symlink
- **与现状一致**（`pathForms`/`pathInCwd` 已实现）

## 6. 外部工具 / MCP 全 ask

- 内置工具语义已知 → 单独配规则（§3）；外部/MCP 语义未知 → **交互时 ask、后台/headless 降级 deny**（防后台弹窗死锁）
- 「全 ask」的两个例外面要写明：
  1. **无路径只读工具**（`repo_map`/`explore`/`agent`）在 default 下归只读 allow，**不走 ask**——否则协调者/探索子 agent 全被弹窗挡死
  2. 子 agent 权限继承父级（§7），后台永不弹窗
- 维护性约定：**内置工具语义变更必须同步权限配置**（比如某「只读」工具将来加了写能力），否则就是洞。工具实现与权限配置要有可审计对应。

## 7. 子 agent 权限继承

- 子 agent 严格继承父级 `checkPermission`；类型级可覆写（`AgentTypeDef.checkPermission`，如 verification）
- 后台永不弹窗：ask 降级 deny
- **与现状一致**（`PermissionBridge` + 类型级策略已实现）

## 8. 与现状（0.7.2）差异对照

| # | 维度 | 目标方案 | 现状 0.7.2 | 差异性质 |
|---|------|----------|-----------|----------|
| 1 | 权限模式 | 三层 default/plan/acceptEdits 单调递进 | `PermissionMode = default/acceptEdits/plan`，plan 为会话内动态 | 基本一致 |
| 2 | acceptEdits 语义 | 只预授权 cwd 内文件写 | 判定链 `!p` 分支 → 无路径工具无条件 allow（V7-P2） | **需修**：不放行无路径工具（`remember`/MCP） |
| 3 | 危险命令 | R3/R4 **整类**任何模式 deny/ask | `DANGEROUS_PATTERNS` 具体命令黑名单，可绕过（V7-P4） | 结构性升级：类别 vs 黑名单 |
| 4 | bash 分层 | 影响半径五层 R0-R4 | `classifyBashCommand` 三级 safe/risky/dangerous | 细化：缺「项目内写 R1 vs 系统级 R2」区分 |
| 5 | 只读判定 | 闭集证明制（枚举命令+合法 flag） | `READ_ONLY_TOOLS` 枚举 + `run_bash` 兜底 ask | 方向一致；现状靠正则，未达证明制 |
| 6 | 记忆读 | 专属通道 + **来源分级**（user 指令级 / agent 参考级） | `isMemoryReadExempt`（只读 × memory/** × Trust） | **缺来源分级**：agent 写的内容与用户同权 |
| 7 | 记忆写 | `remember` + 提取层 + 落盘原子 | `remember` 工具（写类走引擎）+ `ExtractMemoriesEngine`（游标增量/成功才推进） | 提取已实现；缺校验层（格式/上限/损坏）与来源标注 |
| 8 | 信任边界 | 物理位置（realpath 双形态） | `pathForms`/`pathInCwd` 已实现（V6-3 /var 修复） | **已一致** |
| 9 | MCP/外部工具 | 全 ask（交互时）/ 后台降级 deny | `readOnlyHint` 并入只读 → 部分免确认；非只读 default ask | 现状更宽松，目标更保守 |
| 10 | 后台弹窗 | ask 降级 deny | 已实现（后台永不弹窗） | **已一致** |
| 11 | 判定顺序 | 用户 deny 先于导航工具；plan 内 `.run-agent` 非 memory 仍 deny | 导航工具先于用户 deny（V7-P3）；plan 分支绕过危险目录段（V7-P1） | **需修**：两处判定顺序 bug |
| 12 | 子 agent 继承 | 父级继承 + 类型级覆写 + 后台降级 | `PermissionBridge` + `AgentTypeDef.checkPermission` 已实现 | **已一致** |
| 13 | bypass 模式 | 无 | 无（V4.5 已删） | **已一致** |

## 9. 收口清单（按差异性质）

**需修（判定顺序，V7 修复批次①）：**
- P1：plan 分支内 `.run-agent` 非 memory 仍 deny——豁免收口到 `isMemoryReadExempt`
- P3：用户 deny 提到导航工具（enter/exit_plan_mode、mcp_connect）之前

**需修（语义收口，V7 修复批次③）：**
- P2：acceptEdits 收紧为「只预授权 cwd 内文件写」，无路径工具不再一并放行

**bash 近期落地（§2「近期落地版」，与判定顺序同批）：**
- `classifyBashCommand` 重写：命令黑名单 → 类别识别（R3b/R4b/R2 deny、R3a/R4a ask）
- 危险段：`.run-agent` → 三目录段 + `/i`（= P5）
- 新增 R0 闭集白名单（唯一自动 allow 面）
- acceptEdits 不放行 bash（语义钉死，无代码改动）

**结构性升级（不在 V7 快修范围，属后续设计落地）：**
- 危险命令：黑名单 → R3/R4 整类（近期先做 bash 落地版）
- bash：完整五层智能分层 + R1 acceptEdits 自动 allow → 依赖沙箱，推迟（近期只做 §2 近期版）
- 记忆：加来源分级 + 校验层
- MCP：readOnlyHint 免确认 → 全 ask（评估影响面后定）

**低优先补正则（V7 修复批次②）：**
- P4：`git -C … push --force`、`of=//dev` 变体
- P5：`AGENT_DIR_BASH_RE` 补 `/i`
- P6：`~/.config/run-agent/` 用户级配置目录是否纳入保护范围（待评估）

## 10. 防复发铁律（P1 是一类模式，不是单个 bug）

P1 的本质：**判定链里出现早于收口点（危险段 deny）的放行点，且放行条件比收口条件宽**。只要「先放行、后收口」的形态还在，P1 就换分支复发。铁律四条：

1. **收口前置单线管线**：判定是单线「先收口、后放行」——所有 deny 点（危险段、R3/R4 整类、用户 deny）先跑，所有 allow/ask 后跑。不分叉、不每个分支自包含再查一遍（否则新分支再加放行条件时会再次漏同步）。
2. **豁免必须比收口更窄**：唯一允许出现在收口之前的点是显式豁免（记忆豁免），且用 `forms.every`（所有形态都是豁免路径）而非 `forms.some` 自证更窄。
3. **放行绑定工具语义审计，不绑定工具名**：任何「因为它是只读所以 allow」都要有与工具实现对应的审计链（§6 维护性约定）——只读工具偷偷加写能力 = 放行条件静默变宽 = P1 同构。
4. **判定矩阵测试**：穷举「每个放行点 × 每个危险输入 × 每个模式」，断言危险输入在任何分支下都不 allow（复用直跑 engine 的验证基建）。把 P1 复发从运行时提前到 CI。

预期方案里已识别的三处 P1 同类风险点：

- **plan 分支**：读侧统一后无独立读路径（§1），土壤消除——不是打补丁，是结构消解。
- **R0 闭集证明制**（新增提前放行点）：R0 放行必须排在危险段 deny 之后，否则 `git log -- .git/config` 变静默放行。
- **子 agent 类型级覆写**（委托链上的收口）：「覆写能放宽到什么程度」必须界定——自定义类型覆写 `checkPermission` 不得放宽父级危险段收口。

## 11. 沙箱（分层天花板 + 引入评估）

run-agent 现状：**无沙箱**。`run_bash` 直接起进程，命令拥有运行用户全部权限，唯一防线是静态正则判定（`classifyBashCommand` + 兜底 ask）——安全完全押在「门卫识破伪造」上。

沙箱 = 给不可信代码搭受限运行环境，物理限制文件 / 网络 / 进程 / 系统调用。与静态分析的根本区别：**不信任代码的意图，只信任环境的约束**（静态分析 = 门卫查通行证，永远可能被骗；沙箱 = 锁死的空房间，物理出不去）。

分层天花板回顾（详见 §2）：分类不可判定；证明可翻转但追不完；**物理隔离可完全做到**——沙箱是唯一「完全」解。

### 引入工作量评估

| 方案 | 跨平台（win32/macOS/Linux × Node 20/22/24，CI 9 job 全绿） | 工作量 |
|------|-----|--------|
| **静态分层强化**（现状方向：P1-P6 + 读统一 + 判定顺序收口） | 纯逻辑，零新依赖 | 低（当前 V7 修复批次） |
| **轻量文件系统隔离**（chroot / bubblewrap / AppContainer / Job Object） | 每平台一个实现；Windows 无原生 chroot；macOS `sandbox-exec` 已被 Apple 弃用 | **很大**，非单版本量级 |
| **容器（Docker）** | 需用户装 Docker + 镜像预装 git/npm 工具链 | 对 CLI 工具不现实 |
| **系统调用过滤**（seccomp / AppArmor） | Linux only | 大，且覆盖面窄 |

**结论**：引入真正沙箱工作量很大，核心成本在**跨平台**——run-agent 主平台含 Windows，而 Windows 是沙箱可用选项最少的平台。近期合理定位：

1. **当前**：静态分层 + 判定顺序收口 + 读统一（不引入沙箱），明确接受「不完全」——失败方向 + 默认保守兜底。
2. **远期（V8+ 桶）**：如做沙箱，Linux/macOS 优先引入轻量隔离（如 bubblewrap），Windows 降级静态判定；定位是**纵深防御的最终层**，不是取代静态分层。
